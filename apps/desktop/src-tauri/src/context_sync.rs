//! Ngữ cảnh dùng chung của dự án (spec 029): nguồn, memory hub và chính sách đi qua `hive-worker context`. Worker kiểm
//! thư mục, ghi file cục bộ của từng CLI và sao lưu; ở đây chỉ chặn giá trị lạ trước khi thành tham số của sidecar và
//! đưa dữ liệu lớn qua file tạm (xoá sau khi chạy, kể cả khi lỗi).

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use tauri::AppHandle;

use crate::sidecar_command;

/// Nguồn là Markdown người dùng soạn; chặn file khổng lồ trước khi ghi ra đĩa.
const MAX_SOURCE_BYTES: usize = 1024 * 1024;
/// Memory hub đã bị sidecar cắt theo ngân sách token, nên bản nhận vào chỉ cần một trần rộng.
const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;

static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

fn arg(key: &str, value: impl std::fmt::Display) -> String {
    // `--key=value` để giá trị bắt đầu bằng `-` (tên thư mục lạ) không bị đọc thành cờ.
    format!("--{key}={value}")
}

fn base(action: &str) -> Vec<String> {
    vec!["context".into(), action.into(), "--json".into()]
}

fn text_arg(key: &str, value: &str, what: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("Thiếu {what}."));
    }
    if value.len() > max || value.chars().any(char::is_control) {
        return Err(format!("{what} không hợp lệ."));
    }
    Ok(arg(key, value))
}

fn project_arg(project: &str) -> Result<String, String> {
    text_arg("project", project, "khoá dự án", 300)
}

/// Id dự án của hub là UUID; worker cũng chỉ nhận id dạng này.
fn project_id_arg(id: &str) -> Result<String, String> {
    let id = id.trim();
    let uuid = id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        });
    if !uuid {
        return Err("Id dự án không hợp lệ.".into());
    }
    Ok(arg("project-id", id.to_ascii_lowercase()))
}

fn status_args(project: Option<&str>) -> Result<Vec<String>, String> {
    let mut args = base("status");
    if let Some(project) = project.map(str::trim).filter(|p| !p.is_empty()) {
        args.push(project_arg(project)?);
    }
    Ok(args)
}

fn enable_args(folder: &str, project_id: Option<&str>) -> Result<Vec<String>, String> {
    let mut args = base("enable");
    args.push(text_arg("folder", folder, "thư mục dự án", 4096)?);
    if let Some(id) = project_id.map(str::trim).filter(|i| !i.is_empty()) {
        args.push(project_id_arg(id)?);
    }
    Ok(args)
}

fn disable_args(project: &str) -> Result<Vec<String>, String> {
    let mut args = base("disable");
    args.push(project_arg(project)?);
    Ok(args)
}

fn save_source_args(project: &str, content_file: &str) -> Result<Vec<String>, String> {
    let mut args = base("save-source");
    args.push(project_arg(project)?);
    args.push(arg("content-file", content_file));
    Ok(args)
}

fn sync_args(
    project: &str,
    hub_file: Option<&str>,
    policy_file: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut args = base("sync");
    args.push(project_arg(project)?);
    if let Some(file) = hub_file {
        args.push(arg("hub-file", file));
    }
    if let Some(file) = policy_file {
        args.push(arg("policy-file", file));
    }
    Ok(args)
}

fn resolve_args(project: &str, target: &str, keep: &str) -> Result<Vec<String>, String> {
    if !matches!(target, "claude" | "codex" | "gemini" | "antigravity") {
        return Err("File đích phải là claude, codex, gemini hoặc antigravity.".into());
    }
    if !matches!(keep, "file" | "source") {
        return Err("Chỉ giữ được bản file hoặc bản nguồn.".into());
    }
    let mut args = base("resolve");
    args.push(project_arg(project)?);
    args.push(arg("target", target));
    args.push(arg("keep", keep));
    Ok(args)
}

fn migrate_args(project: &str, apply: bool) -> Result<Vec<String>, String> {
    let mut args = base("migrate");
    args.push(project_arg(project)?);
    if apply {
        args.push("--apply".into());
    }
    Ok(args)
}

/// File tạm chứa nguồn, memory hub hay chính sách. Xoá khi bị thả, nên mọi đường thoát (cả lỗi) đều dọn.
struct TempFile {
    path: PathBuf,
}

