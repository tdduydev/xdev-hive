//! Màn Token và ngữ cảnh (AppTokens): số liệu thật từ CLI trên máy, không qua hub.
//!
//! - Claude Code: `claude -p "/context"` (ngữ cảnh lúc mở phiên theo nhóm) và `claude -p "/usage"` (hạn mức gói và
//!   thứ đang tiêu hạn mức) là lệnh cục bộ, không gọi model; file phiên trong `~/.claude/projects/*/*.jsonl` có `usage`
//!   của từng câu trả lời.
//! - Codex không có lệnh tương đương; file phiên `~/.codex/sessions/**/*.jsonl` có sự kiện `token_count` (tổng token
//!   của phiên, cửa sổ ngữ cảnh) và `rate_limits` (hạn mức 5 giờ và theo tuần).
//!
//! Chỉ đọc. Không gửi gì ra ngoài máy, không sửa cấu hình của người dùng.

use crate::doctor::{run_with_timeout, user_path};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

const CLI_TIMEOUT: Duration = Duration::from_secs(30);
const WINDOW: Duration = Duration::from_secs(7 * 24 * 3600);
const MAX_SESSIONS: usize = 200;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub name: String,
    pub tokens: u64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextReport {
    pub model: Option<String>,
    pub used: Option<u64>,
    pub window: Option<u64>,
    pub categories: Vec<Category>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub percent: f64,
    /// Chữ "resets …" nguyên văn của CLI (Claude) hoặc thời điểm ISO (Codex).
    pub resets: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Driver {
    pub percent: u32,
    /// Câu nguyên văn của `/usage` (tiếng Anh), vd. "of your usage was at >150k context".
    pub text: String,
}

#[derive(Serialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub session: Option<Limit>,
    pub week: Option<Limit>,
    pub drivers: Vec<Driver>,
    pub top_subagents: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    /// Lần ghi cuối của phiên (ISO 8601).
    pub at: String,
    pub cwd: String,
    pub model: Option<String>,
    /// Token vào, gồm cả phần đọc từ cache.
    pub input: u64,
    pub cached: u64,
    pub output: u64,
    /// Ngữ cảnh ở lượt cuối và cửa sổ của model (Codex ghi; Claude thì không).
    pub context_used: Option<u64>,
    pub context_window: Option<u64>,
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub sessions: usize,
    pub input: u64,
    pub cached: u64,
    pub output: u64,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    /// Tổng của mọi phiên trong 7 ngày, tính trước khi cắt danh sách.
    pub totals: Totals,
    /// Phiên mới nhất trước, tối đa MAX_SESSIONS.
    pub sessions: Vec<Session>,
    /// Hạn mức Codex lấy từ sự kiện mới nhất: 5 giờ và theo tuần.
    pub primary: Option<Limit>,
    pub secondary: Option<Limit>,
}

/// "12.7k" → 12700, "1m" → 1000000, "10" → 10.
fn tokens(text: &str) -> Option<u64> {
    let t = text.trim().trim_start_matches('~').to_ascii_lowercase();
    let (num, mul) = match t.chars().last()? {
        'k' => (&t[..t.len() - 1], 1_000.0),
        'm' => (&t[..t.len() - 1], 1_000_000.0),
        _ => (t.as_str(), 1.0),
    };
    num.replace(',', "")
        .parse::<f64>()
        .ok()
        .map(|n| (n * mul).round() as u64)
}

/// Đọc bảng "Estimated usage by category" của `/context`. Chịu được dòng thiếu, thứ tự khác, nhóm mới.
pub fn parse_context(text: &str) -> ContextReport {
    let mut report = ContextReport {
        model: None,
        used: None,
        window: None,
        categories: Vec::new(),
    };
    let mut section = "";
    for line in text.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("**Model:**") {
            report.model = Some(rest.trim().to_string());
        } else if let Some(rest) = l.strip_prefix("**Tokens:**") {
            // "12.7k / 1m (1%)"
            let mut it = rest.split('/');
            report.used = it.next().and_then(tokens);
            report.window = it.next().and_then(|w| w.split('(').next()).and_then(tokens);
        } else if let Some(h) = l.strip_prefix("### ") {
            section = if h.trim().eq_ignore_ascii_case("Estimated usage by category") {
                "cat"
            } else {
                ""
            };
        } else if section == "cat" && l.starts_with('|') {
            let cells: Vec<&str> = l.trim_matches('|').split('|').map(str::trim).collect();
            let (Some(name), Some(value)) = (cells.first(), cells.get(1)) else {
                continue;
            };
            if name.eq_ignore_ascii_case("category") || name.starts_with('-') {
                continue;
            }
            if let Some(tokens) = tokens(value) {
                report.categories.push(Category {
                    name: (*name).to_string(),
                    tokens,
                });
            }
        }
    }
    report
}

