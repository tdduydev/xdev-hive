//! Thư mục làm việc (specs/008-desktop-v2 T008) và đọc dữ liệu hub cho các màn của app.

use crate::account::stored_token;
use crate::doctor::{run_with_timeout, user_path};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use tauri::AppHandle;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMeta {
    pub folder: String,
    pub name: String,
    pub is_git: bool,
    pub branch: Option<String>,
    /// URL của remote `origin`, để so với repo của dự án trên hub.
    pub remote: Option<String>,
}

fn git(folder: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(folder)
        .args(args)
        .env("PATH", user_path());
    let out = run_with_timeout(cmd, Duration::from_secs(5))?;
    (out.code == Some(0))
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

#[tauri::command]
pub async fn workspace_meta(folder: String) -> Result<WorkspaceMeta, String> {
    let path = std::path::PathBuf::from(folder.trim());
    if !path.is_dir() {
        return Err(format!("Không tìm thấy thư mục {}.", path.display()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Ba lệnh độc lập: chạy song song, màn chờ bằng lệnh chậm nhất thay vì cả ba cộng lại.
        let (branch, remote, inside) = std::thread::scope(|s| {
            let branch = s.spawn(|| git(&path, &["symbolic-ref", "--short", "HEAD"]));
            let remote = s.spawn(|| git(&path, &["remote", "get-url", "origin"]));
            let inside = git(&path, &["rev-parse", "--is-inside-work-tree"]);
            (
                branch.join().ok().flatten(),
                remote.join().ok().flatten(),
                inside,
            )
        });
        WorkspaceMeta {
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            is_git: inside.as_deref() == Some("true"),
            folder: path.to_string_lossy().into_owned(),
            branch,
            remote,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Tool của hub mà giao diện được gọi qua `hub_tool`: chỉ tool đọc. Tool ghi (đề xuất tài liệu, ghi memory) có lệnh
/// riêng khi màn cần, để không mở rộng quyền của cửa sổ app ngoài ý muốn.
pub const READ_TOOLS: &[&str] = &[
    "hive_whoami",
    "project_list",
    "doc_list",
    "doc_get",
    "skill_list",
    "skill_get",
    "memory_search",
    "run_list",
];

#[tauri::command]
pub async fn hub_tool(app: AppHandle, name: String, args: Value) -> Result<Value, String> {
    if !READ_TOOLS.contains(&name.as_str()) {
        return Err(format!("App không được gọi tool {name} của hub."));
    }
    let hub = crate::hub_of(&app).ok_or("Máy chưa đăng ký với hub nào.")?;
    let token = stored_token(&hub)
        .ok_or("Chưa liên kết tài khoản: mở thẻ người dùng ở góc dưới để dán token MCP.")?;
    crate::hub::call_tool(&hub, &token, &name, args)
        .await
        .map_err(|e| e.text())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_git_metadata_of_a_real_repo() {
        let dir = std::env::temp_dir().join(format!("hive-ws-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .output()
                .unwrap();
        };
        run(&["init", "-q", "-b", "trunk"]);
        run(&[
            "remote",
            "add",
            "origin",
            "git@github.com:acme/payment-api.git",
        ]);
        user_path();
        let mut fastest = std::time::Duration::MAX;
        let mut meta = None;
        for _ in 0..5 {
            let started = std::time::Instant::now();
            meta = Some(
                tauri::async_runtime::block_on(workspace_meta(dir.to_string_lossy().into_owned()))
                    .unwrap(),
            );
            fastest = fastest.min(started.elapsed());
        }
        eprintln!("workspace_meta (nhanh nhất trong 5 lần): {fastest:?}");
        let meta = meta.unwrap();
        assert!(meta.is_git);
        assert_eq!(meta.branch.as_deref(), Some("trunk"));
        assert_eq!(
            meta.remote.as_deref(),
            Some("git@github.com:acme/payment-api.git")
        );
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(
            tauri::async_runtime::block_on(workspace_meta("/khong/co/thu/muc".into())).is_err()
        );
    }

    #[test]
    fn only_read_tools_are_allowed() {
        assert!(READ_TOOLS.contains(&"doc_list"));
        assert!(!READ_TOOLS.contains(&"doc_propose"));
        assert!(!READ_TOOLS.contains(&"memory_write"));
    }
}
