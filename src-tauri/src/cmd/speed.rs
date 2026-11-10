use std::{
    sync::{Arc, atomic::AtomicBool, atomic::Ordering},
    time::{Duration, Instant},
};

use anyhow::Result;
use tauri::{AppHandle, Emitter as _};

use clash_verge_logging::{Type, logging};

use super::CmdResult;
use crate::{config::Config, core_ipc::CoreSession, core_ipc::proto, feat};

static RUNNING: AtomicBool = AtomicBool::new(false);

pub const SPEED_TEST_EVENT: &str = "speed-test://result";

/// 用 Throne core 的 `SpeedTest` RPC 对指定节点做真实下载测速，
/// 并把每条结果落盘 + 推送事件。
#[tauri::command]
pub async fn run_singbox_speed_test(
    app: AppHandle,
    group: String,
    names: Vec<String>,
    url: Option<String>,
    timeout_ms: Option<u32>,
) -> CmdResult<Vec<feat::SpeedTestRecord>> {
    logging!(
        info,
        Type::Cmd,
        "[SpeedTest] request group={} names={} url={:?} timeout={:?}",
        group,
        names.len(),
        url,
        timeout_ms
    );

    if RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        logging!(warn, Type::Cmd, "[SpeedTest] rejected: another test is still running");
        return Err("a speed test is already running".into());
    }

    let started = Instant::now();
    let result = run_inner(app, &group, &names, url.as_deref(), timeout_ms.unwrap_or(5000)).await;
    RUNNING.store(false, Ordering::SeqCst);

    match &result {
        Ok(records) => logging!(
            info,
            Type::Cmd,
            "[SpeedTest] completed records={} elapsed={}ms",
            records.len(),
            started.elapsed().as_millis()
        ),
        Err(err) => logging!(error, Type::Cmd, "[SpeedTest] failed: {err:#}"),
    }
    result.map_err(|err| err.to_string().into())
}

async fn run_inner(
    app: AppHandle,
    group: &str,
    names: &[String],
    url: Option<&str>,
    timeout_ms: u32,
) -> Result<Vec<feat::SpeedTestRecord>> {
    feat::clear_cancel_flag()?;

    // 显式传入的 url 优先；否则使用杂项设置里的「速度测试链接」；
    // 两者都为空时由 build_job 回退到 DEFAULT_TEST_URL。
    let (threads, effective_url) = {
        let verge = Config::verge().await.latest_arc();
        let threads = verge.speed_test_threads.unwrap_or(8).clamp(1, 8);
        let configured_url = verge
            .speed_test_url
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(std::string::String::from);
        let effective_url = url
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(std::string::String::from)
            .or(configured_url);
        (threads, effective_url)
    };

    let (job, unsupported) = feat::build_job(names, group, effective_url.as_deref(), timeout_ms, threads).await?;
    logging!(
        info,
        Type::Cmd,
        "[SpeedTest] job built group={} nodes={} unsupported={} url={} timeout={}ms threads={}",
        group,
        job.nodes.len(),
        unsupported.len(),
        job.url,
        job.timeout_ms,
        job.threads
    );

    let mut results = Vec::new();
    let mut failure: Option<String> = None;

    if job.nodes.is_empty() {
        logging!(warn, Type::Cmd, "[SpeedTest] no testable nodes, core not started");
    } else {
        let core_exe = crate::core_ipc::resolve_core_exe()?;
        let boot = Instant::now();
        let session = Arc::new(CoreSession::start(&core_exe).await?);
        logging!(
            info,
            Type::Cmd,
            "[SpeedTest] core ready in {}ms, testing {} nodes (threads={})",
            boot.elapsed().as_millis(),
            job.nodes.len(),
            job.threads
        );

        // 取消按钮依旧写标记文件；这里轮询到后让 core 的 StopTest 立刻中止下载。
        let cancel_path = feat::cancel_path()?;
        let cancel_watcher = {
            let session = Arc::clone(&session);
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    if cancel_path.exists() {
                        logging!(warn, Type::Cmd, "[SpeedTest] cancel flag detected, sending StopTest");
                        let _ = session.stop_test().await;
                        return;
                    }
                }
            })
        };

        let (sender, mut receiver) = tokio::sync::mpsc::channel::<feat::ProbeResult>(job.nodes.len().max(1));
        let semaphore = Arc::new(tokio::sync::Semaphore::new(job.threads as usize));
        let mut tasks = Vec::with_capacity(job.nodes.len());

        for node in &job.nodes {
            let permit = Arc::clone(&semaphore).acquire_owned().await?;
            let session = Arc::clone(&session);
            let sender = sender.clone();
            let name = node.name.clone();
            let request = build_request(&job, &node.tag)?;

            tasks.push(tokio::spawn(async move {
                // 拿到许可证再发请求，保证同时在跑的临时盒不超过 threads 个。
                let _permit = permit;
                let started = Instant::now();
                let outcome = session.speed_test(&request).await;
                let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
                let _ = sender.send(probe_from(outcome, &name, elapsed_ms)).await;
            }));
        }
        drop(sender);

        while let Some(probe) = receiver.recv().await {
            if !probe.error.is_empty() && probe.dl_bytes == 0 {
                failure = Some(format!("{}: {}", probe.name, probe.error));
            }
            let record = feat::record_from_probe(group, probe);
            logging!(
                info,
                Type::Cmd,
                "[SpeedTest] result name={} speed={} bytes={} latency={}ms error={}",
                record.name,
                record.dl_speed,
                record.dl_bytes,
                record.latency_ms,
                record.error
            );
            feat::save_result(record.clone())?;
            app.emit(SPEED_TEST_EVENT, &record)?;
            results.push(record);
        }

        for task in tasks {
            if let Err(err) = task.await {
                logging!(error, Type::Cmd, "[SpeedTest] worker panicked: {err}");
            }
        }
        cancel_watcher.abort();
    }

    // 无法转换为 sing-box outbound 的节点也给出明确结果。
    for (name, kind) in unsupported {
        logging!(warn, Type::Cmd, "[SpeedTest] unsupported node={} type={}", name, kind);
        let record = feat::unsupported_record(group, &name, &kind);
        feat::save_result(record.clone())?;
        app.emit(SPEED_TEST_EVENT, &record)?;
        results.push(record);
    }

    // 一条结果都没有时把真正的失败原因抛给前端，而不是静默返回空列表。
    let cancel_requested = feat::cancel_path().map(|path| path.exists()).unwrap_or(false);
    if results.is_empty() && !cancel_requested {
        let detail = failure.unwrap_or_else(|| "core produced no results (see logs/[SpeedTest])".into());
        anyhow::bail!("[SpeedTest] {detail}");
    }

    Ok(results)
}

