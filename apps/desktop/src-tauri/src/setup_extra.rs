//! Phần của màn Môi trường đọc ngoài file dự án quen thuộc (DESK-08): công cụ mà `.hive/setup.sh` của dự án cần, MCP
//! server tổ chức cho phép (MCP-05) đã cài vào CLI trên máy chưa, và token MCP của hub đã liên kết chưa.
//!
//! Danh sách MCP lấy thẳng từ hub bằng token đã liên kết (tool `mcp_server_list`), không nhận từ giao diện: lệnh
//! `claude mcp add …` sinh từ đó, giữ nguyên tắc của doctor.rs là giao diện không bao giờ đưa chuỗi lệnh.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub const SETUP_SCRIPT: &str = ".hive/setup.sh";

/// MCP server ngoài hub cho phép dùng với dự án, khớp `jobMcpServer` của contracts.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct McpNeed {
    pub name: String,
    pub transport: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// Dữ liệu từ hub cho một lần quét.
#[derive(Default, Debug, Clone)]
pub struct HubFacts {
    /// Máy đã liên kết tài khoản (có token cá nhân trong keychain). None là app chưa đăng ký với hub nào.
    pub linked: Option<bool>,
    pub servers: Vec<McpNeed>,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

fn valid_tool(word: &str) -> bool {
    !word.is_empty()
        && word.len() <= 64
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'))
        && !word.starts_with('-')
}

/// Công cụ mà setup.sh kiểm có trên máy: `command -v X`, `which X`, `hash X`, `type -p X`, và chỉ thị
/// `# hive-need: X Y` (cho công cụ script không tự kiểm). Không chạy script, chỉ đọc chữ.
pub fn setup_tools(script: &str) -> Vec<String> {
    let mut out = BTreeSet::new();
    for line in script.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("# hive-need:") {
            for w in rest.split_whitespace() {
                if valid_tool(w) {
                    out.insert(w.to_string());
                }
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let words: Vec<&str> = line
            .split(|c: char| {
                c.is_whitespace()
                    || matches!(c, ';' | '|' | '&' | '(' | ')' | '!' | '`' | '"' | '\'')
            })
            .filter(|w| !w.is_empty())
            .collect();
        for (i, w) in words.iter().enumerate() {
            let next = match *w {
                "command" | "type" => words
                    .get(i + 1)
                    .filter(|f| matches!(**f, "-v" | "-p" | "-P"))
                    .and_then(|_| words.get(i + 2)),
                "which" | "hash" => words.get(i + 1),
                _ => None,
            };
            if let Some(tool) = next.filter(|t| valid_tool(t)) {
                out.insert((*tool).to_string());
            }
        }
    }
    out.into_iter().collect()
}

/// Có chương trình trong PATH của người dùng không (cho công cụ không có cờ --version).
pub fn in_path(program: &str, path: &str) -> bool {
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|e| e.to_ascii_lowercase())
            .chain([String::new()])
            .collect()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(path).any(|dir| {
        exts.iter()
            .any(|e| dir.join(format!("{program}{e}")).is_file())
    })
}

pub fn sha256(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Nơi app nhớ setup.sh đã chạy thành công với nội dung nào, theo thư mục dự án. Không ghi gì vào repo.
fn marker_path(folder: &Path) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let key = sha256(&folder.to_string_lossy());
    Some(
        PathBuf::from(home)
            .join(".xdev-hive")
            .join("desktop")
            .join("setup-ran")
            .join(key),
    )
}

/// setup.sh đã chạy thành công với đúng nội dung hiện tại chưa.
pub fn setup_ran(folder: &Path, script: &str) -> bool {
    marker_path(folder)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .is_some_and(|s| s.trim() == sha256(script))
}

pub fn mark_setup_ran(folder: &Path, script: &str) {
    if let Some(p) = marker_path(folder) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, sha256(script));
    }
}

