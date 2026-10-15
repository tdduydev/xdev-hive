//! Danh tính người dùng của app desktop (specs/008-desktop-v2 T023, DESK-09).
//!
//! Token máy của worker (`hwm_…`) là của máy, không dùng thay người. Người dùng dán token MCP cá nhân (`hive_pat_…`,
//! tạo ở web: MCP và công cụ → Token MCP); app lưu nó trong keychain của hệ điều hành theo địa chỉ hub, không ghi ra
//! file, và không bao giờ trả token về giao diện. Hồ sơ menu (lead/dev/writer) giao diện tự tính từ vai trò trả về.

use crate::hub::{HubError, call_tool};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};

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
    save_checked(&app, &hub, &token).await?;
    Ok(status_for(Some(hub)).await)
}

/// Kiểm token với hub rồi lưu vào keychain; đăng nhập bằng trình duyệt cũng đi qua đây.
pub(crate) async fn save_checked(app: &AppHandle, hub: &str, token: &str) -> Result<(), String> {
    whoami(hub, token).await.map_err(|e| e.text())?;
    // Token mới có thể là người khác hay tổ chức khác: bản artifact đã đệm của token cũ không còn là của họ.
    if let Some(old) = stored_token(hub).filter(|old| old != token) {
        crate::artifacts::forget(app, hub, &old);
    }
    entry(hub)?
        .set_password(token)
        .map_err(|e| format!("Không lưu được token vào keychain: {e}"))
}

/// Sự kiện báo cửa sổ app đọc lại tài khoản: đăng xuất từ khay không đi qua giao diện.
pub const CHANGED_EVENT: &str = "account-changed";

/// Đăng xuất người dùng khỏi Hive trên máy này: gỡ token cá nhân khỏi keychain. Không gỡ đăng ký máy: worker giữ token
/// máy riêng (`hwm_…`) và vẫn nhận việc. Mọi lệnh cần hub đọc token ở keychain mỗi lần gọi, nên gỡ token là đủ dừng
/// chúng. Trả về false khi máy chưa có token để gỡ.
pub(crate) fn sign_out(app: &AppHandle) -> bool {
    let Some(hub) = crate::hub_of(app) else {
        return false;
    };
    let old = stored_token(&hub);
    // Đăng xuất bỏ luôn bản đọc offline (FR-091).
    if let Some(old) = &old {
        crate::artifacts::forget(app, &hub, old);
    }
    if let Ok(e) = entry(&hub) {
        // Chưa có token thì coi như đã gỡ.
        let _ = e.delete_credential();
    }
    let _ = app.emit(CHANGED_EVENT, ());
    old.is_some()
}

/// Câu hỏi xác nhận trước khi đăng xuất, cùng nội dung với hộp xác nhận trong cửa sổ app.
pub fn sign_out_prompt(en: bool) -> (&'static str, &'static str, &'static str, &'static str) {
    if en {
        (
            "Sign out of Hive?",
            "Your personal token is removed from this machine's keychain and offline docs are cleared. The machine stays registered: the worker keeps taking runs, and agent plans, projects and tools on this machine keep working.",
            "Sign out",
            "Cancel",
        )
    } else {
        (
            "Đăng xuất khỏi Hive?",
            "Token cá nhân bị gỡ khỏi keychain của máy và bản đọc offline bị xoá. Máy vẫn đăng ký với hub: worker vẫn nhận việc, gói agent, dự án và công cụ trên máy vẫn dùng được.",
            "Đăng xuất",
            "Huỷ",
        )
    }
}

#[tauri::command]
pub async fn account_unlink(app: AppHandle) -> Result<AccountStatus, String> {
    sign_out(&app);
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
