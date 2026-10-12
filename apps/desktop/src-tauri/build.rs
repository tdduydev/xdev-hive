fn main() {
    // Khai báo lệnh của app để chúng chịu capability như lệnh của plugin: chỉ cửa sổ đăng ký cục bộ được gọi, web của
    // hub (trang từ xa) thì không.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "parse_registration",
        "register_worker",
        "scan_environment",
        "run_install",
        "claude_context",
        "claude_usage",
        "session_stats",
        "worker_state",
        "set_lang",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("tauri-build lỗi");
}
