//! Hộp thư đi trên máy (spec 029 T024). Hàng đợi là của worker (`hive-worker outbox`, spec 027): nó giữ việc trên đĩa,
//! gửi lại khi có mạng và gắn khoá chống trùng. Ở đây chỉ bọc lệnh của sidecar, không dựng hàng đợi thứ hai, nên app
//! tắt hay hub vắng thì việc đã xếp vẫn còn. Giao diện chỉ xếp được loại việc trong danh sách đóng; số liệu token và
//! điểm máy do worker tự xếp.

use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

use crate::sidecar_json;

/// Loại việc giao diện được xếp. `machine.token_score` và `project.token_usage` do worker tự xếp từ số đo của nó.
const SUBMIT_KINDS: &[&str] = &["memory.propose"];
/// Đề xuất memory tối đa 2000 ký tự; trần này chỉ chặn dữ liệu bất thường trước khi đi vào dòng lệnh.
const MAX_PAYLOAD_BYTES: usize = 16 * 1024;
/// Chờ sau khi mở app rồi mới gửi phần còn đọng, để việc gửi không tranh tài nguyên lúc khởi động.
const START_DELAY: Duration = Duration::from_secs(5);

fn base(sub: &str) -> Vec<String> {
    vec!["outbox".into(), sub.into(), "--json".into()]
}

/// Dùng dạng `--key=value` để nội dung bắt đầu bằng `-` không bị đọc thành cờ.
fn submit_args(kind: &str, payload: &Value) -> Result<Vec<String>, String> {
    if !SUBMIT_KINDS.contains(&kind) {
        return Err("Loại việc này không xếp từ giao diện được.".into());
    }
    if !payload.is_object() {
        return Err("Nội dung gửi không đúng dạng.".into());
    }
    let body = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    if body.len() > MAX_PAYLOAD_BYTES {
        return Err("Nội dung gửi quá lớn.".into());
    }
    let mut args = base("submit");
    args.push(format!("--kind={kind}"));
    args.push(format!("--payload={body}"));
    args.push("--source=desktop".into());
    Ok(args)
}

/// Khoá do worker sinh (`outbox.NewKey`), cùng dạng `idempotencyKey` của contracts: 16–64 ký tự chữ, số, `_`, `-`.
fn drop_args(key: &str) -> Result<Vec<String>, String> {
    // `drop` nhận khoá là đối số vị trí, nên khoá bắt đầu bằng `-` bị đọc thành cờ: từ chối.
    let valid = (16..=64).contains(&key.len())
        && !key.starts_with('-')
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !valid {
        return Err("Khoá việc không hợp lệ.".into());
    }
    Ok(vec!["outbox".into(), "drop".into(), key.into(), "--json".into()])
}

/// Số việc đang chờ, bị từ chối và quá hạn cùng danh sách việc (không kèm nội dung). Máy chưa đăng ký thì `registered: false`.
#[tauri::command]
pub async fn outbox_status(app: AppHandle) -> Result<Value, String> {
    sidecar_json(&app, base("status"), vec![]).await
}

/// Xếp một việc vào hộp thư đi. Trả mục vừa xếp (`state: "pending"`); gửi thật diễn ra ở lần `outbox_flush`.
#[tauri::command]
pub async fn outbox_submit(app: AppHandle, kind: String, payload: Value) -> Result<Value, String> {
    sidecar_json(&app, submit_args(&kind, &payload)?, vec![]).await
}

/// Thử gửi các việc đang chờ; mục nào hub chưa nhận thì ở lại hàng đợi với `nextAttemptAt` của worker.
#[tauri::command]
pub async fn outbox_flush(app: AppHandle) -> Result<Value, String> {
    sidecar_json(&app, base("flush"), vec![]).await
}

/// Gửi phần còn đọng từ lần trước khi mở app. Lỗi (hub vắng, máy chưa đăng ký) chỉ ghi log: việc vẫn nằm trong hàng đợi
/// và worker thử lại theo nhịp của nó.
pub fn start_flush(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(START_DELAY).await;
        if let Err(e) = sidecar_json::<Value>(&app, base("flush"), vec![]).await {
            eprintln!("Không gửi được hộp thư đi khi mở app: {e}");
        }
    });
}

/// Bỏ một việc khỏi hộp thư đi (người dùng đóng thẻ việc bị từ chối, hay không muốn gửi nữa).
#[tauri::command]
pub async fn outbox_drop(app: AppHandle, key: String) -> Result<Value, String> {
    sidecar_json(&app, drop_args(&key)?, vec![]).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload() -> Value {
        json!({
            "projectId": "0a0a0a0a-0000-4000-8000-000000000001",
            "kind": "note",
            "content": "--dùng pnpm"
        })
    }

    #[test]
    fn status_and_flush_args_are_fixed() {
        assert_eq!(base("status"), ["outbox", "status", "--json"]);
        assert_eq!(base("flush"), ["outbox", "flush", "--json"]);
    }

    #[test]
    fn submit_passes_kind_and_payload_as_one_argument_each() {
        let args = submit_args("memory.propose", &payload()).unwrap();
        assert_eq!(&args[..3], ["outbox", "submit", "--json"]);
        assert_eq!(args[3], "--kind=memory.propose");
        assert_eq!(args[5], "--source=desktop");
        // Nội dung bắt đầu bằng `-` vẫn là giá trị của `--payload=`, không thành cờ.
        let body: Value = serde_json::from_str(args[4].strip_prefix("--payload=").unwrap()).unwrap();
        assert_eq!(body, payload());
    }

    #[test]
    fn submit_rejects_kinds_the_worker_owns() {
        for kind in [
            "machine.token_score",
            "project.token_usage",
            "memory.write",
            "",
            "memory.propose ",
            "--config=/tmp/x",
        ] {
            assert!(submit_args(kind, &payload()).is_err(), "{kind}");
        }
    }

    #[test]
    fn submit_rejects_non_object_and_huge_payloads() {
        assert!(submit_args("memory.propose", &json!("text")).is_err());
        assert!(submit_args("memory.propose", &json!(["a"])).is_err());
        let huge = json!({ "content": "x".repeat(MAX_PAYLOAD_BYTES) });
        assert!(submit_args("memory.propose", &huge).is_err());
    }

    #[test]
    fn drop_accepts_worker_keys_only() {
        assert!(drop_args("01J9ZQ8M3K4N5P6R7S8T9V0W1X").is_ok());
        assert!(drop_args("abc_def-ghi_jkl-mno").is_ok());
        let too_long = "a".repeat(65);
        for key in [
            "",
            "short",
            "-01J9ZQ8M3K4N5P6R7S8T9V0W1X",
            "has space 0123456789abcdef",
            "../../etc/passwd/0123456789",
            "--config=/tmp/x/0123456789ab",
            too_long.as_str(),
        ] {
            assert!(drop_args(key).is_err(), "{key}");
        }
    }
}
