use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue, json};
use serde_yaml_ng::{Mapping, Value as YamlValue};

use crate::{config::Config, utils::dirs};

pub const DEFAULT_TEST_URL: &str = "http://cachefly.cachefly.net/5mb.test";
pub const CANCEL_FILE: &str = "speed-test-cancel.flag";
const RESULT_FILE: &str = "speed-test-results.json";

/// 一条测速结果，同时用于持久化与前端事件推送。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedTestRecord {
    pub group: String,
    pub name: String,
    pub dl_speed: String,
    pub bytes_per_second: f64,
    pub dl_bytes: i64,
    pub latency_ms: i32,
    pub error: String,
    pub updated_at: i64,
}

/// Go CLI 每行 JSONL 的输出格式（字段为 snake_case）。
#[derive(Debug, Deserialize)]
pub struct ProbeResult {
    pub name: String,
    pub dl_speed: String,
    pub bytes_per_second: f64,
    pub dl_bytes: i64,
    pub latency_ms: i32,
    pub error: String,
    pub cancelled: bool,
}

#[derive(Debug, Serialize)]
pub struct SpeedJobNode {
    pub tag: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct SpeedJob {
    pub config: JsonValue,
    pub nodes: Vec<SpeedJobNode>,
    pub url: String,
    pub timeout_ms: u32,
    pub threads: u8,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ResultFile {
    #[serde(default)]
    results: Vec<SpeedTestRecord>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn result_path() -> Result<PathBuf> {
    Ok(dirs::app_home_dir()?.join(RESULT_FILE))
}

pub fn cancel_path() -> Result<PathBuf> {
    Ok(dirs::app_home_dir()?.join(CANCEL_FILE))
}

pub fn clear_cancel_flag() -> Result<()> {
    let path = cancel_path()?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub fn set_cancel_flag() -> Result<()> {
    fs::write(cancel_path()?, b"cancel")?;
    Ok(())
}

pub fn load_results() -> Result<Vec<SpeedTestRecord>> {
    let path = result_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path)?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    let file: ResultFile = serde_json::from_str(&content).unwrap_or_default();
    // 兼容旧版本按 (group, name) 写入的重复记录：同名节点只保留最后一条。
    let mut results: Vec<SpeedTestRecord> = Vec::new();
    for record in file.results {
        results.retain(|r| r.name != record.name);
        results.push(record);
    }
    Ok(results)
}

/// 结果按节点名覆盖写入：同一节点会出现在多个分组中，速度全局共享。
pub fn save_result(record: SpeedTestRecord) -> Result<()> {
    let mut results = load_results()?;
    results.retain(|r| r.name != record.name);
    results.push(record);
    let path = result_path()?;
    fs::write(path, serde_json::to_vec_pretty(&ResultFile { results })?)?;
    Ok(())
}

pub fn record_from_probe(group: &str, probe: ProbeResult) -> SpeedTestRecord {
    // simpleDownloadTest 以 http.Client.Timeout 作为测速窗口，超时时会同时
    // 返回已下载字节和一个 deadline 错误；只要拿到数据就算有效结果。
    let has_data = !probe.cancelled && probe.dl_bytes > 0 && probe.bytes_per_second > 0.0;
    let fatal_error = if has_data {
        String::new()
    } else if !probe.error.is_empty() {
        probe.error.clone()
    } else if probe.cancelled {
        "cancelled".into()
    } else {
        "no data received".into()
    };

    SpeedTestRecord {
        group: group.to_owned(),
        name: probe.name,
        dl_speed: if has_data { probe.dl_speed } else { String::new() },
        bytes_per_second: if has_data { probe.bytes_per_second.max(0.0) } else { 0.0 },
        dl_bytes: probe.dl_bytes,
        latency_ms: probe.latency_ms,
        error: fatal_error,
        updated_at: now_ms(),
    }
}

pub fn unsupported_record(group: &str, name: &str, kind: &str) -> SpeedTestRecord {
    SpeedTestRecord {
        group: group.to_owned(),
        name: name.to_owned(),
        dl_speed: String::new(),
        bytes_per_second: 0.0,
        dl_bytes: 0,
        latency_ms: 0,
        error: format!("unsupported proxy type: {kind}"),
        updated_at: now_ms(),
    }
}

// ---------------------------------------------------------------------------
// Clash YAML proxies -> sing-box outbounds
//
// 字段映射参考 Throne 的 BuildTestConfig / ParseFromClash：把运行配置里的
// proxies 段逐条转成 sing-box 的 outbound，交给独立 sing-box 实例直接拨号。
// ---------------------------------------------------------------------------

fn get<'a>(m: &'a Mapping, key: &str) -> Option<&'a YamlValue> {
    m.get(YamlValue::String(key.to_owned()))
}

fn get_str(m: &Mapping, key: &str) -> Option<String> {
    match get(m, key)? {
        YamlValue::String(s) => Some(s.clone()),
        YamlValue::Number(n) => Some(n.to_string()),
        YamlValue::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn get_u16(m: &Mapping, key: &str) -> Option<u16> {
    match get(m, key)? {
        YamlValue::Number(n) => n.as_u64().and_then(|v| u16::try_from(v).ok()),
        YamlValue::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn get_bool(m: &Mapping, key: &str) -> Option<bool> {
    get(m, key)?.as_bool()
}

/// clash 的 up/down 既可能是数字，也可能是 "50 Mbps" 这样的字符串。
fn get_mbps(m: &Mapping, key: &str) -> Option<u64> {
    match get(m, key)? {
        YamlValue::Number(n) => n.as_u64(),
        YamlValue::String(s) => {
            let digits: String = s.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse().ok()
        }
        _ => None,
    }
}

fn y2j(v: &YamlValue) -> JsonValue {
    match v {
        YamlValue::Null => JsonValue::Null,
        YamlValue::Bool(b) => json!(b),
        YamlValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                json!(i)
            } else if let Some(u) = n.as_u64() {
                json!(u)
            } else {
                json!(n.as_f64().unwrap_or_default())
            }
        }
        YamlValue::String(s) => json!(s),
        YamlValue::Sequence(seq) => JsonValue::Array(seq.iter().map(y2j).collect()),
        YamlValue::Mapping(m) => {
            let mut obj = JsonMap::new();
            for (k, val) in m {
                if let Some(key) = k.as_str() {
                    obj.insert(key.to_owned(), y2j(val));
                }
            }
            JsonValue::Object(obj)
        }
        _ => JsonValue::Null,
    }
}

fn insert_opt_str(o: &mut JsonMap<String, JsonValue>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        o.insert(key.to_owned(), json!(value));
    }
}

fn tls_json(m: &Mapping, force: bool) -> Option<JsonValue> {
    let reality = get(m, "reality-opts").and_then(|v| v.as_mapping());
    let enabled =
        force || get_bool(m, "tls").unwrap_or(false) || reality.is_some() || get(m, "client-fingerprint").is_some();
    if !enabled {
        return None;
    }

    let mut tls = JsonMap::new();
    tls.insert("enabled".into(), json!(true));
    // 与 Throne 的 TLS::ParseFromClash 一致：servername > sni > server。
    insert_opt_str(
        &mut tls,
        "server_name",
        get_str(m, "servername").or_else(|| get_str(m, "sni")),
    );
    if let Some(alpn) = get(m, "alpn") {
        let value = y2j(alpn);
        tls.insert("alpn".into(), if value.is_array() { value } else { json!([value]) });
    }
    if let Some(insecure) = get_bool(m, "skip-cert-verify") {
        tls.insert("insecure".into(), json!(insecure));
    }
    // sing-box only accepts the uTLS fingerprint inside `utls`; there is no
    // `tls.fingerprint` field (it makes the config decode fail). mihomo 的
    // `none` 表示关闭 uTLS，sing-box 没有这个指纹名，照抄会让节点直接不可用。
    if let Some(fp) = get_str(m, "client-fingerprint") {
        let fp = fp.trim().to_lowercase();
        if !fp.is_empty() && fp != "none" {
            tls.insert("utls".into(), json!({ "enabled": true, "fingerprint": fp }));
        }
    }
    if let Some(r) = reality {
        let mut reality_obj = JsonMap::new();
        reality_obj.insert("enabled".into(), json!(true));
        insert_opt_str(&mut reality_obj, "public_key", get_str(r, "public-key"));
        insert_opt_str(&mut reality_obj, "short_id", get_str(r, "short-id"));
        // sing-box 的 REALITY 必须走 uTLS，缺省指纹与 Throne 一致用 chrome；
        // 没有它建盒会直接报 "uTLS is required by REALITY"。
        if !tls.contains_key("utls") {
            tls.insert("utls".into(), json!({ "enabled": true, "fingerprint": "chrome" }));
        }
        tls.insert("reality".into(), JsonValue::Object(reality_obj));
    }
    Some(JsonValue::Object(tls))
}

/// 取字符串或数组首项（clash 里同一个字段既可能是标量也可能是列表）。
fn listable_str(v: &YamlValue) -> Option<String> {
    match v {
        YamlValue::String(s) => Some(s.clone()),
        YamlValue::Number(n) => Some(n.to_string()),
        YamlValue::Sequence(seq) => seq.first().and_then(listable_str),
        _ => None,
    }
}

fn transport_json(m: &Mapping) -> Option<JsonValue> {
    let network = get_str(m, "network").unwrap_or_default();
    let ws_opts = get(m, "ws-opts").and_then(|v| v.as_mapping());
    let ws_path = ws_opts.and_then(|o| get_str(o, "path")).unwrap_or_default();
    // Throne 的 Transport::ParseFromClash 只要有 ws-opts.path 就按 ws 处理，
    // 不强制要求 network 字段。
    let is_ws = network == "ws" || (network.is_empty() && (ws_opts.is_some() || !ws_path.is_empty()));

    if is_ws {
        // mihomo 用 ws-opts.v2ray-http-upgrade 表达 httpupgrade。
        let http_upgrade = ws_opts.and_then(|o| get_bool(o, "v2ray-http-upgrade")).unwrap_or(false);
        let mut t = JsonMap::new();
        if http_upgrade {
            t.insert("type".into(), json!("httpupgrade"));
            if let Some(opts) = ws_opts {
                insert_opt_str(&mut t, "path", get_str(opts, "path"));
                let host = get(opts, "headers")
                    .and_then(|h| h.as_mapping())
                    .and_then(|h| get_str(h, "Host"));
                insert_opt_str(&mut t, "host", host);
            }
        } else {
            t.insert("type".into(), json!("ws"));
            if let Some(opts) = ws_opts {
                insert_opt_str(&mut t, "path", get_str(opts, "path"));
                if let Some(headers) = get(opts, "headers") {
                    t.insert("headers".into(), y2j(headers));
                }
                if let Some(n) = get(opts, "max-early-data").and_then(|v| v.as_u64()) {
                    t.insert("max_early_data".into(), json!(n));
                }
                insert_opt_str(
                    &mut t,
                    "early_data_header_name",
                    get_str(opts, "early-data-header-name"),
                );
            }
        }
        return Some(JsonValue::Object(t));
    }

    if network == "grpc"
        || get(m, "grpc-opts")
            .and_then(|v| v.as_mapping())
            .and_then(|o| get_str(o, "grpc-service-name"))
            .is_some()
    {
        let mut t = JsonMap::new();
        t.insert("type".into(), json!("grpc"));
        if let Some(opts) = get(m, "grpc-opts").and_then(|v| v.as_mapping()) {
            insert_opt_str(&mut t, "service_name", get_str(opts, "grpc-service-name"));
        }
        return Some(JsonValue::Object(t));
    }

    if network == "h2" || network == "http" {
        let opts = get(m, "h2-opts")
            .or_else(|| get(m, "http-opts"))
            .and_then(|v| v.as_mapping());
        let mut t = JsonMap::new();
        t.insert("type".into(), json!("http"));
        if let Some(opts) = opts {
            // `path` 在 h2-opts 是字符串、http-opts 是数组，sing-box 只收字符串。
            if let Some(path) = get(opts, "path").and_then(listable_str) {
                t.insert("path".into(), json!(path));
            }
            // host 在 h2-opts 是列表、http-opts 里则放在 headers.Host。
            let host = get(opts, "host").and_then(listable_str).or_else(|| {
                get(opts, "headers")
                    .and_then(|h| h.as_mapping())
                    .and_then(|h| get_str(h, "Host"))
            });
            if let Some(host) = host {
                t.insert("host".into(), json!([host]));
            }
            insert_opt_str(&mut t, "method", get_str(opts, "method"));
        }
        return Some(JsonValue::Object(t));
    }

    None
}

enum SsPlugin {
    None,
    Supported(String, Option<String>),
    Unsupported,
}

/// shadowsocks 插件：sing-box 只内置 obfs-local / v2ray-plugin，其余插件会让
/// 整份测速配置解码失败，因此判为不支持。
fn ss_plugin(m: &Mapping) -> SsPlugin {
    let Some(plugin) = get_str(m, "plugin") else {
        return SsPlugin::None;
    };
    let opts = get(m, "plugin-opts").and_then(|v| v.as_mapping());
    match plugin.trim() {
        "obfs" => {
            let mut parts = Vec::new();
            if let Some(mode) = opts.and_then(|o| get_str(o, "mode")) {
                parts.push(format!("obfs={mode}"));
            }
            if let Some(host) = opts.and_then(|o| get_str(o, "host")) {
                parts.push(format!("obfs-host={host}"));
            }
            SsPlugin::Supported("obfs-local".into(), (!parts.is_empty()).then(|| parts.join(";")))
        }
        // v2ray-plugin 的参数是位置式 flag，顺序与 Throne 保持一致。
        "v2ray-plugin" => {
            let mut parts = Vec::new();
            if opts.and_then(|o| get_bool(o, "tls")).unwrap_or(false) {
                parts.push("tls".to_string());
            }
            if let Some(host) = opts.and_then(|o| get_str(o, "host")) {
                parts.push(format!("host={host}"));
            }
            if let Some(path) = opts.and_then(|o| get_str(o, "path")) {
                parts.push(format!("path={path}"));
            }
            if let Some(mode) = opts.and_then(|o| get_str(o, "mode")) {
                parts.push(format!("mode={mode}"));
            }
            if opts.and_then(|o| get_bool(o, "mux")).unwrap_or(false) {
                parts.push("mux".to_string());
            }
            SsPlugin::Supported("v2ray-plugin".into(), (!parts.is_empty()).then(|| parts.join(";")))
        }
        _ => SsPlugin::Unsupported,
    }
}

/// sing-box 的 shadowsocks method 是枚举，个别 mihomo 写法需要等价改写。
fn ss_method(name: &str) -> Option<String> {
    const METHODS: [&str; 18] = [
        "none",
        "aes-128-gcm",
        "aes-192-gcm",
        "aes-256-gcm",
        "chacha20-ietf-poly1305",
        "xchacha20-ietf-poly1305",
        "2022-blake3-aes-128-gcm",
        "2022-blake3-aes-256-gcm",
        "2022-blake3-chacha20-poly1305",
        "aes-128-ctr",
        "aes-192-ctr",
        "aes-256-ctr",
        "aes-128-cfb",
        "aes-192-cfb",
        "aes-256-cfb",
        "rc4-md5",
        "chacha20-ietf",
        "xchacha20",
    ];
    let method = match name.trim().to_lowercase().as_str() {
        "chacha20-poly1305" => "chacha20-ietf-poly1305".to_string(),
        "dummy" => "none".to_string(),
        other => other.to_string(),
    };
    METHODS.contains(&method.as_str()).then_some(method)
}

fn clash_to_outbound(m: &Mapping, tag: &str) -> Option<JsonValue> {
    let kind = get_str(m, "type")?.to_lowercase();
    let server = get_str(m, "server")?;
    let port = get_u16(m, "port")?;
    if port == 0 {
        return None;
    }

    let mut o = JsonMap::new();
    o.insert("tag".into(), json!(tag));
    o.insert("server".into(), json!(server));
    o.insert("server_port".into(), json!(port));

    let outbound_type = match kind.as_str() {
        "ss" => {
            let cipher = get_str(m, "cipher").unwrap_or_else(|| "aes-128-gcm".into());
            o.insert("method".into(), json!(ss_method(&cipher)?));
            insert_opt_str(&mut o, "password", get_str(m, "password"));
            match ss_plugin(m) {
                SsPlugin::None => {}
                SsPlugin::Supported(name, opts) => {
                    o.insert("plugin".into(), json!(name));
                    insert_opt_str(&mut o, "plugin_opts", opts);
                }
                SsPlugin::Unsupported => return None,
            }
            if let Some(v) = get_bool(m, "udp-over-tcp") {
                o.insert("udp_over_tcp".into(), json!(v));
            }
            "shadowsocks"
        }
        "vmess" => {
            insert_opt_str(&mut o, "uuid", get_str(m, "uuid"));
            insert_opt_str(&mut o, "security", get_str(m, "cipher"));
            if let Some(n) = get(m, "alterId").and_then(|v| v.as_i64()) {
                o.insert("alter_id".into(), json!(n));
            }
            // 空字符串会被 sing-box 拒绝；mihomo 新版用 packet-encoding，
            // 老写法是 xudp 开关。
            if let Some(enc) = get_str(m, "packet-encoding").filter(|s| !s.is_empty()) {
                o.insert("packet_encoding".into(), json!(enc));
            } else if get_bool(m, "xudp").unwrap_or(false) {
                o.insert("packet_encoding".into(), json!("xudp"));
            }
            "vmess"
        }
        "vless" => {
            // xhttp 只有 Xray 内核支持，sing-box 侧没有对应 transport。
            if get_str(m, "network").as_deref() == Some("xhttp") {
                return None;
            }
            insert_opt_str(&mut o, "uuid", get_str(m, "uuid"));
            insert_opt_str(&mut o, "flow", get_str(m, "flow"));
            if let Some(enc) = get_str(m, "packet-encoding").filter(|s| !s.is_empty()) {
                o.insert("packet_encoding".into(), json!(enc));
            }
            "vless"
        }
        "trojan" => {
            insert_opt_str(&mut o, "password", get_str(m, "password"));
            "trojan"
        }
        "hysteria" => {
            apply_hysteria_v1(m, &mut o);
            "hysteria"
        }
        "hysteria2" | "hy2" => {
            insert_opt_str(&mut o, "password", get_str(m, "password"));
            apply_mbps(m, &mut o);
            if let Some(obfs) = hysteria2_obfs(m) {
                o.insert("obfs".into(), obfs);
            }
            "hysteria2"
        }
        "ssh" => {
            apply_ssh(m, &mut o);
            "ssh"
        }
        "tuic" => {
            insert_opt_str(&mut o, "uuid", get_str(m, "uuid"));
            insert_opt_str(&mut o, "password", get_str(m, "password"));
            insert_opt_str(&mut o, "congestion_control", get_str(m, "congestion-controller"));
            insert_opt_str(&mut o, "udp_relay_mode", get_str(m, "udp-relay-mode"));
            if let Some(v) = get_bool(m, "reduce-rtt") {
                o.insert("zero_rtt_handshake".into(), json!(v));
            }
            "tuic"
        }
        "socks5" => {
            insert_opt_str(&mut o, "username", get_str(m, "username"));
            insert_opt_str(&mut o, "password", get_str(m, "password"));
            "socks"
        }
        "http" => {
            insert_opt_str(&mut o, "username", get_str(m, "username"));
            insert_opt_str(&mut o, "password", get_str(m, "password"));
            "http"
        }
        "snell" => {
            insert_opt_str(&mut o, "psk", get_str(m, "psk"));
            if let Some(v) = get(m, "version").and_then(|v| v.as_u64()) {
                o.insert("version".into(), json!(v));
            }
            "snell"
        }
        "anytls" => {
            insert_opt_str(&mut o, "password", get_str(m, "password"));
            "anytls"
        }
        _ => return None,
    };
    o.insert("type".into(), json!(outbound_type));

    // 这些协议在 clash 侧即便没写 tls 也一定走 TLS（Throne 同样强制打开）。
    let force_tls = matches!(
        kind.as_str(),
        "trojan" | "hysteria" | "hysteria2" | "hy2" | "tuic" | "anytls"
    );
    if let Some(tls) = tls_json(m, force_tls) {
        o.insert("tls".into(), tls);
    }
    if let Some(transport) = transport_json(m) {
        o.insert("transport".into(), transport);
    }

    Some(JsonValue::Object(o))
}

/// up/down 带宽（clash 里可能是 "50 Mbps" 这类字符串）。
fn apply_mbps(m: &Mapping, o: &mut JsonMap<String, JsonValue>) {
    if let Some(value) = get_mbps(m, "up") {
        o.insert("up_mbps".into(), json!(value));
    }
    if let Some(value) = get_mbps(m, "down") {
        o.insert("down_mbps".into(), json!(value));
    }
}

/// hysteria v1 的私有字段；口令在不同面板里是 auth-str / auth_str / auth-string。
fn apply_hysteria_v1(m: &Mapping, o: &mut JsonMap<String, JsonValue>) {
    insert_opt_str(
        o,
        "auth_str",
        get_str(m, "auth-str")
            .or_else(|| get_str(m, "auth_str"))
            .or_else(|| get_str(m, "auth-string")),
    );
    apply_mbps(m, o);
    if let Some(obfs) = get_str(m, "obfs").filter(|s| !s.is_empty()) {
        o.insert("obfs".into(), json!(obfs));
    }
    if let Some(value) = get(m, "recv-window").and_then(|v| v.as_u64()) {
        o.insert("recv_window".into(), json!(value));
    }
    if let Some(value) = get(m, "recv-window-conn").and_then(|v| v.as_u64()) {
        o.insert("recv_window_conn".into(), json!(value));
    }
    if let Some(value) = get_bool(m, "disable-mtu-discovery") {
        o.insert("disable_mtu_discovery".into(), json!(value));
    }
}

/// hysteria2 的 salamander 混淆：缺类型或缺口令都无法握手，因此两者齐了才下发。
fn hysteria2_obfs(m: &Mapping) -> Option<JsonValue> {
    // mihomo 用 `obfs`（类型）+ `obfs-password`（口令），obfs-opts 只是部分面板的写法。
    let opts = get(m, "obfs-opts").and_then(|v| v.as_mapping());
    let kind = get_str(m, "obfs")
        .filter(|value| !value.is_empty())
        .or_else(|| opts.and_then(|o| get_str(o, "type")))?;
    let password = get_str(m, "obfs-password").or_else(|| opts.and_then(|o| get_str(o, "password")))?;
    Some(json!({ "type": kind, "password": password }))
}

fn apply_ssh(m: &Mapping, o: &mut JsonMap<String, JsonValue>) {
    insert_opt_str(o, "user", get_str(m, "username"));
    insert_opt_str(o, "password", get_str(m, "password"));
    insert_opt_str(o, "private_key", get_str(m, "private-key"));
    insert_opt_str(o, "private_key_passphrase", get_str(m, "private-key-passphrase"));
    insert_opt_str(o, "host_key", get(m, "host-key").and_then(listable_str));
    if let Some(algorithms) = get(m, "host-key-algorithms") {
        let value = y2j(algorithms);
        o.insert(
            "host_key_algorithms".into(),
            if value.is_array() { value } else { json!([value]) },
        );
    }
}

/// 从运行配置读取完整节点参数，生成独立 sing-box 测速配置。
/// 返回任务内容以及无法转换的节点名。
pub async fn build_job(
    names: &[String],
    group: &str,
    url: Option<&str>,
    timeout_ms: u32,
    threads: u8,
) -> Result<(SpeedJob, Vec<(String, String)>)> {
    let runtime = Config::runtime().await.latest_arc();
    let config = runtime
        .config
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("runtime config is not loaded"))?;
    let mut proxy_values: Vec<YamlValue> = config
        .get(YamlValue::String("proxies".into()))
        .and_then(|v| v.as_sequence())
        .cloned()
        .unwrap_or_default();

    // proxy-providers 的节点定义在外部 YAML 文件里，也要纳入转换。
    if let Some(providers) = config
        .get(YamlValue::String("proxy-providers".into()))
        .and_then(|v| v.as_mapping())
    {
        let home = dirs::app_home_dir()?;
        for (_, provider) in providers {
            let Some(pm) = provider.as_mapping() else {
                continue;
            };
            let Some(raw_path) = get_str(pm, "path") else {
                continue;
            };
            let path = PathBuf::from(&raw_path);
            let full = if path.is_absolute() { path } else { home.join(path) };
            let Ok(content) = fs::read_to_string(&full) else {
                continue;
            };
            let Ok(value) = serde_yaml_ng::from_str::<YamlValue>(&content) else {
                continue;
            };
            if let Some(seq) = value
                .as_mapping()
                .and_then(|m| m.get(YamlValue::String("proxies".into())))
                .and_then(|v| v.as_sequence())
            {
                proxy_values.extend(seq.iter().cloned());
            }
        }
    }

    if proxy_values.is_empty() {
        anyhow::bail!("no proxies found in runtime config or proxy providers");
    }

    let wanted: Vec<String> = if names.is_empty() {
        // The frontend may not have rendered this group's cards (collapsed group
        // or virtualized list), so expand the group's real nodes from runtime config.
        config
            .get(YamlValue::String("proxy-groups".into()))
            .and_then(|v| v.as_sequence())
            .and_then(|groups| {
                groups.iter().find(|g| {
                    g.as_mapping()
                        .and_then(|m| get_str(m, "name"))
                        .is_some_and(|n| n == group)
                })
            })
            .and_then(|g| g.as_mapping())
            .and_then(|m| m.get(YamlValue::String("proxies".into())))
            .and_then(|v| v.as_sequence())
            .map(|seq| {
                seq.iter()
                    .filter_map(|v| v.as_str())
                    .filter(|name| {
                        proxy_values.iter().any(|p| {
                            p.as_mapping()
                                .and_then(|m| get_str(m, "name"))
                                .is_some_and(|n| n == *name)
                        })
                    })
                    .map(|s| s.to_owned())
                    .collect()
            })
            .unwrap_or_default()
    } else {
        names.iter().map(|s| s.to_string()).collect()
    };

    if wanted.is_empty() {
        anyhow::bail!("no testable proxies found (is the kernel running with a profile loaded?)");
    }
    let mut outbounds = Vec::new();
    let mut nodes = Vec::new();
    let mut unsupported = Vec::new();

    for (index, name) in wanted.iter().enumerate() {
        let proxy = proxy_values.iter().find(|p| {
            p.as_mapping()
                .and_then(|m| get_str(m, "name"))
                .is_some_and(|n| &n == name)
        });

        let Some(proxy) = proxy.and_then(|p| p.as_mapping()) else {
            unsupported.push((name.clone(), "missing".into()));
            continue;
        };
        let tag = format!("proxy-{index}");
        match clash_to_outbound(proxy, &tag) {
            Some(outbound) => {
                outbounds.push(outbound);
                nodes.push(SpeedJobNode {
                    tag,
                    name: name.clone(),
                });
            }
            None => unsupported.push((name.clone(), get_str(proxy, "type").unwrap_or_else(|| "unknown".into()))),
        }
    }

    // direct 仅用于满足 route.final 的引用；测速请求由 outbound.DialContext
    // 直接拨号，不经过任何入站或路由规则。
    outbounds.push(json!({ "type": "direct", "tag": "direct" }));

    let config = json!({
        "log": { "disabled": true },
        "dns": {
            "servers": [{ "type": "local", "tag": "dns-local" }],
            "final": "dns-local"
        },
        "inbounds": [],
        "endpoints": [],
        "outbounds": outbounds,
        "route": {
            "final": "direct",
            "auto_detect_interface": false,
            "default_domain_resolver": { "server": "dns-local" }
        }
    });

    Ok((
        SpeedJob {
            config,
            nodes,
            url: url.unwrap_or(DEFAULT_TEST_URL).to_owned(),
            timeout_ms: timeout_ms.clamp(1000, 60_000),
            threads: threads.clamp(1, 8),
        },
        unsupported,
    ))
}

/// 生成只含单个节点的测速配置。
///
/// core 的 `SpeedTest` 每收到一次请求都会新建一个临时 sing-box 实例（见
/// core/internal/rpc/testenv.go），因此按节点裁剪出最小配置可以显著降低并发
/// 测速时的内存占用；`direct` 必须保留，因为 `route.final` 指向它。
pub fn config_for_tag(config: &JsonValue, tag: &str) -> JsonValue {
    let mut config = config.clone();
    if let Some(outbounds) = config.get_mut("outbounds").and_then(JsonValue::as_array_mut) {
        outbounds.retain(|outbound| {
            let same_tag = outbound.get("tag").and_then(JsonValue::as_str) == Some(tag);
            let is_direct = outbound.get("type").and_then(JsonValue::as_str) == Some("direct");
            same_tag || is_direct
        });
    }
    config
}
