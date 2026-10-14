//! Dùng preset và bản sao lưu của sidecar để không có hai nguồn cấu hình tối ưu trong app và worker.

use tauri::AppHandle;

use crate::sidecar_json;

fn args(action: &str) -> Vec<String> {
    vec!["optimize".into(), action.into(), "--json".into()]
}

fn profile_arg(profile: &str) -> Result<String, String> {
    let profile = profile.trim();
    if profile.is_empty() || profile.chars().any(char::is_control) {
        return Err("Thiếu id hợp lệ của gói.".into());
    }
    // Giá trị bắt đầu bằng dấu '-' vẫn là id, không trở thành cờ của worker.
    Ok(format!("--profile={profile}"))
}

fn profile_args(action: &str, profile: &str) -> Result<Vec<String>, String> {
    let mut args = args(action);
    args.push(profile_arg(profile)?);
    Ok(args)
}

fn enable_args(profile: &str, level: &str, rtk: bool) -> Result<Vec<String>, String> {
    if !matches!(level, "balanced" | "aggressive") {
        return Err("Mức tối ưu phải là balanced hoặc aggressive.".into());
    }
    let mut args = profile_args("enable", profile)?;
    args.push(format!("--level={level}"));
    if rtk {
        args.push("--rtk".into());
    }
    Ok(args)
}

fn restore_args(profile: &str, backup: Option<&str>) -> Result<Vec<String>, String> {
    let mut args = profile_args("restore", profile)?;
    if let Some(backup) = backup {
        if backup.trim().is_empty() || backup.chars().any(char::is_control) {
            return Err("Mốc bản sao lưu không hợp lệ.".into());
        }
        args.push(format!("--backup={backup}"));
    }
    Ok(args)
}

fn report_args(profile: Option<&str>, days: Option<u32>) -> Result<Vec<String>, String> {
    let mut args = args("report");
    if let Some(profile) = profile {
        args.push(profile_arg(profile)?);
    }
    if let Some(days) = days {
        args.push(format!("--days={days}"));
    }
    Ok(args)
}

#[tauri::command]
pub async fn optimizer_status(app: AppHandle) -> Result<serde_json::Value, String> {
    sidecar_json(&app, args("status"), vec![]).await
}

#[tauri::command]
pub async fn optimizer_enable(
    app: AppHandle,
    profile: String,
    level: String,
    rtk: Option<bool>,
) -> Result<serde_json::Value, String> {
    sidecar_json(
        &app,
        enable_args(&profile, &level, rtk.unwrap_or(false))?,
        vec![],
    )
    .await
}

#[tauri::command]
pub async fn optimizer_disable(
    app: AppHandle,
    profile: String,
) -> Result<serde_json::Value, String> {
    sidecar_json(&app, profile_args("disable", &profile)?, vec![]).await
}

#[tauri::command]
pub async fn optimizer_restore(
    app: AppHandle,
    profile: String,
    backup: Option<String>,
) -> Result<serde_json::Value, String> {
    sidecar_json(&app, restore_args(&profile, backup.as_deref())?, vec![]).await
}

#[tauri::command]
pub async fn optimizer_report(
    app: AppHandle,
    profile: Option<String>,
    days: Option<u32>,
) -> Result<serde_json::Value, String> {
    sidecar_json(&app, report_args(profile.as_deref(), days)?, vec![]).await
}

pub(crate) fn link_on_start(app: &AppHandle) {
    let app = app.clone();
    // Liên kết ổn định phải được cập nhật cả khi máy chưa đăng ký với hub.
    tauri::async_runtime::spawn(async move {
        if let Err(e) = sidecar_json::<serde_json::Value>(&app, args("link"), vec![]).await {
            eprintln!("Không cập nhật được liên kết bộ tối ưu: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enable_only_passes_explicit_profile_and_known_preset() {
        assert_eq!(
            enable_args("-gói có khoảng trắng", "aggressive", true).unwrap(),
            [
                "optimize",
                "enable",
                "--json",
                "--profile=-gói có khoảng trắng",
                "--level=aggressive",
                "--rtk"
            ]
        );
        assert!(
            !enable_args("claude", "balanced", false)
                .unwrap()
                .contains(&"--rtk".into())
        );
        assert!(enable_args("claude", "off", false).is_err());
        for profile in ["", "  ", "x\n--rtk", "x\0"] {
            assert!(profile_args("disable", profile).is_err());
        }
    }

    #[test]
    fn restore_and_report_preserve_optional_flags() {
        assert_eq!(
            restore_args("codex", None).unwrap(),
            ["optimize", "restore", "--json", "--profile=codex"]
        );
        assert_eq!(
            restore_args("codex", Some("20261014T000000Z"))
                .unwrap()
                .last()
                .unwrap(),
            "--backup=20261014T000000Z"
        );
        assert!(restore_args("codex", Some("\n")).is_err());
        assert_eq!(
            report_args(None, None).unwrap(),
            ["optimize", "report", "--json"]
        );
        assert_eq!(
            report_args(Some("claude-2"), Some(7)).unwrap(),
            [
                "optimize",
                "report",
                "--json",
                "--profile=claude-2",
                "--days=7"
            ]
        );
        assert_eq!(args("link"), ["optimize", "link", "--json"]);
    }

    #[test]
    fn parses_sidecar_status_and_mutation_without_losing_warnings() {
        let value: serde_json::Value = serde_json::from_str(r#"{
            "statePath":"C:\\Users\\dev\\.xdev-hive\\optimizer\\state.json",
            "linkPath":"C:\\Users\\dev\\.xdev-hive\\bin\\hive-worker.exe",
            "profiles":[{"id":"claude-2","cli":"claude","supported":true,"enabled":true,
                "level":"balanced","version":"2.1.299","inAccounts":true,
                "skipped":[{"key":"hooks.PostToolUse","reason":"CLI chưa hỗ trợ"}],"backups":["20261014T000000Z"]}],
            "result":{"profile":"claude-2","changed":true,"warnings":[{"key":"env.X","kind":"user_set","message":"Giữ giá trị của người dùng"}]}
        }"#).unwrap();
        assert_eq!(value["profiles"][0]["level"], "balanced");
        assert_eq!(
            value["profiles"][0]["skipped"][0]["reason"],
            "CLI chưa hỗ trợ"
        );
        assert_eq!(value["result"]["warnings"][0]["kind"], "user_set");
    }

    #[test]
    fn parses_report_with_before_after_and_optional_rtk() {
        let value: serde_json::Value = serde_json::from_str(r#"{
            "days":7,"sessions":8,"bySource":{"claude/interactive":{"sessions":8,"calls":20}},"versions":["2.1.299"],
            "split":{"cutoff":"2026-10-14T00:00:00Z","before":{"bySource":{}},"after":{"bySource":{}},"sessionsBefore":3,"sessionsAfter":5},
            "trimmed":{"entries":1,"charsBefore":30000,"charsAfter":12000,"charsCut":18000,"byTool":{"Bash":{"entries":1,"charsCut":18000}}},"rtkGain":{"saved_tokens":42}
        }"#).unwrap();
        assert_eq!(value["split"]["sessionsAfter"], 5);
        assert_eq!(value["bySource"]["claude/interactive"]["calls"], 20);
        assert_eq!(value["trimmed"]["charsCut"], 18000);
        assert_eq!(value["rtkGain"]["saved_tokens"], 42);
        let empty: serde_json::Value =
            serde_json::from_str(r#"{"days":"all","sessions":0,"bySource":{},"versions":null}"#)
                .unwrap();
        assert!(empty.get("split").is_none());
    }
}
