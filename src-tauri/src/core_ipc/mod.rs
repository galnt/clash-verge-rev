//! 与 Throne core 的 IPC 客户端。
//!
//! 协议完全沿用 Throne GUI 的做法（见 core/internal/rpc/dispatch.go）：
//! 命名管道（Windows）/ Unix socket（macOS、Linux）+ 小端帧，payload 是
//! core/gen/libcore.proto 里的 protobuf 消息：
//!
//! ```text
//! req  [u32 req_id][u16 method_len][method][u32 payload_len][payload]
//! resp [u32 req_id][u8 status][u32 data_len][data]
//! ```
//!
//! core 侧会校验管道/套接字的对端 pid 是否等于自己的父进程 pid，所以本进程
//! 必须既是管道服务端、又是 core 的父进程——这正是这里 spawn 的方式。

pub mod proto {
    //! 由 build.rs 从 core/gen/libcore.proto 生成，与 core 共用同一份定义。
    //! 这里只用到测速相关的消息，其余方法的消息暂时没有构造点。
    #![allow(dead_code)]
    include!(concat!(env!("OUT_DIR"), "/libcore.rs"));
}

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};

use anyhow::{Context as _, Result, anyhow, bail};
use clash_verge_logging::{Type, logging};
use prost::Message as _;
use tokio::{
    io::{AsyncBufReadExt as _, AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _, BufReader},
    process::{Child, Command},
    sync::{Mutex, oneshot},
};

/// core 以 500ms 间隔重试 10 次，这里留出余量。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 单次 RPC 上限：一批节点串行测速可能跑几分钟。
const CALL_TIMEOUT: Duration = Duration::from_secs(900);

/// 与 core 的连接只需要字节流语义。
trait PipeStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> PipeStream for T {}

type PipeReader = tokio::io::ReadHalf<Box<dyn PipeStream>>;
type PipeWriter = tokio::io::WriteHalf<Box<dyn PipeStream>>;
/// req_id → 等待该响应的一方（status, payload）。
type PendingMap = HashMap<u32, oneshot::Sender<(u8, Vec<u8>)>>;

struct Shared {
    writer: Mutex<PipeWriter>,
    pending: Mutex<PendingMap>,
    next_request: AtomicU32,
}

