//! Nhóm Git theo dõi của màn Dự án trên máy (specs/016-desktop-git-groups): kết nối GitLab/GitHub bằng token hoặc helper,
//! clone, fetch, pull mọi repo của một group qua `hive-worker gitgroups`. Chạy được khi chưa đăng nhập Hive.
//!
//! Token nhập tay nằm trong keychain theo id kết nối. Đăng nhập Git có sẵn chỉ đọc helper khi gọi API, không lưu lại;
//! clone/fetch/pull để Git dùng helper của máy. Secret không về giao diện, file hay tham số dòng lệnh.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

use crate::sidecar_json;

const SERVICE: &str = "dev.xdev.hive.git";
const TOKEN_ENV: &str = "HIVE_GIT_TOKEN";
const TOKENS_ENV: &str = "HIVE_GIT_TOKENS";
/// Tiến độ của thao tác hàng loạt; chỉ cửa sổ app nghe.
const EVENT: &str = "git-groups:event";
/// Lượt tự fetch xong: màn đang mở đọc lại trạng thái.
const CHANGED: &str = "git-groups:changed";
const AUTO_FETCH_TICK: Duration = Duration::from_secs(60);

/// Thao tác đang chạy theo id, để huỷ.
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, CommandChild>>);

static JOB_SEQ: AtomicU64 = AtomicU64::new(0);

fn arg(key: &str, value: impl std::fmt::Display) -> String {
    // `--key=value` để giá trị bắt đầu bằng `-` không bị đọc thành cờ.
    format!("--{key}={value}")
}

/// Id kết nối và nhóm do worker sinh: 12 ký tự hex.
fn id_arg(key: &str, id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.len() != 12 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Id không hợp lệ.".into());
    }
    Ok(arg(key, id.to_ascii_lowercase()))
}

fn text_arg(key: &str, value: &str, what: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.len() > max || value.chars().any(char::is_control) {
        return Err(format!("{what} không hợp lệ."));
    }
    Ok(arg(key, value))
}

fn required(key: &str, value: &str, what: &str, max: usize) -> Result<String, String> {
    if value.trim().is_empty() {
        return Err(format!("Thiếu {what}."));
    }
    text_arg(key, value, what, max)
}

fn base(action: &str) -> Vec<String> {
    let mut v = vec!["gitgroups".to_string()];
    if !action.is_empty() {
        v.push(action.into());
    }
    v.push("--json".into());
    v
}

fn check_token(token: &str) -> Result<String, String> {
    let t = token.trim();
    if t.is_empty() {
        return Err("Nhập personal access token.".into());
    }
    if t.len() > 1000 || t.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Token không hợp lệ.".into());
    }
    Ok(t.to_string())
}

pub fn host_add_args(kind: &str, url: &str, name: &str) -> Result<Vec<String>, String> {
    if kind != "gitlab" && kind != "github" {
        return Err("Chọn GitLab hoặc GitHub.".into());
    }
    let mut v = base("host-add");
    v.push(arg("kind", kind));
    v.push(text_arg("url", url, "Địa chỉ máy chủ", 500)?);
    v.push(text_arg("name", name, "Tên kết nối", 100)?);
    Ok(v)
}

pub fn group_add_args(
    host: &str,
    path: &str,
    root: &str,
    protocol: &str,
    filter: &str,
    include_archived: bool,
) -> Result<Vec<String>, String> {
    let mut v = base("group-add");
    v.push(id_arg("host", host)?);
    v.push(required("path", path, "đường dẫn group", 500)?);
    v.push(required("root", root, "thư mục gốc", 4096)?);
    v.push(protocol_arg(protocol)?);
    v.push(text_arg("filter", filter, "Bộ lọc", 500)?);
    v.push(arg("include-archived", include_archived));
    Ok(v)
}

fn protocol_arg(protocol: &str) -> Result<String, String> {
    match protocol {
        "https" | "ssh" => Ok(arg("protocol", protocol)),
        _ => Err("Cách clone là HTTPS hoặc SSH.".into()),
    }
}

