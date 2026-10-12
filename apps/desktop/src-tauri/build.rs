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
        "account_status",
        "account_link",
        "account_unlink",
        "workspace_meta",
        "hub_tool",
        "skill_uses",
        "installed_skills",
        "install_skills",
        "remove_skills",
        "propose_skill",
        "run_cli_stream",
        "cancel_cli_stream",
        "cli_accounts",
        "folder_tree",
        "propose_doc",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("tauri-build lỗi");
}
