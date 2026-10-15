//! Gọi tool MCP của hub bằng token cá nhân (`hive_pat_…`, MCP-07) thay cho người dùng. Hub chạy MCP không giữ phiên
//! nên mỗi lời gọi là một `tools/call` độc lập, không cần `initialize` trước.

use serde_json::{Value, json};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(20);

/// Lỗi gọi hub, đã thành câu tiếng Việt cho người dùng. `Unauthorized` để app biết token hỏng mà hỏi lại.
#[derive(Debug, PartialEq)]
pub enum HubError {
    Unauthorized,
    Message(String),
}

impl HubError {
    pub fn text(&self) -> String {
        match self {
            HubError::Unauthorized => {
                "Token không còn dùng được (sai, hết hạn hoặc đã thu hồi). Tạo token mới ở web: MCP và công cụ → Token MCP."
                    .into()
            }
            HubError::Message(m) => m.clone(),
        }
    }
}

/// Lấy JSON-RPC trả về: hub trả `application/json`, hoặc SSE (`data: {...}`) khi client nhận cả hai.
pub fn parse_rpc_body(content_type: &str, body: &str) -> Result<Value, HubError> {
    let raw = if content_type.contains("text/event-stream") {
        body.lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .map(str::trim)
            .rfind(|l| !l.is_empty())
            .ok_or_else(|| HubError::Message("Hub trả luồng rỗng.".into()))?
            .to_string()
    } else {
        body.to_string()
    };
    serde_json::from_str(&raw)
        .map_err(|_| HubError::Message("Hub trả dữ liệu không đọc được.".into()))
}

/// Kết quả của `tools/call`: tool trả JSON trong `content[0].text`; `isError` là lỗi nghiệp vụ, câu đã là tiếng Việt.
pub fn tool_result(rpc: &Value) -> Result<Value, HubError> {
    if let Some(err) = rpc.get("error") {
        let message = err["message"].as_str().unwrap_or("Hub báo lỗi.");
        return Err(HubError::Message(message.to_string()));
    }
    let result = &rpc["result"];
    let text = result["content"][0]["text"].as_str().unwrap_or_default();
    if result["isError"].as_bool() == Some(true) {
        return Err(HubError::Message(if text.is_empty() {
            "Tool của hub báo lỗi.".into()
        } else {
            text.to_string()
        }));
    }
    serde_json::from_str(text).or(Ok(Value::String(text.to_string())))
}