/// Phần đổi của nhóm; trường None giữ nguyên.
#[derive(serde::Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GroupPatch {
    root: Option<String>,
    protocol: Option<String>,
    filter: Option<String>,
    include_archived: Option<bool>,
    excluded: Option<Vec<String>>,
    auto_fetch_minutes: Option<u32>,
}

pub fn group_update_args(id: &str, patch: &GroupPatch) -> Result<Vec<String>, String> {
    let mut v = base("group-update");
    v.push(id_arg("id", id)?);
    if let Some(root) = &patch.root {
        v.push(required("root", root, "thư mục gốc", 4096)?);
    }
    if let Some(p) = &patch.protocol {
        v.push(protocol_arg(p)?);
    }
    if let Some(f) = &patch.filter {
        v.push(text_arg("filter", f, "Bộ lọc", 500)?);
    }
    if let Some(a) = patch.include_archived {
        v.push(arg("include-archived", a));
    }
    if let Some(list) = &patch.excluded {
        if list
            .iter()
            .any(|p| p.len() > 1000 || p.chars().any(char::is_control))
        {
            return Err("Danh sách repo bỏ chọn không hợp lệ.".into());
        }
        v.push(arg(
            "excluded",
            serde_json::to_string(list).map_err(|e| e.to_string())?,
        ));
    }
    if let Some(m) = patch.auto_fetch_minutes {
        v.push(arg("auto-fetch", m));
    }
    Ok(v)
}

pub fn sync_args(id: &str, action: &str) -> Result<Vec<String>, String> {
    if !matches!(action, "clone" | "fetch" | "pull" | "status") {
        return Err("Thao tác không hỗ trợ.".into());
    }
    let mut v = base("sync");
    v.push(id_arg("id", id)?);
    v.push(arg("action", action));
    Ok(v)
}

fn entry(host_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, host_id)
        .map_err(|e| format!("Không mở được keychain của máy: {e}"))
}

/// Chỉ gọi helper cho API. Clone/fetch/pull dùng helper trực tiếp trong Git của máy.
async fn tokens_env(
    app: &AppHandle,
    host_ids: &[&str],
    api: bool,
) -> Result<Vec<(&'static str, String)>, String> {
    let view: Value = sidecar_json(app, base(""), vec![]).await?;
    let mut tokens = serde_json::Map::new();
    for id in host_ids {
        let host = view["hosts"]
            .as_array()
            .and_then(|hosts| hosts.iter().find(|h| h["id"].as_str() == Some(id)));
        let token = if let Some(h) = host.filter(|h| h["authMode"] == "git") {
            if api {
                Some(
                    crate::git_credentials::credential(
                        h["kind"].as_str().unwrap_or(""),
                        h["url"].as_str().unwrap_or(""),
                    )
                    .await?,
                )
            } else {
                None
            }
        } else {
            entry(id).ok().and_then(|e| e.get_password().ok())
        };
        if let Some(t) = token {
            tokens.insert((*id).to_string(), Value::String(t));
        }
    }
    Ok(if tokens.is_empty() {
        vec![]
    } else {
        vec![(TOKENS_ENV, Value::Object(tokens).to_string())]
    })
}

#[tauri::command]
pub async fn git_host_probe(kind: String, url: String) -> Result<Value, String> {
    let username = crate::git_credentials::probe(&kind, &url).await?;
    Ok(serde_json::json!({ "username": username }))
}

