//! Danh tính người dùng của app desktop (specs/008-desktop-v2 T023, DESK-09).
//!
//! Token máy của worker (`hwm_…`) là của máy, không dùng thay người. Người dùng dán token MCP cá nhân (`hive_pat_…`,
//! tạo ở web: MCP và công cụ → Token MCP); app lưu nó trong keychain của hệ điều hành theo địa chỉ hub, không ghi ra
//! file, và không bao giờ trả token về giao diện. Hồ sơ menu (lead/dev/writer) giao diện tự tính từ vai trò trả về.

use crate::hub::{HubError, call_tool};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::AppHandle;

const SERVICE: &str = "dev.xdev.hive";

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub name: String,
    pub role: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub name: String,
    pub email: String,
    pub org_id: String,
    pub org_name: String,
    pub org_role: Option<String>,
    pub teams: Vec<Team>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    /// Hub máy đã đăng ký; chưa đăng ký máy thì chưa liên kết được.
    pub hub: Option<String>,
    pub linked: bool,
    pub account: Option<Account>,
    /// Có token nhưng hub từ chối hoặc không gọi được.
    pub error: Option<String>,
}

/// Đọc kết quả của `hive_whoami`.
pub fn parse_whoami(v: &Value) -> Option<Account> {
    let s = |x: &Value| x.as_str().map(String::from);
    Some(Account {
        name: s(&v["user"]["name"]).unwrap_or_default(),
        email: s(&v["user"]["email"]).unwrap_or_default(),
        org_id: s(&v["org"]["id"])?,
        org_name: s(&v["org"]["name"]).unwrap_or_default(),
        org_role: s(&v["org"]["role"]),
        teams: v["teams"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|t| {
                        Some(Team {
                            id: s(&t["id"])?,
                            name: s(&t["name"]).unwrap_or_default(),
                            role: s(&t["role"])?,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Token cá nhân có dạng `hive_pat_<id tổ chức>_<bí mật>`; kiểm sơ trước khi gửi lên hub.
pub fn looks_like_pat(token: &str) -> bool {
    let t = token.trim();
    t.starts_with("hive_pat_") && t.len() > 50 && !t.contains(char::is_whitespace)
}

fn entry(hub: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, hub.trim_end_matches('/'))
        .map_err(|e| format!("Không mở được keychain của máy: {e}"))
}

pub(crate) fn stored_token(hub: &str) -> Option<String> {
    entry(hub).ok()?.get_password().ok()
}

async fn whoami(hub: &str, token: &str) -> Result<Account, HubError> {
    let v = call_tool(hub, token, "hive_whoami", json!({})).await?;
    parse_whoami(&v).ok_or_else(|| HubError::Message("Hub không trả thông tin tài khoản.".into()))
}

async fn status_for(hub: Option<String>) -> AccountStatus {
    let Some(hub) = hub else {
        return AccountStatus::default();
    };
    let Some(token) = stored_token(&hub) else {
        return AccountStatus {
            hub: Some(hub),
            ..Default::default()
        };
    };
    match whoami(&hub, &token).await {
        Ok(account) => AccountStatus {
            hub: Some(hub),
            linked: true,
            account: Some(account),
            error: None,
        },
        Err(e) => AccountStatus {
            hub: Some(hub),
            linked: true,
            account: None,
            error: Some(e.text()),
        },
    }
}

#[tauri::command]
pub async fn account_status(app: AppHandle) -> Result<AccountStatus, String> {
    Ok(status_for(crate::hub_of(&app)).await)
}

/// Kiểm token với hub rồi mới lưu: token sai không bao giờ vào keychain.
#[tauri::command]
pub async fn account_link(app: AppHandle, token: String) -> Result<AccountStatus, String> {
    let hub = crate::hub_of(&app).ok_or("Máy chưa đăng ký với hub nào. Đăng ký máy trước.")?;
    let token = token.trim().to_string();
    if !looks_like_pat(&token) {
        return Err("Đây không phải token MCP cá nhân (bắt đầu bằng hive_pat_).".into());
    }
    save_checked(&hub, &token).await?;
    Ok(status_for(Some(hub)).await)
}

/// Kiểm token với hub rồi lưu vào keychain; đăng nhập bằng trình duyệt cũng đi qua đây.
pub(crate) async fn save_checked(hub: &str, token: &str) -> Result<(), String> {
    whoami(hub, token).await.map_err(|e| e.text())?;
    entry(hub)?
        .set_password(token)
        .map_err(|e| format!("Không lưu được token vào keychain: {e}"))
}

#[tauri::command]
pub async fn account_unlink(app: AppHandle) -> Result<AccountStatus, String> {
    if let Some(hub) = crate::hub_of(&app) {
        if let Ok(e) = entry(&hub) {
            // Chưa có token thì coi như đã gỡ.
            let _ = e.delete_credential();
        }
    }
    Ok(status_for(crate::hub_of(&app)).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_whoami_with_teams() {
        let v = json!({
            "kind": "user",
            "user": { "id": "u1", "name": "Phạm Hà", "email": "ha@acme.vn" },
            "org": { "id": "o1", "slug": "acme", "name": "Acme", "role": "member" },
            "teams": [{ "id": "t1", "name": "Thanh toán", "role": "admin" }, { "id": "t2", "role": "viewer" }]
        });
        let a = parse_whoami(&v).unwrap();
        assert_eq!(a.name, "Phạm Hà");
        assert_eq!(a.org_role.as_deref(), Some("member"));
        assert_eq!(a.teams.len(), 2);
        assert_eq!(
            a.teams[0],
            Team {
                id: "t1".into(),
                name: "Thanh toán".into(),
                role: "admin".into()
            }
        );
        // Hub cũ chưa trả teams: vẫn đọc được, danh sách rỗng.
        let old = json!({ "user": { "name": "A" }, "org": { "id": "o1", "role": "owner" } });
        assert!(parse_whoami(&old).unwrap().teams.is_empty());
        assert!(parse_whoami(&json!({ "user": {} })).is_none());
    }

    #[test]
    fn checks_pat_shape_before_calling_hub() {
        let good = format!(
            "hive_pat_0a0a0a0a-0000-4000-8000-00000000000a_{}",
            "x".repeat(43)
        );
        assert!(looks_like_pat(&good));
        assert!(looks_like_pat(&format!("  {good}\n")));
        assert!(!looks_like_pat("hwm_machine_token"));
        assert!(!looks_like_pat("hive_pat_short"));
    }
}