/// `POST {hub}/mcp` với `tools/call`. Không ghi token vào log hay vào lỗi trả về.
pub async fn call_tool(hub: &str, token: &str, tool: &str, args: Value) -> Result<Value, HubError> {
    let url = format!("{}/mcp", hub.trim_end_matches('/'));
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": args } });
    let response = crate::tls::client()
        .map_err(HubError::Message)?
        .post(&url)
        .timeout(TIMEOUT)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| HubError::Message(format!("Không kết nối được hub: {}", e.without_url())))?;
    if response.status().as_u16() == 401 {
        return Err(HubError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(HubError::Message(format!(
            "Hub trả mã {}.",
            response.status().as_u16()
        )));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let text = response
        .text()
        .await
        .map_err(|_| HubError::Message("Không đọc được phản hồi của hub.".into()))?;
    tool_result(&parse_rpc_body(&content_type, &text)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_json_and_sse_bodies() {
        let json_body =
            r#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"a\":1}"}]}}"#;
        assert_eq!(
            tool_result(&parse_rpc_body("application/json", json_body).unwrap()).unwrap(),
            json!({ "a": 1 })
        );
        let sse = format!("event: message\ndata: {json_body}\n\n");
        assert_eq!(
            tool_result(&parse_rpc_body("text/event-stream", &sse).unwrap()).unwrap(),
            json!({ "a": 1 })
        );
        assert!(parse_rpc_body("text/event-stream", "event: ping\n\n").is_err());
    }

    #[test]
    fn tool_errors_keep_the_hub_message() {
        let rpc = json!({ "result": { "isError": true, "content": [{ "type": "text", "text": "Bạn không phải thành viên của tổ chức này." }] } });
        assert_eq!(
            tool_result(&rpc),
            Err(HubError::Message(
                "Bạn không phải thành viên của tổ chức này.".into()
            ))
        );
        let rpc = json!({ "error": { "code": -32001, "message": "Cổng MCP qua http chỉ nhận run token hoặc token MCP cá nhân." } });
        assert!(
            matches!(tool_result(&rpc), Err(HubError::Message(m)) if m.contains("token MCP cá nhân"))
        );
    }

    #[test]
    fn unauthorized_text_does_not_leak_anything() {
        assert!(HubError::Unauthorized.text().contains("Token MCP"));
    }
}

/// Tổ chức của token cá nhân: `hive_pat_<id tổ chức>_<bí mật>`. Hub chỉ nhận token đúng tổ chức (header `x-hive-org`).
pub fn org_of_pat(token: &str) -> Option<&str> {
    let rest = token.strip_prefix("hive_pat_")?;
    let (org, secret) = rest.split_at_checked(36)?;
    (secret.starts_with('_')
        && org.len() == 36
        && org.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
    .then_some(org)
}

/// Đường dẫn RPC của hub mà giao diện được gọi: chỉ `/rpc/<thủ tục>` (kèm query của GET), không đi ra ngoài hub.
pub fn safe_rpc_path(path: &str) -> bool {
    path.starts_with("/rpc/")
        && !path.contains("..")
        && !path.contains("//")
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/_-.?=&%+".contains(c))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcReply {
    pub status: u16,
    pub content_type: String,
    pub body: String,
}

/// Gọi RPC của hub bằng token cá nhân trong keychain (spec 008 FR-026): giao diện dùng đúng hợp đồng của web
/// (`packages/contracts`) mà không bao giờ thấy token.
#[tauri::command]
pub async fn hub_rpc(
    app: tauri::AppHandle,
    method: String,
    path: String,
    body: Option<String>,
    content_type: Option<String>,
) -> Result<RpcReply, String> {
    if method != "GET" && method != "POST" {
        return Err("Phương thức không được phép.".into());
    }
    if !safe_rpc_path(&path) {
        return Err("Đường dẫn không hợp lệ.".into());
    }
    let hub = crate::hub_of(&app).ok_or("Máy chưa đăng ký với hub nào.")?;
    let token = crate::account::stored_token(&hub)
        .ok_or("Chưa liên kết tài khoản. Đăng nhập bằng trình duyệt hoặc dán token cá nhân ở mục Tài khoản.")?;
    let org = org_of_pat(&token).ok_or("Token đã lưu không đúng dạng; liên kết lại tài khoản.")?;
    let url = format!("{}{}", hub.trim_end_matches('/'), path);
    let client = crate::tls::client()?;
    let mut request = if method == "GET" {
        client.get(&url)
    } else {
        client.post(&url)
    };
    request = request
        .timeout(TIMEOUT)
        .header("authorization", format!("Bearer {token}"))
        .header("x-hive-org", org);
    if let Some(ct) = content_type {
        request = request.header("content-type", ct);
    }
    if let Some(b) = body {
        request = request.body(b);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Không gọi được hub: {e}"))?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Không đọc được trả lời của hub: {e}"))?;
    Ok(RpcReply {
        status,
        content_type,
        body,
    })
}

#[cfg(test)]
mod rpc_tests {
    use super::*;

    #[test]
    fn reads_org_from_personal_token() {
        let org = "0a0a0a0a-0000-4000-8000-00000000000a";
        assert_eq!(
            org_of_pat(&format!("hive_pat_{org}_{}", "s".repeat(43))),
            Some(org)
        );
        assert_eq!(org_of_pat("hive_pat_short"), None);
        assert_eq!(org_of_pat(&format!("hwm_{org}_x")), None);
        assert_eq!(org_of_pat(&format!("hive_pat_{}_x", "z".repeat(36))), None);
    }

    #[test]
    fn only_rpc_paths_of_the_hub() {
        assert!(safe_rpc_path("/rpc/docEditor/state"));
        assert!(safe_rpc_path("/rpc/teams/list?data=%7B%7D"));
        assert!(!safe_rpc_path("/api/auth/sign-out"));
        assert!(!safe_rpc_path("/rpc/../api/auth"));
        assert!(!safe_rpc_path("//evil.com/rpc/x"));
        assert!(!safe_rpc_path("/rpc/x#frag"));
    }
}