/// 一个 core 子进程 + 一条 IPC 连接。Drop 时关闭连接（core 随即自行退出）。
pub struct CoreSession {
    shared: Arc<Shared>,
    child: Child,
    reader_task: tokio::task::JoinHandle<()>,
    log_tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl CoreSession {
    /// 建管道 → 启动 core → 等它连上来。
    pub async fn start(core_exe: &Path) -> Result<Self> {
        let endpoint = Endpoint::bind()?;
        logging!(
            info,
            Type::Core,
            "[CoreIPC] starting {} on {}",
            core_exe.display(),
            endpoint.name()
        );

        let mut child = spawn_core(core_exe, &endpoint.name())?;
        let pid = child.id().unwrap_or_default();
        logging!(info, Type::Core, "[CoreIPC] core spawned pid={pid}");

        let conn = match tokio::time::timeout(CONNECT_TIMEOUT, endpoint.accept()).await {
            Ok(Ok(conn)) => conn,
            Ok(Err(err)) => {
                let _ = child.start_kill();
                return Err(err);
            }
            Err(_) => {
                let _ = child.start_kill();
                bail!("core did not connect within {CONNECT_TIMEOUT:?}");
            }
        };
        logging!(info, Type::Core, "[CoreIPC] core connected");

        let (reader, writer) = tokio::io::split(conn);
        let shared = Arc::new(Shared {
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            next_request: AtomicU32::new(1),
        });
        let reader_task = tokio::spawn(read_loop(reader, Arc::clone(&shared)));
        let log_tasks = pump_child_output(&mut child);

        Ok(Self {
            shared,
            child,
            reader_task,
            log_tasks,
        })
    }

    /// `SpeedTest`：core 会用请求里的 config 建一个临时盒，按 tag 拨号测速。
    pub async fn speed_test(&self, request: &proto::SpeedTestRequest) -> Result<Vec<proto::SpeedTestResult>> {
        let data = self.call("SpeedTest", &request.encode_to_vec()).await?;
        let response =
            proto::SpeedTestResponse::decode(&data[..]).context("decode SpeedTestResponse failed")?;
        Ok(response.results)
    }

    /// `StopTest`：取消所有正在进行的测速（core 侧 probe.CancelTests）。
    pub async fn stop_test(&self) -> Result<()> {
        self.call("StopTest", &proto::EmptyReq {}.encode_to_vec()).await?;
        Ok(())
    }

    async fn call(&self, method: &str, payload: &[u8]) -> Result<Vec<u8>> {
        let request_id = self.shared.next_request.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.shared.pending.lock().await.insert(request_id, sender);

        let method_len = u16::try_from(method.len()).context("method name too long")?;
        let payload_len = u32::try_from(payload.len()).context("payload too large")?;
        let mut frame = Vec::with_capacity(10 + method.len() + payload.len());
        frame.extend_from_slice(&request_id.to_le_bytes());
        frame.extend_from_slice(&method_len.to_le_bytes());
        frame.extend_from_slice(method.as_bytes());
        frame.extend_from_slice(&payload_len.to_le_bytes());
        frame.extend_from_slice(payload);

        let mut writer = self.shared.writer.lock().await;
        writer.write_all(&frame).await.context("write core request failed")?;
        writer.flush().await.context("flush core request failed")?;
        // 尽早放锁：等待响应可能很久，不该让别的调用排在后面。
        drop(writer);

        let (status, data) = tokio::time::timeout(CALL_TIMEOUT, receiver)
            .await
            .with_context(|| format!("core did not answer {method} in time"))?
            .context("core connection closed")?;

        if status != 0 {
            // 出错时 core 把错误文本直接放在 data 里，不是 protobuf。
            bail!("core {method} failed: {}", String::from_utf8_lossy(&data).trim());
        }
        Ok(data)
    }
}

impl Drop for CoreSession {
    fn drop(&mut self) {
        self.reader_task.abort();
        for task in &self.log_tasks {
            task.abort();
        }
        // 关闭管道后 core 会自己退出；这里再补一刀，避免它成为孤儿进程。
        let _ = self.child.start_kill();
    }
}

async fn read_loop(mut reader: PipeReader, shared: Arc<Shared>) {
    loop {
        let mut header = [0u8; 9];
        if reader.read_exact(&mut header).await.is_err() {
            break;
        }
        let request_id = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
        let status = header[4];
        let len = u32::from_le_bytes([header[5], header[6], header[7], header[8]]) as usize;

        let mut data = vec![0u8; len];
        if len > 0 && reader.read_exact(&mut data).await.is_err() {
            break;
        }
        let waiter = shared.pending.lock().await.remove(&request_id);
        if let Some(sender) = waiter {
            let _ = sender.send((status, data));
        }
    }

    // 连接断开：丢掉所有等待中的 responder，让对应调用立即返回错误。
    shared.pending.lock().await.clear();
    logging!(warn, Type::Core, "[CoreIPC] core connection closed");
}

fn spawn_core(core_exe: &Path, endpoint: &str) -> Result<Child> {
    let mut command = Command::new(core_exe);
    command
        .env("THRONE_CORE_SOCKET", endpoint)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // 别给 core 弹控制台窗口；tokio 的 Command 自带 creation_flags。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .with_context(|| format!("spawn core {} failed", core_exe.display()))
}

fn pump_child_output(child: &mut Child) -> Vec<tokio::task::JoinHandle<()>> {
    let mut tasks = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        tasks.push(tokio::spawn(pump_lines(stdout)));
    }
    if let Some(stderr) = child.stderr.take() {
        tasks.push(tokio::spawn(pump_lines(stderr)));
    }
    tasks
}

async fn pump_lines<R: AsyncRead + Unpin>(reader: R) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            logging!(info, Type::Core, "[core] {}", trimmed);
        }
    }
}

/// IPC 端点：Windows 命名管道，其他平台 Unix socket。
enum Endpoint {
    #[cfg(windows)]
    Windows(tokio::net::windows::named_pipe::NamedPipeServer, String),
    #[cfg(unix)]
    Unix(tokio::net::UnixListener, PathBuf),
}

