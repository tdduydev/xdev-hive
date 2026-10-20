//! Điểm tối ưu token (spec 025): lệnh Tauri cho thẻ điểm ở màn Token.
//!
//! Điểm và các sửa nhanh `optimizer.*` chạy trong sidecar (ADR 0026). Rust giữ kết quả điểm gần nhất để đổi
//! `projectKey` thành thư mục dự án, và tự chạy hai sửa nhanh nằm ngoài sidecar (`codegraph.mcp`, `codegraph.init`).
//! Giao diện chỉ gửi id, không bao giờ gửi chuỗi lệnh hay đường dẫn: id lạ, gói hay dự án không có trong kết quả
//! điểm gần nhất đều bị từ chối.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::doctor::{Output, run_with_timeout, user_path};
use crate::setup_extra::{McpNeed, in_path, mcp_add_argv};
use crate::sidecar_json;

const MCP_TIMEOUT: Duration = Duration::from_secs(60);
const INIT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const GIT_TIMEOUT: Duration = Duration::from_secs(15);
const OUTPUT_TAIL: usize = 400;
const MCP_NAME: &str = "codegraph";
const EXCLUDE_LINE: &str = ".codegraph/";
/// Chờ sau khi mở app rồi mới tính nền, để việc tính không tranh tài nguyên với lúc app khởi động.
const DAILY_DELAY: Duration = Duration::from_secs(2 * 60);
/// Điểm cũ hơn mức này thì tính lại khi mở app.
const DAILY_MAX_AGE_SECS: i64 = 24 * 60 * 60;
/// Sự kiện báo lần tính nền xong; tên khớp `TOKEN_SCORE_UPDATED` ở `lib/token-score.ts`.
const UPDATED_EVENT: &str = "token-score-updated";

/// Tắt telemetry ẩn danh (mặc định bật) và daemon nền của CodeGraph, như worker (`runner/tools.go` `codegraphEnv`).
const CODEGRAPH_ENV: [(&str, &str); 3] = [
    ("CODEGRAPH_TELEMETRY", "0"),
    ("DO_NOT_TRACK", "1"),
    ("CODEGRAPH_NO_DAEMON", "1"),
];

/// Kết quả điểm gần nhất, và khoá cho file các lần sửa nhanh Rust đã áp dụng.
#[derive(Default)]
pub struct Last {
    score: Mutex<Option<Value>>,
    applied: Mutex<()>,
}

/// Một lần sửa nhanh chạy trong Rust (`codegraph.mcp`, `codegraph.init`) đã áp dụng. Lưu xuống đĩa để hoàn tác chỉ gỡ
/// đúng thứ app đã làm, kể cả sau khi mở lại app: không có bản ghi thì không hoàn tác.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Applied {
    fix_id: String,
    profile: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<PathBuf>,
    /// Chỉ gỡ dòng `.codegraph/` khi chính app đã thêm, không đụng dòng người dùng tự viết.
    #[serde(default)]
    exclude_added: bool,
}

fn applied_path() -> Result<PathBuf, String> {
    Ok(home()?
        .join(".xdev-hive")
        .join("optimizer")
        .join("score-desktop-fixes.json"))
}

fn load_applied(path: &Path) -> Vec<Applied> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_applied(path: &Path, list: &[Applied]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string(list).map_err(|e| e.to_string())?;
    std::fs::write(path, text)
        .map_err(|e| format!("Không ghi được danh sách sửa nhanh đã áp dụng: {e}"))
}

/// Lần áp dụng gần nhất khớp sửa nhanh, gói và (với `codegraph.init`) dự án.
fn find_applied(
    list: &[Applied],
    fix: Fix,
    profile: &str,
    project: Option<&Path>,
) -> Option<usize> {
    list.iter().rposition(|a| {
        a.fix_id == fix.id() && a.profile == profile && a.project.as_deref() == project
    })
}

/// Đọc, sửa rồi ghi lại danh sách dưới khoá, để hai lần bấm cùng lúc không ghi đè nhau.
fn update_applied<T>(
    app: &AppHandle,
    change: impl FnOnce(&mut Vec<Applied>) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<Last>();
    let _guard = state.applied.lock().map_err(|e| e.to_string())?;
    let path = applied_path()?;
    let mut list = load_applied(&path);
    let out = change(&mut list)?;
    save_applied(&path, &list)?;
    Ok(out)
}

fn codegraph_env() -> Vec<(&'static str, String)> {
    CODEGRAPH_ENV
        .iter()
        .map(|(k, v)| (*k, (*v).to_string()))
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fix {
    Balanced,
    Rtk,
    Aggressive,
    CodegraphMcp,
    CodegraphInit,
}

/// Bảng cho phép. `tool.*` và `open.*` do giao diện tự xử lý (mở màn khác) nên không có ở đây.
const FIXES: [(&str, Fix); 5] = [
    ("optimizer.balanced", Fix::Balanced),
    ("optimizer.rtk", Fix::Rtk),
    ("optimizer.aggressive", Fix::Aggressive),
    ("codegraph.mcp", Fix::CodegraphMcp),
    ("codegraph.init", Fix::CodegraphInit),
];

impl Fix {
    fn parse(id: &str) -> Result<Fix, String> {
        FIXES
            .iter()
            .find(|(name, _)| *name == id)
            .map(|(_, fix)| *fix)
            .ok_or_else(|| "Sửa nhanh này không có trong danh sách cho phép.".to_string())
    }

    fn id(self) -> &'static str {
        FIXES
            .iter()
            .find(|(_, fix)| *fix == self)
            .map(|(name, _)| *name)
            .unwrap_or_default()
    }

    /// Sửa nhanh Rust tự chạy thì Rust tự ghi mốc cho biểu đồ; `optimizer.*` do sidecar ghi trong `optimize fix`.
    fn marks_in_rust(self) -> bool {
        matches!(self, Fix::CodegraphMcp | Fix::CodegraphInit)
    }

    /// Chạy trong sidecar (`optimize fix`), không phải trong Rust.
    fn in_sidecar(self) -> bool {
        matches!(self, Fix::Balanced | Fix::Rtk | Fix::Aggressive)
    }

    fn allows(self, cli: &str) -> bool {
        match self {
            Fix::Balanced | Fix::CodegraphMcp => matches!(cli, "claude" | "codex"),
            // Sidecar chỉ đề nghị đổi model subagent (mức aggressive) cho Claude Code.
            Fix::Rtk | Fix::Aggressive => cli == "claude",
            Fix::CodegraphInit => matches!(cli, "claude" | "codex" | "antigravity"),
        }
    }
}

