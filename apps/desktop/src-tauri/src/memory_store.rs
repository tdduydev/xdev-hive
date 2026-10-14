//! Worker kiểm file đã quét và sao lưu mọi thao tác; app không tự ghi trực tiếp vào memory của CLI.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::AppHandle;

use crate::sidecar_json;

#[derive(Deserialize, Debug)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum MemoryAction {
    Edit {
        path: String,
        content: String,
    },
    Delete {
        path: String,
    },
    Restore {
        id: String,
    },
    Merge {
        sources: Vec<String>,
        target: String,
        content: String,
    },
    Share {
        project: String,
        folder: Option<String>,
        #[serde(default)]
        picks: BTreeMap<String, String>,
    },
    Unshare {
        project: String,
    },
}

impl MemoryAction {
    fn content(&self) -> Option<&str> {
        match self {
            Self::Edit { content, .. } | Self::Merge { content, .. } => Some(content),
            _ => None,
        }
    }
}

fn text_arg(key: &str, value: &str) -> Result<String, String> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(format!("Giá trị --{key} không hợp lệ."));
    }
    // Đường dẫn có khoảng trắng, dấu nháy hoặc dấu '-' được giữ trong một đối số.
    Ok(format!("--{key}={value}"))
}

fn scan_args() -> Vec<String> {
    vec!["memory".into(), "scan".into(), "--json".into()]
}

fn apply_args(action: &MemoryAction, content_file: Option<&Path>) -> Result<Vec<String>, String> {
    let name = match action {
        MemoryAction::Edit { .. } => "edit",
        MemoryAction::Delete { .. } => "delete",
        MemoryAction::Restore { .. } => "restore",
        MemoryAction::Merge { .. } => "merge",
        MemoryAction::Share { .. } => "share",
        MemoryAction::Unshare { .. } => "unshare",
    };
    let mut args = vec!["memory".into(), name.into(), "--json".into()];
    match action {
        MemoryAction::Edit { path, .. } | MemoryAction::Delete { path } => {
            args.push(text_arg("path", path)?);
        }
        MemoryAction::Restore { id } => args.push(text_arg("id", id)?),
        MemoryAction::Merge {
            sources, target, ..
        } => {
            if sources.is_empty() {
                return Err("Chọn ít nhất một file nguồn để gộp.".into());
            }
            for source in sources {
                args.push(text_arg("source", source)?);
            }
            args.push(text_arg("target", target)?);
        }
        MemoryAction::Share {
            project,
            folder,
            picks,
        } => {
            args.push(text_arg("project", project)?);
            if let Some(folder) = folder {
                args.push(text_arg("folder", folder)?);
            }
            for (name, profile) in picks {
                if name.contains('=') || name.trim().is_empty() || profile.trim().is_empty() {
                    return Err("Lựa chọn bản memory phải có tên file và id gói hợp lệ.".into());
                }
                args.push(text_arg("pick", &format!("{name}={profile}"))?);
            }
        }
        MemoryAction::Unshare { project } => args.push(text_arg("project", project)?),
    }
    if action.content().is_some() {
        let file = content_file
            .and_then(Path::to_str)
            .ok_or("Thiếu file nội dung memory hợp lệ.")?;
        args.push(text_arg("content-file", file)?);
    }
    Ok(args)
}

struct ContentFile(PathBuf);

impl ContentFile {
    fn create(dir: &Path, content: &str) -> Result<Self, String> {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|e| format!("Không tạo được mã file tạm: {e}"))?;
        let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let path = dir.join(format!("hive-memory-{name}.txt"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|e| format!("Không tạo được file nội dung memory: {e}"))?;
        let temporary = Self(path);
        let written = file.write_all(content.as_bytes());
        // Windows chỉ xoá được file tạm sau khi đóng handle, kể cả khi ghi lỗi.
        drop(file);
        written.map_err(|e| format!("Không ghi được nội dung memory: {e}"))?;
        Ok(temporary)
    }
}

impl Drop for ContentFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[tauri::command]
pub async fn memory_scan(app: AppHandle) -> Result<serde_json::Value, String> {
    sidecar_json(&app, scan_args(), vec![]).await
}