impl Endpoint {
    fn bind() -> Result<Self> {
        let nonce = std::process::id();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_micros())
            .unwrap_or_default();

        #[cfg(windows)]
        {
            let name = format!(r"\\.\pipe\clash-verge-throne-core-{nonce}-{stamp}");
            let server = tokio::net::windows::named_pipe::ServerOptions::new()
                .first_pipe_instance(true)
                .create(&name)
                .with_context(|| format!("create named pipe {name} failed"))?;
            Ok(Self::Windows(server, name))
        }
        #[cfg(unix)]
        {
            let path = std::env::temp_dir().join(format!("clash-verge-throne-core-{nonce}-{stamp}.sock"));
            let listener =
                tokio::net::UnixListener::bind(&path).with_context(|| format!("bind {} failed", path.display()))?;
            Ok(Self::Unix(listener, path))
        }
    }

    /// core 通过 THRONE_CORE_SOCKET 拿到这个名字去连接。
    fn name(&self) -> String {
        match self {
            #[cfg(windows)]
            Self::Windows(_, name) => name.clone(),
            #[cfg(unix)]
            Self::Unix(_, path) => path.to_string_lossy().into_owned(),
        }
    }

    async fn accept(self) -> Result<Box<dyn PipeStream>> {
        match self {
            #[cfg(windows)]
            Self::Windows(server, _) => {
                server.connect().await.context("core did not connect to the pipe")?;
                Ok(Box::new(server))
            }
            #[cfg(unix)]
            Self::Unix(listener, path) => {
                let (stream, _) = listener.accept().await.context("core did not connect to the socket")?;
                // 连接建立后 socket 文件就没用了。
                let _ = std::fs::remove_file(path);
                Ok(Box::new(stream))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    // 测试里用 expect/assert 表达断言是刻意的。
    #![allow(clippy::expect_used)]

    use super::{CoreSession, proto, resolve_core_exe};

    /// 端到端验证：起 core、走管道、发 SpeedTest、拿回结果。
    /// 需要先跑 `node scripts/build-speedtest.mjs` 产出 sidecar。
    #[tokio::test]
    #[ignore = "requires src-tauri/sidecar/verge-throne-core-* built by scripts/build-speedtest.mjs"]
    async fn speed_test_round_trip() {
        let exe = resolve_core_exe().expect("core executable");
        let session = CoreSession::start(&exe).await.expect("start core");

        let config = serde_json::json!({
            "log": { "disabled": true },
            "dns": {
                "servers": [{ "type": "local", "tag": "dns-local" }],
                "final": "dns-local"
            },
            "inbounds": [],
            "outbounds": [
                { "type": "direct", "tag": "proxy-0" },
                { "type": "direct", "tag": "direct" }
            ],
            "route": {
                "final": "direct",
                "auto_detect_interface": false,
                "default_domain_resolver": { "server": "dns-local" }
            }
        });

        // proto2 的 optional 字段在 core 侧是直接解引用，留空会 panic。
        let request = proto::SpeedTestRequest {
            config: Some(config.to_string()),
            outbound_tags: vec!["proxy-0".to_owned()],
            test_current: Some(false),
            use_default_outbound: Some(false),
            test_download: Some(true),
            test_upload: Some(false),
            simple_download: Some(true),
            simple_download_addr: Some("https://speed.cloudflare.com/__down?bytes=1000000".to_owned()),
            timeout_ms: Some(8000),
            only_country: Some(false),
            country_concurrency: Some(5),
            need_xray: Some(false),
            xray_config: Some(String::new()),
            xray_full_configs: Vec::new(),
            xray_outbound_dns_strategy: Some(String::new()),
        };

        let results = session.speed_test(&request).await.expect("speed test");
        assert_eq!(results.len(), 1, "one result per tag");
        let result = &results[0];
        assert_eq!(result.outbound_tag.as_deref(), Some("proxy-0"));
        assert!(result.dl_bytes.unwrap_or_default() > 0, "should download bytes: {result:?}");
        assert!(!result.dl_speed.clone().unwrap_or_default().is_empty(), "speed string: {result:?}");
    }

    /// 8 个节点并发测速：证明同一条管道上多请求并行可用，且结果按 reqId 正确归属。
    #[tokio::test]
    #[ignore = "requires src-tauri/sidecar/verge-throne-core-* built by scripts/build-speedtest.mjs"]
    async fn eight_parallel_speed_tests() {
        let exe = resolve_core_exe().expect("core executable");
        let session = std::sync::Arc::new(CoreSession::start(&exe).await.expect("start core"));

        let mut outbounds = Vec::new();
        for index in 0..8 {
            outbounds.push(serde_json::json!({ "type": "direct", "tag": format!("proxy-{index}") }));
        }
        outbounds.push(serde_json::json!({ "type": "direct", "tag": "direct" }));
        let config = serde_json::json!({
            "log": { "disabled": true },
            "dns": {
                "servers": [{ "type": "local", "tag": "dns-local" }],
                "final": "dns-local"
            },
            "inbounds": [],
            "outbounds": outbounds,
            "route": {
                "final": "direct",
                "auto_detect_interface": false,
                "default_domain_resolver": { "server": "dns-local" }
            }
        });

        let started = std::time::Instant::now();
        let mut tasks = Vec::new();
        for index in 0..8 {
            let session = std::sync::Arc::clone(&session);
            let config = config.to_string();
            tasks.push(tokio::spawn(async move {
                let request = proto::SpeedTestRequest {
                    config: Some(config),
                    outbound_tags: vec![format!("proxy-{index}")],
                    test_current: Some(false),
                    use_default_outbound: Some(false),
                    test_download: Some(true),
                    test_upload: Some(false),
                    simple_download: Some(true),
                    simple_download_addr: Some(
                        "https://speed.cloudflare.com/__down?bytes=1000000".to_owned(),
                    ),
                    timeout_ms: Some(20000),
                    only_country: Some(false),
                    country_concurrency: Some(5),
                    need_xray: Some(false),
                    xray_config: Some(String::new()),
                    xray_full_configs: Vec::new(),
                    xray_outbound_dns_strategy: Some(String::new()),
                };
                let tag = format!("proxy-{index}");
                let results = session.speed_test(&request).await;
                (tag, results)
            }));
        }

        let mut downloaded = 0;
        for task in tasks {
            let (tag, results) = task.await.expect("join worker");
            let results = results.expect("speed test call");
            let bytes = results.first().and_then(|result| result.dl_bytes).unwrap_or_default();
            let speed = results
                .first()
                .and_then(|result| result.dl_speed.clone())
                .unwrap_or_default();
            println!("{tag}: bytes={bytes} speed={speed}");
            if bytes > 0 {
                downloaded += 1;
            }
        }
        println!("8 parallel finished in {:?}", started.elapsed());
        assert_eq!(downloaded, 8, "every node should download concurrently");
    }
}

/// 定位 core 可执行文件：环境变量 → 应用目录 → 开发态 sidecar 目录。
#[allow(clippy::items_after_test_module)]
pub fn resolve_core_exe() -> Result<PathBuf> {
    let file_name = if cfg!(windows) { "verge-throne-core.exe" } else { "verge-throne-core" };

    if let Some(custom) = std::env::var_os("CLASH_VERGE_THRONE_CORE") {
        let path = PathBuf::from(custom);
        if path.is_file() {
            return Ok(path);
        }
        bail!("CLASH_VERGE_THRONE_CORE points to a missing file: {}", path.display());
    }

    let mut candidates = Vec::new();
    if let Ok(current) = std::env::current_exe()
        && let Some(dir) = current.parent()
    {
        candidates.push(dir.join(file_name));
    }
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        let sidecar = Path::new(manifest).join("sidecar");
        for suffix in ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"] {
            candidates.push(sidecar.join(format!("verge-throne-core-{suffix}.exe")));
        }
        for suffix in ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"] {
            candidates.push(sidecar.join(format!("verge-throne-core-{suffix}")));
        }
    }

    candidates
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .ok_or_else(|| {
            anyhow!(
                "verge-throne-core not found (build it with scripts/build-speedtest.mjs); tried: {}",
                candidates
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}