struct Resolved {
    fix: Fix,
    cli: String,
    /// Đường dẫn rút gọn `~/…` như trong kết quả điểm; chỉ có với sửa nhanh cần dự án.
    project: Option<String>,
}

fn find_profile<'a>(score: &'a Value, id: &str) -> Option<&'a Value> {
    score["profiles"].as_array()?.iter().find(|p| p["id"] == id)
}

fn project_path(score: &Value, profile: &str, key: &str) -> Result<String, String> {
    find_profile(score, profile)
        .and_then(|p| p["projects"].as_array())
        .and_then(|projects| projects.iter().find(|p| p["key"] == key))
        .and_then(|p| p["path"].as_str())
        .map(str::to_string)
        .ok_or_else(|| "Dự án này không có trong kết quả điểm gần nhất.".to_string())
}

/// Kiểm id sửa nhanh, gói và dự án đều nằm trong kết quả điểm gần nhất rồi mới cho chạy.
fn resolve(
    score: &Value,
    fix_id: &str,
    profile_id: &str,
    project_key: Option<&str>,
) -> Result<Resolved, String> {
    let fix = Fix::parse(fix_id)?;
    let cli = find_profile(score, profile_id)
        .and_then(|p| p["cli"].as_str())
        .ok_or("Gói này không có trong kết quả điểm gần nhất. Hãy tính lại điểm.")?;
    if !fix.allows(cli) {
        return Err(format!("Sửa nhanh này không dùng được cho {cli}."));
    }
    let project = if fix == Fix::CodegraphInit {
        let key = project_key.ok_or("Cần chọn một dự án.")?;
        Some(project_path(score, profile_id, key)?)
    } else {
        None
    };
    Ok(Resolved {
        fix,
        cli: cli.to_string(),
        project,
    })
}

fn profile_arg(profile: &str) -> Result<String, String> {
    let profile = profile.trim();
    if profile.is_empty() || profile.chars().any(char::is_control) {
        return Err("Thiếu id hợp lệ của gói.".into());
    }
    // Giá trị bắt đầu bằng dấu '-' vẫn là id, không trở thành cờ của worker.
    Ok(format!("--profile={profile}"))
}

/// `fresh` chạy `/context` (gọi model, tốn token) cho đúng gói người dùng bấm đo; không có gói thì mọi gói Claude.
fn score_args(fresh: bool, profile: Option<&str>) -> Result<Vec<String>, String> {
    let mut args = vec!["optimize".to_string(), "score".into(), "--json".into()];
    if fresh {
        args.push("--fresh".into());
        if let Some(profile) = profile {
            args.push(profile_arg(profile)?);
        }
    }
    Ok(args)
}

/// Lịch sử cho biểu đồ: không tính điểm, không gọi model.
fn history_args(days: u32) -> Vec<String> {
    vec![
        "optimize".into(),
        "score".into(),
        "history".into(),
        "--json".into(),
        format!("--days={days}"),
    ]
}

/// Chỉ dòng cuối của lịch sử (huy hiệu ở menu, và kiểm điểm đã quá 24 giờ chưa).
fn last_args() -> Vec<String> {
    vec![
        "optimize".into(),
        "score".into(),
        "history".into(),
        "--json".into(),
        "--last".into(),
    ]
}

/// Ghi mốc cho sửa nhanh Rust tự chạy; id ngoài `codegraph.*` bị từ chối vì mốc của `optimizer.*` là của sidecar.
fn mark_args(fix: Fix, apply: bool) -> Result<Vec<String>, String> {
    if !fix.marks_in_rust() {
        return Err("Sửa nhanh này do worker tự ghi mốc.".into());
    }
    Ok(vec![
        "optimize".into(),
        "score".into(),
        "mark".into(),
        "--json".into(),
        format!("--fix={}", fix.id()),
        format!("--action={}", if apply { "apply" } else { "undo" }),
    ])
}

/// `optimize fix optimizer.rtk` trên Windows thoát với stderr bắt đầu bằng `windows_rtk_unsupported:`: đổi mã đó thành
/// câu tiếng Việt, các lỗi khác giữ nguyên chữ của worker.
fn sidecar_fix_error(message: String) -> String {
    if message.starts_with("windows_rtk_unsupported:") {
        return "RTK chưa hỗ trợ Windows nên không bật được trên máy này.".into();
    }
    message
}

fn fix_args(fix: Fix, profile: &str, preview: bool) -> Result<Vec<String>, String> {
    let mut args = vec![
        "optimize".to_string(),
        "fix".into(),
        fix.id().into(),
        "--json".into(),
        profile_arg(profile)?,
    ];
    if preview {
        args.push("--preview".into());
    }
    Ok(args)
}

/// Hoàn tác do sidecar làm: nó nhớ mức và RTK của gói trước lần sửa, rồi bật lại mức cũ hoặc tắt. Chép bản sao lưu
/// thì manifest vẫn ghi mức mới.
fn undo_args(fix: Fix, profile: &str) -> Result<Vec<String>, String> {
    let mut args = fix_args(fix, profile, false)?;
    args.push("--undo".into());
    Ok(args)
}

/// `codegraph serve --mcp`; trên Windows qua `cmd /c codegraph.cmd` như cấu hình đang chạy trên máy dev.
fn codegraph_need(windows: bool) -> McpNeed {
    let (command, args) = if windows {
        ("cmd", vec!["/c", "codegraph.cmd", "serve", "--mcp"])
    } else {
        ("codegraph", vec!["serve", "--mcp"])
    };
    McpNeed {
        name: MCP_NAME.into(),
        transport: "stdio".into(),
        command: Some(command.into()),
        args: args.into_iter().map(String::from).collect(),
        url: None,
    }
}

