//! CLI Hive qua socket để chỉ worker đang chạy sở hữu hàng đợi và thứ tự gửi của người dùng.
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;
use tokio::io::AsyncWriteExt;

/// Nội dung lớn đi qua stdin; CLI tự chuyển sang bodyFile khi vượt trần dòng socket.
pub(crate) async fn hive(
    app: &AppHandle,
    args: Vec<String>,
    input: Option<String>,
) -> Result<String, String> {
    let cmd: std::process::Command = app
        .shell()
        .sidecar("hive")
        .map_err(|e| format!("Không mở được lệnh Hive: {e}"))?
        .args(args)
        .into();
    let mut cmd = tokio::process::Command::from(cmd);
    cmd.kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Không chạy được lệnh Hive: {e}"))?;
    tokio::time::timeout(Duration::from_secs(45), async move {
        if let Some(mut stdin) = child.stdin.take()
            && let Some(input) = input
        {
            stdin
                .write_all(input.as_bytes())
                .await
                .map_err(|e| format!("Không gửi được nội dung cho Hive: {e}"))?;
        }
        let out = child
            .wait_with_output()
            .await
            .map_err(|e| format!("Không đọc được kết quả Hive: {e}"))?;
        if !out.status.success() {
            let message = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if message.is_empty() {
                "Sidecar hive-worker không chạy; mở worker rồi thử lại.".into()
            } else {
                message
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    })
    .await
    .map_err(|_| "Hive chưa trả lời; kiểm tra worker rồi thử lại.".to_string())?
}

async fn hive_json(
    app: &AppHandle,
    args: Vec<String>,
    input: Option<Value>,
) -> Result<Value, String> {
    let raw = hive(app, args, input.map(|v| v.to_string())).await?;
    serde_json::from_str(&raw).map_err(|e| format!("Không đọc được kết quả Hive: {e}"))
}

fn submit_request(kind: &str, payload: Value) -> Result<Value, String> {
    if !payload.is_object() {
        return Err("Nội dung gửi không đúng dạng.".into());
    }
    let (kind, transport, body, target) = match kind {
        "memory.propose" => ("memory.write", "rpc", json!({
            "scope": { "level": "project", "projectId": payload["projectId"] },
            "kind": payload["kind"], "content": payload["content"], "source": "machine",
        }), json!({ "type": "project", "id": payload["projectId"] })),
        "doc_propose" => ("doc_propose", "mcp", payload.clone(), json!({ "type": "doc", "id": payload["key"] })),
        "skill_propose" => ("skill_propose", "mcp", payload.clone(), json!({ "type": "skill", "id": payload["name"] })),
        _ => return Err("Loại việc này không xếp từ giao diện được.".into()),
    };
    Ok(json!({ "kind": kind, "transport": transport, "body": body, "target": target, "source": "desktop", "waitMs": 10000 }))
}

pub(crate) async fn submit(
    app: &AppHandle,
    kind: &str,
    payload: Value,
) -> Result<Value, String> {
    let request = submit_request(kind, payload)?;
    crate::account::sync_cli_login(app).await?;
    hive_json(app, submit_args(), Some(request)).await
}

fn submit_args() -> Vec<String> {
    vec!["outbox".into(), "submit".into(), "--json".into(), "-".into()]
}

fn key_args(sub: &str, key: &str) -> Result<Vec<String>, String> {
    if !(16..=64).contains(&key.len())
        || key.starts_with('-')
        || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("Khoá việc không hợp lệ.".into());
    }
    Ok(vec!["outbox".into(), sub.into(), key.into(), "--json".into()])
}

fn status_view(mut raw: Value) -> Value {
    let mut status = raw["status"].take();
    let mut items = raw["items"].take();
    if let Some(items) = items.as_array_mut() {
        for item in items {
            item["code"] = item["result"]["code"].clone();
            item["reason"] = item["result"]["reason"].clone();
        }
    }
    status["items"] = if items.is_array() { items } else { json!([]) };
    status
}

#[tauri::command]
pub async fn outbox_status(app: AppHandle) -> Result<Value, String> {
    hive_json(&app, vec!["outbox".into(), "--json".into()], None)
        .await
        .map(status_view)
}

/// Giữ command cũ cho sự kiện máy; mục của người dùng chỉ worker đang chạy được phép gửi.
#[tauri::command]
pub async fn outbox_flush(app: AppHandle) -> Result<Value, String> {
    crate::sidecar_json(
        &app,
        vec!["outbox".into(), "flush".into(), "--json".into()],
        vec![],
    )
    .await
}

#[tauri::command]
pub async fn outbox_submit(app: AppHandle, kind: String, payload: Value) -> Result<Value, String> {
    // Tài liệu và skill phải qua kiểm đầu vào của command riêng.
    if kind != "memory.propose" {
        return Err("Loại việc này không xếp từ giao diện được.".into());
    }
    submit(&app, &kind, payload).await
}

#[tauri::command]
pub async fn outbox_drop(app: AppHandle, key: String) -> Result<Value, String> {
    hive_json(&app, key_args("drop", &key)?, None).await
}

#[tauri::command]
pub async fn outbox_retry(app: AppHandle, key: String) -> Result<Value, String> {
    hive_json(&app, key_args("retry", &key)?, None).await
}

#[tauri::command]
pub async fn outbox_export(app: AppHandle, key: String) -> Result<Value, String> {
    let mut args = key_args("export", &key)?;
    let dialog = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        dialog.dialog().file()
            .set_file_name("hive-outbox.json")
            .add_filter("JSON", &["json"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("Không mở được hộp chọn file: {e}"))?;
    let Some(path) = path else {
        return Ok(Value::Null);
    };
    let path = path.into_path().map_err(|_| "Đường dẫn xuất không hợp lệ.")?;
    args.push(format!("-o={}", path.display()));
    hive_json(&app, args, None).await
}

pub(crate) fn logout_args(action: &str) -> Result<Vec<String>, String> {
    if !["send", "keep", "drop"].contains(&action) {
        return Err("Chọn Gửi trước, Giữ lại hoặc Bỏ.".into());
    }
    Ok(vec!["logout".into(), format!("--outbox={action}")])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proposals_use_stdin_and_fixed_kinds() {
        assert_eq!(submit_args(), ["outbox", "submit", "--json", "-"]);
        for kind in ["doc_propose", "skill_propose"] {
            let body = json!({ "key": "project.p.docs", "name": "test", "content": "--flag\nTiếng Việt" });
            let req = submit_request(kind, body.clone()).unwrap();
            assert_eq!(req["body"], body);
            assert_eq!(req["transport"], "mcp");
            assert_eq!(req["source"], "desktop");
        }
        assert!(submit_request("task_update", json!({})).is_err());
        assert!(submit_request("doc_propose", json!("text")).is_err());
        let large = "x".repeat(200_000);
        let req = submit_request("doc_propose", json!({ "key": "project.p.docs", "content": large })).unwrap();
        assert_eq!(req["body"]["content"].as_str().unwrap().len(), 200_000);
        assert_eq!(submit_args().len(), 4);
    }
    #[test]
    fn memory_stays_a_machine_proposal_with_user_identity() {
        let req = submit_request("memory.propose", json!({ "projectId": "p", "kind": "note", "content": "x" })).unwrap();
        assert_eq!(req["kind"], "memory.write");
        assert_eq!(req["transport"], "rpc");
        assert_eq!(req["body"]["source"], "machine");
        assert_eq!(req["body"]["scope"], json!({ "level": "project", "projectId": "p" }));
    }
    #[test]
    fn validates_keys_and_logout_actions() {
        let key = "01J9ZQ8M3K4N5P6R7S8T9V0W1X";
        for sub in ["drop", "retry", "export"] {
            assert_eq!(key_args(sub, key).unwrap(), ["outbox", sub, key, "--json"]);
            for bad in ["", "--config=/tmp/x", "../../0123456789abcdef", "has space 0123456789"] {
                assert!(key_args(sub, bad).is_err());
            }
        }
        for action in ["send", "keep", "drop"] {
            assert_eq!(logout_args(action).unwrap(), vec!["logout".to_string(), format!("--outbox={action}")]);
        }
        assert!(logout_args("--help").is_err());
        assert!(key_args("retry", &"x".repeat(65)).is_err());
    }
    #[test]
    fn exposes_hub_rejection_and_health() {
        let view = status_view(json!({ "status": { "hub": "down", "pending": 3 }, "items": [
            { "key": "k", "state": "rejected", "result": { "code": "CONFLICT", "reason": "Đã đổi" } }
        ] }));
        assert_eq!(view["hub"], "down");
        assert_eq!(view["items"][0]["code"], "CONFLICT");
        assert_eq!(view["items"][0]["reason"], "Đã đổi");
    }
}