#[tauri::command]
pub async fn git_host_discover(app: AppHandle) -> Result<Value, String> {
    let projects: Value = sidecar_json(&app, vec!["projects".into(), "--json".into()], vec![])
        .await
        .unwrap_or(Value::Null);
    let remotes: Vec<String> = projects["projects"]
        .as_array()
        .map(|ps| {
            ps.iter()
                .filter_map(|p| p["origin"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let items = crate::git_credentials::discover(&remotes).await?;
    serde_json::to_value(items).map_err(|_| "Không đọc được gợi ý kết nối Git.".into())
}

/// Kết nối, nhóm và danh sách repo đã lưu; không gọi mạng.
#[tauri::command]
pub async fn git_groups(app: AppHandle) -> Result<Value, String> {
    sidecar_json(&app, base(""), vec![]).await
}

/// Chỉ token nhập tay mới lưu keychain; đăng nhập Git luôn đọc lại từ helper khi cần API.
#[tauri::command]
pub async fn git_host_add(
    app: AppHandle,
    kind: String,
    url: String,
    name: String,
    token: String,
    auth_mode: Option<String>,
) -> Result<Value, String> {
    let mut args = host_add_args(&kind, &url, &name)?;
    let mode = auth_mode.as_deref().unwrap_or("token");
    let token = match mode {
        "git" => {
            crate::git_credentials::verified_credential(&kind, &url)
                .await?
                .0
        }
        "token" => check_token(&token)?,
        _ => return Err("Cách đăng nhập không hợp lệ.".into()),
    };
    args.push(arg("auth-mode", mode));
    let view: Value = sidecar_json(&app, args, vec![(TOKEN_ENV, token.clone())]).await?;
    if mode == "git" {
        return Ok(view);
    }
    let id = view["host"]["id"]
        .as_str()
        .ok_or("Worker không trả id kết nối.")?
        .to_string();
    if let Err(e) = entry(&id).and_then(|e| {
        e.set_password(&token)
            .map_err(|e| format!("Không lưu được token vào keychain: {e}"))
    }) {
        // Không có token thì kết nối vô dụng: bỏ luôn để người dùng thêm lại.
        let _ = sidecar_json::<Value>(&app, host_remove_args(&id)?, vec![]).await;
        return Err(e);
    }
    Ok(view)
}

fn host_remove_args(id: &str) -> Result<Vec<String>, String> {
    let mut v = base("host-remove");
    v.push(id_arg("id", id)?);
    Ok(v)
}

#[tauri::command]
pub async fn git_host_remove(app: AppHandle, id: String) -> Result<Value, String> {
    let view = sidecar_json(&app, host_remove_args(&id)?, vec![]).await?;
    if let Ok(e) = entry(id.trim()) {
        // Chưa có token thì coi như đã gỡ.
        let _ = e.delete_credential();
    }
    Ok(view)
}

/// Gợi ý group (GitLab) hay org (GitHub) cho ô nhập.
#[tauri::command]
pub async fn git_group_suggest(
    app: AppHandle,
    host: String,
    search: String,
) -> Result<Value, String> {
    let mut args = base("suggest");
    args.push(id_arg("host", &host)?);
    args.push(text_arg("search", &search, "Chữ tìm", 200)?);
    sidecar_json(&app, args, tokens_env(&app, &[host.trim()], true).await?).await
}

#[tauri::command]
pub async fn git_group_add(
    app: AppHandle,
    host: String,
    path: String,
    root: String,
    protocol: String,
    filter: String,
    include_archived: bool,
) -> Result<Value, String> {
    let args = group_add_args(&host, &path, &root, &protocol, &filter, include_archived)?;
    sidecar_json(&app, args, tokens_env(&app, &[host.trim()], true).await?).await
}

#[tauri::command]
pub async fn git_group_update(
    app: AppHandle,
    id: String,
    patch: GroupPatch,
) -> Result<Value, String> {
    sidecar_json(&app, group_update_args(&id, &patch)?, vec![]).await
}

/// Đọc lại danh sách repo của group từ API.
#[tauri::command]
pub async fn git_group_refresh(app: AppHandle, id: String, host: String) -> Result<Value, String> {
    let mut args = base("group-refresh");
    args.push(id_arg("id", &id)?);
    sidecar_json(&app, args, tokens_env(&app, &[host.trim()], true).await?).await
}

/// Bỏ theo dõi; thư mục đã clone giữ nguyên.
#[tauri::command]
pub async fn git_group_remove(app: AppHandle, id: String) -> Result<Value, String> {
    let mut args = base("group-remove");
    args.push(id_arg("id", &id)?);
    sidecar_json(&app, args, vec![]).await
}

/// Trạng thái từng repo của nhóm, đọc tại máy.
#[tauri::command]
pub async fn git_group_status(app: AppHandle, id: String) -> Result<Value, String> {
    let mut args = base("status");
    args.push(id_arg("id", &id)?);
    sidecar_json(&app, args, vec![]).await
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    job_id: String,
    event: Value,
}

fn emit(app: &AppHandle, job_id: &str, event: Value) {
    let _ = app.emit_to(
        crate::APP,
        EVENT,
        Envelope {
            job_id: job_id.to_string(),
            event,
        },
    );
}

/// Chạy clone/fetch/pull cho cả nhóm, trả id ngay; tiến độ đến qua `git-groups:event`, kết thúc bằng sự kiện `done`
/// hoặc `exit` (sidecar dừng mà không báo xong, kèm lỗi).
#[tauri::command]
pub async fn git_group_sync(
    app: AppHandle,
    id: String,
    host: String,
    action: String,
) -> Result<String, String> {
    let args = sync_args(&id, &action)?;
    let (key, path) = tauri::async_runtime::spawn_blocking(crate::sidecar_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut cmd = app
        .shell()
        .sidecar(crate::SIDECAR)
        .map_err(|e| e.to_string())?
        .args(args)
        .env(key, path);
    if action != "status" {
        for (k, v) in tokens_env(&app, &[host.trim()], false).await? {
            cmd = cmd.env(k, v);
        }
    }
    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("Không chạy được worker: {e}"))?;
    let job_id = format!("git-{}", JOB_SEQ.fetch_add(1, Ordering::Relaxed) + 1);
    app.state::<Jobs>()
        .0
        .lock()
        .map_err(|_| "Không ghi được thao tác.")?
        .insert(job_id.clone(), child);
    let id = job_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut buf = String::new();
        let mut stderr = String::new();
        let mut finished = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    // Sidecar ghi mỗi sự kiện một dòng; một lần đọc có thể chứa nửa dòng.
                    while let Some(i) = buf.find('\n') {
                        let line: String = buf.drain(..=i).collect();
                        if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
                            finished |= v["type"] == "done";
                            emit(&app, &id, v);
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    if stderr.len() < 4000 {
                        stderr.push_str(&String::from_utf8_lossy(&bytes));
                    }
                }
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }
        if let Ok(mut jobs) = app.state::<Jobs>().0.lock() {
            jobs.remove(&id);
        }
        if !finished {
            emit(
                &app,
                &id,
                serde_json::json!({ "type": "exit", "message": stderr.trim() }),
            );
        }
    });
    Ok(job_id)
}

/// Huỷ: báo sidecar qua stdin để nó dừng git đang chạy (git tự dọn clone dở) và không bắt đầu repo mới.
#[tauri::command]
pub fn git_group_cancel(app: AppHandle, job_id: String) -> Result<(), String> {
    let state = app.state::<Jobs>();
    let mut jobs = state.0.lock().map_err(|_| "Không đọc được thao tác.")?;
    if let Some(child) = jobs.get_mut(&job_id) {
        child
            .write(b"cancel\n")
            .map_err(|e| format!("Không huỷ được: {e}"))?;
    }
    Ok(())
}

/// Thư mục mở được: tuyệt đối và đang có. Giao diện chỉ gửi thư mục repo do worker trả về.
fn existing_dir(folder: &str) -> Result<std::path::PathBuf, String> {
    let p = Path::new(folder.trim());
    if !p.is_absolute() || !p.is_dir() {
        return Err("Thư mục không còn trên máy.".into());
    }
    Ok(p.to_path_buf())
}

#[tauri::command]
pub async fn open_folder(folder: String) -> Result<(), String> {
    let dir = existing_dir(&folder)?;
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(windows)]
    let mut cmd = std::process::Command::new("explorer");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Không mở được thư mục: {e}"))
}

