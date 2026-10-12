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