/// Tên MCP server đã khai cho Claude Code trên máy: phạm vi người dùng và phạm vi local của thư mục trong
/// `~/.claude.json`, cộng `.mcp.json` của dự án. Đọc file thay vì `claude mcp list` vì lệnh đó khởi động từng server
/// để kiểm sức khoẻ.
pub fn claude_mcp_names(config: &Path, folder: Option<&Path>) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut add = |v: &serde_json::Value| {
        if let Some(obj) = v.as_object() {
            out.extend(obj.keys().cloned());
        }
    };
    if let Some(v) = std::fs::read_to_string(config)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    {
        add(&v["mcpServers"]);
        if let Some(f) = folder {
            add(&v["projects"][f.to_string_lossy().as_ref()]["mcpServers"]);
        }
    }
    if let Some(v) = folder
        .and_then(|f| std::fs::read_to_string(f.join(".mcp.json")).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    {
        add(&v["mcpServers"]);
    }
    out
}

/// File cấu hình của Claude Code (CLAUDE_CONFIG_DIR đổi chỗ của nó).
pub fn claude_config_file(home: &Path) -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(|d| PathBuf::from(d).join(".claude.json"))
        .unwrap_or_else(|| home.join(".claude.json"))
}

pub fn codex_home(home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"))
}

/// Tên MCP server trong `config.toml` của Codex (`[mcp_servers.<tên>]`).
pub fn codex_mcp_names(dir: &Path) -> BTreeSet<String> {
    let text = std::fs::read_to_string(dir.join("config.toml")).unwrap_or_default();
    text.lines()
        .filter_map(|l| {
            l.trim()
                .strip_prefix("[mcp_servers.")?
                .strip_suffix(']')
                .map(str::to_string)
        })
        .map(|n| n.trim_matches('"').to_string())
        // Bảng con như [mcp_servers.x.env] không phải server riêng.
        .filter(|n| !n.contains('.'))
        .collect()
}

/// Lệnh cài một MCP server vào CLI. Server không hợp lệ (tên lạ, thiếu lệnh) thì không có lệnh.
pub fn mcp_add_argv(cli: &str, s: &McpNeed) -> Option<Vec<String>> {
    if !valid_name(&s.name) {
        return None;
    }
    let mut argv: Vec<String> = match cli {
        "claude" => vec![
            "claude".into(),
            "mcp".into(),
            "add".into(),
            "--scope".into(),
            "user".into(),
        ],
        "codex" => vec!["codex".into(), "mcp".into(), "add".into()],
        _ => return None,
    };
    match s.transport.as_str() {
        "http" => {
            let url = s
                .url
                .as_deref()
                .filter(|u| u.starts_with("https://") || u.starts_with("http://"))?;
            if cli == "claude" {
                argv.extend([
                    "--transport".into(),
                    "http".into(),
                    s.name.clone(),
                    url.into(),
                ]);
            } else {
                argv.extend([s.name.clone(), "--url".into(), url.into()]);
            }
        }
        "stdio" => {
            let command = s.command.as_deref().filter(|c| !c.trim().is_empty())?;
            argv.extend([s.name.clone(), "--".into(), command.into()]);
            argv.extend(s.args.iter().cloned());
        }
        _ => return None,
    }
    Some(argv)
}

