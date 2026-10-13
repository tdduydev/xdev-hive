//! Màn Dự án trên máy: dự án của hub gắn với thư mục repo trên máy và công tắc toàn quyền theo dự án, đọc và ghi qua
//! `hive-worker projects` (projects.json, ADR 0020). Worker kiểm thư mục và remote origin; ở đây chỉ chặn giá trị lạ
//! trước khi thành tham số của sidecar.

use tauri::AppHandle;

use crate::sidecar_json;

fn arg(key: &str, value: impl std::fmt::Display) -> String {
    // `--key=value` để giá trị bắt đầu bằng `-` (tên thư mục) không bị đọc thành cờ.
    format!("--{key}={value}")
}

/// Id dự án của hub là UUID; worker cũng chỉ báo hub id dạng này.
fn id_arg(id: &str) -> Result<String, String> {
    let id = id.trim();
    let uuid = id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        });
    if !uuid {
        return Err("Id dự án không hợp lệ.".into());
    }
    Ok(arg("id", id.to_ascii_lowercase()))
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

fn bind_args(
    id: &str,
    folder: &str,
    name: Option<&str>,
    repo_url: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut args = vec![
        "projects".into(),
        "bind".into(),
        id_arg(id)?,
        text_arg("folder", folder, "thư mục repo", 4096)?,
    ];
    if let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) {
        args.push(text_arg("name", name, "tên dự án", 200)?);
    }
    if let Some(url) = repo_url.map(str::trim).filter(|u| !u.is_empty()) {
        args.push(text_arg("repo-url", url, "URL repo", 1000)?);
    }
    args.push("--json".into());
    Ok(args)
}

fn unbind_args(id: Option<&str>, folder: Option<&str>) -> Result<Vec<String>, String> {
    let target = match (id, folder) {
        (Some(id), None) => id_arg(id)?,
        (None, Some(folder)) => text_arg("folder", folder, "thư mục repo", 4096)?,
        _ => return Err("Chọn đúng một dự án hoặc một thư mục để bỏ.".into()),
    };
    Ok(vec![
        "projects".into(),
        "unbind".into(),
        target,
        "--json".into(),
    ])
}

fn set_full_args(id: &str, full: bool) -> Result<Vec<String>, String> {
    Ok(vec![
        "projects".into(),
        "set".into(),
        id_arg(id)?,
        arg("full", full),
        "--json".into(),
    ])
}

/// Dự án đã gắn và repo chưa gắn trên máy, kèm trạng thái thư mục (còn không, có phải repo git, origin).
#[tauri::command]
pub async fn local_projects(app: AppHandle) -> Result<serde_json::Value, String> {
    sidecar_json(&app, vec!["projects".into(), "--json".into()], vec![]).await
}

/// Nhập projects[] của app v1 (~/.xdev-hive/config.json) một lần; projects.json đã có thì không làm gì.
#[tauri::command]
pub async fn local_projects_import(app: AppHandle) -> Result<serde_json::Value, String> {
    sidecar_json(
        &app,
        vec!["projects".into(), "import-legacy".into(), "--json".into()],
        vec![],
    )
    .await
}

/// Gắn dự án với thư mục repo; có repo_url thì worker từ chối khi remote origin không khớp.
#[tauri::command]
pub async fn local_project_bind(
    app: AppHandle,
    id: String,
    folder: String,
    name: Option<String>,
    repo_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let args = bind_args(&id, &folder, name.as_deref(), repo_url.as_deref())?;
    sidecar_json(&app, args, vec![]).await
}

/// Bỏ gắn một dự án, hoặc bỏ một repo chưa có dự án trên hub khỏi danh sách. Thư mục giữ nguyên.
#[tauri::command]
pub async fn local_project_unbind(
    app: AppHandle,
    id: Option<String>,
    folder: Option<String>,
) -> Result<serde_json::Value, String> {
    sidecar_json(&app, unbind_args(id.as_deref(), folder.as_deref())?, vec![]).await
}

/// Bật hoặc tắt toàn quyền của dự án trên máy này. Worker chỉ chạy toàn quyền khi tổ chức cũng cho phép.
#[tauri::command]
pub async fn local_project_set_full(
    app: AppHandle,
    id: String,
    full: bool,
) -> Result<serde_json::Value, String> {
    sidecar_json(&app, set_full_args(&id, full)?, vec![]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0A0A0A0A-0000-4000-8000-000000000003";

    #[test]
    fn bind_passes_values_as_single_arguments() {
        let args = bind_args(
            ID,
            "/Users/ha/-lạ",
            Some("payment-api"),
            Some("git@github.com:acme/app.git"),
        )
        .unwrap();
        assert_eq!(
            args,
            [
                "projects",
                "bind",
                "--id=0a0a0a0a-0000-4000-8000-000000000003",
                "--folder=/Users/ha/-lạ",
                "--name=payment-api",
                "--repo-url=git@github.com:acme/app.git",
                "--json"
            ]
        );
        let bare = bind_args(ID, "C:\\Work\\app", Some(" "), None).unwrap();
        assert_eq!(bare.len(), 5);
    }

    #[test]
    fn refuses_bad_ids_and_values() {
        assert!(bind_args("abc", "/x", None, None).is_err());
        assert!(bind_args("0a0a0a0a-0000-4000-8000-00000000000g", "/x", None, None).is_err());
        assert!(bind_args(ID, " ", None, None).is_err());
        assert!(bind_args(ID, "/x\n--full=true", None, None).is_err());
        assert!(bind_args(ID, "/x", None, Some("https://a\u{0}b")).is_err());
        assert!(unbind_args(None, None).is_err());
        assert!(unbind_args(Some(ID), Some("/x")).is_err());
        assert!(set_full_args("--full=true", true).is_err());
    }

    #[test]
    fn unbind_and_set_full() {
        assert_eq!(
            unbind_args(None, Some("/Users/ha/cu")).unwrap(),
            ["projects", "unbind", "--folder=/Users/ha/cu", "--json"]
        );
        assert_eq!(
            unbind_args(Some(ID), None).unwrap()[2],
            "--id=0a0a0a0a-0000-4000-8000-000000000003"
        );
        assert_eq!(set_full_args(ID, true).unwrap()[3], "--full=true");
        assert_eq!(set_full_args(ID, false).unwrap()[3], "--full=false");
    }
}