fn parse_limit(rest: &str) -> Option<Limit> {
    // "11% used · resets Oct 12 at 6:50pm (Asia/Saigon)"
    let percent = rest.split('%').next()?.trim().parse::<f64>().ok()?;
    let resets = rest
        .split("resets")
        .nth(1)
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty());
    Some(Limit { percent, resets })
}

/// Đọc `/usage`: hạn mức phiên và tuần, và mục "Last 7d" của phần "What's contributing to your limits usage?".
pub fn parse_usage(text: &str) -> UsageReport {
    let mut report = UsageReport::default();
    let mut in_week = false;
    for line in text.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("Current session:") {
            report.session = parse_limit(rest);
        } else if let Some(rest) = l.strip_prefix("Current week (all models):") {
            report.week = parse_limit(rest);
        } else if l.starts_with("Last ") {
            in_week = l.starts_with("Last 7d");
        } else if in_week {
            if let Some(rest) = l.strip_prefix("Top subagents:") {
                report.top_subagents = Some(rest.trim().to_string());
            } else if let Some((pct, text)) = l.split_once('%') {
                if let Ok(percent) = pct.trim().parse::<u32>() {
                    report.drivers.push(Driver {
                        percent,
                        text: text.trim().to_string(),
                    });
                }
            }
        }
    }
    report
}

/// Chạy `claude -p <lệnh>` trong thư mục (để tính đúng CLAUDE.md và skill của thư mục đó), không lưu phiên.
fn claude_print(command: &str, folder: Option<&Path>) -> Result<String, String> {
    let mut cmd = Command::new("claude");
    cmd.args(["-p", command, "--no-session-persistence"])
        .env("PATH", user_path());
    if let Some(dir) = folder {
        cmd.current_dir(dir);
    } else if let Some(home) = std::env::var_os("HOME") {
        cmd.current_dir(home);
    }
    let out = run_with_timeout(cmd, CLI_TIMEOUT)
        .ok_or("Không chạy được Claude Code (chưa cài hoặc quá 30 giây).")?;
    if out.code != Some(0) {
        return Err(format!(
            "Claude Code báo lỗi (mã {}).",
            out.code.unwrap_or(-1)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn folder_path(folder: Option<&str>) -> Result<Option<PathBuf>, String> {
    match folder.map(str::trim).filter(|f| !f.is_empty()) {
        None => Ok(None),
        Some(f) => {
            let p = PathBuf::from(f);
            if p.is_dir() {
                Ok(Some(p))
            } else {
                Err(format!("Không tìm thấy thư mục {f}."))
            }
        }
    }
}

fn in_folder(cwd: &str, folder: Option<&Path>) -> bool {
    match folder {
        None => true,
        Some(f) => {
            let f = f.to_string_lossy();
            let f = f.trim_end_matches('/');
            cwd == f || cwd.starts_with(&format!("{f}/"))
        }
    }
}

fn recent_files(root: &Path, now: SystemTime, window: Duration) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "jsonl")
                && meta
                    .modified()
                    .is_ok_and(|m| now.duration_since(m).unwrap_or_default() < window)
            {
                out.push(path);
            }
        }
    }
    out
}

/// Thư mục dự án của Claude Code mã hoá đường dẫn bằng cách thay "/" và "." bằng "-".
fn claude_project_dir(folder: &Path) -> String {
    folder.to_string_lossy().replace(['/', '.'], "-")
}

