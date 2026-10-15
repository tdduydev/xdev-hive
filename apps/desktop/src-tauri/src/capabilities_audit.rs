//! Kiểm quyền của từng cửa sổ (spec 008 T024, US8). Cửa sổ web của hub (`main`) nạp trang từ xa: lỗi XSS trên hub
//! không được biến thành lệnh chạy trên máy, nên nó không có quyền nào. Lệnh của app chỉ dành cho cửa sổ cục bộ cần
//! nó, và lệnh nào cũng phải khai trong build.rs: lệnh không khai thì Tauri không đặt nó dưới capability.

use std::collections::{BTreeSet, HashMap};

use serde::Deserialize;

#[derive(Deserialize)]
struct Capability {
    identifier: String,
    windows: Vec<String>,
    #[serde(default)]
    webviews: Vec<String>,
    #[serde(default)]
    remote: Option<serde_json::Value>,
    permissions: Vec<serde_json::Value>,
}

fn capabilities() -> Vec<Capability> {
    [
        include_str!("../capabilities/default.json"),
        include_str!("../capabilities/app.json"),
    ]
    .iter()
    .map(|raw| serde_json::from_str(raw).expect("capability JSON hợp lệ"))
    .collect()
}

/// Số file trong capabilities/: thêm file mới thì phải thêm vào danh sách trên để được kiểm.
fn capability_files() -> usize {
    std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities"))
        .expect("đọc thư mục capabilities")
        .filter(|e| {
            e.as_ref()
                .is_ok_and(|e| e.path().extension().is_some_and(|x| x == "json"))
        })
        .count()
}

/// `allow-foo-bar` của lệnh app `foo_bar`; quyền của plugin (`core:…`, `dialog:…`) có tiền tố và trả None.
fn app_command(permission: &serde_json::Value) -> Option<String> {
    let id = permission.as_str()?;
    if id.contains(':') {
        return None;
    }
    id.strip_prefix("allow-").map(|c| c.replace('-', "_"))
}

fn names_in_macro(source: &str, open: &str, close: &str) -> BTreeSet<String> {
    let start = source.find(open).expect("có danh sách lệnh") + open.len();
    let body = &source[start..start + source[start..].find(close).expect("đóng danh sách")];
    body.split(',')
        .map(|w| w.trim().trim_matches('"'))
        .filter(|w| !w.is_empty())
        .map(|w| w.rsplit("::").next().unwrap_or(w).to_string())
        .collect()
}

/// Lệnh đăng ký với Tauri trong lib.rs (generate_handler!).
fn handler_commands() -> BTreeSet<String> {
    names_in_macro(include_str!("lib.rs"), "generate_handler![", "]")
}

/// Lệnh khai trong build.rs (AppManifest::commands).
fn manifest_commands() -> BTreeSet<String> {
    names_in_macro(include_str!("../build.rs"), ".commands(&[", "]")
}

#[test]
fn every_capability_file_is_audited() {
    assert_eq!(capability_files(), capabilities().len());
}

#[test]
fn hub_web_window_has_no_permission() {
    for cap in capabilities() {
        assert!(
            !cap.windows.iter().any(|w| w == "main" || w.contains('*')),
            "capability {} cấp quyền cho cửa sổ web của hub hoặc dùng *: {:?}",
            cap.identifier,
            cap.windows
        );
        assert!(cap.webviews.is_empty(), "{} khai webviews", cap.identifier);
        assert!(
            cap.remote.is_none(),
            "{} cho trang từ xa gọi lệnh",
            cap.identifier
        );
    }
}

#[test]
fn each_local_window_has_exactly_one_capability() {
    let mut by_window: HashMap<String, Vec<String>> = HashMap::new();
    for cap in capabilities() {
        for w in cap.windows {
            by_window.entry(w).or_default().push(cap.identifier.clone());
        }
    }
    let windows: BTreeSet<_> = by_window.keys().cloned().collect();
    assert_eq!(
        windows,
        BTreeSet::from([super::REGISTER.to_string(), super::APP.to_string()])
    );
    assert!(
        by_window.values().all(|caps| caps.len() == 1),
        "{by_window:?}"
    );
}

#[test]
fn every_command_is_declared_in_build_manifest() {
    let handlers = handler_commands();
    let manifest = manifest_commands();
    assert_eq!(
        handlers, manifest,
        "lệnh trong generate_handler! và build.rs phải khớp"
    );
    // Lệnh đã khai mà không cửa sổ nào được gọi là lệnh thừa; lệnh được cho phép mà không có là gõ nhầm.
    let granted: BTreeSet<String> = capabilities()
        .iter()
        .flat_map(|c| c.permissions.iter().filter_map(app_command))
        .collect();
    assert_eq!(
        granted, manifest,
        "mỗi lệnh phải được đúng cửa sổ cần nó cho phép"
    );
}

#[test]
fn register_window_only_registers() {
    let caps = capabilities();
    let register = caps
        .iter()
        .find(|c| c.windows == [super::REGISTER])
        .expect("capability của cửa sổ đăng ký");
    let commands: BTreeSet<String> = register
        .permissions
        .iter()
        .filter_map(app_command)
        .collect();
    assert_eq!(
        commands,
        BTreeSet::from(
            [
                "parse_registration",
                "register_worker",
                "browser_login",
                "hub_check",
                "hub_ca_inspect",
                "hub_ca_trust",
                "hub_ca_forget",
                "set_lang"
            ]
            .map(String::from)
        )
    );
}

#[test]
fn no_shell_or_filesystem_plugin_permission() {
    // Sidecar và đọc file làm trong Rust; webview không được tự chạy lệnh hay đọc ghi file.
    for cap in capabilities() {
        for p in &cap.permissions {
            let id = p
                .as_str()
                .or_else(|| p.get("identifier").and_then(|v| v.as_str()))
                .unwrap_or("");
            assert!(
                !id.starts_with("shell:") && !id.starts_with("fs:") && !id.starts_with("http:"),
                "{} có quyền {id}",
                cap.identifier
            );
        }
    }
}

#[test]
fn remote_control_commands_belong_to_the_local_app_window_only() {
    // Ghép thiết bị và bật điều khiển từ xa là quyết định của người ngồi tại máy (FR-012): cửa sổ nào ngoài cửa sổ app
    // cục bộ mà gọi được `remote_*` là mở đường cho trang từ xa tự ghép thiết bị của kẻ tấn công.
    for cap in capabilities() {
        let remote: Vec<String> = cap
            .permissions
            .iter()
            .filter_map(app_command)
            .filter(|c| c.starts_with("remote_"))
            .collect();
        if cap.windows == [super::APP] {
            assert!(
                remote.iter().any(|c| c == "remote_pair_decide"),
                "cửa sổ app phải trả lời được yêu cầu ghép"
            );
        } else {
            assert!(remote.is_empty(), "{} có {remote:?}", cap.identifier);
        }
    }
}

#[test]
fn app_webviews_only_load_local_content() {
    assert!(!include_str!("lib.rs").contains("WebviewUrl::External"));
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let csp = config["app"]["security"]["csp"].as_str().unwrap();
    assert!(csp.contains("connect-src ipc: http://ipc.localhost;"));
}