/// Lấy từ hub: đã liên kết chưa và MCP server được phép của dự án. Lỗi mạng hay chưa liên kết thì trả rỗng: màn vẫn
/// hiện phần còn lại.
pub async fn hub_facts(app: &tauri::AppHandle, project: Option<&str>) -> HubFacts {
    let Some(hub) = crate::hub_of(app) else {
        return HubFacts::default();
    };
    let Some(token) = crate::account::stored_token(&hub) else {
        return HubFacts {
            linked: Some(false),
            servers: vec![],
        };
    };
    let mut facts = HubFacts {
        linked: Some(true),
        servers: vec![],
    };
    if let Some(key) = project.map(str::trim).filter(|k| !k.is_empty()) {
        if let Ok(v) = crate::hub::call_tool(
            &hub,
            &token,
            "mcp_server_list",
            serde_json::json!({ "project": key }),
        )
        .await
        {
            facts.servers = serde_json::from_value(v["servers"].clone()).unwrap_or_default();
        }
    }
    facts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_tools_the_setup_script_checks() {
        let script = r#"#!/bin/sh
set -e
# hive-need: golangci-lint buf
command -v sqlc >/dev/null 2>&1 || go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest
if ! which jq >/dev/null; then brew install jq; fi
hash protoc 2>/dev/null || echo "thiếu protoc"
type -p "mise" && mise install
command echo không phải kiểm
"#;
        assert_eq!(
            setup_tools(script),
            vec!["buf", "golangci-lint", "jq", "mise", "protoc", "sqlc"]
        );
    }

    #[test]
    fn builds_mcp_add_commands_without_a_shell() {
        let gh = McpNeed {
            name: "github".into(),
            transport: "stdio".into(),
            command: Some("npx".into()),
            args: vec!["-y".into(), "@modelcontextprotocol/server-github".into()],
            url: None,
        };
        assert_eq!(
            mcp_add_argv("claude", &gh).unwrap().join(" "),
            "claude mcp add --scope user github -- npx -y @modelcontextprotocol/server-github"
        );
        assert_eq!(
            mcp_add_argv("codex", &gh).unwrap().join(" "),
            "codex mcp add github -- npx -y @modelcontextprotocol/server-github"
        );
        let c7 = McpNeed {
            name: "context7".into(),
            transport: "http".into(),
            command: None,
            args: vec![],
            url: Some("https://mcp.context7.com/mcp".into()),
        };
        assert_eq!(
            mcp_add_argv("claude", &c7).unwrap().join(" "),
            "claude mcp add --scope user --transport http context7 https://mcp.context7.com/mcp"
        );
        assert_eq!(
            mcp_add_argv("codex", &c7).unwrap().join(" "),
            "codex mcp add context7 --url https://mcp.context7.com/mcp"
        );
        let bad = McpNeed {
            name: "a b".into(),
            ..gh.clone()
        };
        assert!(mcp_add_argv("claude", &bad).is_none());
        let file = McpNeed {
            url: Some("file:///etc/passwd".into()),
            ..c7
        };
        assert!(mcp_add_argv("claude", &file).is_none());
    }

    #[test]
    fn reads_configured_mcp_names_from_cli_config_files() {
        let home = std::env::temp_dir().join(format!("hive-mcp-{}", std::process::id()));
        let folder = home.join("work").join("pay");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir_all(&folder).unwrap();
        let claude = serde_json::json!({
            "mcpServers": { "context7": {} },
            "projects": { folder.to_string_lossy(): { "mcpServers": { "local-only": {} } } }
        });
        std::fs::write(home.join(".claude.json"), claude.to_string()).unwrap();
        std::fs::write(
            folder.join(".mcp.json"),
            r#"{"mcpServers":{"xdev-hive":{}}}"#,
        )
        .unwrap();
        std::fs::write(
            home.join(".codex/config.toml"),
            "model = \"x\"\n[mcp_servers.github]\ncommand = \"npx\"\n[mcp_servers.github.env]\nA = \"1\"\n[mcp_servers.\"my-server\"]\n",
        )
        .unwrap();
        let names: Vec<_> = claude_mcp_names(&home.join(".claude.json"), Some(&folder))
            .into_iter()
            .collect();
        assert_eq!(names, vec!["context7", "local-only", "xdev-hive"]);
        let names: Vec<_> = codex_mcp_names(&home.join(".codex")).into_iter().collect();
        assert_eq!(names, vec!["github", "my-server"]);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn remembers_setup_runs_by_script_content() {
        let folder = std::env::temp_dir().join(format!("hive-setup-{}", std::process::id()));
        assert!(!setup_ran(&folder, "echo a"));
        mark_setup_ran(&folder, "echo a");
        assert!(setup_ran(&folder, "echo a"));
        assert!(!setup_ran(&folder, "echo b"));
        if let Some(p) = marker_path(&folder) {
            let _ = std::fs::remove_file(p);
        }
    }
}