#[tauri::command]
pub async fn open_folder_terminal(folder: String) -> Result<(), String> {
    let dir = existing_dir(&folder)?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Terminal"])
            .arg(&dir)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Không mở được Terminal: {e}"))
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // `start /D` đặt thư mục cho cửa sổ cmd mới; thư mục là một đối số, không ghép vào chuỗi lệnh.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "/D"])
            .arg(&dir)
            .arg("cmd")
            .creation_flags(0x0800_0000)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Không mở được cửa sổ lệnh: {e}"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for program in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            if std::process::Command::new(program)
                .current_dir(&dir)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        Err("Không tìm thấy ứng dụng terminal.".into())
    }
}

/// Tự fetch định kỳ (US4, tắt mặc định): mỗi phút hỏi worker nhóm nào đến lượt (không gọi mạng, không cần token), chỉ
/// khi có mới đọc token của đúng các kết nối đó và fetch. Không pull.
pub fn start_auto_fetch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(AUTO_FETCH_TICK).await;
            let Ok(due) = sidecar_json::<Value>(&app, base("due"), vec![]).await else {
                continue;
            };
            let hosts: Vec<String> = due["due"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|g| g["hostId"].as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            if hosts.is_empty() {
                continue;
            }
            let ids: Vec<&str> = hosts.iter().map(String::as_str).collect();
            let Ok(env) = tokens_env(&app, &ids, false).await else {
                continue;
            };
            if let Err(e) = sidecar_json::<Value>(&app, base("auto-fetch"), env).await {
                eprintln!("[gitgroups] tự fetch lỗi: {e}");
            }
            let _ = app.emit_to(crate::APP, CHANGED, ());
        }
    });
}