/// 一个节点一次 `SpeedTest` 请求：配置裁剪到只剩该节点 + direct。
fn build_request(job: &feat::SpeedJob, tag: &str) -> Result<proto::SpeedTestRequest> {
    let config = feat::config_for_tag(&job.config, tag);
    let config = serde_json::to_string(&config)?;
    // proto2 的 optional 字段在 core 里是裸指针解引用（rpc/speedtest.go），
    // 该给值的字段一个都不能留空，否则 core 会 panic 而不是报参数错误。
    Ok(proto::SpeedTestRequest {
        config: Some(config),
        outbound_tags: vec![tag.to_owned()],
        test_current: Some(false),
        use_default_outbound: Some(false),
        test_download: Some(true),
        test_upload: Some(false),
        simple_download: Some(true),
        simple_download_addr: Some(job.url.clone()),
        timeout_ms: Some(i32::try_from(job.timeout_ms).unwrap_or(i32::MAX)),
        only_country: Some(false),
        country_concurrency: Some(5),
        need_xray: Some(false),
        xray_config: Some(String::new()),
        xray_full_configs: Vec::new(),
        xray_outbound_dns_strategy: Some(String::new()),
    })
}

fn probe_from(outcome: Result<Vec<proto::SpeedTestResult>>, name: &str, elapsed_ms: u64) -> feat::ProbeResult {
    let failed = |message: String| feat::ProbeResult {
        name: name.to_owned(),
        dl_speed: String::new(),
        bytes_per_second: 0.0,
        dl_bytes: 0,
        latency_ms: 0,
        error: message,
        cancelled: false,
    };

    let results = match outcome {
        Ok(results) => results,
        Err(err) => return failed(format!("{err:#}")),
    };
    let Some(result) = results.into_iter().next() else {
        return failed("core returned no result".into());
    };

    let dl_bytes = result.dl_bytes.unwrap_or_default();
    // 与 core 的 dl_speed 口径不同：这里按整次调用计时（含握手），
    // 便于前端排序；dl_speed 只覆盖响应体窗口。
    let bytes_per_second = if elapsed_ms > 0 {
        dl_bytes as f64 * 1000.0 / elapsed_ms as f64
    } else {
        0.0
    };

    feat::ProbeResult {
        name: name.to_owned(),
        dl_speed: result.dl_speed.unwrap_or_default(),
        bytes_per_second,
        dl_bytes,
        latency_ms: result.latency.unwrap_or_default(),
        error: result.error.unwrap_or_default(),
        cancelled: result.cancelled.unwrap_or(false),
    }
}

/// 读取持久化的历史测速结果。
#[tauri::command]
pub fn get_speed_test_results() -> CmdResult<Vec<feat::SpeedTestRecord>> {
    logging!(info, Type::Cmd, "[SpeedTest] loading persisted results");
    feat::load_results().map_err(|err| err.to_string().into())
}

/// 请求中止当前测速（标记文件 → 本轮测速发送 StopTest）。
#[tauri::command]
pub fn cancel_speed_test() -> CmdResult {
    logging!(info, Type::Cmd, "[SpeedTest] cancel requested");
    feat::set_cancel_flag().map_err(|err| err.to_string().into())
}
