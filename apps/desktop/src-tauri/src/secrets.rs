//! Bí mật cục bộ của máy này (specs/031-local-secrets): các lệnh Tauri bọc `hive-worker secrets …`. Chạy được khi chưa
//! đăng nhập Hive.
//!
//! Giá trị bí mật chỉ đi qua stdin của sidecar dạng `{"value":"…"}`: không nằm trong tham số, biến môi trường, file, log
//! hay sự kiện Tauri. Mô tả (có thể dài, xuống dòng) đi qua file tạm, xoá ngay sau lệnh.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::secret_clipboard::{self, System};
use crate::sidecar_command;

/// Sidecar kho khoá của hệ điều hành có thể hỏi mật khẩu; chờ đủ lâu để người dùng nhập kịp.
const RUN_TIMEOUT: Duration = Duration::from_secs(30);
/// Hộp duyệt hỏi mỗi 2 giây nên không được kẹt lâu.
const POLL_TIMEOUT: Duration = Duration::from_secs(10);

const MAX_ARG: usize = 256;

fn arg(key: &str, value: impl std::fmt::Display) -> String {
    // `--key=value` để giá trị bắt đầu bằng `-` không bị đọc thành cờ.
    format!("--{key}={value}")
}

fn base(action: &[&str]) -> Vec<String> {
    let mut args = vec!["secrets".to_string()];
    args.extend(action.iter().map(|a| a.to_string()));
    args.push("--json".into());
    args
}

/// Tên, mã dự án, mã yêu cầu: chỉ chặn thứ làm hỏng dòng lệnh. Quy tắc tên thật do worker kiểm để thông báo lỗi giống
/// CLI.
fn text_arg(key: &str, value: &str, what: &str) -> Result<String, String> {
    let v = value.trim();
    if v.is_empty() || v.len() > MAX_ARG || v.chars().any(char::is_control) {
        return Err(format!("{what} không hợp lệ."));
    }
    Ok(arg(key, v))
}

fn id_arg(key: &str, value: &str, what: &str) -> Result<String, String> {
    let v = value.trim();
    let ok = !v.is_empty()
        && v.len() <= 64
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
    if !ok {
        return Err(format!("{what} không hợp lệ."));
    }
    Ok(arg(key, v))
}

fn name_arg(key: &str, name: &str) -> Result<String, String> {
    text_arg(key, name, "Tên bí mật")
}

fn project_arg(project: &str) -> Result<String, String> {
    id_arg("project", project, "Mã dự án")
}

fn list_args(project: Option<&str>) -> Result<Vec<String>, String> {
    let mut args = base(&["list"]);
    if let Some(p) = project.filter(|p| !p.trim().is_empty()) {
        args.push(project_arg(p)?);
    }
    Ok(args)
}

fn log_args(
    name: Option<&str>,
    project: Option<&str>,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    let mut args = base(&["log"]);
    if let Some(n) = name.filter(|n| !n.trim().is_empty()) {
        args.push(name_arg("name", n)?);
    }
    if let Some(p) = project.filter(|p| !p.trim().is_empty()) {
        args.push(project_arg(p)?);
    }
    if let Some(l) = limit.filter(|l| *l > 0) {
        args.push(arg("limit", l.min(1000)));
    }
    Ok(args)
}

fn purge_args(project: Option<&str>, all: bool) -> Result<Vec<String>, String> {
    let project = project.filter(|p| !p.trim().is_empty());
    if all == project.is_some() {
        return Err("Chọn xoá bí mật của một dự án hoặc xoá tất cả, không chọn cả hai.".into());
    }
    let mut args = base(&["purge"]);
    match project {
        Some(p) => args.push(project_arg(p)?),
        None => args.push("--all".into()),
    }
    Ok(args)
}

fn approve_args(id: &str, allow: bool) -> Result<Vec<String>, String> {
    let mut args = base(&["approve"]);
    args.push(id_arg("id", id, "Mã yêu cầu")?);
    args.push(if allow { "--allow" } else { "--deny" }.into());
    Ok(args)
}