// git giả của test là script sh.
#[cfg(all(test, unix))]
#[path = "git_groups_e2e.rs"]
mod e2e;

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0a1b2c3d4e5f";

    #[test]
    fn host_add_never_puts_token_in_args() {
        let args = host_add_args("gitlab", "https://git.acme.vn", "GitLab công ty").unwrap();
        assert_eq!(
            args,
            [
                "gitgroups",
                "host-add",
                "--json",
                "--kind=gitlab",
                "--url=https://git.acme.vn",
                "--name=GitLab công ty"
            ]
        );
        assert!(host_add_args("bitbucket", "", "").is_err());
        assert!(host_add_args("github", "https://x\n--kind=gitlab", "").is_err());
        assert!(check_token(" glpat-abc ").unwrap() == "glpat-abc");
        assert!(check_token("a b").is_err());
        assert!(check_token("").is_err());
    }

    #[test]
    fn group_args_are_single_values() {
        let args = group_add_args(
            ID,
            "acme/pay",
            "C:\\Code\\-lạ",
            "ssh",
            "^acme/(api|web)$",
            true,
        )
        .unwrap();
        assert_eq!(
            &args[3..],
            [
                "--host=0a1b2c3d4e5f",
                "--path=acme/pay",
                "--root=C:\\Code\\-lạ",
                "--protocol=ssh",
                "--filter=^acme/(api|web)$",
                "--include-archived=true"
            ]
        );
        assert!(group_add_args("../x", "a", "/r", "https", "", false).is_err());
        assert!(group_add_args(ID, " ", "/r", "https", "", false).is_err());
        assert!(group_add_args(ID, "a", "/r", "git", "", false).is_err());
    }

    #[test]
    fn update_only_sends_changed_fields() {
        let patch = GroupPatch {
            excluded: Some(vec!["acme/old".into()]),
            auto_fetch_minutes: Some(15),
            ..Default::default()
        };
        assert_eq!(
            &group_update_args(ID, &patch).unwrap()[3..],
            [
                "--id=0a1b2c3d4e5f",
                "--excluded=[\"acme/old\"]",
                "--auto-fetch=15"
            ]
        );
        let bad = GroupPatch {
            excluded: Some(vec!["a\nb".into()]),
            ..Default::default()
        };
        assert!(group_update_args(ID, &bad).is_err());
    }

    #[test]
    fn sync_actions() {
        assert_eq!(
            sync_args(ID, "pull").unwrap(),
            [
                "gitgroups",
                "sync",
                "--json",
                "--id=0a1b2c3d4e5f",
                "--action=pull"
            ]
        );
        assert!(sync_args(ID, "push").is_err());
        assert!(sync_args("x", "pull").is_err());
    }

    #[test]
    fn opens_only_existing_absolute_dirs() {
        assert!(existing_dir("relative/dir").is_err());
        assert!(
            existing_dir(
                &std::env::temp_dir()
                    .join("khong-co-hive-xyz")
                    .to_string_lossy()
            )
            .is_err()
        );
        assert!(existing_dir(&std::env::temp_dir().to_string_lossy()).is_ok());
    }
}