fn mcp_add(cli: &str, windows: bool) -> Result<Vec<String>, String> {
    let mut argv = mcp_add_argv(cli, &codegraph_need(windows))
        .ok_or_else(|| "CLI này chưa hỗ trợ thêm MCP.".to_string())?;
    // Server do CLI chạy về sau cũng phải tắt telemetry, nên env nằm trong cấu hình server (`--env` của cả hai CLI).
    let at = argv
        .iter()
        .position(|a| a == "--")
        .ok_or("Lệnh thêm MCP thiếu phần lệnh của server.")?;
    let env: Vec<String> = CODEGRAPH_ENV
        .iter()
        .flat_map(|(k, v)| ["--env".to_string(), format!("{k}={v}")])
        .collect();
    argv.splice(at..at, env);
    Ok(argv)
}

fn mcp_remove(cli: &str) -> Result<Vec<String>, String> {
    let argv: &[&str] = match cli {
        "claude" => &["claude", "mcp", "remove", "-s", "user", MCP_NAME],
        "codex" => &["codex", "mcp", "remove", MCP_NAME],
        _ => return Err("CLI này chưa hỗ trợ gỡ MCP.".into()),
    };
    Ok(argv.iter().map(|a| a.to_string()).collect())
}

/// `-y` và `-f` để lệnh không hỏi lại: stdin đã đóng nên một câu hỏi sẽ treo tới hết thời hạn.
fn init_argv(path: &str) -> Vec<String> {
    ["codegraph", "init", "-y", path].map(String::from).to_vec()
}

fn uninit_argv(path: &str) -> Vec<String> {
    ["codegraph", "uninit", "-f", path]
        .map(String::from)
        .to_vec()
}

struct ProfileDir {
    config_dir: Option<PathBuf>,
    default: bool,
}

fn profile_dir_of(status: &Value, id: &str) -> Option<ProfileDir> {
    let Some(p) = find_profile(status, id) else {
        // Điểm tự thêm thư mục mặc định (~/.claude, ~/.codex) với id là tên CLI, kể cả khi accounts.json không có nó.
        return matches!(id, "claude" | "codex").then_some(ProfileDir {
            config_dir: None,
            default: true,
        });
    };
    Some(ProfileDir {
        config_dir: p["configDir"]
            .as_str()
            .filter(|d| !d.is_empty())
            .map(PathBuf::from),
        default: p["default"].as_bool().unwrap_or(false),
    })
}

/// Biến môi trường để lệnh `mcp` của CLI ghi vào đúng gói. Gói mặc định không đặt gì: CLI tự dùng thư mục của nó.
fn mcp_env(cli: &str, dir: &ProfileDir) -> Result<Option<(&'static str, String)>, String> {
    if dir.default {
        return Ok(None);
    }
    let var = match cli {
        "claude" => "CLAUDE_CONFIG_DIR",
        "codex" => "CODEX_HOME",
        _ => return Err("CLI này chưa hỗ trợ thêm MCP.".into()),
    };
    let config_dir = dir
        .config_dir
        .as_ref()
        .ok_or("Không biết thư mục cấu hình của gói này.")?;
    Ok(Some((var, config_dir.to_string_lossy().into_owned())))
}

fn expand_home(path: &str, home: &Path) -> PathBuf {
    match path.strip_prefix("~") {
        Some("") => home.to_path_buf(),
        Some(rest) if rest.starts_with('/') || rest.starts_with('\\') => {
            home.join(rest.trim_start_matches(['/', '\\']))
        }
        _ => PathBuf::from(path),
    }
}

fn shorten_home(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) => {
            let parts: Vec<_> = rest.iter().map(|c| c.to_string_lossy()).collect();
            if parts.is_empty() {
                "~".to_string()
            } else {
                format!("~/{}", parts.join("/"))
            }
        }
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

/// File mà `mcp add` sẽ ghi, để hiện trong hộp xem trước.
fn mcp_config_file(cli: &str, dir: &ProfileDir, home: &Path) -> PathBuf {
    match (cli, &dir.config_dir) {
        ("codex", Some(d)) => d.join("config.toml"),
        ("codex", None) => home.join(".codex").join("config.toml"),
        (_, Some(d)) if !dir.default => d.join(".claude.json"),
        _ => home.join(".claude.json"),
    }
}

fn local_preview(fix: Fix, profile: &str, file: String, command: String) -> Value {
    let (after, warning) = match fix {
        Fix::CodegraphInit => ("indexed", "long_running"),
        _ => ("added", "context_grows"),
    };
    json!({
        "fixId": fix.id(),
        "profile": profile,
        "changes": [{ "file": file, "key": command, "before": null, "after": after }],
        "warnings": [warning],
    })
}

/// Thêm dòng vào cuối nội dung, bảo đảm dòng cũ đã xuống dòng.
fn with_line(text: &str, line: &str) -> String {
    let mut out = text.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(line);
    out.push('\n');
    out
}

fn without_line(text: &str, line: &str) -> String {
    text.split_inclusive('\n')
        .filter(|l| l.trim() != line)
        .collect()
}

/// Windows chỉ tự tìm `.exe`; CLI cài bằng npm (codex, codegraph) là file `.cmd`.
fn resolve_program(program: &str, path: &str) -> String {
    if cfg!(windows) {
        for ext in ["exe", "cmd"] {
            let candidate = format!("{program}.{ext}");
            if in_path(&candidate, path) {
                return candidate;
            }
        }
    }
    program.to_string()
}

fn run_argv(
    argv: &[String],
    env: Vec<(&'static str, String)>,
    dir: Option<&Path>,
    timeout: Duration,
) -> Result<Output, String> {
    let (program, args) = argv.split_first().ok_or("Lệnh rỗng.")?;
    let path = user_path();
    let mut cmd = Command::new(resolve_program(program, path));
    cmd.args(args).env("PATH", path);
    for (key, value) in env {
        cmd.env(key, value);
    }
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }
    run_with_timeout(cmd, timeout)
        .ok_or_else(|| format!("Không chạy được `{program}` hoặc lệnh chạy quá hạn."))
}