#[tauri::command]
pub async fn memory_apply(
    app: AppHandle,
    operation: MemoryAction,
) -> Result<serde_json::Value, String> {
    // Nội dung không đi vào dòng lệnh (giới hạn độ dài trên Windows, dấu nháy và xuống dòng); worker nhận file UTF-8.
    let temporary = operation
        .content()
        .map(|content| ContentFile::create(&std::env::temp_dir(), content))
        .transpose()?;
    let args = apply_args(&operation, temporary.as_ref().map(|file| file.0.as_path()))?;
    sidecar_json(&app, args, vec![]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operation(raw: &str) -> MemoryAction {
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn edits_and_merges_keep_content_out_of_command_arguments() {
        let edit = operation(
            r#"{"action":"edit","path":"C:\\Memory có dấu\\a.md","content":"Dòng 1\n\"dòng 2\""}"#,
        );
        assert_eq!(edit.content(), Some("Dòng 1\n\"dòng 2\""));
        let file = Path::new("nội dung.txt");
        assert_eq!(
            apply_args(&edit, Some(file)).unwrap(),
            [
                "memory",
                "edit",
                "--json",
                "--path=C:\\Memory có dấu\\a.md",
                "--content-file=nội dung.txt"
            ]
        );
        assert!(apply_args(&edit, None).is_err());
        let merge = operation(
            r#"{"action":"merge","sources":["/a.md","/b.md"],"target":"/c.md","content":""}"#,
        );
        assert_eq!(
            apply_args(&merge, Some(file)).unwrap(),
            [
                "memory",
                "merge",
                "--json",
                "--source=/a.md",
                "--source=/b.md",
                "--target=/c.md",
                "--content-file=nội dung.txt"
            ]
        );
    }

    #[test]
    fn only_supported_operations_and_required_fields_are_accepted() {
        for raw in [
            r#"{"action":"exec"}"#,
            r#"{"action":"edit","path":"/a.md"}"#,
            r#"{"action":"delete","path":"/a.md","config":"/other"}"#,
        ] {
            assert!(serde_json::from_str::<MemoryAction>(raw).is_err());
        }
        for raw in [
            r#"{"action":"delete","path":""}"#,
            r#"{"action":"restore","id":"\n--config=x"}"#,
            r#"{"action":"merge","sources":[],"target":"/a.md","content":"x"}"#,
            r#"{"action":"share","project":"p","picks":{"a=b":"claude-2"}}"#,
        ] {
            assert!(apply_args(&operation(raw), Some(Path::new("content.txt"))).is_err());
        }
    }

    #[test]
    fn delete_restore_and_sharing_use_worker_operations() {
        assert_eq!(scan_args(), ["memory", "scan", "--json"]);
        assert_eq!(
            apply_args(
                &operation(r#"{"action":"delete","path":"/a 'b'.md"}"#),
                None
            )
            .unwrap(),
            ["memory", "delete", "--json", "--path=/a 'b'.md"]
        );
        assert_eq!(
            apply_args(&operation(r#"{"action":"restore","id":"-backup"}"#), None).unwrap(),
            ["memory", "restore", "--json", "--id=-backup"]
        );
        assert_eq!(apply_args(&operation(r#"{"action":"share","project":"-p","folder":"/repo có dấu","picks":{"a.md":"claude-2","b.md":"claude-3"}}"#), None).unwrap(), ["memory", "share", "--json", "--project=-p", "--folder=/repo có dấu", "--pick=a.md=claude-2", "--pick=b.md=claude-3"]);
        assert_eq!(
            apply_args(&operation(r#"{"action":"unshare","project":"p"}"#), None).unwrap(),
            ["memory", "unshare", "--json", "--project=p"]
        );
    }

    #[test]
    fn parses_sidecar_inventory_and_share_conflicts() {
        let scan: serde_json::Value = serde_json::from_str(r#"{
            "files":[{"cli":"claude","profile":"claude-2","projectKey":"p","path":"/memory/a.md","tokens":10,"flags":[]}],
            "sessions":[{"projectKey":"p","sessionTokens":10}],"warnings":[],"shared":null,
            "entries":[{"id":"backup","op":"delete","trash":true,"paths":["/memory/a.md"]}]
        }"#).unwrap();
        assert_eq!(scan["files"][0]["tokens"], 10);
        assert_eq!(scan["entries"][0]["trash"], true);
        let result: serde_json::Value = serde_json::from_str(r#"{
            "applied":false,"conflicts":[{"name":"a.md","candidates":[{"profile":"claude-2","tokens":10}]}],"changed":null,"warnings":["Chọn bản cần giữ"]
        }"#).unwrap();
        assert_eq!(result["applied"], false);
        assert_eq!(
            result["conflicts"][0]["candidates"][0]["profile"],
            "claude-2"
        );
        let applied: serde_json::Value = serde_json::from_str(r#"{"applied":true,"entry":"backup","changed":["/memory/a.md"],"conflicts":null,"warnings":[]}"#).unwrap();
        assert_eq!(applied["entry"], "backup");
    }

    #[test]
    fn temporary_content_is_exact_private_unique_and_removed_on_drop() {
        let text = "Nội dung tiếng Việt\n\"dấu nháy\"\r\n";
        let file = ContentFile::create(&std::env::temp_dir(), text).unwrap();
        let second = ContentFile::create(&std::env::temp_dir(), "").unwrap();
        assert_ne!(file.0, second.0);
        assert_eq!(std::fs::read_to_string(&file.0).unwrap(), text);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file.0).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let path = file.0.clone();
        drop(file);
        assert!(!path.exists());
    }
}