/// Một file phiên của Claude Code: cộng `usage` theo id câu trả lời (một câu trả lời có thể ghi nhiều dòng).
pub fn read_claude_session(reader: impl BufRead, id: &str) -> Option<Session> {
    let mut by_message: HashMap<String, (u64, u64, u64)> = HashMap::new();
    let (mut at, mut cwd, mut model) = (String::new(), String::new(), None);
    for line in reader.lines().map_while(Result::ok) {
        if !line.contains("\"usage\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let msg = &v["message"];
        let u = &msg["usage"];
        if !u.is_object() {
            continue;
        }
        let n = |k: &str| u[k].as_u64().unwrap_or(0);
        let fresh = n("input_tokens") + n("cache_creation_input_tokens");
        let cached = n("cache_read_input_tokens");
        let key = msg["id"]
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| by_message.len().to_string());
        by_message.insert(key, (fresh + cached, cached, n("output_tokens")));
        if let Some(t) = v["timestamp"].as_str() {
            at = t.to_string();
        }
        if let Some(c) = v["cwd"].as_str() {
            cwd = c.to_string();
        }
        if let Some(m) = msg["model"].as_str() {
            model = Some(m.to_string());
        }
    }
    if by_message.is_empty() {
        return None;
    }
    let (input, cached, output) = by_message
        .values()
        .fold((0, 0, 0), |a, b| (a.0 + b.0, a.1 + b.1, a.2 + b.2));
    Some(Session {
        id: id.to_string(),
        at,
        cwd,
        model,
        input,
        cached,
        output,
        context_used: None,
        context_window: None,
    })
}

/// Một file phiên của Codex: `token_count` là tổng dồn của phiên, lấy sự kiện cuối.
pub fn read_codex_session(
    reader: impl BufRead,
    id: &str,
) -> (Option<Session>, Option<(String, Limit, Limit)>) {
    let mut session: Option<Session> = None;
    let (mut cwd, mut model) = (String::new(), None);
    let mut limits = None;
    for line in reader.lines().map_while(Result::ok) {
        let meta = line.contains("\"session_meta\"") || line.contains("\"turn_context\"");
        if !meta && !line.contains("\"token_count\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let p = &v["payload"];
        if meta {
            if let Some(c) = p["cwd"].as_str() {
                cwd = c.to_string();
            }
            if let Some(m) = p["model"].as_str() {
                model = Some(m.to_string());
            }
            continue;
        }
        let at = v["timestamp"].as_str().unwrap_or_default().to_string();
        let info = &p["info"];
        if info.is_object() {
            let total = &info["total_token_usage"];
            let n = |o: &serde_json::Value, k: &str| o[k].as_u64().unwrap_or(0);
            session = Some(Session {
                id: id.to_string(),
                at: at.clone(),
                cwd: cwd.clone(),
                model: model.clone(),
                input: n(total, "input_tokens"),
                cached: n(total, "cached_input_tokens"),
                output: n(total, "output_tokens"),
                context_used: info["last_token_usage"]["input_tokens"].as_u64(),
                context_window: info["model_context_window"].as_u64(),
            });
        }
        let rl = &p["rate_limits"];
        let limit = |o: &serde_json::Value| {
            o["used_percent"].as_f64().map(|percent| Limit {
                percent,
                resets: o["resets_at"].as_i64().map(|s| s.to_string()),
            })
        };
        if let (Some(a), Some(b)) = (limit(&rl["primary"]), limit(&rl["secondary"])) {
            limits = Some((at, a, b));
        }
    }
    (session.map(|s| Session { cwd, model, ..s }), limits)
}

/// Xếp mới nhất trước, cộng tổng rồi mới cắt danh sách; bỏ phiên chưa dùng token nào.
fn finish(mut sessions: Vec<Session>) -> (Totals, Vec<Session>) {
    sessions.retain(|s| s.input + s.output > 0);
    sessions.sort_by(|a, b| b.at.cmp(&a.at));
    let start = Totals {
        sessions: sessions.len(),
        ..Totals::default()
    };
    let totals = sessions.iter().fold(start, |t, s| Totals {
        input: t.input + s.input,
        cached: t.cached + s.cached,
        output: t.output + s.output,
        ..t
    });
    sessions.truncate(MAX_SESSIONS);
    (totals, sessions)
}

fn open(path: &Path) -> Option<BufReader<std::fs::File>> {
    std::fs::File::open(path).ok().map(BufReader::new)
}

fn stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn claude_root() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude")))
        .map(|p| p.join("projects"))
}

/// File phiên Claude Code trong cửa sổ thời gian. Lọc sơ theo tên thư mục để khỏi đọc phiên của dự án khác; cwd trong
/// file mới là điều kiện thật.
fn claude_files(root: &Path, folder: Option<&Path>, window: Duration) -> Vec<PathBuf> {
    let prefix = folder.map(claude_project_dir);
    recent_files(root, SystemTime::now(), window)
        .into_iter()
        .filter(|p| {
            let dir = p
                .parent()
                .and_then(Path::file_name)
                .map(|d| d.to_string_lossy().into_owned());
            match (&prefix, dir) {
                (Some(want), Some(dir)) => dir == *want || dir.starts_with(&format!("{want}-")),
                _ => true,
            }
        })
        .collect()
}