fn output_tail(out: &Output) -> String {
    let mut text = String::from_utf8_lossy(&out.stderr).into_owned();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&out.stdout).into_owned();
    }
    let text = text.trim();
    text.char_indices()
        .rev()
        .nth(OUTPUT_TAIL)
        .map(|(i, _)| text[i..].to_string())
        .unwrap_or_else(|| text.to_string())
}

fn run_checked(
    what: &str,
    argv: &[String],
    env: Vec<(&'static str, String)>,
    dir: Option<&Path>,
    timeout: Duration,
) -> Result<(), String> {
    let out = run_argv(argv, env, dir, timeout)?;
    if out.code == Some(0) {
        return Ok(());
    }
    Err(format!("{what} không thành công: {}", output_tail(&out)))
}

fn home() -> Result<PathBuf, String> {
    crate::profiles::home_dir()
        .ok_or_else(|| "Không tìm thấy thư mục nhà của người dùng.".to_string())
}

/// Đổi đường dẫn `~/…` của kết quả điểm thành thư mục thật; phải là thư mục tuyệt đối đang có trên đĩa.
fn project_dir(display: &str) -> Result<PathBuf, String> {
    let dir = expand_home(display, &home()?);
    if !dir.is_absolute() || !dir.is_dir() {
        return Err("Thư mục dự án không còn trên đĩa.".into());
    }
    Ok(dir)
}

fn last_score(app: &AppHandle) -> Result<Value, String> {
    app.state::<Last>()
        .score
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .ok_or_else(|| "Chưa có kết quả điểm. Hãy tính điểm trước.".to_string())
}

async fn profile_dir(app: &AppHandle, profile: &str) -> Result<ProfileDir, String> {
    let args = vec!["optimize".into(), "status".into(), "--json".into()];
    let status: Value = sidecar_json(app, args, vec![]).await?;
    profile_dir_of(&status, profile)
        .ok_or_else(|| "Không tìm thấy thư mục cấu hình của gói.".to_string())
}

/// Thêm `.codegraph/` vào `.git/info/exclude` khi git chưa bỏ qua nó. Trả true nếu đã thêm dòng.
fn add_exclude(dir: &Path) -> Result<bool, String> {
    let exclude = dir.join(".git").join("info").join("exclude");
    if !exclude.is_file() {
        // Chưa có git (hoặc worktree, `.git` là file): bỏ bước này.
        return Ok(false);
    }
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(["check-ignore", "-q", ".codegraph"])
        .env("PATH", user_path());
    if run_with_timeout(cmd, GIT_TIMEOUT).is_some_and(|o| o.code == Some(0)) {
        return Ok(false);
    }
    let text = std::fs::read_to_string(&exclude)
        .map_err(|e| format!("Không đọc được .git/info/exclude: {e}"))?;
    std::fs::write(&exclude, with_line(&text, EXCLUDE_LINE))
        .map_err(|e| format!("Không ghi được .git/info/exclude: {e}"))?;
    Ok(true)
}

fn remove_exclude(dir: &Path) -> Result<(), String> {
    let exclude = dir.join(".git").join("info").join("exclude");
    let Ok(text) = std::fs::read_to_string(&exclude) else {
        return Ok(());
    };
    let next = without_line(&text, EXCLUDE_LINE);
    if next != text {
        std::fs::write(&exclude, next)
            .map_err(|e| format!("Không ghi được .git/info/exclude: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn token_score(
    app: AppHandle,
    fresh: Option<bool>,
    profile_id: Option<String>,
) -> Result<Value, String> {
    let args = score_args(fresh.unwrap_or(false), profile_id.as_deref())?;
    let score: Value = sidecar_json(&app, args, vec![]).await?;
    if let Ok(mut last) = app.state::<Last>().score.lock() {
        *last = Some(score.clone());
    }
    Ok(score)
}

/// Lịch sử điểm `days` ngày gần nhất cho biểu đồ; chỉ đọc file lịch sử, không tính điểm.
#[tauri::command]
pub async fn token_score_history(app: AppHandle, days: Option<u32>) -> Result<Value, String> {
    sidecar_json(&app, history_args(days.unwrap_or(30).clamp(1, 90)), vec![]).await
}

/// Dòng lịch sử sau cùng, không tính lại: huy hiệu ở menu đọc số này, không có gì chạy lúc khởi động.
#[tauri::command]
pub async fn token_score_last(app: AppHandle) -> Result<Value, String> {
    sidecar_json(&app, last_args(), vec![]).await
}

#[tauri::command]
pub async fn token_score_fix_preview(
    app: AppHandle,
    fix_id: String,
    profile_id: String,
    project_key: Option<String>,
) -> Result<Value, String> {
    let score = last_score(&app)?;
    let resolved = resolve(&score, &fix_id, &profile_id, project_key.as_deref())?;
    match resolved.fix {
        fix if fix.in_sidecar() => sidecar_json(&app, fix_args(fix, &profile_id, true)?, vec![])
            .await
            .map_err(sidecar_fix_error),
        Fix::CodegraphMcp => {
            let cli = resolved.cli;
            let dir = profile_dir(&app, &profile_id).await?;
            let home = home()?;
            let command = mcp_add(&cli, cfg!(windows))?.join(" ");
            let file = shorten_home(&mcp_config_file(&cli, &dir, &home), &home);
            Ok(local_preview(Fix::CodegraphMcp, &profile_id, file, command))
        }
        fix => {
            let display = resolved.project.unwrap_or_default();
            project_dir(&display)?;
            let command = format!("codegraph init -y {display}");
            Ok(local_preview(fix, &profile_id, display, command))
        }
    }
}

#[tauri::command]
pub async fn token_score_fix(
    app: AppHandle,
    fix_id: String,
    profile_id: String,
    project_key: Option<String>,
) -> Result<Value, String> {
    let score = last_score(&app)?;
    let resolved = resolve(&score, &fix_id, &profile_id, project_key.as_deref())?;
    match resolved.fix {
        fix if fix.in_sidecar() => sidecar_json(&app, fix_args(fix, &profile_id, false)?, vec![])
            .await
            .map_err(sidecar_fix_error),
        Fix::CodegraphMcp => {
            let cli = resolved.cli;
            let dir = profile_dir(&app, &profile_id).await?;
            let argv = mcp_add(&cli, cfg!(windows))?;
            let mut env: Vec<_> = mcp_env(&cli, &dir)?.into_iter().collect();
            env.extend(codegraph_env());
            blocking(move || run_checked("Thêm MCP codegraph", &argv, env, None, MCP_TIMEOUT))
                .await?;
            let record = Applied {
                fix_id: Fix::CodegraphMcp.id().into(),
                profile: profile_id.clone(),
                project: None,
                exclude_added: false,
            };
            update_applied(&app, |list| {
                list.push(record);
                Ok(())
            })?;
            mark_fix(&app, Fix::CodegraphMcp, true).await;
            Ok(json!({ "fixId": Fix::CodegraphMcp.id(), "profile": profile_id }))
        }
        fix => {
            let path = project_dir(&resolved.project.unwrap_or_default())?;
            let dir = path.clone();
            let added = blocking(move || {
                let argv = init_argv(&dir.to_string_lossy());
                let cwd = Some(dir.as_path());
                run_checked("codegraph init", &argv, codegraph_env(), cwd, INIT_TIMEOUT)?;
                add_exclude(&dir)
            })
            .await?;
            let record = Applied {
                fix_id: fix.id().into(),
                profile: profile_id.clone(),
                project: Some(path),
                exclude_added: added,
            };
            update_applied(&app, |list| {
                list.push(record);
                Ok(())
            })?;
            mark_fix(&app, fix, true).await;
            Ok(json!({ "fixId": fix.id(), "profile": profile_id }))
        }
    }
}

#[tauri::command]
pub async fn token_score_undo(
    app: AppHandle,
    fix_id: String,
    profile_id: String,
    project_key: Option<String>,
    backup: Option<String>,
) -> Result<Value, String> {
    // Giữ tham số để giao diện cũ không lỗi; sidecar tự biết trạng thái trước lần sửa.
    let _ = backup;
    let score = last_score(&app)?;
    let resolved = resolve(&score, &fix_id, &profile_id, project_key.as_deref())?;
    if resolved.fix.in_sidecar() {
        return sidecar_json(&app, undo_args(resolved.fix, &profile_id)?, vec![])
            .await
            .map_err(sidecar_fix_error);
    }
    let fix = resolved.fix;
    let project = match fix {
        Fix::CodegraphInit => Some(project_dir(&resolved.project.unwrap_or_default())?),
        _ => None,
    };
    // Chỉ hoàn tác thứ chính app đã làm: không có bản ghi thì không gỡ MCP hay xoá `.codegraph/` của ai cả.
    let record = {
        let state = app.state::<Last>();
        let _guard = state.applied.lock().map_err(|e| e.to_string())?;
        let list = load_applied(&applied_path()?);
        let index = find_applied(&list, fix, &profile_id, project.as_deref())
            .ok_or("App chưa áp dụng sửa nhanh này nên không có gì để hoàn tác.")?;
        list[index].clone()
    };
    if fix == Fix::CodegraphMcp {
        let cli = resolved.cli;
        let dir = profile_dir(&app, &profile_id).await?;
        let argv = mcp_remove(&cli)?;
        let env: Vec<_> = mcp_env(&cli, &dir)?.into_iter().collect();
        blocking(move || run_checked("Gỡ MCP codegraph", &argv, env, None, MCP_TIMEOUT)).await?;
    } else {
        let dir = project.clone().unwrap_or_default();
        let remove_line = record.exclude_added;
        blocking(move || {
            let argv = uninit_argv(&dir.to_string_lossy());
            run_checked(
                "codegraph uninit",
                &argv,
                codegraph_env(),
                Some(dir.as_path()),
                INIT_TIMEOUT,
            )?;
            if remove_line {
                remove_exclude(&dir)?;
            }
            Ok(())
        })
        .await?;
    }
    update_applied(&app, |list| {
        if let Some(index) = find_applied(list, fix, &profile_id, project.as_deref()) {
            list.remove(index);
        }
        Ok(())
    })?;
    mark_fix(&app, fix, false).await;
    Ok(json!({ "fixId": fix.id(), "profile": profile_id }))
}

/// Ghi mốc cho biểu đồ sau khi sửa nhanh Rust đã thành công. Lỗi ghi mốc không làm hỏng sửa nhanh đã áp dụng, chỉ
/// mất một dấu trên biểu đồ.
async fn mark_fix(app: &AppHandle, fix: Fix, apply: bool) {
    let args = match mark_args(fix, apply) {
        Ok(args) => args,
        Err(e) => return eprintln!("{e}"),
    };
    if let Err(e) = sidecar_json::<Value>(app, args, vec![]).await {
        eprintln!("Không ghi được mốc sửa nhanh: {e}");
    }
}

/// Số giây Unix của một mốc RFC 3339 (`2026-10-19T08:00:00Z`, `…+07:00`, có hay không có phần lẻ giây). Dùng cho một
/// phép so "đã quá 24 giờ chưa" nên không kéo thêm thư viện thời gian.
fn parse_rfc3339(text: &str) -> Option<i64> {
    let (date, rest) = text.split_once(['T', 't'])?;
    let mut d = date.split('-');
    let (year, month, day) = (
        d.next()?.parse::<i64>().ok()?,
        d.next()?.parse::<i64>().ok()?,
        d.next()?.parse::<i64>().ok()?,
    );
    let split = rest.find(['Z', 'z', '+', '-'])?;
    let (clock, zone) = rest.split_at(split);
    let mut t = clock.split(':');
    let hour = t.next()?.parse::<i64>().ok()?;
    let minute = t.next()?.parse::<i64>().ok()?;
    let second = t.next()?.split('.').next()?.parse::<i64>().ok()?;
    let offset = match zone.as_bytes().first()? {
        b'Z' | b'z' => 0,
        sign => {
            let (h, m) = zone[1..].split_once(':')?;
            let secs = h.parse::<i64>().ok()? * 3600 + m.parse::<i64>().ok()? * 60;
            if *sign == b'-' { -secs } else { secs }
        }
    };
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    // Ngày dân sự sang số ngày từ 1970-01-01 (Howard Hinnant, days_from_civil).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

/// Cần tính lại khi chưa có dòng lịch sử nào, mốc không đọc được, hoặc dòng cuối đã quá 24 giờ.
fn daily_due(last: &Value, now_secs: i64) -> bool {
    last["entries"]
        .as_array()
        .and_then(|entries| entries.last())
        .and_then(|entry| entry["ts"].as_str())
        .and_then(parse_rfc3339)
        .is_none_or(|ts| now_secs - ts > DAILY_MAX_AGE_SECS)
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// Mở app thì sau 2 phút kiểm điểm đã quá 24 giờ chưa; quá thì tính lại ở nền, không `--fresh` vì `/context` gọi model
/// và tốn token. Chạy trong tác vụ riêng nên không chặn giao diện. Xong thì phát sự kiện để thẻ và huy hiệu đọc lại.
pub fn start_daily(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DAILY_DELAY).await;
        if !crate::settings::get(&app).token_score_daily {
            return;
        }
        let last: Value = match sidecar_json(&app, last_args(), vec![]).await {
            Ok(last) => last,
            Err(e) => return eprintln!("Không đọc được lịch sử điểm token: {e}"),
        };
        if !daily_due(&last, unix_now()) {
            return;
        }
        match sidecar_json::<Value>(&app, score_args(false, None).unwrap_or_default(), vec![]).await
        {
            Ok(score) => {
                if let Ok(mut slot) = app.state::<Last>().score.lock() {
                    *slot = Some(score);
                }
                if let Err(e) = app.emit(UPDATED_EVENT, ()) {
                    eprintln!("Không phát được sự kiện điểm token: {e}");
                }
            }
            Err(e) => eprintln!("Không tính được điểm token hằng ngày: {e}"),
        }
    });
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        json!({
            "scoreVersion": 1,
            "profiles": [
                {
                    "id": "claude-2", "cli": "claude",
                    "projects": [
                        { "key": "p1", "path": "~/work/app", "share": 0.6, "codegraph": false },
                        { "key": "p2", "path": "~/work/lib", "share": 0.4, "codegraph": true }
                    ]
                },
                { "id": "codex-1", "cli": "codex", "projects": [{ "key": "p9", "path": "~/x", "share": 1.0, "codegraph": false }] },
                { "id": "agy", "cli": "antigravity", "projects": [] },
                { "id": "gem", "cli": "gemini" }
            ]
        })
    }

    #[test]
    fn allowlist_rejects_unknown_ids() {
        for id in [
            "",
            "tool.rtk",
            "tool.codegraph",
            "open.memory",
            "open.mcp",
            "optimizer.balanced ",
            "rm -rf /",
            "optimizer.balanced; calc",
        ] {
            assert!(Fix::parse(id).is_err(), "{id:?}");
            assert!(resolve(&sample(), id, "claude-2", None).is_err(), "{id:?}");
        }
        for (id, fix) in FIXES {
            assert_eq!(Fix::parse(id).unwrap(), fix);
            assert_eq!(fix.id(), id);
        }
    }

    #[test]
    fn fix_must_be_allowed_for_the_profile_cli() {
        let score = sample();
        assert!(resolve(&score, "optimizer.rtk", "claude-2", None).is_ok());
        assert!(resolve(&score, "optimizer.rtk", "codex-1", None).is_err());
        assert!(resolve(&score, "optimizer.aggressive", "codex-1", None).is_err());
        assert!(resolve(&score, "optimizer.balanced", "codex-1", None).is_ok());
        assert!(resolve(&score, "optimizer.balanced", "agy", None).is_err());
        assert!(resolve(&score, "codegraph.mcp", "agy", None).is_err());
        assert!(resolve(&score, "codegraph.mcp", "gem", None).is_err());
        assert!(resolve(&score, "codegraph.init", "gem", Some("p1")).is_err());
        assert!(resolve(&score, "optimizer.balanced", "claude-9", None).is_err());
    }

    #[test]
    fn project_key_is_looked_up_in_the_last_score_only() {
        let score = sample();
        let ok = resolve(&score, "codegraph.init", "claude-2", Some("p2")).unwrap();
        assert_eq!(ok.project.as_deref(), Some("~/work/lib"));
        assert!(resolve(&score, "codegraph.init", "claude-2", Some("p3")).is_err());
        // Khoá của gói khác không dùng được cho gói này.
        assert!(resolve(&score, "codegraph.init", "claude-2", Some("p9")).is_err());
        assert!(resolve(&score, "codegraph.init", "claude-2", Some("~/work/app")).is_err());
        assert!(resolve(&score, "codegraph.init", "claude-2", None).is_err());
        // Sửa nhanh không cần dự án thì bỏ qua khoá.
        let no_project = resolve(&score, "codegraph.mcp", "claude-2", Some("p1")).unwrap();
        assert_eq!(no_project.project, None);
    }

    #[test]
    fn builds_codegraph_mcp_argv_for_both_clis() {
        assert_eq!(
            mcp_add("claude", false).unwrap().join(" "),
            "claude mcp add --scope user codegraph --env CODEGRAPH_TELEMETRY=0 --env DO_NOT_TRACK=1 --env CODEGRAPH_NO_DAEMON=1 -- codegraph serve --mcp"
        );
        assert_eq!(
            mcp_add("codex", false).unwrap().join(" "),
            "codex mcp add codegraph --env CODEGRAPH_TELEMETRY=0 --env DO_NOT_TRACK=1 --env CODEGRAPH_NO_DAEMON=1 -- codegraph serve --mcp"
        );
        assert_eq!(
            mcp_add("claude", true).unwrap().join(" "),
            "claude mcp add --scope user codegraph --env CODEGRAPH_TELEMETRY=0 --env DO_NOT_TRACK=1 --env CODEGRAPH_NO_DAEMON=1 -- cmd /c codegraph.cmd serve --mcp"
        );
        assert_eq!(
            mcp_add("codex", true).unwrap().join(" "),
            "codex mcp add codegraph --env CODEGRAPH_TELEMETRY=0 --env DO_NOT_TRACK=1 --env CODEGRAPH_NO_DAEMON=1 -- cmd /c codegraph.cmd serve --mcp"
        );
        assert!(mcp_add("gemini", false).is_err());
        assert_eq!(
            mcp_remove("claude").unwrap().join(" "),
            "claude mcp remove -s user codegraph"
        );
        assert_eq!(
            mcp_remove("codex").unwrap().join(" "),
            "codex mcp remove codegraph"
        );
        assert!(mcp_remove("antigravity").is_err());
    }

    #[test]
    fn mcp_env_points_at_the_profile_config_dir() {
        let custom = ProfileDir {
            config_dir: Some(PathBuf::from("/data/claude-2")),
            default: false,
        };
        assert_eq!(
            mcp_env("claude", &custom).unwrap(),
            Some(("CLAUDE_CONFIG_DIR", "/data/claude-2".to_string()))
        );
        assert_eq!(
            mcp_env("codex", &custom).unwrap(),
            Some(("CODEX_HOME", "/data/claude-2".to_string()))
        );
        let default = ProfileDir {
            config_dir: Some(PathBuf::from("/home/dev/.claude")),
            default: true,
        };
        assert_eq!(mcp_env("claude", &default).unwrap(), None);
        let unknown = ProfileDir {
            config_dir: None,
            default: false,
        };
        assert!(mcp_env("claude", &unknown).is_err());
    }

    #[test]
    fn reads_profile_dir_from_sidecar_status() {
        let status = json!({ "profiles": [
            { "id": "claude", "cli": "claude", "configDir": "/home/dev/.claude", "default": true },
            { "id": "claude-2", "cli": "claude", "configDir": "/data/c2" }
        ]});
        let d = profile_dir_of(&status, "claude").unwrap();
        assert!(d.default);
        let d = profile_dir_of(&status, "claude-2").unwrap();
        assert!(!d.default);
        assert_eq!(d.config_dir, Some(PathBuf::from("/data/c2")));
        assert!(profile_dir_of(&status, "nope").is_none());
        // Thư mục mặc định không có trong accounts.json vẫn dùng được.
        let empty = json!({ "profiles": [] });
        let d = profile_dir_of(&empty, "codex").unwrap();
        assert!(d.default && d.config_dir.is_none());
    }

    #[test]
    fn undo_needs_a_matching_applied_record() {
        let app = Path::new("/home/dev/app");
        let lib = Path::new("/home/dev/lib");
        let list = vec![
            Applied {
                fix_id: "codegraph.mcp".into(),
                profile: "claude-2".into(),
                project: None,
                exclude_added: false,
            },
            Applied {
                fix_id: "codegraph.init".into(),
                profile: "claude-2".into(),
                project: Some(app.to_path_buf()),
                exclude_added: true,
            },
        ];
        assert_eq!(
            find_applied(&list, Fix::CodegraphMcp, "claude-2", None),
            Some(0)
        );
        assert_eq!(
            find_applied(&list, Fix::CodegraphInit, "claude-2", Some(app)),
            Some(1)
        );
        // Dự án khác, gói khác hay sửa nhanh khác: không có gì để hoàn tác.
        assert_eq!(
            find_applied(&list, Fix::CodegraphInit, "claude-2", Some(lib)),
            None
        );
        assert_eq!(
            find_applied(&list, Fix::CodegraphMcp, "codex-1", None),
            None
        );
        assert_eq!(
            find_applied(&list, Fix::CodegraphInit, "claude-2", None),
            None
        );
        let text = serde_json::to_string(&list).unwrap();
        assert!(text.contains("\"excludeAdded\":true"));
        let back: Vec<Applied> = serde_json::from_str(&text).unwrap();
        assert_eq!(back, list);
    }

    #[test]
    fn sidecar_arguments_keep_fix_id_first_and_profile_as_value() {
        assert_eq!(
            fix_args(Fix::Balanced, "claude-2", true).unwrap(),
            [
                "optimize",
                "fix",
                "optimizer.balanced",
                "--json",
                "--profile=claude-2",
                "--preview"
            ]
        );
        assert_eq!(
            fix_args(Fix::Aggressive, "-x", false).unwrap(),
            [
                "optimize",
                "fix",
                "optimizer.aggressive",
                "--json",
                "--profile=-x"
            ]
        );
        assert!(fix_args(Fix::Rtk, "x\n--rtk", false).is_err());
        // Không đo thì không truyền gói: /context chỉ chạy khi người dùng bấm đo một gói.
        assert_eq!(
            score_args(false, Some("claude-2")).unwrap(),
            ["optimize", "score", "--json"]
        );
        assert_eq!(
            score_args(true, Some("claude-2")).unwrap(),
            [
                "optimize",
                "score",
                "--json",
                "--fresh",
                "--profile=claude-2"
            ]
        );
        assert_eq!(
            score_args(true, None).unwrap(),
            ["optimize", "score", "--json", "--fresh"]
        );
        assert!(score_args(true, Some("a\nb")).is_err());
        assert_eq!(
            undo_args(Fix::Balanced, "codex-1").unwrap(),
            [
                "optimize",
                "fix",
                "optimizer.balanced",
                "--json",
                "--profile=codex-1",
                "--undo"
            ]
        );
        assert!(undo_args(Fix::Balanced, "a\nb").is_err());
    }

    #[test]
    fn codegraph_commands_are_non_interactive() {
        assert_eq!(
            init_argv("/home/dev/app"),
            ["codegraph", "init", "-y", "/home/dev/app"]
        );
        assert_eq!(
            uninit_argv("/home/dev/app"),
            ["codegraph", "uninit", "-f", "/home/dev/app"]
        );
    }

    #[test]
    fn local_preview_matches_the_fix_preview_contract() {
        let mcp = local_preview(
            Fix::CodegraphMcp,
            "claude-2",
            "~/.claude.json".into(),
            "claude mcp add --scope user codegraph -- codegraph serve --mcp".into(),
        );
        assert_eq!(mcp["fixId"], "codegraph.mcp");
        assert_eq!(mcp["profile"], "claude-2");
        assert_eq!(mcp["changes"][0]["file"], "~/.claude.json");
        assert!(mcp["changes"][0]["before"].is_null());
        assert_eq!(mcp["changes"][0]["after"], "added");
        assert_eq!(mcp["warnings"], json!(["context_grows"]));
        let init = local_preview(
            Fix::CodegraphInit,
            "claude-2",
            "~/work/app".into(),
            "codegraph init -y ~/work/app".into(),
        );
        assert_eq!(init["changes"][0]["after"], "indexed");
        assert_eq!(init["warnings"], json!(["long_running"]));
    }

    #[test]
    fn expands_and_shortens_home_paths() {
        let home = Path::new("/home/dev");
        assert_eq!(expand_home("~/work/app", home), home.join("work/app"));
        assert_eq!(expand_home("~", home), home);
        assert_eq!(expand_home("/srv/app", home), PathBuf::from("/srv/app"));
        // `~user` không phải thư mục nhà của người dùng này.
        assert_eq!(expand_home("~other/x", home), PathBuf::from("~other/x"));
        assert_eq!(
            shorten_home(&home.join(".claude.json"), home),
            "~/.claude.json"
        );
        assert_eq!(shorten_home(Path::new("/data/c2"), home), "/data/c2");
    }

    #[test]
    fn preview_names_the_file_the_cli_will_write() {
        let home = Path::new("/home/dev");
        let default = ProfileDir {
            config_dir: Some(home.join(".claude")),
            default: true,
        };
        assert_eq!(
            mcp_config_file("claude", &default, home),
            home.join(".claude.json")
        );
        let custom = ProfileDir {
            config_dir: Some(PathBuf::from("/data/c2")),
            default: false,
        };
        assert_eq!(
            mcp_config_file("claude", &custom, home),
            Path::new("/data/c2").join(".claude.json")
        );
        assert_eq!(
            mcp_config_file("codex", &custom, home),
            Path::new("/data/c2").join("config.toml")
        );
    }

    #[test]
    fn edits_only_the_exclude_line_the_app_owns() {
        assert_eq!(with_line("# c\n", ".codegraph/"), "# c\n.codegraph/\n");
        assert_eq!(with_line("# c", ".codegraph/"), "# c\n.codegraph/\n");
        assert_eq!(with_line("", ".codegraph/"), ".codegraph/\n");
        assert_eq!(
            without_line("# c\n.codegraph/\nnode_modules/\n", ".codegraph/"),
            "# c\nnode_modules/\n"
        );
        assert_eq!(without_line("# c\n", ".codegraph/"), "# c\n");
    }

    #[test]
    fn history_and_last_arguments_use_the_read_only_subcommand() {
        assert_eq!(
            history_args(30),
            ["optimize", "score", "history", "--json", "--days=30"]
        );
        assert_eq!(
            last_args(),
            ["optimize", "score", "history", "--json", "--last"]
        );
        // Không có cờ tính điểm: đọc lịch sử không gọi model.
        assert!(!history_args(7).iter().any(|a| a == "--fresh"));
    }

    #[test]
    fn mark_arguments_carry_fix_and_action_as_values() {
        assert_eq!(
            mark_args(Fix::CodegraphMcp, true).unwrap(),
            [
                "optimize",
                "score",
                "mark",
                "--json",
                "--fix=codegraph.mcp",
                "--action=apply"
            ]
        );
        assert_eq!(
            mark_args(Fix::CodegraphInit, false).unwrap(),
            [
                "optimize",
                "score",
                "mark",
                "--json",
                "--fix=codegraph.init",
                "--action=undo"
            ]
        );
    }

    #[test]
    fn mark_rejects_fixes_the_sidecar_marks_itself() {
        for fix in [Fix::Balanced, Fix::Rtk, Fix::Aggressive] {
            assert!(mark_args(fix, true).is_err(), "{}", fix.id());
        }
        assert!(Fix::parse("tool.rtk").is_err());
        assert!(Fix::parse("codegraph.mcp; rm -rf").is_err());
    }

    #[test]
    fn windows_rtk_code_becomes_a_vietnamese_message() {
        let msg = sidecar_fix_error("windows_rtk_unsupported: rtk chưa chạy trên Windows".into());
        assert!(msg.contains("Windows") && !msg.contains("windows_rtk_unsupported"));
        assert_eq!(sidecar_fix_error("lỗi khác".into()), "lỗi khác");
    }

    #[test]
    fn parses_rfc3339_with_zone_and_fraction() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2026-10-19T08:00:00Z"), Some(1_792_396_800));
        assert_eq!(
            parse_rfc3339("2026-10-19T15:00:00.123456+07:00"),
            parse_rfc3339("2026-10-19T08:00:00Z")
        );
        assert_eq!(
            parse_rfc3339("2026-10-19T03:00:00-05:00"),
            parse_rfc3339("2026-10-19T08:00:00Z")
        );
        assert_eq!(parse_rfc3339("2024-03-01T00:00:00Z"), Some(1_709_251_200));
        assert_eq!(parse_rfc3339("không phải mốc"), None);
        assert_eq!(parse_rfc3339("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn daily_recompute_is_due_after_24_hours_or_without_history() {
        let at = parse_rfc3339("2026-10-19T08:00:00Z").unwrap();
        let last = json!({ "entries": [{ "ts": "2026-10-19T08:00:00Z" }] });
        assert!(!daily_due(&last, at + 23 * 3600));
        assert!(!daily_due(&last, at + 24 * 3600));
        assert!(daily_due(&last, at + 24 * 3600 + 1));
        assert!(daily_due(&json!({ "entries": [] }), at));
        assert!(daily_due(&json!({}), at));
        assert!(daily_due(&json!({ "entries": [{ "ts": "hỏng" }] }), at));
    }
}