impl TempFile {
    fn create(label: &str, bytes: &[u8]) -> Result<Self, String> {
        let name = format!(
            "hive-context-{}-{}-{label}.tmp",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(name);
        // create_new: không ghi đè hay đi theo liên kết sẵn có ở đường dẫn đoán được.
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("Không tạo được file tạm: {e}"))?;
        // Bọc ngay sau khi tạo để ghi lỗi cũng xoá file.
        let temp = Self { path };
        file.write_all(bytes)
            .map_err(|e| format!("Không ghi được file tạm: {e}"))?;
        Ok(temp)
    }

    fn arg(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn json_temp(label: &str, value: &Value) -> Result<TempFile, String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err("Dữ liệu gửi cho worker quá lớn.".into());
    }
    TempFile::create(label, &bytes)
}

/// Kết quả của sidecar. Với `--json` lỗi nằm ở stdout dạng `{"error":{"code","message"}}` (stderr trống), nên đọc
/// message từ đó trước, rồi mới đến stderr.
fn parse_output(success: bool, stdout: &[u8], stderr: &[u8]) -> Result<Value, String> {
    let parsed: Option<Value> = serde_json::from_slice(stdout).ok();
    if let Some(message) = parsed
        .as_ref()
        .and_then(|v| v.get("error"))
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
    {
        return Err(message.to_string());
    }
    if !success {
        let msg = String::from_utf8_lossy(stderr).trim().to_string();
        return Err(if msg.is_empty() {
            "Worker báo lỗi mà không có chi tiết.".into()
        } else {
            msg
        });
    }
    parsed.ok_or_else(|| "Không đọc được kết quả của worker.".to_string())
}

