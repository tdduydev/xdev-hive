//! Viết tài liệu từ code bằng agent CLI trên máy (AppDocs, specs/008-desktop-v2 T010, DESK-05).
//!
//! App chạy Claude Code hoặc Codex không tương tác trong thư mục người dùng chọn, đọc luồng JSON của CLI và phát từng
//! sự kiện cho cửa sổ app. Agent chỉ đọc code để đề xuất văn bản; bản nháp nằm trong app và chỉ lên hub khi người
//! dùng gửi đề xuất (`propose_doc`). Vì vậy mặc định app khoá agent ở chế độ chỉ đọc (người dùng tự bật "Accept
//! edits" hay "Bypass" thì xem `Mode`):
//! - Claude Code: `--restricted` (bỏ tool chạy lệnh, giam tool file trong thư mục, bỏ qua file settings và hook của
//!   người dùng lẫn dự án), chỉ `Read,Glob,Grep`, `--strict-mcp-config` không kèm cấu hình nên không nạp MCP server nào
//!   (MCP xdev-hive trong cấu hình người dùng mang token cá nhân của hub), `--permission-prompts none` để việc gì cần
//!   hỏi quyền đều bị từ chối thay vì treo.
//! - Codex: sandbox `read-only`, `--ignore-user-config` để không nạp MCP server và plugin trong `~/.codex/config.toml`
//!   (đăng nhập vẫn lấy từ CODEX_HOME).
//!
//! Môi trường của CLI dựng từ danh sách cho phép, không thừa kế môi trường của app: token máy, biến HIVE_*, khoá API
//! của tổ chức hay biến của phiên agent đang chạy app không lọt sang. Lời nhắc đi qua stdin để không lộ trong danh sách
//! tiến trình và không vướng giới hạn độ dài dòng lệnh của Windows.

use crate::doctor::{extract_version, run_with_timeout, user_path};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Sự kiện phát cho cửa sổ app, kèm id lượt chạy để màn bỏ qua sự kiện của lượt đã huỷ.
pub const EVENT: &str = "cli:event";
/// Lời nhắc gồm cả bản nháp tài liệu (tối đa 200k ký tự trên hub) và yêu cầu của người dùng.
const MAX_PROMPT: usize = 400_000;
const MAX_STDERR: usize = 4_000;
const PREVIEW: usize = 160;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Engine {
    Claude,
    Codex,
}

impl Engine {
    pub fn parse(s: &str) -> Result<Engine, String> {
        match s {
            "claude" => Ok(Engine::Claude),
            "codex" => Ok(Engine::Codex),
            _ => Err(format!("App không chạy agent {s}.")),
        }
    }