fn set_args(name: &str, description_file: Option<&std::path::Path>) -> Result<Vec<String>, String> {
    let mut args = base(&["set"]);
    args.push(name_arg("name", name)?);
    if let Some(path) = description_file {
        args.push(arg("description-file", path.display()));
    }
    Ok(args)
}

/// Dạng worker đọc từ stdin. Mượn chuỗi để không sinh thêm bản sao giá trị ngoài vùng đệm sẽ bị xoá.
#[derive(Serialize)]
struct ValueIn<'a> {
    value: &'a str,
}

#[derive(Deserialize)]
struct Revealed {
    value: String,
}

/// Ghi đè bằng 0 trước khi trả bộ nhớ. Chỉ là cố gắng tốt nhất: chuỗi đã đi qua webview và IPC.
fn wipe_bytes(bytes: &mut [u8]) {
    bytes.fill(0);
    std::hint::black_box(&*bytes);
}

fn wipe(secret: String) {
    let mut bytes = secret.into_bytes();
    wipe_bytes(&mut bytes);
}

fn value_input(value: &str) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&ValueIn { value }).map_err(|e| e.to_string())
}

/// Lỗi của worker: stderr là câu tiếng Việt cho người đọc; thiếu thì lấy `error.message` ở stdout.
fn error_text(stdout: &[u8], stderr: &[u8]) -> String {
    let err = String::from_utf8_lossy(stderr).trim().to_string();
    if !err.is_empty() {
        return err;
    }
    serde_json::from_slice::<Value>(stdout)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "Worker báo lỗi mà không có chi tiết.".into())
}

fn drain<R: Read + Send + 'static>(mut from: R) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = from.read_to_end(&mut buf);
        buf
    })
}

/// Chạy sidecar, ghi `input` (nếu có) vào stdin rồi đóng, trả stdout. Người gọi phải `wipe_bytes` kết quả khi nó chứa
/// giá trị. `input` được xoá ngay sau khi ghi.
fn run(mut cmd: Command, input: Option<Vec<u8>>, wait: Duration) -> Result<Vec<u8>, String> {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Không chạy được worker: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        if let Some(mut bytes) = input {
            // Worker thoát sớm vì lỗi tham số thì ghi hỏng; kết quả thật nằm ở mã thoát và stderr bên dưới.
            let _ = stdin.write_all(&bytes);
            wipe_bytes(&mut bytes);
        }
        // Đóng stdin để worker thấy EOF.
        drop(stdin);
    }
    let out = child.stdout.take().map(drain);
    let err = child.stderr.take().map(drain);
    let deadline = Instant::now() + wait;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(e) => return Err(format!("Không chờ được worker: {e}")),
        }
    };
    let mut stdout = out.and_then(|h| h.join().ok()).unwrap_or_default();
    let stderr = err.and_then(|h| h.join().ok()).unwrap_or_default();
    let Some(status) = status else {
        wipe_bytes(&mut stdout);
        return Err("Worker không trả lời kịp. Thử lại sau.".into());
    };
    if !status.success() {
        let msg = error_text(&stdout, &stderr);
        wipe_bytes(&mut stdout);
        return Err(msg);
    }
    Ok(stdout)
}

async fn call(
    app: &AppHandle,
    args: Vec<String>,
    input: Option<Vec<u8>>,
    wait: Duration,
) -> Result<Vec<u8>, String> {
    let cmd = sidecar_command(app, args, vec![]).await?;
    tauri::async_runtime::spawn_blocking(move || run(cmd, input, wait))
        .await
        .map_err(|e| e.to_string())?
}

async fn call_json(
    app: &AppHandle,
    args: Vec<String>,
    input: Option<Vec<u8>>,
    wait: Duration,
) -> Result<Value, String> {
    let out = call(app, args, input, wait).await?;
    serde_json::from_slice(&out).map_err(|e| format!("Không đọc được kết quả của worker: {e}"))
}