fn claude_stats(folder: Option<&Path>) -> SessionStats {
    let Some(root) = claude_root() else {
        return SessionStats::default();
    };
    let sessions: Vec<Session> = claude_files(&root, folder, WINDOW)
        .into_iter()
        .filter_map(|p| read_claude_session(open(&p)?, &stem(&p)))
        .filter(|s| in_folder(&s.cwd, folder))
        .collect();
    let (totals, sessions) = finish(sessions);
    SessionStats {
        totals,
        sessions,
        primary: None,
        secondary: None,
    }
}

fn codex_stats(folder: Option<&Path>) -> SessionStats {
    let root = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex")))
        .map(|p| p.join("sessions"));
    let Some(root) = root else {
        return SessionStats::default();
    };
    let mut stats = SessionStats::default();
    let mut latest = String::new();
    for path in recent_files(&root, SystemTime::now(), WINDOW) {
        let Some(reader) = open(&path) else { continue };
        let (session, limits) = read_codex_session(reader, &stem(&path));
        // Hạn mức là của tài khoản, không theo thư mục: lấy sự kiện mới nhất trong mọi phiên.
        if let Some((at, primary, secondary)) = limits {
            if at > latest {
                latest = at;
                stats.primary = Some(primary);
                stats.secondary = Some(secondary);
            }
        }
        if let Some(s) = session.filter(|s| in_folder(&s.cwd, folder)) {
            stats.sessions.push(s);
        }
    }
    (stats.totals, stats.sessions) = finish(std::mem::take(&mut stats.sessions));
    stats
}

#[tauri::command]
pub async fn claude_context(folder: Option<String>) -> Result<ContextReport, String> {
    let dir = folder_path(folder.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        claude_print("/context", dir.as_deref()).map(|t| parse_context(&t))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn claude_usage() -> Result<UsageReport, String> {
    tauri::async_runtime::spawn_blocking(|| claude_print("/usage", None).map(|t| parse_usage(&t)))
        .await
        .map_err(|e| e.to_string())?
}

/// Lần gọi tool `Skill` trong một file phiên Claude Code, theo tên skill; chỉ tính khi cwd của phiên nằm trong thư mục.
pub fn count_skill_uses(
    reader: impl BufRead,
    folder: Option<&Path>,
    counts: &mut HashMap<String, u32>,
) {
    let mut found: Vec<String> = Vec::new();
    let mut cwd = String::new();
    for line in reader.lines().map_while(Result::ok) {
        if cwd.is_empty() && line.contains("\"cwd\"") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(c) = v["cwd"].as_str() {
                    cwd = c.to_string();
                }
            }
        }
        if !line.contains("\"Skill\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(c) = v["cwd"].as_str() {
            cwd = c.to_string();
        }
        for item in v["message"]["content"].as_array().into_iter().flatten() {
            if item["type"] == "tool_use" && item["name"] == "Skill" {
                if let Some(name) = item["input"]["skill"].as_str() {
                    found.push(name.to_string());
                }
            }
        }
    }
    if in_folder(&cwd, folder) {
        for name in found {
            *counts.entry(name).or_default() += 1;
        }
    }
}