/// Chạy `hive-worker context …`; `temps` sống đến khi sidecar thoát rồi mới bị xoá.
async fn run(app: &AppHandle, args: Vec<String>, temps: Vec<TempFile>) -> Result<Value, String> {
    let mut cmd = sidecar_command(app, args, vec![]).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = cmd.output();
        drop(temps);
        let out = out.map_err(|e| format!("Không chạy được worker: {e}"))?;
        parse_output(out.status.success(), &out.stdout, &out.stderr)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn context_status(app: AppHandle, project: Option<String>) -> Result<Value, String> {
    run(&app, status_args(project.as_deref())?, vec![]).await
}

#[tauri::command]
pub async fn context_enable(
    app: AppHandle,
    folder: String,
    project_id: Option<String>,
) -> Result<Value, String> {
    run(&app, enable_args(&folder, project_id.as_deref())?, vec![]).await
}

#[tauri::command]
pub async fn context_disable(app: AppHandle, project: String) -> Result<Value, String> {
    run(&app, disable_args(&project)?, vec![]).await
}

#[tauri::command]
pub async fn context_save_source(
    app: AppHandle,
    project: String,
    content: String,
) -> Result<Value, String> {
    if content.len() > MAX_SOURCE_BYTES {
        return Err("Nguồn ngữ cảnh quá lớn.".into());
    }
    // Kiểm khoá trước khi ghi file tạm.
    project_arg(&project)?;
    let file = TempFile::create("source", content.as_bytes())?;
    let args = save_source_args(&project, &file.arg())?;
    run(&app, args, vec![file]).await
}

#[tauri::command]
pub async fn context_sync(
    app: AppHandle,
    project: String,
    hub: Option<Value>,
    policy: Option<Value>,
) -> Result<Value, String> {
    project_arg(&project)?;
    let mut temps = Vec::new();
    let mut hub_file = None;
    let mut policy_file = None;
    if let Some(hub) = hub.filter(|v| !v.is_null()) {
        let file = json_temp("hub", &hub)?;
        hub_file = Some(file.arg());
        temps.push(file);
    }
    if let Some(policy) = policy.filter(|v| !v.is_null()) {
        let file = json_temp("policy", &policy)?;
        policy_file = Some(file.arg());
        temps.push(file);
    }
    let args = sync_args(&project, hub_file.as_deref(), policy_file.as_deref())?;
    run(&app, args, temps).await
}

#[tauri::command]
pub async fn context_resolve(
    app: AppHandle,
    project: String,
    target: String,
    keep: String,
) -> Result<Value, String> {
    run(&app, resolve_args(&project, &target, &keep)?, vec![]).await
}

#[tauri::command]
pub async fn context_migrate(
    app: AppHandle,
    project: String,
    apply: Option<bool>,
) -> Result<Value, String> {
    run(&app, migrate_args(&project, apply.unwrap_or(false))?, vec![]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_and_enable_pass_explicit_values() {
        assert_eq!(status_args(None).unwrap(), ["context", "status", "--json"]);
        assert_eq!(
            status_args(Some("  p_1 ")).unwrap(),
            ["context", "status", "--json", "--project=p_1"]
        );
        let id = "7F3C1B52-0A1E-4C0E-9D57-2F4C8F0B6A11";
        assert_eq!(
            enable_args("-thư mục", Some(id)).unwrap(),
            [
                "context",
                "enable",
                "--json",
                "--folder=-thư mục",
                "--project-id=7f3c1b52-0a1e-4c0e-9d57-2f4c8f0b6a11"
            ]
        );
        assert_eq!(
            enable_args("/work/app", None).unwrap(),
            ["context", "enable", "--json", "--folder=/work/app"]
        );
        assert!(enable_args("", None).is_err());
        assert!(enable_args("/x\n--project=p_1", None).is_err());
        assert!(enable_args("/work/app", Some("không-phải-uuid")).is_err());
    }

    #[test]
    fn project_key_cannot_become_a_flag() {
        assert_eq!(
            disable_args("-p_1").unwrap(),
            ["context", "disable", "--json", "--project=-p_1"]
        );
        for key in ["", "  ", "p_1\n--apply", "p_1\0"] {
            assert!(disable_args(key).is_err());
            assert!(migrate_args(key, true).is_err());
        }
    }

    #[test]
    fn sync_passes_only_the_files_it_was_given() {
        assert_eq!(
            sync_args("p_1", None, None).unwrap(),
            ["context", "sync", "--json", "--project=p_1"]
        );
        assert_eq!(
            sync_args("p_1", Some("/t/hub.tmp"), Some("/t/policy.tmp")).unwrap(),
            [
                "context",
                "sync",
                "--json",
                "--project=p_1",
                "--hub-file=/t/hub.tmp",
                "--policy-file=/t/policy.tmp"
            ]
        );
        assert_eq!(
            save_source_args("p_1", "/t/source.tmp").unwrap(),
            [
                "context",
                "save-source",
                "--json",
                "--project=p_1",
                "--content-file=/t/source.tmp"
            ]
        );
    }

    #[test]
    fn resolve_and_migrate_only_accept_known_values() {
        assert_eq!(
            resolve_args("p_1", "gemini", "file").unwrap(),
            [
                "context",
                "resolve",
                "--json",
                "--project=p_1",
                "--target=gemini",
                "--keep=file"
            ]
        );
        assert!(resolve_args("p_1", "cursor", "file").is_err());
        assert!(resolve_args("p_1", "claude", "both").is_err());
        assert_eq!(
            migrate_args("p_1", false).unwrap(),
            ["context", "migrate", "--json", "--project=p_1"]
        );
        assert_eq!(migrate_args("p_1", true).unwrap().last().unwrap(), "--apply");
    }

    #[test]
    fn temp_file_is_removed_when_dropped() {
        let file = TempFile::create("test", b"# Nguon\n").unwrap();
        let path = file.path.clone();
        assert_eq!(std::fs::read(&path).unwrap(), b"# Nguon\n");
        let other = TempFile::create("test", b"x").unwrap();
        assert_ne!(other.path, path);
        drop(file);
        assert!(!path.exists());
        assert!(other.path.exists());
    }

    #[test]
    fn json_temp_rejects_oversized_payload() {
        let big = Value::String("x".repeat(MAX_JSON_BYTES + 1));
        assert!(json_temp("hub", &big).is_err());
    }

    #[test]
    fn error_message_comes_from_stdout_json_before_stderr() {
        let out = r#"{"error":{"code":"not_found","message":"Dự án chưa bật ngữ cảnh."}}"#;
        assert_eq!(
            parse_output(false, out.as_bytes(), b"").unwrap_err(),
            "Dự án chưa bật ngữ cảnh."
        );
        assert_eq!(parse_output(false, b"", b" hỏng \n").unwrap_err(), "hỏng");
        assert_eq!(
            parse_output(false, b"", b"").unwrap_err(),
            "Worker báo lỗi mà không có chi tiết."
        );
        assert!(parse_output(true, b"khong phai json", b"").is_err());
    }

    #[test]
    fn parses_project_result_without_losing_conflict() {
        let raw = r##"{"key":"p_1","enabled":true,"targets":[{"id":"gemini","status":"conflict","reason":null,
            "conflict":{"file":"# Tại máy\n","source":"# Nguồn\n"}}],"locked":true}"##;
        let value = parse_output(true, raw.as_bytes(), b"").unwrap();
        assert_eq!(value["targets"][0]["conflict"]["source"], "# Nguồn\n");
        assert_eq!(value["locked"], true);
    }
}
