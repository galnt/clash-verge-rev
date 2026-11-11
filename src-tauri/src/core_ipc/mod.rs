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
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicU32, Ordering},
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
    /// 读循环结束（连接断开）后置位，用于判定这个会话还能不能复用。
    closed: AtomicBool,
}

/// 一个 core 子进程 + 一条 IPC 连接。
/// 默认 Drop 会关掉管道并结束子进程；用户退出时置 `detached`，让 core 转入后台常驻。
pub struct CoreSession {
    shared: Arc<Shared>,
    child: Child,
    reader_task: tokio::task::JoinHandle<()>,
    log_tasks: Vec<tokio::task::JoinHandle<()>>,
    detached: AtomicBool,
}

impl CoreSession {
    /// 清理上一次 GUI 遗留的常驻 core → 建管道 → 启动 core → 等它连上来。
    pub async fn start(core_exe: &Path) -> Result<Self> {
        // GUI 重启/Clash 重启时，先结束掉留在后台的旧 core，保证全局只有一个实例。
        cleanup_stale_resident_core().await;

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
        write_resident_pid(pid);
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
            closed: AtomicBool::new(false),
        });
        let reader_task = tokio::spawn(read_loop(reader, Arc::clone(&shared)));
        let log_tasks = pump_child_output(&mut child);

        Ok(Self {
            shared,
            child,
            reader_task,
            log_tasks,
            detached: AtomicBool::new(false),
        })
    }

    /// `SpeedTest`：core 会用请求里的 config 建一个临时盒，按 tag 拨号测速。
    pub async fn speed_test(&self, request: &proto::SpeedTestRequest) -> Result<Vec<proto::SpeedTestResult>> {
        let data = self.call("SpeedTest", &request.encode_to_vec()).await?;
        let response = proto::SpeedTestResponse::decode(&data[..]).context("decode SpeedTestResponse failed")?;
        Ok(response.results)
    }

    /// `StopTest`：取消所有正在进行的测速（core 侧 probe.CancelTests）。
    pub async fn stop_test(&self) -> Result<()> {
        self.call("StopTest", &proto::EmptyReq {}.encode_to_vec()).await?;
        Ok(())
    }

    /// `UserExit`：GUI 退出前通知 core「用户已退出」，core 收到后不再随父进程/
    /// IPC 连接断开而自杀，转入后台常驻。旧版 core 没有这个 method，失败也不阻塞退出。
    pub async fn notify_user_exit(&self) {
        let outcome = tokio::time::timeout(
            Duration::from_secs(3),
            self.call("UserExit", &proto::EmptyReq {}.encode_to_vec()),
        )
        .await;
        match outcome {
            Ok(Ok(_)) => logging!(info, Type::Core, "[CoreIPC] user exit notified"),
            Ok(Err(err)) => logging!(warn, Type::Core, "[CoreIPC] user exit notification failed: {err}"),
            Err(_) => logging!(warn, Type::Core, "[CoreIPC] user exit notification timed out"),
        }
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

    /// 连接是否仍然可用：core 退出或管道断开后为 false，需要重新拉起。
    pub fn is_alive(&self) -> bool {
        !self.shared.closed.load(Ordering::SeqCst)
    }
}

/// 常驻 core：应用启动时拉起一次，之后整个生命周期复用同一个子进程。
static SHARED_SESSION: OnceLock<Mutex<Option<Arc<CoreSession>>>> = OnceLock::new();

fn shared_slot() -> &'static Mutex<Option<Arc<CoreSession>>> {
    SHARED_SESSION.get_or_init(|| Mutex::new(None))
}

/// 取得常驻会话：没有或已断开就重新拉起，并发调用只会拉起一次。
pub async fn shared_session() -> Result<Arc<CoreSession>> {
    let mut slot = shared_slot().lock().await;

    // 复用仍然存活的会话
    if let Some(session) = slot.as_ref().filter(|session| session.is_alive()) {
        return Ok(Arc::clone(session));
    }

    if slot.is_some() {
        logging!(warn, Type::Core, "[CoreIPC] resident core is gone, restarting");
        // 丢掉旧会话：其 Drop 会关掉管道并杀掉残留子进程。
        let _ = slot.take();
    }

    let core_exe = resolve_core_exe()?;
    let session = Arc::new(CoreSession::start(&core_exe).await?);
    *slot = Some(Arc::clone(&session));
    Ok(session)
}

/// 后台预热：应用启动时调用，让 core 常驻，测速时无需再等它启动。
pub fn warm_up() {
    let _ = tauri::async_runtime::spawn(async {
        match shared_session().await {
            Ok(_) => logging!(info, Type::Core, "[CoreIPC] resident core ready"),
            Err(err) => {
                logging!(warn, Type::Core, "[CoreIPC] resident core unavailable: {}", err)
            }
        }
    });
}

