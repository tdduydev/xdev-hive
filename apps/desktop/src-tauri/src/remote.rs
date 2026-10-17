//! Điều khiển từ xa (specs/010-hive-cli-remote, màn "Điều khiển từ xa"): app không nói chuyện với worker bằng giao thức
//! riêng mà gọi sidecar `hive remote … --json`, nên CLI và app luôn cho cùng kết quả và cùng luật (xác nhận, kiểm đầu vào).
//!
//! - Một tiến trình `hive remote watch --json` chạy nền suốt lúc worker online: mỗi dòng stdout là một sự kiện chuyển
//!   cho cửa sổ app; câu trả lời hộp xác nhận ghép (`remote.pair.decide`) đi ngược vào stdin của chính tiến trình đó.
//! - Các lệnh `remote_*` mỗi lệnh một lần gọi `hive`; thao tác cần xác nhận (bật từ xa, toàn quyền, tắt TOTP) truyền
//!   `--yes` vì giao diện đã hỏi người dùng, hive không có terminal để hỏi.
//! - Chấm trên khay và mục "Tắt điều khiển từ xa ngay" theo trạng thái bật và danh sách phiên.
//!
//! Ghép thiết bị không phụ thuộc hub: socket cục bộ của worker là ranh giới "ngay tại máy" (FR-012), nên chỉ cửa sổ app
//! cục bộ có quyền gọi các lệnh này (capabilities/app.json), cửa sổ web của hub thì không.

use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

const HIVE: &str = "hive";
/// Chờ giữa hai lần thử mở lại watch khi worker chưa nghe hoặc vừa khởi động lại.
const RETRY: Duration = Duration::from_secs(5);
/// Chu kỳ đọc danh sách phiên để vẽ chấm khay và danh sách trên màn.
const POLL: Duration = Duration::from_secs(5);

/// Khoá của `hive remote set`; trùng `remoteKeys` trong worker/cmd/hive/remote.go. Khoá lạ bị từ chối ở đây để lệnh app
/// không bao giờ chuyển tham số tuỳ ý cho hive.
const SETTING_KEYS: [(&str, bool); 6] = [
    ("confirm-on-machine", false),
    ("idle-minutes", true),
    ("detached-hours", true),
    ("max-hours", true),
    ("allow-full-access", false),
    ("totp-on-https", false),
];

#[derive(Default)]
pub(crate) struct Remote {
    /// Tiến trình watch đang chạy; giữ để ghi câu trả lời vào stdin và để giết khi thoát app.
    watch: Mutex<Option<CommandChild>>,
    /// Điều khiển từ xa đang bật (theo sự kiện state của watch): khay chỉ cho "Tắt ngay" khi đúng.
    enabled: AtomicBool,
    /// Đang có phiên do thiết bị từ xa điều khiển: bật chấm trên biểu tượng khay.
    active: AtomicBool,
}

impl Remote {
    pub(crate) fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub(crate) fn active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
}

/// Bỏ tiền tố "hive: " để lỗi hiện cho người dùng là câu của worker, không lộ tên lệnh nội bộ.
fn clean_error(stderr: &str) -> String {
    let msg = stderr.trim();
    let msg = msg.strip_prefix("hive:").unwrap_or(msg).trim();
    if msg.is_empty() {
        "Lệnh hive báo lỗi mà không có chi tiết.".into()
    } else {
        msg.to_string()
    }
}