/// Gọi `secrets reveal` và trả giá trị. Bản đệm stdout được xoá ngay sau khi tách ra.
async fn reveal(app: &AppHandle, name: &str, copy: bool) -> Result<String, String> {
    let mut args = base(&["reveal"]);
    args.push(name_arg("name", name)?);
    if copy {
        args.push("--copy".into());
    }
    let mut out = call(app, args, None, RUN_TIMEOUT).await?;
    let parsed = serde_json::from_slice::<Revealed>(&out);
    wipe_bytes(&mut out);
    parsed
        .map(|r| r.value)
        .map_err(|_| "Không đọc được kết quả của worker.".into())
}

/// File tạm chứa mô tả; xoá khi hết phạm vi dù lệnh thành công hay lỗi.
struct TempDescription(std::path::PathBuf);

impl TempDescription {
    fn create(text: &str) -> Result<Self, String> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!(
            "hive-secret-description-{}-{nanos}.txt",
            std::process::id()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|e| format!("Không tạo được file mô tả tạm: {e}"))?;
        let guard = TempDescription(path);
        file.write_all(text.as_bytes())
            .map_err(|e| format!("Không ghi được file mô tả tạm: {e}"))?;
        Ok(guard)
    }
}

impl Drop for TempDescription {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[tauri::command]
pub async fn secrets_status(app: AppHandle) -> Result<Value, String> {
    call_json(&app, base(&["status"]), None, RUN_TIMEOUT).await
}

#[tauri::command]
pub async fn secrets_list(app: AppHandle, project: Option<String>) -> Result<Value, String> {
    call_json(&app, list_args(project.as_deref())?, None, RUN_TIMEOUT).await
}

/// Lưu bí mật. Bỏ trống `value` thì giữ giá trị cũ (chỉ sửa mô tả). `projects` là các dự án mới cần gán thêm.
#[tauri::command]
pub async fn secret_save(
    app: AppHandle,
    name: String,
    description: String,
    value: Option<String>,
    projects: Option<Vec<String>>,
) -> Result<Value, String> {
    let projects = projects.unwrap_or_default();
    // Kiểm hết trước khi ghi gì, để một mã dự án sai không để lại bí mật đã lưu mà chưa gán.
    let project_args = projects
        .iter()
        .map(|p| project_arg(p))
        .collect::<Result<Vec<_>, _>>()?;
    let description_file = TempDescription::create(&description)?;
    let args = set_args(&name, Some(&description_file.0))?;
    let input = match value.filter(|v| !v.trim().is_empty()) {
        Some(v) => {
            let bytes = value_input(&v);
            wipe(v);
            Some(bytes?)
        }
        None => None,
    };
    let mut item = call_json(&app, args, input, RUN_TIMEOUT).await?;
    drop(description_file);
    for project in project_args {
        let mut args = base(&["assign"]);
        args.push(name_arg("name", &name)?);
        args.push(project);
        item = call_json(&app, args, None, RUN_TIMEOUT).await?;
    }
    Ok(item)
}

#[tauri::command]
pub async fn secret_rename(app: AppHandle, name: String, to: String) -> Result<Value, String> {
    let mut args = base(&["rename"]);
    args.push(name_arg("name", &name)?);
    args.push(name_arg("to", &to)?);
    call_json(&app, args, None, RUN_TIMEOUT).await
}

#[tauri::command]
pub async fn secret_assign(
    app: AppHandle,
    name: String,
    project: String,
    assigned: bool,
) -> Result<Value, String> {
    let mut args = base(&[if assigned { "assign" } else { "unassign" }]);
    args.push(name_arg("name", &name)?);
    args.push(project_arg(&project)?);
    call_json(&app, args, None, RUN_TIMEOUT).await
}

#[tauri::command]
pub async fn secret_delete(app: AppHandle, name: String) -> Result<Value, String> {
    let mut args = base(&["delete"]);
    args.push(name_arg("name", &name)?);
    call_json(&app, args, None, RUN_TIMEOUT).await
}

/// Trả giá trị cho UI đúng một lần (FR-051). Worker ghi một dòng "Hiện" vào nhật ký.
#[tauri::command]
pub async fn secret_reveal(app: AppHandle, name: String) -> Result<String, String> {
    reveal(&app, &name, false).await
}

/// Đặt giá trị vào clipboard mà không đưa nó qua UI; sau 30 giây xoá nếu người dùng chưa chép thứ khác (FR-052).
#[tauri::command]
pub async fn secret_copy(app: AppHandle, name: String) -> Result<(), String> {
    let value = reveal(&app, &name, true).await?;
    let written = System.write(&value);
    if let Err(e) = written {
        wipe(value);
        return Err(e);
    }
    std::thread::spawn(move || {
        std::thread::sleep(secret_clipboard::CLEAR_AFTER);
        secret_clipboard::clear_if_unchanged(&System, &value);
        wipe(value);
    });
    Ok(())
}

#[tauri::command]
pub async fn secrets_log(
    app: AppHandle,
    name: Option<String>,
    project: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let args = log_args(name.as_deref(), project.as_deref(), limit)?;
    call_json(&app, args, None, RUN_TIMEOUT).await
}

#[tauri::command]
pub async fn secrets_log_clear(app: AppHandle) -> Result<Value, String> {
    call_json(&app, base(&["log", "clear"]), None, RUN_TIMEOUT).await
}

#[tauri::command]
pub async fn secrets_purge(
    app: AppHandle,
    project: Option<String>,
    all: Option<bool>,
) -> Result<Value, String> {
    let args = purge_args(project.as_deref(), all.unwrap_or(false))?;
    call_json(&app, args, None, RUN_TIMEOUT).await
}

#[tauri::command]
pub async fn secret_approvals(app: AppHandle) -> Result<Value, String> {
    call_json(&app, base(&["approvals"]), None, POLL_TIMEOUT).await
}

#[tauri::command]
pub async fn secret_approve(app: AppHandle, id: String, allow: bool) -> Result<(), String> {
    call(&app, approve_args(&id, allow)?, None, RUN_TIMEOUT)
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAKE: &str = "gia-tri-gia-123456";

    #[test]
    fn base_always_asks_for_json() {
        assert_eq!(base(&["status"]), ["secrets", "status", "--json"]);
        assert_eq!(base(&["log", "clear"]), ["secrets", "log", "clear", "--json"]);
    }

    #[test]
    fn list_filters_by_project_only_when_given() {
        assert_eq!(list_args(None).unwrap(), ["secrets", "list", "--json"]);
        assert_eq!(list_args(Some("  ")).unwrap(), ["secrets", "list", "--json"]);
        assert_eq!(
            list_args(Some("1111111111111111")).unwrap(),
            ["secrets", "list", "--json", "--project=1111111111111111"]
        );
    }

    #[test]
    fn project_ids_cannot_inject_flags() {
        assert!(project_arg("--all").is_ok_and(|a| a == "--project=--all"));
        for bad in ["", "a b", "x;rm", "a\nb", "../x"] {
            assert!(project_arg(bad).is_err(), "{bad:?} phải bị từ chối");
        }
    }

    #[test]
    fn names_with_control_characters_are_rejected() {
        assert_eq!(
            name_arg("name", " DATABASE_URL ").unwrap(),
            "--name=DATABASE_URL"
        );
        assert!(name_arg("name", "A\u{0}B").is_err());
        assert!(name_arg("name", "").is_err());
        assert!(name_arg("name", &"A".repeat(MAX_ARG + 1)).is_err());
        // Tên đứng sau `--name=`, nên bắt đầu bằng `-` cũng không thành cờ.
        assert_eq!(name_arg("name", "-x").unwrap(), "--name=-x");
    }

    #[test]
    fn log_limit_is_clamped_and_optional() {
        assert_eq!(log_args(None, None, None).unwrap(), ["secrets", "log", "--json"]);
        assert_eq!(log_args(None, None, Some(0)).unwrap(), ["secrets", "log", "--json"]);
        assert_eq!(
            log_args(Some("A_B"), Some("p1"), Some(99999)).unwrap(),
            ["secrets", "log", "--json", "--name=A_B", "--project=p1", "--limit=1000"]
        );
    }

    #[test]
    fn purge_needs_exactly_one_target() {
        assert!(purge_args(None, false).is_err());
        assert!(purge_args(Some("p1"), true).is_err());
        assert_eq!(
            purge_args(Some("p1"), false).unwrap(),
            ["secrets", "purge", "--json", "--project=p1"]
        );
        assert_eq!(purge_args(None, true).unwrap(), ["secrets", "purge", "--json", "--all"]);
        assert_eq!(
            purge_args(Some(" "), true).unwrap(),
            ["secrets", "purge", "--json", "--all"]
        );
    }

    #[test]
    fn approve_picks_exactly_one_answer() {
        assert_eq!(
            approve_args("ap-1", true).unwrap(),
            ["secrets", "approve", "--json", "--id=ap-1", "--allow"]
        );
        assert_eq!(
            approve_args("ap-1", false).unwrap(),
            ["secrets", "approve", "--json", "--id=ap-1", "--deny"]
        );
        assert!(approve_args("ap 1", true).is_err());
    }

    #[test]
    fn value_goes_to_stdin_as_json_and_never_to_argv() {
        let input = value_input(FAKE).unwrap();
        assert_eq!(
            String::from_utf8(input).unwrap(),
            format!(r#"{{"value":"{FAKE}"}}"#)
        );
        let escaped = value_input("dòng \"một\"\nhai").unwrap();
        let back: Value = serde_json::from_slice(&escaped).unwrap();
        assert_eq!(back["value"], "dòng \"một\"\nhai");

        let all: Vec<Vec<String>> = vec![
            set_args("DATABASE_URL", Some(std::path::Path::new("/tmp/d.txt"))).unwrap(),
            list_args(Some("p1")).unwrap(),
            log_args(Some("DATABASE_URL"), None, None).unwrap(),
            purge_args(None, true).unwrap(),
            approve_args("ap-1", true).unwrap(),
        ];
        assert!(all.iter().flatten().all(|a| !a.contains(FAKE)));
    }

    #[test]
    fn set_points_at_the_description_file() {
        let args = set_args("A_B", Some(std::path::Path::new("/tmp/mo-ta.txt"))).unwrap();
        assert_eq!(
            args,
            ["secrets", "set", "--json", "--name=A_B", "--description-file=/tmp/mo-ta.txt"]
        );
        assert_eq!(set_args("A_B", None).unwrap(), ["secrets", "set", "--json", "--name=A_B"]);
    }

    #[test]
    fn worker_error_text_prefers_stderr_then_json() {
        let json = br#"{"error":{"code":"store_locked","message":"Kho đang khoá."}}"#;
        assert_eq!(error_text(json, "Kho đang bị khoá.\n".as_bytes()), "Kho đang bị khoá.");
        assert_eq!(error_text(json, b"  \n"), "Kho đang khoá.");
        assert_eq!(
            error_text(b"", b""),
            "Worker báo lỗi mà không có chi tiết."
        );
        assert_eq!(
            error_text(b"khong phai json", b""),
            "Worker báo lỗi mà không có chi tiết."
        );
    }

    #[test]
    fn temp_description_is_removed_on_drop() {
        let guard = TempDescription::create("mô tả\nnhiều dòng").unwrap();
        let path = guard.0.clone();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "mô tả\nnhiều dòng");
        drop(guard);
        assert!(!path.exists());
    }

    #[test]
    fn wipe_zeroes_the_buffer() {
        let mut secret = FAKE.as_bytes().to_vec();
        wipe_bytes(&mut secret);
        assert!(secret.iter().all(|&b| b == 0));
    }
}