/// 退出流程：通知 core「用户退出」，然后只断开 IPC，把 core 留在后台常驻。
/// feat::quit 与 RunEvent::Exit 都可能调用，第二次会话已被取走，是幂等的。
pub async fn notify_user_exit_and_detach() {
    let mut slot = shared_slot().lock().await;
    let Some(session) = slot.take() else {
        return;
    };
    drop(slot);

    session.notify_user_exit().await;
    // Drop 时不再 kill 子进程：管道随 GUI 退出而关闭，core 会继续跑后台任务。
    session.detached.store(true, Ordering::SeqCst);
    logging!(info, Type::Core, "[CoreIPC] GUI 退出，core 转入后台常驻");
}

/// Clash 内核重启时调用：结束当前常驻 core，并重新拉起一个。
pub async fn restart_resident_core() -> Result<Arc<CoreSession>> {
    {
        let mut slot = shared_slot().lock().await;
        // 旧会话 drop 时会 kill 掉自己的子进程。
        let old = slot.take();
        drop(old);
    }

    let core_exe = resolve_core_exe()?;
    let session = Arc::new(CoreSession::start(&core_exe).await?);
    let mut slot = shared_slot().lock().await;
    *slot = Some(Arc::clone(&session));
    Ok(session)
}

impl Drop for CoreSession {
    fn drop(&mut self) {
        self.reader_task.abort();
        for task in &self.log_tasks {
            task.abort();
        }
        if self.detached.load(Ordering::SeqCst) {
            // 用户已退出：只断开连接，core 保留在后台继续运行。
            return;
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
    shared.closed.store(true, Ordering::SeqCst);
    shared.pending.lock().await.clear();
    logging!(warn, Type::Core, "[CoreIPC] core connection closed");
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CORE_EXE_NAME: &str = "verge-throne-core.exe";
/// GUI 退出后 core 仍在后台，下次启动靠这个 PID 文件找到并结束旧进程。
const RESIDENT_PID_FILE: &str = "clash-verge-throne-core.pid";

fn resident_pid_path() -> PathBuf {
    std::env::temp_dir().join(RESIDENT_PID_FILE)
}

fn write_resident_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    if let Err(err) = std::fs::write(resident_pid_path(), pid.to_string()) {
        logging!(warn, Type::Core, "[CoreIPC] write resident core pid failed: {err}");
    }
}

#[cfg(windows)]
async fn resident_core_alive(pid: u32) -> bool {
    let filter = format!("PID eq {pid}");
    match Command::new("tasklist")
        .args(["/FI", filter.as_str(), "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
    {
        Ok(output) => String::from_utf8_lossy(&output.stdout)
            .to_ascii_lowercase()
            .contains(CORE_EXE_NAME),
        Err(err) => {
            logging!(warn, Type::Core, "[CoreIPC] tasklist failed: {err}");
            false
        }
    }
}

#[cfg(windows)]
async fn kill_resident_core(pid: u32) {
    let pid = pid.to_string();
    if let Err(err) = Command::new("taskkill")
        .args(["/PID", pid.as_str(), "/F", "/T"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
    {
        logging!(warn, Type::Core, "[CoreIPC] taskkill {pid} failed: {err}");
    }
}

#[cfg(unix)]
async fn resident_core_alive(pid: u32) -> bool {
    let pid = pid.to_string();
    Command::new("kill")
        .args(["-0", pid.as_str()])
        .output()
        .await
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
async fn kill_resident_core(pid: u32) {
    let pid = pid.to_string();
    let _ = Command::new("kill").args(["-9", pid.as_str()]).output().await;
}

/// 结束上一次 GUI 遗留的常驻 core（只针对确实还在跑的同名进程）。
async fn cleanup_stale_resident_core() {
    let path = resident_pid_path();
    let Some(pid) = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok())
    else {
        return;
    };
    let _ = std::fs::remove_file(&path);
    if pid == 0 || pid == std::process::id() || !resident_core_alive(pid).await {
        return;
    }

    logging!(
        info,
        Type::Core,
        "[CoreIPC] terminating leftover resident core pid={pid}"
    );
    kill_resident_core(pid).await;
    // 给旧进程一点时间退出，避免新 core 与它抢占资源。
    tokio::time::sleep(Duration::from_millis(200)).await;
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
        assert!(
            result.dl_bytes.unwrap_or_default() > 0,
            "should download bytes: {result:?}"
        );
        assert!(
            !result.dl_speed.clone().unwrap_or_default().is_empty(),
            "speed string: {result:?}"
        );
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
                    simple_download_addr: Some("https://speed.cloudflare.com/__down?bytes=1000000".to_owned()),
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
    let file_name = if cfg!(windows) {
        "verge-throne-core.exe"
    } else {
        "verge-throne-core"
    };

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
        for suffix in [
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
            "x86_64-unknown-linux-gnu",
            "aarch64-unknown-linux-gnu",
        ] {
            candidates.push(sidecar.join(format!("verge-throne-core-{suffix}")));
        }
    }

    candidates.iter().find(|path| path.is_file()).cloned().ok_or_else(|| {
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