async fn hive_raw(app: &AppHandle, args: Vec<String>) -> Result<String, String> {
    let out = app
        .shell()
        .sidecar(HIVE)
        .map_err(|e| e.to_string())?
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Không chạy được lệnh hive: {e}"))?;
    if !out.status.success() {
        return Err(clean_error(&String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub(crate) async fn hive_json(app: &AppHandle, args: &[&str]) -> Result<Value, String> {
    let text = hive_raw(app, args.iter().map(|a| a.to_string()).collect()).await?;
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(text.trim()).map_err(|e| format!("Không đọc được kết quả của hive: {e}"))
}

fn setting_value_ok(key: &str, value: &str) -> bool {
    match SETTING_KEYS.iter().find(|(k, _)| *k == key) {
        Some((_, true)) => {
            value.len() <= 6 && !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
        }
        Some((_, false)) => matches!(value, "on" | "off"),
        None => false,
    }
}

/// Mã phiên do worker cấp là chữ số và chữ cái; chặn mọi thứ bắt đầu bằng "-" để không thành cờ của hive.
fn session_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && !id.starts_with('-')
}

fn totp_code_ok(code: &str) -> bool {
    code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit())
}

/// Mã ghép đi trong JSON trên stdin chứ không thành đối số dòng lệnh, nên chỉ cần đúng bộ ký tự base64url/hex.
fn pair_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn status_of(reply: &Value) -> Value {
    reply.get("status").cloned().unwrap_or(Value::Null)
}

#[tauri::command]
pub(crate) async fn remote_status(app: AppHandle) -> Result<Value, String> {
    let reply = hive_json(&app, &["remote", "status", "--json"]).await?;
    let status = status_of(&reply);
    note_state(&app, &status);
    Ok(status)
}

/// Người dùng đã xác nhận trên giao diện (hai bước), nên truyền `--yes`.
#[tauri::command]
pub(crate) async fn remote_enable(app: AppHandle) -> Result<Value, String> {
    let reply = hive_json(&app, &["remote", "on", "--yes", "--json"]).await?;
    let status = status_of(&reply);
    note_state(&app, &status);
    Ok(status)
}

#[tauri::command]
pub(crate) async fn remote_disable(app: AppHandle) -> Result<Value, String> {
    disable(&app).await
}

async fn disable(app: &AppHandle) -> Result<Value, String> {
    let reply = hive_json(app, &["remote", "off", "--json"]).await?;
    let status = status_of(&reply);
    note_state(app, &status);
    Ok(status)
}

#[tauri::command]
pub(crate) async fn remote_root_add(
    app: AppHandle,
    path: String,
    label: Option<String>,
) -> Result<Value, String> {
    // Worker chỉ nhận đường dẫn tuyệt đối; thư mục tương đối sẽ hiểu theo thư mục chạy của app, không phải ý người dùng.
    if !Path::new(&path).is_absolute() {
        return Err("Cần đường dẫn tuyệt đối tới thư mục.".into());
    }
    let label = label.unwrap_or_default();
    let mut args = vec!["remote", "roots", "add", path.as_str(), "--json"];
    if !label.trim().is_empty() {
        args.extend(["--label", label.trim()]);
    }
    hive_json(&app, &args).await
}

#[tauri::command]
pub(crate) async fn remote_root_remove(app: AppHandle, id: String) -> Result<(), String> {
    if !session_id_ok(&id) {
        return Err("Mã thư mục không hợp lệ.".into());
    }
    hive_json(&app, &["remote", "roots", "rm", &id, "--json"]).await?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn remote_device_remove(app: AppHandle, id: String) -> Result<(), String> {
    if !session_id_ok(&id) {
        return Err("Mã thiết bị không hợp lệ.".into());
    }
    hive_json(&app, &["remote", "devices", "rm", &id, "--json"]).await?;
    Ok(())
}

/// Tạo mã ghép; giao diện tự vẽ QR từ `pair.url` và trả lời hộp xác nhận qua `remote_pair_decide`.
#[tauri::command]
pub(crate) async fn remote_pair(app: AppHandle) -> Result<Value, String> {
    let reply = hive_json(&app, &["remote", "pair", "--json"]).await?;
    Ok(reply.get("pair").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub(crate) async fn remote_set(
    app: AppHandle,
    key: String,
    value: String,
) -> Result<Value, String> {
    if !setting_value_ok(&key, &value) {
        return Err("Thiết lập không hợp lệ.".into());
    }
    // --yes cho allow-full-access: giao diện đã hỏi riêng trước khi gọi (hive không có terminal để hỏi).
    let reply = hive_json(&app, &["remote", "set", &key, &value, "--yes", "--json"]).await?;
    let status = status_of(&reply);
    note_state(&app, &status);
    Ok(status)
}

/// Trả lời yêu cầu ghép đang chờ ("Hỏi trên máy") qua stdin của watch; worker coi là câu trả lời của chủ máy.
#[tauri::command]
pub(crate) fn remote_pair_decide(
    app: AppHandle,
    pair_id: String,
    allow: bool,
) -> Result<(), String> {
    if !pair_id_ok(&pair_id) {
        return Err("Mã ghép không hợp lệ.".into());
    }
    let line = format!(
        "{}\n",
        json!({"op": "remote.pair.decide", "pairId": pair_id, "allow": allow})
    );
    let remote = app.state::<Remote>();
    let mut slot = remote.watch.lock().map_err(|e| e.to_string())?;
    let child = slot
        .as_mut()
        .ok_or("Chưa kết nối tới worker để trả lời; thử lại sau giây lát.")?;
    child
        .write(line.as_bytes())
        .map_err(|e| format!("Không gửi được câu trả lời: {e}"))
}

#[tauri::command]
pub(crate) async fn remote_totp_enroll(app: AppHandle) -> Result<Value, String> {
    let reply = hive_json(&app, &["remote", "totp", "enroll", "--json"]).await?;
    Ok(reply.get("totp").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub(crate) async fn remote_totp_confirm(app: AppHandle, code: String) -> Result<(), String> {
    let code = code.trim().to_string();
    if !totp_code_ok(&code) {
        return Err("Mã gồm đúng 6 chữ số.".into());
    }
    hive_json(&app, &["remote", "totp", "confirm", &code, "--json"]).await?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn remote_totp_disable(app: AppHandle) -> Result<(), String> {
    hive_json(&app, &["remote", "totp", "disable", "--yes", "--json"]).await?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn remote_totp_unlock(app: AppHandle) -> Result<(), String> {
    hive_json(&app, &["remote", "totp", "unlock", "--json"]).await?;
    Ok(())
}

/// Phiên đang chạy trên máy (`hive ls --json`).
#[tauri::command]
pub(crate) async fn remote_sessions(app: AppHandle) -> Result<Value, String> {
    let list = hive_json(&app, &["ls", "--json"]).await?;
    publish_sessions(&app, &list);
    Ok(list)
}

/// Ngắt một phiên bằng `hive kill`, cùng đường với lệnh gõ trong terminal.
#[tauri::command]
pub(crate) async fn remote_session_kill(app: AppHandle, id: String) -> Result<(), String> {
    if !session_id_ok(&id) {
        return Err("Mã phiên không hợp lệ.".into());
    }
    hive_raw(&app, vec!["kill".into(), id]).await?;
    Ok(())
}

/// Phiên do thiết bị từ xa mở hoặc đang điều khiển. hive-worker cũ không có trường `origin`, `controller`; thiếu thì
/// không coi là từ xa (không đoán).
fn is_remote_session(s: &Value) -> bool {
    s.get("origin").and_then(Value::as_str) == Some("remote")
        || s.get("controller").and_then(Value::as_str) == Some("remote")
}

fn any_remote(list: &Value) -> bool {
    list.as_array()
        .is_some_and(|a| a.iter().any(is_remote_session))
}

fn publish_sessions(app: &AppHandle, list: &Value) {
    let remote = app.state::<Remote>();
    let active = any_remote(list);
    let changed = remote.active.swap(active, Ordering::SeqCst) != active;
    let _ = app.emit("remote-sessions", json!({"sessions": list}));
    if changed {
        crate::refresh_tray(app);
    }
}

/// Ghi nhận trạng thái bật/tắt mới nhất rồi báo cửa sổ app và khay.
fn note_state(app: &AppHandle, status: &Value) {
    if status.is_null() {
        return;
    }
    let enabled = status
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let remote = app.state::<Remote>();
    let changed = remote.enabled.swap(enabled, Ordering::SeqCst) != enabled;
    if !enabled {
        remote.active.store(false, Ordering::SeqCst);
    }
    let _ = app.emit("remote-state", status);
    if changed {
        crate::refresh_tray(app);
    }
}

/// Một dòng stdout của watch: dòng đầu là `{"ok":true,"status":…}`, các dòng sau là `{"event":…}` hoặc trả lời cho yêu cầu
/// ghi vào stdin (`{"ok":…}`, không cần chuyển tiếp).
fn handle_line(app: &AppHandle, line: &str) {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return;
    };
    match v.get("event").and_then(Value::as_str) {
        None => {
            if let Some(status) = v.get("status") {
                note_state(app, status);
            }
        }
        Some("state") => {
            if let Some(state) = v.get("state") {
                note_state(app, state);
            }
        }
        Some("pair_request") => {
            let label = v.get("label").and_then(Value::as_str).unwrap_or("");
            // Hộp xác nhận nằm trong cửa sổ app: đưa lên trước để người ở máy thấy, và báo hệ điều hành phòng khi
            // cửa sổ đang ẩn vào khay.
            crate::show_app(app);
            let en = crate::lang_of(app) == "en";
            crate::notify(
                app,
                &if en {
                    format!("\"{label}\" wants to pair with this machine. Open the app to answer.")
                } else {
                    format!("\"{label}\" muốn ghép với máy này. Mở app để trả lời.")
                },
            );
            let _ = app.emit("remote-pair-request", &v);
        }
        Some("pair_done") => {
            let _ = app.emit("remote-pair-done", &v);
        }
        Some(_) => {}
    }
}

fn is_online(app: &AppHandle) -> bool {
    app.state::<crate::State>()
        .worker
        .lock()
        .map(|w| w.kind() == "online")
        .unwrap_or(false)
}

fn quitting(app: &AppHandle) -> bool {
    app.state::<crate::State>().quitting.load(Ordering::SeqCst)
}

#[derive(Serialize, Clone)]
struct Connected {
    connected: bool,
}

/// Mở watch một lần và chuyển sự kiện tới khi tiến trình thoát.
async fn watch_once(app: &AppHandle) -> Result<(), String> {
    let (mut rx, child) = app
        .shell()
        .sidecar(HIVE)
        .map_err(|e| e.to_string())?
        .args(["remote", "watch", "--json"])
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Ok(mut slot) = app.state::<Remote>().watch.lock() {
        *slot = Some(child);
    }
    let _ = app.emit("remote-watch", Connected { connected: true });
    let mut pending = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                // Một sự kiện có thể tới làm nhiều mảnh; chỉ xử lý dòng đã đủ.
                pending.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(end) = pending.find('\n') {
                    let line: String = pending.drain(..=end).collect();
                    handle_line(app, line.trim());
                }
            }
            CommandEvent::Stderr(bytes) => {
                eprintln!(
                    "[hive remote watch] {}",
                    String::from_utf8_lossy(&bytes).trim()
                );
            }
            CommandEvent::Error(e) => eprintln!("[hive remote watch] {e}"),
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }
    if let Ok(mut slot) = app.state::<Remote>().watch.lock() {
        *slot = None;
    }
    let _ = app.emit("remote-watch", Connected { connected: false });
    Ok(())
}

/// Bật nền: giữ watch khi worker online, đọc danh sách phiên theo chu kỳ khi từ xa đang bật.
pub(crate) fn start(app: &AppHandle) {
    let watcher = app.clone();
    tauri::async_runtime::spawn(async move {
        while !quitting(&watcher) {
            if is_online(&watcher)
                && let Err(e) = watch_once(&watcher).await
            {
                eprintln!("Không theo dõi được điều khiển từ xa: {e}");
            }
            tokio::time::sleep(RETRY).await;
        }
    });
    let poller = app.clone();
    tauri::async_runtime::spawn(async move {
        while !quitting(&poller) {
            tokio::time::sleep(POLL).await;
            if !is_online(&poller) || !poller.state::<Remote>().enabled() {
                continue;
            }
            if let Ok(list) = hive_json(&poller, &["ls", "--json"]).await {
                publish_sessions(&poller, &list);
            }
        }
    });
}

/// Đóng watch khi app thoát: đóng stdin là hive thôi theo dõi; giết hẳn để không sót tiến trình con.
pub(crate) fn stop(app: &AppHandle) {
    if let Some(remote) = app.try_state::<Remote>()
        && let Ok(mut slot) = remote.watch.lock()
        && let Some(child) = slot.take()
    {
        let _ = child.kill();
    }
}

/// Mục khay "Tắt điều khiển từ xa ngay": không hỏi lại, vì đây là nút dừng khẩn.
pub(crate) fn disable_from_tray(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = disable(&app).await {
            crate::notify(&app, &e);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_accept_only_known_keys_and_shapes() {
        assert!(setting_value_ok("confirm-on-machine", "on"));
        assert!(setting_value_ok("allow-full-access", "off"));
        assert!(setting_value_ok("idle-minutes", "30"));
        assert!(!setting_value_ok("idle-minutes", "-1"));
        assert!(!setting_value_ok("idle-minutes", ""));
        assert!(!setting_value_ok("max-hours", "on"));
        assert!(!setting_value_ok("confirm-on-machine", "30"));
        assert!(!setting_value_ok("--yes", "on"));
        assert!(!setting_value_ok("unknown", "on"));
    }

    #[test]
    fn ids_cannot_turn_into_flags() {
        assert!(session_id_ok("ab12-cd_3"));
        assert!(!session_id_ok("-f"));
        assert!(!session_id_ok("--all"));
        assert!(!session_id_ok(""));
        assert!(!session_id_ok("a b"));
        assert!(!session_id_ok(&"a".repeat(65)));
    }

    #[test]
    fn totp_code_is_six_digits() {
        assert!(totp_code_ok("012345"));
        assert!(!totp_code_ok("12345"));
        assert!(!totp_code_ok("1234567"));
        assert!(!totp_code_ok("12a456"));
    }

    #[test]
    fn errors_drop_the_command_prefix() {
        assert_eq!(clean_error("hive: Đã huỷ.\n"), "Đã huỷ.");
        assert_eq!(
            clean_error("  \n"),
            "Lệnh hive báo lỗi mà không có chi tiết."
        );
    }

    #[test]
    fn remote_sessions_need_an_explicit_origin() {
        let list = json!([{"id": "a", "controlled": true}, {"id": "b", "origin": "local"}]);
        assert!(!any_remote(&list));
        let list = json!([{"id": "a"}, {"id": "c", "origin": "remote"}]);
        assert!(any_remote(&list));
        assert!(any_remote(&json!([{"id": "d", "controller": "remote"}])));
        assert!(!any_remote(&Value::Null));
    }
}
