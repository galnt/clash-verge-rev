use std::path::{Path, PathBuf};

fn main() {
    generate_core_protocol();

    #[cfg(feature = "clippy")]
    {
        println!("cargo:warning=Skipping tauri_build during Clippy");
    }

    #[cfg(not(feature = "clippy"))]
    tauri_build::build();
}

/// core/gen/libcore.proto 是 Throne core 与 GUI 之间唯一的协议定义，这里直接编译它，
/// 避免在 Rust 侧维护第二份消息定义（core 升级时协议自动跟随）。
#[allow(clippy::expect_used)]
fn generate_core_protocol() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let proto_dir: PathBuf = Path::new(&manifest_dir).join("../core/gen");
    let proto = proto_dir.join("libcore.proto");

    println!("cargo:rerun-if-changed={}", proto.display());
    println!("cargo:rerun-if-changed={}", proto_dir.display());

    // 用 crate 内置的 protoc，构建机不需要预装。
    let protoc = protoc_bin_vendored::protoc_bin_path().expect("vendored protoc binary");
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc);
    config
        .compile_protos(&[proto.as_path()], &[proto_dir.as_path()])
        .expect("compile core/gen/libcore.proto");
}