/// Số lần agent của tôi gọi từng skill trong 30 ngày (màn Skills, cột "Tôi dùng"). Codex không ghi lần đọc skill thành
/// sự kiện riêng nên chỉ tính Claude Code.
#[tauri::command]
pub async fn skill_uses(folder: Option<String>) -> Result<HashMap<String, u32>, String> {
    let dir = folder_path(folder.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut counts = HashMap::new();
        if let Some(root) = claude_root() {
            for p in claude_files(&root, dir.as_deref(), Duration::from_secs(30 * 24 * 3600)) {
                if let Some(r) = open(&p) {
                    count_skill_uses(r, dir.as_deref(), &mut counts);
                }
            }
        }
        counts
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn session_stats(engine: String, folder: Option<String>) -> Result<SessionStats, String> {
    let dir = folder_path(folder.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || match engine.as_str() {
        "claude" => Ok(claude_stats(dir.as_deref())),
        "codex" => Ok(codex_stats(dir.as_deref())),
        _ => Err("Không biết CLI này.".to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    // Đầu ra thật của Claude Code 2.1.296 trên máy dev (2026-10-12), rút gọn bảng Skills.
    const CONTEXT: &str = "## Context Usage\n\n**Model:** claude-opus-5-5  \n**Tokens:** 12.7k / 1m (1%)\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|----------|--------|------------|\n| System prompt | 2.3k | 0.2% |\n| System tools | 6.1k | 0.6% |\n| System tools (deferred) | 13.3k | 1.3% |\n| Skills | 4.3k | 0.4% |\n| Messages | 10 | 0.0% |\n| Free space | 954.3k | 95.4% |\n| Autocompact buffer | 33k | 3.3% |\n\n### Skills\n\n| Skill | Source | Tokens |\n|-------|--------|--------|\n| dataviz | Built-in | ~480 |\n";

    const USAGE: &str = "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 11% used · resets Oct 12 at 6:50pm (Asia/Saigon)\nCurrent week (all models): 70% used · resets Oct 16 at 3am (Asia/Saigon)\nCurrent week (Fable): 0% used · resets Oct 16 at 3am (Asia/Saigon)\n\nWhat's contributing to your limits usage?\nApproximate, based on local sessions on this machine — does not include other devices or claude.ai.\n\nLast 24h · 2121 requests · 10 sessions\n  94% of your usage was at >150k context\n  89% of your usage came from subagent-heavy sessions\n\nLast 7d · 5639 requests · 18 sessions\n  94% of your usage was at >150k context\n  92% of your usage came from subagent-heavy sessions\n  77% of your usage came from sessions active for 8+ hours\n  Top subagents: fork 33%, general-purpose 2%, Explore 1%\n";

    #[test]
    fn parses_real_context_output() {
        let r = parse_context(CONTEXT);
        assert_eq!(r.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(r.used, Some(12_700));
        assert_eq!(r.window, Some(1_000_000));
        assert_eq!(r.categories.len(), 7);
        assert_eq!(
            r.categories[0],
            Category {
                name: "System prompt".into(),
                tokens: 2_300
            }
        );
        assert_eq!(
            r.categories[4],
            Category {
                name: "Messages".into(),
                tokens: 10
            }
        );
        // Bảng Skills không lẫn vào nhóm.
        assert!(r.categories.iter().all(|c| c.name != "dataviz"));
    }

    #[test]
    fn context_parser_tolerates_missing_and_reordered_lines() {
        let r = parse_context(
            "### Estimated usage by category\n| Skills | 1.5k | 1% |\n| New thing | 2k | 2% |\n",
        );
        assert_eq!(r.model, None);
        assert_eq!(
            r.categories.iter().map(|c| c.tokens).collect::<Vec<_>>(),
            vec![1_500, 2_000]
        );
        assert_eq!(parse_context("").categories, vec![]);
    }

    #[test]
    fn parses_real_usage_output() {
        let r = parse_usage(USAGE);
        assert_eq!(
            r.session,
            Some(Limit {
                percent: 11.0,
                resets: Some("Oct 12 at 6:50pm (Asia/Saigon)".into())
            })
        );
        assert_eq!(r.week.as_ref().map(|w| w.percent), Some(70.0));
        // Chỉ mục 7 ngày, không lẫn 24 giờ.
        assert_eq!(r.drivers.len(), 3);
        assert_eq!(
            r.drivers[2],
            Driver {
                percent: 77,
                text: "of your usage came from sessions active for 8+ hours".into()
            }
        );
        assert_eq!(
            r.top_subagents.as_deref(),
            Some("fork 33%, general-purpose 2%, Explore 1%")
        );
    }

    #[test]
    fn sums_claude_usage_once_per_message() {
        let lines = [
            r#"{"type":"user","message":{"content":"hi"}}"#,
            r#"{"type":"assistant","timestamp":"2026-10-12T01:00:00Z","cwd":"/w/app","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_read_input_tokens":900,"output_tokens":10}}}"#,
            r#"{"type":"assistant","timestamp":"2026-10-12T01:00:01Z","cwd":"/w/app","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_read_input_tokens":900,"output_tokens":40}}}"#,
            r#"{"type":"assistant","timestamp":"2026-10-12T01:05:00Z","cwd":"/w/app","message":{"id":"m2","model":"claude-opus-5-5","usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":1000,"output_tokens":20}}}"#,
        ]
        .join("\n");
        let s = read_claude_session(lines.as_bytes(), "s1").unwrap();
        assert_eq!((s.input, s.cached, s.output), (1002 + 1005, 1900, 60));
        assert_eq!(s.at, "2026-10-12T01:05:00Z");
        assert_eq!(s.cwd, "/w/app");
        assert_eq!(s.model.as_deref(), Some("claude-opus-5-5"));
        assert!(read_claude_session("{}\n".as_bytes(), "x").is_none());
    }

    #[test]
    fn reads_codex_totals_and_limits_from_last_event() {
        let lines = [
            r#"{"timestamp":"2026-10-12T06:26:59Z","type":"session_meta","payload":{"cwd":"/w/api"}}"#,
            r#"{"timestamp":"2026-10-12T06:27:00Z","type":"turn_context","payload":{"cwd":"/w/api","model":"gpt-6.1-sol"}}"#,
            r#"{"timestamp":"2026-10-12T06:27:13Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":21496,"cached_input_tokens":13056,"output_tokens":144},"last_token_usage":{"input_tokens":21496},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":1.0,"resets_at":1791802453},"secondary":{"used_percent":31.0,"resets_at":1792305949}}}}"#,
            r#"{"timestamp":"2026-10-12T06:30:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":50000,"cached_input_tokens":40000,"output_tokens":900},"last_token_usage":{"input_tokens":28504},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":3.0,"resets_at":1791802453},"secondary":{"used_percent":32.0,"resets_at":1792305949}}}}"#,
        ]
        .join("\n");
        let (s, limits) = read_codex_session(lines.as_bytes(), "c1");
        let s = s.unwrap();
        assert_eq!((s.input, s.cached, s.output), (50_000, 40_000, 900));
        assert_eq!(
            (s.context_used, s.context_window),
            (Some(28_504), Some(258_400))
        );
        assert_eq!(s.model.as_deref(), Some("gpt-6.1-sol"));
        assert_eq!(s.cwd, "/w/api");
        let (_, primary, secondary) = limits.unwrap();
        assert_eq!((primary.percent, secondary.percent), (3.0, 32.0));
    }

    #[test]
    fn folder_filter_and_project_dir_encoding() {
        assert!(in_folder("/w/app", Some(Path::new("/w/app"))));
        assert!(in_folder("/w/app/sub", Some(Path::new("/w/app/"))));
        assert!(!in_folder("/w/app-2", Some(Path::new("/w/app"))));
        assert!(in_folder("/anything", None));
        assert_eq!(
            claude_project_dir(Path::new("/Users/a/Work/x.dev/hive")),
            "-Users-a-Work-x-dev-hive"
        );
    }

    #[test]
    fn totals_cover_every_session_before_truncating() {
        let s = |i: usize, input: u64| Session {
            id: i.to_string(),
            at: format!("2026-10-12T{:02}:{:02}:00Z", i / 60, i % 60),
            cwd: "/w".into(),
            model: None,
            input,
            cached: input / 2,
            output: 1,
            context_used: None,
            context_window: None,
        };
        let n = MAX_SESSIONS + 10;
        let mut all: Vec<Session> = (0..n).map(|i| s(i, 10)).collect();
        all.push(Session {
            output: 0,
            ..s(999, 0)
        });
        let (totals, kept) = finish(all);
        let n64 = n as u64;
        assert_eq!(
            totals,
            Totals {
                sessions: n,
                input: 10 * n64,
                cached: 5 * n64,
                output: n64
            }
        );
        assert_eq!(kept.len(), MAX_SESSIONS);
        assert!(kept.windows(2).all(|w| w[0].at >= w[1].at));
    }

    #[test]
    fn counts_skill_tool_calls_inside_the_folder() {
        let log = concat!(
            r#"{"type":"user","cwd":"/w/pay","message":{"content":"hi"}}"#,
            "\n",
            r#"{"type":"assistant","cwd":"/w/pay","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"db-migration"}}]}}"#,
            "\n",
            r#"{"type":"assistant","cwd":"/w/pay","message":{"content":[{"type":"text","text":"Skill"},{"type":"tool_use","name":"Skill","input":{"skill":"db-migration"}},{"type":"tool_use","name":"Read","input":{"file_path":"Skill"}}]}}"#,
            "\n",
        );
        let mut counts = HashMap::new();
        count_skill_uses(log.as_bytes(), Some(Path::new("/w/pay")), &mut counts);
        assert_eq!(counts.get("db-migration"), Some(&2));
        assert_eq!(counts.len(), 1);
        let mut other = HashMap::new();
        count_skill_uses(log.as_bytes(), Some(Path::new("/w/other")), &mut other);
        assert!(other.is_empty());
    }

    #[test]
    fn token_units() {
        assert_eq!(tokens("12.7k"), Some(12_700));
        assert_eq!(tokens("1m"), Some(1_000_000));
        assert_eq!(tokens("~480"), Some(480));
        assert_eq!(tokens("abc"), None);
    }
}