    fn program(self) -> &'static str {
        match self {
            Engine::Claude => "claude",
            Engine::Codex => "codex",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Engine::Claude => "Claude Code",
            Engine::Codex => "Codex",
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Môi trường và tham số

/// Biến môi trường chuyển cho CLI (so không phân biệt hoa thường vì Windows). Đủ để CLI tìm cấu hình, đăng nhập bằng
/// gói thuê bao của người dùng và đi qua proxy công ty; không có khoá API: lượt dùng tính vào gói của người dùng, không
/// vào khoá của tổ chức có thể nằm trong môi trường của app.
const ENV_ALLOW: &[&str] = &[
    "HOME",
    "USER",
    "USERNAME",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TERM",
    "TZ",
    "TMPDIR",
    "TEMP",
    "TMP",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    // Secret Service trên Linux: nơi CLI giữ phiên đăng nhập của gói.
    "DBUS_SESSION_BUS_ADDRESS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
];

fn env_allowed(key: &str) -> bool {
    let k = key.to_ascii_uppercase();
    // HIVE_* không bao giờ qua, kể cả khi sau này ai đó thêm tiền tố rộng vào danh sách cho phép.
    !k.starts_with("HIVE_") && (ENV_ALLOW.contains(&k.as_str()) || k.starts_with("LC_"))
}

/// Môi trường của CLI: chỉ biến trong danh sách cho phép, PATH lấy từ shell đăng nhập (app mở từ Finder chỉ có PATH
/// tối thiểu, không thấy claude hay codex cài bằng npm hoặc Homebrew).
pub fn child_env(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
    path: &str,
) -> Vec<(OsString, OsString)> {
    let mut out: Vec<(OsString, OsString)> = vars
        .into_iter()
        .filter(|(k, _)| k.to_str().is_some_and(env_allowed))
        .collect();
    out.push(("PATH".into(), path.into()));
    out
}

/// Glob của Claude Code dừng sau 20 giây và mặc định quét cả file bị .gitignore: repo lớn (nhất là trên Windows) báo
/// "Ripgrep search timed out". Nới lên 60 giây và bỏ qua file bị .gitignore (biến trong code.claude.com/docs/en/env-vars);
/// biến người dùng tự đặt thì giữ.
pub fn search_env(env: &mut Vec<(OsString, OsString)>) {
    for (key, value) in [
        ("CLAUDE_CODE_GLOB_TIMEOUT_SECONDS", "60"),
        ("CLAUDE_CODE_GLOB_NO_IGNORE", "false"),
    ] {
        if !env.iter().any(|(k, _)| k == key) {
            env.push((key.into(), value.into()));
        }
    }
}

/// Quyền của agent trong thư mục. Mặc định chỉ đọc; hai chế độ ghi do người dùng bật trong khung chat (Bypass phải
/// qua hộp xác nhận ở giao diện).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    Read,
    /// Sửa và tạo file trong thư mục, không chạy lệnh.
    Edit,
    /// Bỏ hỏi quyền và sandbox: agent chạy lệnh và sửa file tuỳ ý.
    Bypass,
}

impl Mode {
    pub fn parse(s: Option<&str>) -> Result<Mode, String> {
        match s.unwrap_or("read") {
            "" | "read" => Ok(Mode::Read),
            "edit" => Ok(Mode::Edit),
            "bypass" => Ok(Mode::Bypass),
            other => Err(format!("Chế độ không hợp lệ: {other}")),
        }
    }
}

/// Tên model (alias như `opus` hay tên đầy đủ như `gpt-5.5-codex`). Kiểm vì nó vào dòng lệnh: không cho khoảng trắng
/// hay ký tự lạ, không bắt đầu bằng `-` để không thành cờ của CLI.
pub fn valid_model(model: &str) -> bool {
    (1..=64).contains(&model.len())
        && !model.starts_with('-')
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

/// Tham số của `claude`. Lời nhắc đọc từ stdin (`-p` không kèm lời nhắc). Chỉ đọc và "Accept edits" giữ
/// `--restricted` (không chạy lệnh, file tool chỉ trong thư mục); `--restricted` từ chối bypassPermissions nên Bypass
/// bỏ nó, nhưng vẫn không nạp MCP server nào.
pub fn claude_args(session: Option<&str>, model: Option<&str>, mode: Mode) -> Vec<String> {
    let mut args: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose"]
        .map(String::from)
        .to_vec();
    match mode {
        Mode::Read => args.extend(
            [
                "--restricted",
                "--strict-mcp-config",
                "--tools",
                "Read,Glob,Grep",
            ]
            .map(String::from),
        ),
        Mode::Edit => args.extend(
            [
                "--restricted",
                "--strict-mcp-config",
                "--tools",
                "Read,Glob,Grep,Edit,Write",
                "--permission-mode",
                "acceptEdits",
            ]
            .map(String::from),
        ),
        Mode::Bypass => args.extend(
            [
                "--strict-mcp-config",
                "--permission-mode",
                "bypassPermissions",
            ]
            .map(String::from),
        ),
    }
    args.extend(["--permission-prompts".into(), "none".into()]);
    if let Some(m) = model {
        args.extend(["--model".into(), m.into()]);
    }
    if let Some(id) = session {
        args.extend(["--resume".into(), id.into()]);
    }
    args
}

/// Tham số của `codex`. `exec resume` không nhận `-s` và `-C` nên đặt sandbox bằng `-c`, thư mục bằng cwd.
pub fn codex_args(
    folder: &Path,
    session: Option<&str>,
    model: Option<&str>,
    mode: Mode,
) -> Vec<String> {
    let common = ["--json", "--ignore-user-config", "--skip-git-repo-check"];
    let sandbox = match mode {
        Mode::Read => Some("read-only"),
        Mode::Edit => Some("workspace-write"),
        Mode::Bypass => None,
    };
    let mut args: Vec<String> = vec!["exec".into()];
    if session.is_some() {
        args.push("resume".into());
    }
    args.extend(common.map(String::from));
    match (sandbox, session) {
        (Some(s), None) => args.extend(["--sandbox".into(), s.into()]),
        (Some(s), Some(_)) => args.extend(["-c".into(), format!("sandbox_mode=\"{s}\"")]),
        (None, _) => args.push("--dangerously-bypass-approvals-and-sandbox".into()),
    }
    if let Some(m) = model {
        args.extend(["-m".into(), m.into()]);
    }
    match session {
        None => args.extend(["-C".into(), folder.to_string_lossy().into_owned()]),
        Some(id) => args.push(id.into()),
    }
    args.push("-".into());
    args
}

/// Thư mục dự án để agent đọc. Không nhận thư mục gốc hay thư mục nhà: agent sẽ đọc được cấu hình của mọi công cụ
/// trên máy (kể cả file cấu hình của worker), không chỉ code của một dự án.
pub fn project_folder(folder: &str, home: Option<&Path>) -> Result<PathBuf, String> {
    let raw = folder.trim();
    if raw.is_empty() {
        return Err("Chọn thư mục dự án trước.".into());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() || !path.is_dir() {
        return Err(format!("Không tìm thấy thư mục {raw}."));
    }
    let path = path
        .canonicalize()
        .map_err(|e| format!("Không mở được thư mục {raw}: {e}"))?;
    let is_home = home
        .and_then(|h| h.canonicalize().ok())
        .is_some_and(|h| h == path);
    if path.parent().is_none() || is_home {
        return Err(
            "Chọn thư mục của một dự án, không chọn thư mục gốc hay cả thư mục nhà.".into(),
        );
    }
    Ok(path)
}

/// Id phiên do CLI cấp (uuid). Kiểm vì nó vào dòng lệnh: chuỗi bắt đầu bằng `-` sẽ thành cờ của CLI.
pub fn valid_session(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

// ---------------------------------------------------------------------------------------------------------------
// Sự kiện

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub text: String,
    /// "done", "doing" hoặc "todo".
    pub status: &'static str,
}

/// Sự kiện đã đọc từ luồng JSON của CLI, chung cho Claude Code và Codex. Kiểu khớp với src/lib/agent.ts.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    /// Phiên của CLI (session id của Claude, thread id của Codex) để hỏi tiếp bằng resume.
    Session {
        id: String,
        model: Option<String>,
    },
    Text {
        text: String,
    },
    /// Agent gọi tool. `paths`: file trong thư mục agent đã đọc, để chấm xanh ở cây thư mục.
    Tool {
        id: String,
        name: String,
        arg: String,
        paths: Vec<String>,
    },
    ToolDone {
        id: String,
        ok: bool,
        lines: Option<u64>,
        files: Option<u64>,
        preview: String,
    },
    Todos {
        items: Vec<Todo>,
    },
    /// Hạn mức của gói sắp hết (Claude báo khi vượt ngưỡng).
    Limit {
        window: String,
        percent: u32,
    },
    Notice {
        text: String,
    },
    Result {
        ok: bool,
        text: Option<String>,
        error: Option<String>,
        input_tokens: u64,
        cached_tokens: u64,
        output_tokens: u64,
        cost_usd: Option<f64>,
        duration_ms: Option<u64>,
    },
    /// CLI đã thoát. Luôn là sự kiện cuối của một lượt chạy.
    Exit {
        code: Option<i32>,
        cancelled: bool,
        stderr: String,
    },
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

fn first_line(text: &str) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let line = line.trim();
    if line.chars().count() > PREVIEW {
        format!("{}…", line.chars().take(PREVIEW).collect::<String>())
    } else {
        line.to_string()
    }
}

/// Đường dẫn trong thư mục, tính từ gốc thư mục; ngoài thư mục thì giữ nguyên.
fn relative(path: &str, folder: &Path) -> String {
    Path::new(path)
        .strip_prefix(folder)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

fn claude_tool(block: &Value, folder: &Path) -> AgentEvent {
    let name = s(&block["name"]);
    let input = &block["input"];
    let (arg, paths) = match name.as_str() {
        "Read" => {
            let p = relative(&s(&input["file_path"]), folder);
            (p.clone(), vec![p])
        }
        // Màn tải lại file đang mở khi agent sửa: cần đường dẫn trong thư mục, không phải đường dẫn tuyệt đối.
        "Edit" | "Write" | "MultiEdit" => (relative(&s(&input["file_path"]), folder), vec![]),
        "Glob" => (s(&input["pattern"]), vec![]),
        "Grep" => {
            let mut a = format!("\"{}\"", s(&input["pattern"]));
            if let Some(p) = input["path"].as_str() {
                a = format!("{a}, {}", relative(p, folder));
            }
            (a, vec![])
        }
        _ => (
            input
                .as_object()
                .and_then(|o| o.values().find_map(Value::as_str))
                .map(first_line)
                .unwrap_or_default(),
            vec![],
        ),
    };
    AgentEvent::Tool {
        id: s(&block["id"]),
        name,
        arg,
        paths,
    }
}

fn result_text(content: &Value) -> String {
    match content {
        Value::String(t) => t.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Một dòng của `claude -p --output-format stream-json --verbose`.
pub fn parse_claude_line(line: &str, folder: &Path) -> Vec<AgentEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
        return vec![];
    };
    match v["type"].as_str() {
        Some("system") if v["subtype"] == "init" => {
            let id = s(&v["session_id"]);
            if id.is_empty() {
                return vec![];
            }
            vec![AgentEvent::Session {
                id,
                model: v["model"].as_str().map(String::from),
            }]
        }
        Some("assistant") => v["message"]["content"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| match b["type"].as_str() {
                        Some("text") => {
                            let text = s(&b["text"]);
                            (!text.trim().is_empty()).then_some(AgentEvent::Text { text })
                        }
                        Some("tool_use") => Some(claude_tool(b, folder)),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Some("user") => {
            let meta = &v["tool_use_result"];
            let lines = meta["file"]["numLines"]
                .as_u64()
                .or_else(|| meta["numLines"].as_u64());
            let files = meta["numFiles"].as_u64();
            v["message"]["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|b| b["type"] == "tool_result")
                        .map(|b| AgentEvent::ToolDone {
                            id: s(&b["tool_use_id"]),
                            ok: b["is_error"].as_bool() != Some(true),
                            lines,
                            files,
                            preview: first_line(&result_text(&b["content"])),
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
        Some("rate_limit_event") => {
            let info = &v["rate_limit_info"];
            if info["status"].as_str() == Some("allowed") {
                return vec![];
            }
            let percent = (info["utilization"].as_f64().unwrap_or(0.0) * 100.0).round() as u32;
            vec![AgentEvent::Limit {
                window: s(&info["rateLimitType"]),
                percent,
            }]
        }
        Some("result") => {
            let u = &v["usage"];
            let n = |x: &Value| x.as_u64().unwrap_or(0);
            let ok = v["is_error"].as_bool() != Some(true) && v["subtype"] == "success";
            let error = (!ok).then(|| {
                v["errors"]
                    .as_array()
                    .and_then(|e| e.iter().find_map(Value::as_str))
                    .map(String::from)
                    .or_else(|| v["result"].as_str().map(first_line))
                    .unwrap_or_else(|| s(&v["subtype"]))
            });
            vec![AgentEvent::Result {
                ok,
                text: v["result"].as_str().map(String::from),
                error,
                input_tokens: n(&u["input_tokens"])
                    + n(&u["cache_creation_input_tokens"])
                    + n(&u["cache_read_input_tokens"]),
                cached_tokens: n(&u["cache_read_input_tokens"]),
                output_tokens: n(&u["output_tokens"]),
                cost_usd: v["total_cost_usd"].as_f64(),
                duration_ms: v["duration_ms"].as_u64(),
            }]
        }
        _ => vec![],
    }
}

/// `/bin/zsh -lc 'cat go.mod'` → `cat go.mod`: Codex bọc mỗi lệnh trong shell đăng nhập, khung chat chỉ cần lệnh.
pub fn unwrap_shell(cmd: &str) -> String {
    for flag in [" -lc ", " -c "] {
        let Some(i) = cmd.find(flag) else { continue };
        let program = cmd[..i].trim().trim_end_matches(".exe");
        let shell = program.rsplit(['/', '\\']).next().unwrap_or(program);
        if !["sh", "bash", "zsh", "dash", "fish", "pwsh", "powershell"].contains(&shell) {
            continue;
        }
        let rest = cmd[i + flag.len()..].trim();
        if rest.len() >= 2 && rest.starts_with('\'') && rest.ends_with('\'') {
            return rest[1..rest.len() - 1].replace("'\\''", "'");
        }
        if rest.len() >= 2 && rest.starts_with('"') && rest.ends_with('"') {
            return rest[1..rest.len() - 1].replace("\\\"", "\"");
        }
        return rest.to_string();
    }
    cmd.to_string()
}

/// Một dòng của `codex exec --json`.
pub fn parse_codex_line(line: &str) -> Vec<AgentEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
        return vec![];
    };
    let n = |x: &Value| x.as_u64().unwrap_or(0);
    match v["type"].as_str() {
        Some("thread.started") => vec![AgentEvent::Session {
            id: s(&v["thread_id"]),
            model: None,
        }],
        Some(kind @ ("item.started" | "item.updated" | "item.completed")) => {
            let item = &v["item"];
            let done = kind == "item.completed";
            let id = s(&item["id"]);
            match item["type"].as_str() {
                Some("agent_message") if done => vec![AgentEvent::Text {
                    text: s(&item["text"]),
                }],
                Some("command_execution") if kind == "item.started" => vec![AgentEvent::Tool {
                    id,
                    name: "shell".into(),
                    arg: unwrap_shell(&s(&item["command"])),
                    paths: vec![],
                }],
                Some("command_execution") if done => {
                    let out = s(&item["aggregated_output"]);
                    vec![AgentEvent::ToolDone {
                        id,
                        ok: item["exit_code"].as_i64() == Some(0),
                        lines: Some(out.lines().count() as u64),
                        files: None,
                        preview: first_line(&out),
                    }]
                }
                Some("file_change") if done => {
                    let paths: Vec<String> = item["changes"]
                        .as_array()
                        .map(|c| c.iter().map(|x| s(&x["path"])).collect())
                        .unwrap_or_default();
                    vec![
                        AgentEvent::Tool {
                            id: id.clone(),
                            name: "apply_patch".into(),
                            arg: paths.join(", "),
                            paths: vec![],
                        },
                        AgentEvent::ToolDone {
                            id,
                            ok: item["status"] == "completed",
                            lines: None,
                            files: Some(paths.len() as u64),
                            preview: String::new(),
                        },
                    ]
                }
                Some("mcp_tool_call") if kind == "item.started" => vec![AgentEvent::Tool {
                    id,
                    name: format!("{}.{}", s(&item["server"]), s(&item["tool"])),
                    arg: String::new(),
                    paths: vec![],
                }],
                Some("web_search") if kind == "item.started" => vec![AgentEvent::Tool {
                    id,
                    name: "web_search".into(),
                    arg: s(&item["query"]),
                    paths: vec![],
                }],
                Some("mcp_tool_call" | "web_search") if done => vec![AgentEvent::ToolDone {
                    id,
                    ok: item["status"].as_str() != Some("failed"),
                    lines: None,
                    files: None,
                    preview: String::new(),
                }],
                Some("todo_list") => {
                    let mut doing = false;
                    let items = item["items"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .map(|t| {
                                    let status = if t["completed"].as_bool() == Some(true) {
                                        "done"
                                    } else if !doing {
                                        doing = true;
                                        "doing"
                                    } else {
                                        "todo"
                                    };
                                    Todo {
                                        text: s(&t["text"]),
                                        status,
                                    }
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    vec![AgentEvent::Todos { items }]
                }
                Some("error") if done => vec![AgentEvent::Notice {
                    text: s(&item["message"]),
                }],
                _ => vec![],
            }
        }
        Some("turn.completed") => {
            let u = &v["usage"];
            vec![AgentEvent::Result {
                ok: true,
                text: None,
                error: None,
                input_tokens: n(&u["input_tokens"]),
                cached_tokens: n(&u["cached_input_tokens"]),
                output_tokens: n(&u["output_tokens"]),
                cost_usd: None,
                duration_ms: None,
            }]
        }
        Some("turn.failed") => vec![AgentEvent::Result {
            ok: false,
            text: None,
            error: Some(s(&v["error"]["message"])),
            input_tokens: 0,
            cached_tokens: 0,
            output_tokens: 0,
            cost_usd: None,
            duration_ms: None,
        }],
        Some("error") => vec![AgentEvent::Notice {
            text: s(&v["message"]),
        }],
        _ => vec![],
    }
}

/// File trong thư mục mà lệnh shell của Codex nhắc tới (`sed -n 1,80p internal/ws.go`). Codex đọc file bằng lệnh,
/// không có tool Read như Claude, nên đoán theo đối số có thật trong thư mục.
pub fn command_paths(command: &str, folder: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in
        command.split(|c: char| c.is_whitespace() || matches!(c, '|' | ';' | '&' | '<' | '>'))
    {
        let token = raw.trim_matches(|c| c == '\'' || c == '"');
        let token = token.strip_prefix("./").unwrap_or(token);
        if token.is_empty()
            || token.starts_with('-')
            || Path::new(token).is_absolute()
            || token.split(['/', '\\']).any(|p| p == "..")
        {
            continue;
        }
        if folder.join(token).is_file() && !out.iter().any(|p| p == token) {
            out.push(token.to_string());
        }
        if out.len() >= 20 {
            break;
        }
    }
    out
}

/// Đọc luồng stdout của CLI, gọi `emit` cho từng sự kiện. Tách khỏi lệnh Tauri để test bằng dòng mẫu thật.
pub fn read_stream(
    reader: impl BufRead,
    engine: Engine,
    folder: &Path,
    mut emit: impl FnMut(AgentEvent),
) {
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let events = match engine {
            Engine::Claude => parse_claude_line(&line, folder),
            Engine::Codex => parse_codex_line(&line),
        };
        for mut event in events {
            if let AgentEvent::Tool { arg, paths, .. } = &mut event
                && engine == Engine::Codex
                && paths.is_empty()
            {
                *paths = command_paths(arg, folder);
            }
            emit(event);
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Chạy và huỷ

struct Run {
    child: Child,
    cancelled: bool,
}

/// Lượt chạy đang mở, theo id; huỷ thì giết cả nhóm tiến trình (CLI còn chạy rg, shell con).
#[derive(Default)]
pub struct Runs(Mutex<HashMap<String, Run>>);

static RUN_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    run_id: String,
    event: AgentEvent,
}

/// Lệnh cho CLI: cwd là thư mục dự án, chỉ các biến `env` (đã lọc bằng child_env), ba ống stdin/stdout/stderr.
fn command(
    program: &str,
    args: &[String],
    folder: &Path,
    env: Vec<(OsString, OsString)>,
) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(folder)
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Nhóm tiến trình riêng để huỷ giết được cả tiến trình con của CLI.
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // App GUI: không bật cửa sổ console cho CLI.
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        if let Ok(pid) = i32::try_from(child.id()) {
            // SAFETY: gửi tín hiệu cho nhóm tiến trình do chính app tạo (process_group(0)); không đụng bộ nhớ.
            unsafe {
                libc::kill(-pid, libc::SIGTERM);
            }
        }
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/T", "/F", "/PID", &child.id().to_string()]);
        let _ = run_with_timeout(cmd, Duration::from_secs(5));
    }
    let _ = child.kill();
}

fn emit(app: &AppHandle, run_id: &str, event: AgentEvent) {
    // Chỉ cửa sổ app nghe; cửa sổ web của hub (trang từ xa) không nhận nội dung code của máy.
    let _ = app.emit_to(
        crate::APP,
        EVENT,
        Envelope {
            run_id: run_id.to_string(),
            event,
        },
    );
}

/// Chạy agent trong thư mục, trả id lượt chạy ngay; sự kiện đến sau qua `cli:event`, kết thúc bằng `exit`.
#[tauri::command]
pub async fn run_cli_stream(
    app: AppHandle,
    engine: String,
    folder: String,
    prompt: String,
    session: Option<String>,
    model: Option<String>,
    mode: Option<String>,
) -> Result<String, String> {
    let engine = Engine::parse(&engine)?;
    let mode = Mode::parse(mode.as_deref())?;
    let model = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
    if model.as_deref().is_some_and(|m| !valid_model(m)) {
        return Err("Tên model không hợp lệ: chỉ gồm chữ, số và . _ : - (tối đa 64 ký tự).".into());
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let folder = project_folder(&folder, home.as_deref())?;
    if prompt.trim().is_empty() {
        return Err("Nhập yêu cầu cho agent.".into());
    }
    if prompt.len() > MAX_PROMPT {
        return Err("Yêu cầu quá dài (gồm cả bản nháp tài liệu).".into());
    }
    let session = session.filter(|s| !s.is_empty());
    if session.as_deref().is_some_and(|s| !valid_session(s)) {
        return Err("Phiên không hợp lệ.".into());
    }
    let args = match engine {
        Engine::Claude => claude_args(session.as_deref(), model.as_deref(), mode),
        Engine::Codex => codex_args(&folder, session.as_deref(), model.as_deref(), mode),
    };
    let mut env = child_env(std::env::vars_os(), user_path());
    if matches!(engine, Engine::Claude) {
        search_env(&mut env);
    }
    let mut child = command(engine.program(), &args, &folder, env)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "Chưa cài {} trên máy (không thấy lệnh {}). Cài ở màn Môi trường.",
                    engine.label(),
                    engine.program()
                )
            } else {
                format!("Không chạy được {}: {e}", engine.label())
            }
        })?;
    let run_id = format!("run-{}", RUN_SEQ.fetch_add(1, Ordering::Relaxed) + 1);
    let (Some(mut stdin), Some(stdout), Some(mut stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        kill_tree(&mut child);
        return Err(format!("Không mở được ống dữ liệu tới {}.", engine.label()));
    };
    app.state::<Runs>()
        .0
        .lock()
        .map_err(|_| "Không ghi được lượt chạy.")?
        .insert(
            run_id.clone(),
            Run {
                child,
                cancelled: false,
            },
        );
    std::thread::spawn(move || {
        // Ghi xong thì đóng stdin để CLI biết lời nhắc đã hết.
        let _ = stdin.write_all(prompt.as_bytes());
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        let text = String::from_utf8_lossy(&buf).trim().to_string();
        let start = text.len().saturating_sub(MAX_STDERR);
        let start = (start..text.len())
            .find(|i| text.is_char_boundary(*i))
            .unwrap_or(text.len());
        text[start..].to_string()
    });
    let id = run_id.clone();
    std::thread::spawn(move || {
        read_stream(BufReader::new(stdout), engine, &folder, |event| {
            emit(&app, &id, event)
        });
        let run = app
            .state::<Runs>()
            .0
            .lock()
            .ok()
            .and_then(|mut m| m.remove(&id));
        let (code, cancelled) = match run {
            Some(mut r) => (r.child.wait().ok().and_then(|s| s.code()), r.cancelled),
            None => (None, true),
        };
        let stderr = err_reader.join().unwrap_or_default();
        emit(
            &app,
            &id,
            AgentEvent::Exit {
                code,
                cancelled,
                stderr,
            },
        );
    });
    Ok(run_id)
}

/// Huỷ lượt chạy: giết nhóm tiến trình; sự kiện `exit` (cancelled) vẫn đến như lượt bình thường.
#[tauri::command]
pub fn cancel_cli_stream(app: AppHandle, run_id: String) -> Result<(), String> {
    let state = app.state::<Runs>();
    let mut runs = state.0.lock().map_err(|_| "Không đọc được lượt chạy.")?;
    if let Some(run) = runs.get_mut(&run_id) {
        run.cancelled = true;
        kill_tree(&mut run.child);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Tài khoản AI trên máy (hộp "Tài khoản AI", T012)

#[derive(Serialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliAccount {
    pub engine: &'static str,
    pub installed: bool,
    pub version: Option<String>,
    pub logged_in: bool,
    /// "claude.ai", "ChatGPT", "API key"…
    pub method: Option<String>,
    pub email: Option<String>,
    /// Gói Claude (pro, max, team…); Codex không báo.
    pub plan: Option<String>,
}

/// Kết quả JSON của `claude auth status`.
pub fn parse_claude_auth(text: &str) -> (bool, Option<String>, Option<String>, Option<String>) {
    let Ok(v) = serde_json::from_str::<Value>(text.trim()) else {
        return (false, None, None, None);
    };
    let o = |k: &str| v[k].as_str().map(String::from);
    (
        v["loggedIn"].as_bool() == Some(true),
        o("authMethod"),
        o("email"),
        o("subscriptionType"),
    )
}

/// `codex login status`: mã 0 kèm "Logged in using ChatGPT" (hoặc "using an API key - sk-…"); chưa đăng nhập thì mã 1.
pub fn parse_codex_login(code: Option<i32>, text: &str) -> (bool, Option<String>) {
    let line = text.lines().find(|l| l.contains("Logged in")).unwrap_or("");
    if code != Some(0) || line.is_empty() {
        return (false, None);
    }
    let method = line.split("using").nth(1).map(|m| {
        let m = m.trim();
        // Không đưa phần khoá (dù đã che) lên giao diện.
        if m.to_ascii_lowercase().contains("api key") {
            "API key".to_string()
        } else {
            m.to_string()
        }
    });
    (true, method)
}

fn cli_output(program: &str, args: &[&str]) -> Option<(Option<i32>, String)> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env_clear()
        .envs(child_env(std::env::vars_os(), user_path()));
    if let Some(home) = std::env::var_os("HOME") {
        cmd.current_dir(home);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = run_with_timeout(cmd, Duration::from_secs(15))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Some((out.code, text))
}

/// Phiên bản và trạng thái đăng nhập của Claude Code và Codex. Chỉ hỏi CLI (`auth status`, `login status`); app không
/// đọc file chứa phiên đăng nhập của gói.
#[tauri::command]
pub async fn cli_accounts() -> Result<Vec<CliAccount>, String> {
    tauri::async_runtime::spawn_blocking(|| read_cli_accounts(cli_output))
        .await
        .map_err(|e| e.to_string())
}

type CliProbe = fn(&str, &[&str]) -> Option<(Option<i32>, String)>;

fn read_cli_accounts(run: CliProbe) -> Vec<CliAccount> {
    let claude = || {
        let version = run("claude", &["--version"]);
        let mut claude = CliAccount {
            engine: "claude",
            installed: version.is_some(),
            version: version.and_then(|(_, t)| extract_version(&t)),
            ..Default::default()
        };
        if claude.installed
            && let Some((_, text)) = run("claude", &["auth", "status"])
        {
            (claude.logged_in, claude.method, claude.email, claude.plan) = parse_claude_auth(&text);
        }
        claude
    };
    let codex = || {
        let version = run("codex", &["--version"]);
        let mut codex = CliAccount {
            engine: "codex",
            installed: version.is_some(),
            version: version.and_then(|(_, t)| extract_version(&t)),
            ..Default::default()
        };
        if codex.installed
            && let Some((code, text)) = run("codex", &["login", "status"])
        {
            (codex.logged_in, codex.method) = parse_codex_login(code, &text);
        }
        codex
    };
    // Hai CLI độc lập; mỗi bên khởi động mất vài trăm ms nên hỏi cùng lúc.
    std::thread::scope(|s| {
        let codex = s.spawn(codex);
        let claude = claude();
        vec![
            claude,
            codex.join().unwrap_or_else(|_| CliAccount {
                engine: "codex",
                ..Default::default()
            }),
        ]
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Cây thư mục cho khung "Thư mục"

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    /// Đường dẫn tính từ gốc thư mục, dùng `/`.
    pub path: String,
    pub dir: bool,
    pub depth: u8,
}

/// Thư mục sinh ra hoặc tải về: không phải code người viết, bỏ khỏi cây.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "coverage",
    "__pycache__",
    // .NET và Java: bin/obj là kết quả build; repo lớn trên Windows làm Glob của CLI quá giờ nếu không bỏ.
    "bin",
    "obj",
];
const TREE_MAX: usize = 400;

pub(crate) fn walk(root: &Path, dir: &Path, depth: u8, max_depth: u8, out: &mut Vec<TreeEntry>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<(String, bool)> = read
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = e.file_type().ok()?.is_dir();
            // `.hive` chứa setup.sh của dự án (thiết kế cho thấy trong cây); thư mục ẩn khác là cấu hình công cụ.
            let hidden = name.starts_with('.') && name != ".hive";
            (!hidden && !(is_dir && SKIP_DIRS.contains(&name.as_str()))).then_some((name, is_dir))
        })
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    for (name, is_dir) in entries {
        if out.len() >= TREE_MAX {
            return;
        }
        let path = dir.join(&name);
        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or(name);
        out.push(TreeEntry {
            path: rel,
            dir: is_dir,
            depth,
        });
        if is_dir && depth < max_depth {
            walk(root, &path, depth + 1, max_depth, out);
        }
    }
}

/// Hai tầng đầu của thư mục dự án (thư mục trước, theo tên), tối đa 400 mục.
pub fn tree(root: &Path) -> Vec<TreeEntry> {
    let mut out = Vec::new();
    walk(root, root, 0, 1, &mut out);
    out
}

/// Đuôi file được coi là tài liệu khi liệt kê cho agent (agent hỏi "tài liệu nào" thì có sẵn danh sách).
const DOC_EXTS: &[&str] = &[
    "md", "mdx", "markdown", "txt", "rst", "adoc", "pdf", "docx", "doc",
];
const DOCS_MAX: usize = 80;
const DOCS_DEPTH: u8 = 4;

fn walk_docs(root: &Path, dir: &Path, depth: u8, out: &mut Vec<String>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<(String, bool)> = read
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = e.file_type().ok()?.is_dir();
            (!name.starts_with('.') && !(is_dir && SKIP_DIRS.contains(&name.as_str())))
                .then_some((name, is_dir))
        })
        .collect();
    // File trước thư mục để tài liệu ở gốc (README, docs/…) có chỗ trước khi chạm giới hạn.
    entries.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    for (name, is_dir) in entries {
        if out.len() >= DOCS_MAX {
            return;
        }
        let path = dir.join(&name);
        if is_dir {
            if depth < DOCS_DEPTH {
                walk_docs(root, &path, depth + 1, out);
            }
            continue;
        }
        let ext = Path::new(&name)
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if DOC_EXTS.contains(&ext.as_str()) {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// File tài liệu trong thư mục dự án (tối đa 80, sâu 4 tầng, bỏ thư mục ẩn và thư mục sinh ra).
pub fn doc_files(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    walk_docs(root, root, 0, &mut out);
    out
}

/// Danh sách tài liệu đưa vào prompt của màn "Tài liệu từ code": agent biết có tài liệu nào mà không phải Glob cả repo
/// (repo lớn làm Glob của Claude Code quá giờ 20 giây).
#[tauri::command]
pub async fn folder_docs(folder: String) -> Result<Vec<String>, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let root = project_folder(&folder, home.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || doc_files(&root))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn folder_tree(folder: String) -> Result<Vec<TreeEntry>, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let root = project_folder(&folder, home.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || tree(&root))
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------------------------
// Gửi đề xuất lên hub

/// Dạng key tài liệu của hub: `org/…`, `team/<đội>/…`, `project/<dự án>/…`, chữ thường không dấu. Hub kiểm lại; ở đây
/// chặn sớm để không gửi nội dung lớn cho một key chắc chắn sai.
pub fn valid_doc_key(key: &str) -> bool {
    let parts: Vec<&str> = key.split('/').collect();
    let rest = match parts.first() {
        Some(&"org") => &parts[1..],
        Some(&"team" | &"project") if parts.len() > 1 => {
            let slug = parts[1];
            if slug.is_empty()
                || !slug
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            {
                return false;
            }
            &parts[2..]
        }
        _ => return false,
    };
    key.len() <= 200
        && !rest.is_empty()
        && rest.iter().all(|p| {
            p.chars()
                .next()
                .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                && p.chars().all(|c| {
                    c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-')
                })
        })
}

/// "Đẩy lên hub và gửi duyệt": gửi bản nháp thành đề xuất (`doc_propose`) bằng token cá nhân. Lệnh riêng thay vì mở
/// `hub_tool` cho tool ghi, để cửa sổ app chỉ ghi được đúng việc này.
#[tauri::command]
pub async fn propose_doc(
    app: AppHandle,
    key: String,
    base_version: u32,
    content: String,
    note: String,
) -> Result<Value, String> {
    if !valid_doc_key(&key) {
        return Err(format!("Key tài liệu không hợp lệ: {key}"));
    }
    let note = note.trim();
    if note.is_empty() || note.chars().count() > 2000 {
        return Err("Ghi vì sao cần sửa (tối đa 2000 ký tự) cho người duyệt.".into());
    }
    if content.chars().count() > 200_000 {
        return Err("Tài liệu dài tối đa 200.000 ký tự.".into());
    }
    let hub = crate::hub_of(&app).ok_or("Máy chưa đăng ký với hub nào.")?;
    let token = crate::account::stored_token(&hub)
        .ok_or("Chưa liên kết tài khoản: mở thẻ người dùng ở góc dưới để dán token MCP.")?;
    let args = serde_json::json!({ "key": key, "baseVersion": base_version, "content": content, "note": note });
    crate::hub::call_tool(&hub, &token, "doc_propose", args)
        .await
        .map_err(|e| e.text())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_env_sets_glob_defaults_but_keeps_user_values() {
        let mut env: Vec<(OsString, OsString)> =
            vec![("CLAUDE_CODE_GLOB_TIMEOUT_SECONDS".into(), "120".into())];
        search_env(&mut env);
        assert_eq!(
            env,
            vec![
                ("CLAUDE_CODE_GLOB_TIMEOUT_SECONDS".into(), "120".into()),
                ("CLAUDE_CODE_GLOB_NO_IGNORE".into(), "false".into()),
            ]
        );
    }

    #[test]
    fn doc_files_lists_documents_and_skips_generated_folders() {
        let root = std::env::temp_dir().join(format!("hive-docs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (path, body) in [
            ("README.md", "x"),
            ("docs/spec/srs.docx", "x"),
            ("docs/plan.pdf", "x"),
            ("src/main.cs", "x"),
            ("bin/Debug/notes.md", "x"),
            ("node_modules/pkg/README.md", "x"),
            (".git/HEAD.md", "x"),
        ] {
            let p = root.join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        assert_eq!(
            doc_files(&root),
            ["README.md", "docs/plan.pdf", "docs/spec/srs.docx"]
        );
        let _ = std::fs::remove_dir_all(&root);
    }
    use std::io::Cursor;

    #[test]
    fn reads_claude_and_codex_accounts_at_the_same_time() {
        // Mỗi lệnh giả mất 100 ms như CLI thật (claude, codex khởi động Node/Rust): bốn lệnh nối tiếp là 400 ms.
        fn slow(program: &str, args: &[&str]) -> Option<(Option<i32>, String)> {
            std::thread::sleep(std::time::Duration::from_millis(100));
            Some(match (program, args) {
                ("claude", ["auth", "status"]) => (
                    Some(0),
                    r#"{"loggedIn":true,"authMethod":"claude.ai","email":"ha@acme.vn","subscriptionType":"max"}"#.into(),
                ),
                ("codex", ["login", "status"]) => (Some(0), "Logged in using ChatGPT".into()),
                _ => (Some(0), format!("{program} 2.1.0")),
            })
        }
        let started = std::time::Instant::now();
        let accounts = read_cli_accounts(slow);
        let took = started.elapsed();
        eprintln!("cli_accounts với lệnh 100 ms: {took:?}");
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].engine, "claude");
        assert!(accounts[0].logged_in);
        assert_eq!(accounts[0].version.as_deref(), Some("2.1.0"));
        assert_eq!(accounts[1].engine, "codex");
        assert!(accounts[1].logged_in);
        assert!(took < std::time::Duration::from_millis(350));
    }

    fn temp(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "hive-cli-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    #[test]
    fn env_keeps_only_the_allowlist() {
        let vars = os(&[
            ("HOME", "/Users/ha"),
            ("LANG", "vi_VN.UTF-8"),
            ("LC_ALL", "vi_VN.UTF-8"),
            ("https_proxy", "http://proxy.acme.vn:3128"),
            ("CLAUDE_CONFIG_DIR", "/Users/ha/.claude-work"),
            ("CODEX_HOME", "/Users/ha/.codex"),
            ("PATH", "/usr/bin:/bin"),
            ("HIVE_MACHINE_TOKEN", "hwm_secret"),
            ("HIVE_REGISTRATION_TOKEN", "hwr_secret"),
            ("HIVE_TOKEN", "hive_pat_secret"),
            ("hive_lowercase", "x"),
            ("DATABASE_URL", "postgres://hive:pw@db/hive"),
            ("GITHUB_TOKEN", "ghp_secret"),
            ("ANTHROPIC_API_KEY", "sk-ant-org"),
            ("OPENAI_API_KEY", "sk-org"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_MESSAGING_TOKEN", "x"),
            ("SSH_AUTH_SOCK", "/tmp/agent.sock"),
        ]);
        let env = child_env(vars, "/opt/homebrew/bin:/usr/bin");
        let keys: Vec<String> = env
            .iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            keys,
            [
                "HOME",
                "LANG",
                "LC_ALL",
                "https_proxy",
                "CLAUDE_CONFIG_DIR",
                "CODEX_HOME",
                "PATH"
            ]
        );
        let path = &env.last().unwrap().1;
        assert_eq!(path, "/opt/homebrew/bin:/usr/bin");
        let all = format!("{env:?}");
        for secret in [
            "hwm_secret",
            "hwr_secret",
            "hive_pat_secret",
            "postgres://",
            "ghp_secret",
            "sk-",
        ] {
            assert!(!all.contains(secret), "{secret} lọt vào môi trường của CLI");
        }
    }

    #[cfg(unix)]
    #[test]
    fn spawned_cli_does_not_see_hub_secrets() {
        let dir = temp("env");
        let env = child_env(
            os(&[
                ("HOME", "/Users/ha"),
                ("HIVE_MACHINE_TOKEN", "hwm_should_not_leak"),
                ("DATABASE_URL", "postgres://leak"),
            ]),
            "/usr/bin:/bin",
        );
        let mut cmd = command("env", &[], &dir, env);
        cmd.stdin(Stdio::null());
        let out = cmd.output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("PATH="));
        assert!(text.contains("HOME=/Users/ha"));
        assert!(!text.contains("hwm_should_not_leak"));
        assert!(!text.contains("postgres://leak"));
        // Không thừa kế gì từ tiến trình cha (môi trường của test có USER, TMPDIR…).
        assert_eq!(text.lines().count(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn claude_runs_read_only() {
        let args = claude_args(None, None, Mode::Read);
        let joined = args.join(" ");
        for flag in [
            "-p",
            "--output-format stream-json",
            "--verbose",
            "--restricted",
            "--strict-mcp-config",
            "--tools Read,Glob,Grep",
            "--permission-prompts none",
        ] {
            assert!(joined.contains(flag), "thiếu {flag}");
        }
        for tool in ["Write", "Edit", "Bash", "WebFetch"] {
            assert!(!joined.contains(tool));
        }
        assert!(!joined.contains("--mcp-config"));
        assert!(!joined.contains("--resume"));
        let resumed = claude_args(
            Some("7854d262-d8c6-4701-964c-dee4af8a1f1b"),
            None,
            Mode::Read,
        );
        assert_eq!(
            resumed[resumed.len() - 2..],
            ["--resume", "7854d262-d8c6-4701-964c-dee4af8a1f1b"]
        );
    }

    #[test]
    fn codex_runs_read_only() {
        let folder = Path::new("/w/payment-api");
        assert_eq!(
            codex_args(folder, None, None, Mode::Read),
            [
                "exec",
                "--json",
                "--ignore-user-config",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                "-C",
                "/w/payment-api",
                "-"
            ]
        );
        assert_eq!(
            codex_args(
                folder,
                Some("01a12fc6-f57d-7833-bbae-a1fcd5044a11"),
                None,
                Mode::Read
            ),
            [
                "exec",
                "resume",
                "--json",
                "--ignore-user-config",
                "--skip-git-repo-check",
                "-c",
                "sandbox_mode=\"read-only\"",
                "01a12fc6-f57d-7833-bbae-a1fcd5044a11",
                "-"
            ]
        );
    }

    #[test]
    fn claude_modes_and_model() {
        let edit = claude_args(None, Some("sonnet"), Mode::Edit).join(" ");
        for flag in [
            "--restricted",
            "--strict-mcp-config",
            "--tools Read,Glob,Grep,Edit,Write",
            "--permission-mode acceptEdits",
            "--permission-prompts none",
            "--model sonnet",
        ] {
            assert!(edit.contains(flag), "thiếu {flag}");
        }
        assert!(!edit.contains("Bash"));
        let bypass = claude_args(
            Some("7854d262-d8c6-4701-964c-dee4af8a1f1b"),
            None,
            Mode::Bypass,
        );
        let joined = bypass.join(" ");
        assert!(joined.contains("--permission-mode bypassPermissions"));
        assert!(joined.contains("--strict-mcp-config"));
        // --restricted từ chối bypassPermissions.
        assert!(!joined.contains("--restricted"));
        assert!(!joined.contains("--model"));
        assert_eq!(
            bypass[bypass.len() - 2..],
            ["--resume", "7854d262-d8c6-4701-964c-dee4af8a1f1b"]
        );
    }

    #[test]
    fn codex_modes_and_model() {
        let folder = Path::new("/w/payment-api");
        assert_eq!(
            codex_args(folder, None, Some("gpt-5.5-codex"), Mode::Edit),
            [
                "exec",
                "--json",
                "--ignore-user-config",
                "--skip-git-repo-check",
                "--sandbox",
                "workspace-write",
                "-m",
                "gpt-5.5-codex",
                "-C",
                "/w/payment-api",
                "-"
            ]
        );
        assert_eq!(
            codex_args(folder, Some("01a12fc6-f57d"), None, Mode::Edit)[5..7],
            ["-c", "sandbox_mode=\"workspace-write\""]
        );
        for session in [None, Some("01a12fc6-f57d")] {
            let args = codex_args(folder, session, None, Mode::Bypass);
            assert!(args.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
            assert!(
                !args
                    .iter()
                    .any(|a| a.contains("sandbox_mode") || a == "--sandbox")
            );
        }
    }

    #[test]
    fn modes_and_models_are_checked() {
        assert_eq!(Mode::parse(None), Ok(Mode::Read));
        assert_eq!(Mode::parse(Some("edit")), Ok(Mode::Edit));
        assert_eq!(Mode::parse(Some("bypass")), Ok(Mode::Bypass));
        assert!(Mode::parse(Some("full")).is_err());
        for ok in ["opus", "claude-opus-5-5", "gpt-5.5-codex", "o4:mini", "a_b"] {
            assert!(valid_model(ok), "{ok}");
        }
        for bad in [
            "",
            "--dangerously-skip-permissions",
            "opus --tools Bash",
            "a/b",
            "x;rm",
            &"a".repeat(65),
        ] {
            assert!(!valid_model(bad), "{bad}");
        }
    }

    #[test]
    fn session_ids_cannot_become_flags() {
        assert!(valid_session("7854d262-d8c6-4701-964c-dee4af8a1f1b"));
        assert!(!valid_session("--dangerously-skip-permissions"));
        assert!(!valid_session("abc"));
        assert!(!valid_session("7854d262 --tools Bash"));
    }

    #[test]
    fn folder_must_be_a_project_folder() {
        let dir = temp("folder");
        assert_eq!(
            project_folder(&format!(" {} ", dir.display()), None).unwrap(),
            dir
        );
        assert!(project_folder("/khong/co/thu/muc", None).is_err());
        assert!(project_folder("relative/path", None).is_err());
        assert!(project_folder("", None).is_err());
        assert!(project_folder("/", None).is_err());
        assert!(project_folder(&dir.display().to_string(), Some(&dir)).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // Dòng thật của Claude Code 2.1.296 (`claude -p --output-format stream-json --verbose --restricted …`), đã cắt bớt
    // trường không dùng.
    const CLAUDE: &str = r#"{"type":"system","subtype":"init","cwd":"/w/sample","session_id":"7854d262-d8c6-4701-964c-dee4af8a1f1b","tools":["Glob","Grep","Read"],"mcp_servers":[],"model":"claude-haiku-5-5","permissionMode":"default","claude_code_version":"2.1.296"}
{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"session_id":"7854d262-d8c6-4701-964c-dee4af8a1f1b"}
{"type":"assistant","message":{"model":"claude-haiku-5-5","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"CAQS"}]},"session_id":"7854d262-d8c6-4701-964c-dee4af8a1f1b"}
{"type":"assistant","message":{"model":"claude-haiku-5-5","role":"assistant","content":[{"type":"text","text":"Tôi đọc go.mod trước."}]},"parent_tool_use_id":null}
{"type":"assistant","message":{"model":"claude-haiku-5-5","role":"assistant","content":[{"type":"tool_use","id":"toolu_011EUmdXEEMnnkpe5PtGKqXc","name":"Read","input":{"file_path":"/w/sample/go.mod"},"caller":{"type":"direct"}}]}}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_011EUmdXEEMnnkpe5PtGKqXc","type":"tool_result","content":"1\tmodule example.com/w\n2\t\n3\tgo 1.27\n4\t"}]},"tool_use_result":{"type":"text","file":{"filePath":"/w/sample/go.mod","content":"module example.com/w\n\ngo 1.27\n","numLines":4,"startLine":1,"totalLines":4}}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_glob","name":"Glob","input":{"pattern":"**/*.go"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"internal/channel/ws.go","tool_use_id":"toolu_glob"}]},"tool_use_result":{"filenames":["internal/channel/ws.go"],"durationMs":29,"numFiles":1,"truncated":false}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_grep","name":"Grep","input":{"pattern":"websocket","output_mode":"files_with_matches"}}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_hosts","name":"Read","input":{"file_path":"/etc/hosts"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"/etc/hosts is outside /w/sample; --restricted confines the file tools to the working directory.","is_error":true,"tool_use_id":"toolu_hosts"}]},"tool_use_result":"Error: /etc/hosts is outside /w/sample"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1792094400,"rateLimitType":"seven_day","utilization":0.82}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"```markdown\n# example.com/w\n```"}]}}
{"duration_api_ms":5746,"stop_reason":"end_turn","session_id":"7854d262-d8c6-4701-964c-dee4af8a1f1b","total_cost_usd":0.00184146,"usage":{"input_tokens":4,"cache_creation_input_tokens":6555,"cache_read_input_tokens":5956,"output_tokens":941},"is_error":false,"num_turns":3,"subtype":"success","result":"```markdown\n# example.com/w\n```","type":"result","duration_ms":6400}
not json"#;

    fn collect(engine: Engine, text: &str, folder: &Path) -> Vec<AgentEvent> {
        let mut out = Vec::new();
        read_stream(Cursor::new(text), engine, folder, |e| out.push(e));
        out
    }

    #[test]
    fn parses_claude_stream_json() {
        let events = collect(Engine::Claude, CLAUDE, Path::new("/w/sample"));
        assert_eq!(
            events[0],
            AgentEvent::Session {
                id: "7854d262-d8c6-4701-964c-dee4af8a1f1b".into(),
                model: Some("claude-haiku-5-5".into())
            }
        );
        assert_eq!(
            events[1],
            AgentEvent::Text {
                text: "Tôi đọc go.mod trước.".into()
            }
        );
        assert_eq!(
            events[2],
            AgentEvent::Tool {
                id: "toolu_011EUmdXEEMnnkpe5PtGKqXc".into(),
                name: "Read".into(),
                arg: "go.mod".into(),
                paths: vec!["go.mod".into()]
            }
        );
        assert_eq!(
            events[3],
            AgentEvent::ToolDone {
                id: "toolu_011EUmdXEEMnnkpe5PtGKqXc".into(),
                ok: true,
                lines: Some(4),
                files: None,
                preview: "1\tmodule example.com/w".into()
            }
        );
        assert!(
            matches!(&events[4], AgentEvent::Tool { name, arg, .. } if name == "Glob" && arg == "**/*.go")
        );
        assert!(matches!(
            &events[5],
            AgentEvent::ToolDone {
                files: Some(1),
                ok: true,
                ..
            }
        ));
        assert!(
            matches!(&events[6], AgentEvent::Tool { name, arg, .. } if name == "Grep" && arg == "\"websocket\"")
        );
        // Đọc ngoài thư mục bị --restricted chặn: tool báo lỗi, đường dẫn giữ nguyên (không thành chấm xanh trong cây).
        assert!(matches!(&events[7], AgentEvent::Tool { arg, .. } if arg == "/etc/hosts"));
        assert!(
            matches!(&events[8], AgentEvent::ToolDone { ok: false, preview, .. } if preview.contains("--restricted"))
        );
        assert_eq!(
            events[9],
            AgentEvent::Limit {
                window: "seven_day".into(),
                percent: 82
            }
        );
        assert!(matches!(&events[10], AgentEvent::Text { .. }));
        assert_eq!(
            events[11],
            AgentEvent::Result {
                ok: true,
                text: Some("```markdown\n# example.com/w\n```".into()),
                error: None,
                input_tokens: 4 + 6555 + 5956,
                cached_tokens: 5956,
                output_tokens: 941,
                cost_usd: Some(0.00184146),
                duration_ms: Some(6400),
            }
        );
        assert_eq!(events.len(), 12);
    }

    #[test]
    fn claude_error_result_keeps_the_reason() {
        let line = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"errors":["Reached maximum number of turns"],"usage":{}}"#;
        assert!(matches!(
            &parse_claude_line(line, Path::new("/w"))[0],
            AgentEvent::Result { ok: false, error: Some(e), .. } if e == "Reached maximum number of turns"
        ));
    }

    // Dòng thật của codex-cli 0.162.1 (`codex exec --json --sandbox read-only …`).
    const CODEX: &str = r#"{"type":"thread.started","thread_id":"01a12fc6-f57d-7833-bbae-a1fcd5044a11"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll read the two files and write a short, three-line description."}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'cat go.mod internal/channel/ws.go'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'cat go.mod internal/channel/ws.go'","aggregated_output":"module example.com/w\n\ngo 1.27\npackage channel\n","exit_code":0,"status":"completed"}}
{"type":"item.updated","item":{"id":"item_2","type":"todo_list","items":[{"text":"Đọc go.mod","completed":true},{"text":"Viết mục Kênh tới hub","completed":false},{"text":"Đánh dấu phần chưa có code","completed":false}]}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"```markdown\n# example.com/w\n```"}}
{"type":"turn.completed","usage":{"input_tokens":41568,"cached_input_tokens":33664,"cache_write_input_tokens":0,"output_tokens":99,"reasoning_output_tokens":0}}"#;

    #[test]
    fn parses_codex_jsonl() {
        let dir = temp("codex");
        std::fs::write(dir.join("go.mod"), "module example.com/w\n").unwrap();
        std::fs::create_dir_all(dir.join("internal/channel")).unwrap();
        std::fs::write(dir.join("internal/channel/ws.go"), "package channel\n").unwrap();
        let events = collect(Engine::Codex, CODEX, &dir);
        assert_eq!(
            events[0],
            AgentEvent::Session {
                id: "01a12fc6-f57d-7833-bbae-a1fcd5044a11".into(),
                model: None
            }
        );
        assert!(matches!(&events[1], AgentEvent::Text { text } if text.starts_with("I’ll read")));
        assert_eq!(
            events[2],
            AgentEvent::Tool {
                id: "item_1".into(),
                name: "shell".into(),
                arg: "cat go.mod internal/channel/ws.go".into(),
                paths: vec!["go.mod".into(), "internal/channel/ws.go".into()]
            }
        );
        assert_eq!(
            events[3],
            AgentEvent::ToolDone {
                id: "item_1".into(),
                ok: true,
                lines: Some(4),
                files: None,
                preview: "module example.com/w".into()
            }
        );
        assert_eq!(
            events[4],
            AgentEvent::Todos {
                items: vec![
                    Todo {
                        text: "Đọc go.mod".into(),
                        status: "done"
                    },
                    Todo {
                        text: "Viết mục Kênh tới hub".into(),
                        status: "doing"
                    },
                    Todo {
                        text: "Đánh dấu phần chưa có code".into(),
                        status: "todo"
                    },
                ]
            }
        );
        assert!(matches!(&events[5], AgentEvent::Text { text } if text.contains("```markdown")));
        assert!(matches!(
            &events[6],
            AgentEvent::Result {
                ok: true,
                input_tokens: 41568,
                cached_tokens: 33664,
                output_tokens: 99,
                ..
            }
        ));
        assert_eq!(events.len(), 7);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn codex_failures_surface() {
        assert!(matches!(
            &parse_codex_line(r#"{"type":"turn.failed","error":{"message":"You've hit your usage limit."}}"#)[0],
            AgentEvent::Result { ok: false, error: Some(e), .. } if e.contains("usage limit")
        ));
        assert_eq!(
            parse_codex_line(r#"{"type":"error","message":"stream disconnected"}"#),
            [AgentEvent::Notice {
                text: "stream disconnected".into()
            }]
        );
    }

    #[test]
    fn unwraps_codex_shell_commands() {
        assert_eq!(
            unwrap_shell("/bin/zsh -lc 'cat go.mod'"),
            "cat go.mod".to_string()
        );
        assert_eq!(
            unwrap_shell("/bin/bash -lc 'rg -n '\\''proxy'\\'' internal'"),
            "rg -n 'proxy' internal"
        );
        assert_eq!(
            unwrap_shell("bash -c \"sed -n 1,120p \\\"a b.go\\\"\""),
            "sed -n 1,120p \"a b.go\""
        );
        assert_eq!(unwrap_shell("rg -c websocket"), "rg -c websocket");
    }

    #[test]
    fn command_paths_only_names_files_in_the_folder() {
        let dir = temp("paths");
        std::fs::write(dir.join("go.mod"), "").unwrap();
        std::fs::create_dir_all(dir.join("internal")).unwrap();
        std::fs::write(dir.join("internal/ws.go"), "").unwrap();
        assert_eq!(
            command_paths(
                "sed -n 1,80p ./internal/ws.go | head; cat go.mod go.mod ../secret /etc/hosts -n internal",
                &dir
            ),
            ["internal/ws.go", "go.mod"]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tree_lists_two_levels_without_generated_dirs() {
        let dir = temp("tree");
        for d in [
            "cmd/hive-worker",
            "internal/channel",
            "node_modules/x",
            ".git",
            ".hive",
        ] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
        }
        for f in [
            "go.mod",
            "cmd/hive-worker/main.go",
            "internal/channel/ws.go",
            ".hive/setup.sh",
            ".env",
        ] {
            std::fs::write(dir.join(f), "").unwrap();
        }
        let got: Vec<(String, bool, u8)> = tree(&dir)
            .into_iter()
            .map(|e| (e.path, e.dir, e.depth))
            .collect();
        assert_eq!(
            got,
            [
                (".hive".to_string(), true, 0),
                (".hive/setup.sh".to_string(), false, 1),
                ("cmd".to_string(), true, 0),
                ("cmd/hive-worker".to_string(), true, 1),
                ("internal".to_string(), true, 0),
                ("internal/channel".to_string(), true, 1),
                ("go.mod".to_string(), false, 0),
            ]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_cli_sign_in_state() {
        let claude = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"lan@acme.vn","subscriptionType":"max"}"#;
        assert_eq!(
            parse_claude_auth(claude),
            (
                true,
                Some("claude.ai".into()),
                Some("lan@acme.vn".into()),
                Some("max".into())
            )
        );
        assert_eq!(
            parse_claude_auth("Not logged in"),
            (false, None, None, None)
        );
        assert_eq!(
            parse_codex_login(Some(0), "Logged in using ChatGPT\n"),
            (true, Some("ChatGPT".into()))
        );
        assert_eq!(
            parse_codex_login(Some(0), "Logged in using an API key - sk-proj-***ABCD"),
            (true, Some("API key".into()))
        );
        assert_eq!(parse_codex_login(Some(1), "Not logged in"), (false, None));
    }

    #[test]
    fn doc_keys_follow_the_hub_format() {
        assert!(valid_doc_key("project/payment-api/architecture"));
        assert!(valid_doc_key("org/quy-uoc/tien-te.md"));
        assert!(valid_doc_key("team/thanh-toan/runbook"));
        assert!(!valid_doc_key("project/Payment/architecture"));
        assert!(!valid_doc_key("project/payment-api"));
        assert!(!valid_doc_key("docs/architecture.md"));
        assert!(!valid_doc_key("org/../secret"));
        assert!(!valid_doc_key(&format!("org/{}", "a".repeat(200))));
    }

    #[cfg(unix)]
    #[test]
    fn cancel_kills_the_whole_process_group() {
        let dir = temp("kill");
        // sh chạy sleep làm tiến trình con: huỷ phải giết cả cháu, nếu không ống stdout không đóng.
        let env = child_env(os(&[]), "/usr/bin:/bin");
        let mut cmd = command("sh", &["-c".into(), "sleep 30 & wait".into()], &dir, env);
        cmd.stdin(Stdio::null());
        let mut child = cmd.spawn().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let started = std::time::Instant::now();
        kill_tree(&mut child);
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = child.wait();
        assert!(started.elapsed() < Duration::from_secs(5));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
