//! "Đang làm gì" của một agent: đọc, chỉ đọc, file phiên mà chính CLI ghi trên máy. Định dạng là chi tiết nội bộ
//! của từng CLI, không có tài liệu (thấy ở Claude Code 2.1.299): sai định dạng thì trả None hay trường rỗng, không báo
//! lỗi. Nội dung chỉ về cửa sổ app, không gửi hub.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Đọc tối đa ngần này byte cuối của transcript: đủ cho vài lượt gần nhất, không đọc cả file nhiều MB mỗi 3 giây.
pub(crate) const TAIL: u64 = 256 * 1024;
const PROMPT_MAX: usize = 300;
const STEP_MAX: usize = 160;

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// Tên phiên do người dùng hay CLI đặt.
    pub title: Option<String>,
    /// `busy` hoặc `idle`.
    pub status: Option<String>,
    /// Lời nhắc cuối của người dùng.
    pub prompt: Option<String>,
    /// Bước công cụ cuối, ví dụ "Bash: Chạy test".
    pub step: Option<String>,
    /// Giờ của bước cuối (ISO 8601 như CLI ghi).
    pub at: Option<String>,
    /// Không có file nối pid với phiên: chọn phiên mới nhất của thư mục.
    pub guessed: bool,
    /// Claude Code ghi ai mở phiên (`claude-desktop`, `cli`…); chỉ dùng để nhận nguồn.
    #[serde(skip)]
    pub entrypoint: Option<String>,
}

/// File phiên nhỏ (vài trăm byte); giới hạn để file lạ không làm app đọc mãi.
const JSON_MAX: u64 = 64 * 1024;
/// Dòng đầu của rollout Codex chứa cả lời dặn hệ thống (vài chục KB).
const META_MAX: u64 = 1024 * 1024;
/// Claude Code rút gọn tên thư mục dài; khớp theo phần đầu.
const DIR_PREFIX: usize = 200;
/// File phiên ghi ngay khi CLI chạy; lệch vài giây do đồng hồ và lúc sysinfo đọc giờ bắt đầu.
const SLACK_SECS: u64 = 120;

/// Thư mục transcript của Claude Code theo thư mục làm việc: mọi ký tự không phải chữ hay số ASCII thành `-`, tính
/// theo đơn vị UTF-16 như chuỗi JavaScript (khớp `E:\Codes\xDev` → `E--Codes-xDev` thấy trên máy dev).
pub(crate) fn encode_project_dir(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len());
    for c in cwd.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('-', c.len_utf16()));
        }
    }
    out
}

pub(crate) fn one_line(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut cut: String = flat.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// Ngày dương lịch (UTC) từ số ngày kể từ 1970-01-01 (thuật toán `civil_from_days` của Howard Hinnant). Tránh thêm
/// crate ngày giờ chỉ để tìm thư mục `sessions/YYYY/MM/DD` của Codex.
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

fn read_capped(path: &Path, max: u64) -> Option<String> {
    use std::io::Read;
    let mut buf = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(max)
        .read_to_end(&mut buf)
        .ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Các dòng JSON trong `TAIL` byte cuối, mới nhất trước. Dòng đầu bị cắt giữa chừng thì bỏ.
fn tail_entries(path: &Path) -> Vec<serde_json::Value> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let from = len.saturating_sub(TAIL);
    if file.seek(SeekFrom::Start(from)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    if from > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    lines
        .into_iter()
        .rev()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn modified_secs(path: &Path) -> Option<u64> {
    let t = std::fs::metadata(path).ok()?.modified().ok()?;
    t.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

fn text(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
}

/// Đích ngắn của một lần gọi công cụ: mô tả lệnh, tên file, mẫu tìm, dòng đầu của lệnh, URL.
fn tool_detail(input: &serde_json::Value) -> Option<String> {
    if let Some(d) = text(input, "description") {
        return Some(d);
    }
    for key in ["file_path", "notebook_path", "path"] {
        if let Some(p) = text(input, key) {
            return p.rsplit(['/', '\\']).next().map(str::to_string);
        }
    }
    if let Some(p) = text(input, "pattern") {
        return Some(p);
    }
    if let Some(c) = text(input, "command") {
        return c.lines().next().map(str::to_string);
    }
    text(input, "url")
}

fn step_text(name: &str, detail: Option<String>) -> String {
    let full = match detail {
        Some(d) => format!("{name}: {d}"),
        None => name.to_string(),
    };
    one_line(&full, STEP_MAX)
}

/// Thư mục transcript của `cwd`; tên dài bị Claude Code rút gọn thì tìm thư mục cùng phần đầu.
fn project_dir(config: &Path, cwd: &str) -> Option<PathBuf> {
    let name = encode_project_dir(cwd);
    let exact = config.join("projects").join(&name);
    if exact.is_dir() {
        return Some(exact);
    }
    if name.len() <= DIR_PREFIX {
        return None;
    }
    let prefix = &name[..DIR_PREFIX];
    std::fs::read_dir(config.join("projects"))
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(prefix))
        })
}

/// File `jsonl` mới nhất trong `dir` sửa từ `since` trở đi.
fn newest_jsonl(dir: &Path, since: u64) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| modified_secs(&p).map(|t| (t, p)))
        .filter(|(t, _)| *t >= since)
        .max_by_key(|(t, _)| *t)
        .map(|(_, p)| p)
}

struct ClaudeSession {
    id: String,
    cwd: Option<String>,
    title: Option<String>,
    status: Option<String>,
    entrypoint: Option<String>,
}

/// `<config>/sessions/<pid>.json` của đúng tiến trình này. File của tiến trình cũ cùng pid (Windows dùng lại pid) có
/// giờ bắt đầu khác nên bị bỏ.
fn claude_session(config: &Path, pid: u32, start: u64) -> Option<ClaudeSession> {
    let raw = read_capped(
        &config.join("sessions").join(format!("{pid}.json")),
        JSON_MAX,
    )?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if v.get("pid")
        .and_then(|p| p.as_u64())
        .is_some_and(|p| p != u64::from(pid))
    {
        return None;
    }
    if let Some(ms) = v.get("startedAt").and_then(|s| s.as_u64())
        && (ms / 1000).abs_diff(start) > SLACK_SECS
    {
        return None;
    }
    let id = text(&v, "sessionId").filter(|id| crate::cli::valid_session(id))?;
    Some(ClaudeSession {
        id,
        cwd: text(&v, "cwd"),
        title: text(&v, "name"),
        status: text(&v, "status"),
        entrypoint: text(&v, "entrypoint"),
    })
}

/// Lời nhắc cuối, bước công cụ cuối và tên phiên trong đuôi transcript của Claude Code.
fn read_claude_transcript(path: &Path, a: &mut Activity) {
    let entries = tail_entries(path);
    let kind = |e: &serde_json::Value| e.get("type").and_then(|t| t.as_str()).map(str::to_string);
    a.prompt = entries
        .iter()
        .filter(|e| kind(e).as_deref() == Some("last-prompt"))
        .find_map(|e| text(e, "lastPrompt"))
        .or_else(|| {
            entries
                .iter()
                .filter(|e| kind(e).as_deref() == Some("user"))
                .find_map(|e| text(e.get("message")?, "content"))
        })
        .map(|p| one_line(&p, PROMPT_MAX));
    for e in entries
        .iter()
        .filter(|e| kind(e).as_deref() == Some("assistant"))
    {
        let tool = e
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
            .and_then(|items| {
                items
                    .iter()
                    .rev()
                    .find(|i| i.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
            });
        if let Some(tool) = tool {
            let name = text(tool, "name").unwrap_or_else(|| "tool".into());
            a.step = Some(step_text(&name, tool.get("input").and_then(tool_detail)));
            a.at = text(e, "timestamp");
            break;
        }
    }
    if a.title.is_none() {
        a.title = entries
            .iter()
            .filter(|e| kind(e).as_deref() == Some("custom-title"))
            .find_map(|e| text(e, "customTitle"));
    }
}

/// Claude Code: nối pid với phiên qua `sessions/<pid>.json`, rồi đọc đuôi transcript. Không có file đó (bản cũ) thì
/// đoán bằng transcript mới nhất của thư mục.
pub(crate) fn claude_activity(
    config: &Path,
    pids: &[u32],
    cwd: Option<&str>,
    start: u64,
) -> Option<Activity> {
    if let Some(s) = pids
        .iter()
        .find_map(|pid| claude_session(config, *pid, start))
    {
        let mut a = Activity {
            title: s.title,
            status: s.status,
            entrypoint: s.entrypoint,
            ..Activity::default()
        };
        if let Some(dir) = s
            .cwd
            .as_deref()
            .or(cwd)
            .and_then(|c| project_dir(config, c))
        {
            read_claude_transcript(&dir.join(format!("{}.jsonl", s.id)), &mut a);
        }
        return Some(a);
    }
    let dir = project_dir(config, cwd?)?;
    let path = newest_jsonl(&dir, start.saturating_sub(5))?;
    let mut a = Activity {
        guessed: true,
        ..Activity::default()
    };
    read_claude_transcript(&path, &mut a);
    Some(a)
}

/// Hai thư mục là một: bỏ dấu phân cách cuối, so không phân biệt hoa thường với đường dẫn kiểu Windows.
fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let p = p.replace('\\', "/");
        let p = p.trim_end_matches('/').to_string();
        let windows = p.as_bytes().get(1) == Some(&b':');
        if windows { p.to_lowercase() } else { p }
    };
    norm(a) == norm(b)
}

/// Lệnh shell của Codex là mảng (`["bash","-lc","cargo test"]`): lấy phần lệnh thật.
fn codex_command(args: &serde_json::Value) -> Option<String> {
    match args.get("command") {
        Some(serde_json::Value::Array(parts)) => {
            let parts: Vec<&str> = parts.iter().filter_map(|p| p.as_str()).collect();
            let body = match parts.as_slice() {
                [_, flag, rest @ ..] if matches!(*flag, "-lc" | "-c") && !rest.is_empty() => rest,
                all => all,
            };
            Some(body.join(" "))
        }
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        _ => text(args, "cmd"),
    }
}

/// Codex không ghi pid: chọn rollout mới nhất của đúng thư mục, sửa sau khi tiến trình chạy, nên luôn là "đoán".
pub(crate) fn codex_activity(home: &Path, cwd: &str, start: u64, now: u64) -> Option<Activity> {
    let first = (start / 86_400) as i64 - 1;
    let last = (now / 86_400) as i64 + 1;
    let since = start.saturating_sub(5);
    let mut best: Option<(u64, PathBuf)> = None;
    for day in first.max(last - 7)..=last {
        let (y, m, d) = civil_from_days(day);
        let dir = home.join(format!("sessions/{y:04}/{m:02}/{d:02}"));
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for path in entries.flatten().map(|e| e.path()) {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                continue;
            }
            let Some(t) = modified_secs(&path).filter(|t| *t >= since) else {
                continue;
            };
            if best.as_ref().is_some_and(|(bt, _)| *bt >= t) {
                continue;
            }
            let meta = read_capped(&path, META_MAX)
                .and_then(|raw| raw.lines().next().map(str::to_string))
                .and_then(|l| serde_json::from_str::<serde_json::Value>(&l).ok());
            let meta_cwd = meta
                .as_ref()
                .and_then(|m| m.get("payload"))
                .and_then(|p| text(p, "cwd"));
            if meta_cwd.is_some_and(|c| same_path(&c, cwd)) {
                best = Some((t, path));
            }
        }
    }
    let (_, path) = best?;
    let entries = tail_entries(&path);
    let payload_type = |e: &serde_json::Value| {
        e.get("payload")
            .and_then(|p| p.get("type"))
            .and_then(|t| t.as_str())
            .map(str::to_string)
    };
    let mut a = Activity {
        guessed: true,
        ..Activity::default()
    };
    a.prompt = entries
        .iter()
        .filter(|e| payload_type(e).as_deref() == Some("user_message"))
        .find_map(|e| text(e.get("payload")?, "message"))
        .map(|p| one_line(&p, PROMPT_MAX));
    if let Some(e) = entries.iter().find(|e| {
        matches!(
            payload_type(e).as_deref(),
            Some("function_call" | "custom_tool_call" | "local_shell_call")
        )
    }) {
        let p = &e["payload"];
        let name = text(p, "name").unwrap_or_else(|| "shell".into());
        let detail = text(p, "arguments")
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|args| codex_command(&args))
            .or_else(|| p.get("action").and_then(codex_command))
            .or_else(|| text(p, "input").and_then(|i| i.lines().next().map(str::to_string)));
        a.step = Some(step_text(&name, detail));
        a.at = text(e, "timestamp");
    }
    a.status = entries
        .iter()
        .find_map(|e| match payload_type(e).as_deref() {
            Some("task_started") => Some("busy".to_string()),
            Some("task_complete") => Some("idle".to_string()),
            _ => None,
        });
    Some(a)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hive-activity-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    fn lines(values: &[serde_json::Value]) -> String {
        values.iter().map(|v| format!("{v}\n")).collect()
    }

    const CWD: &str = "/Users/ha/shop";
    const SESSION: &str = "f8562734-31ab-467c-9d4e-ce1e1a72258f";

    fn transcript() -> String {
        lines(&[
            json!({"type": "user", "message": {"role": "user", "content": "sửa đăng nhập"}, "timestamp": "2026-10-17T08:00:00Z"}),
            json!({"type": "last-prompt", "lastPrompt": "Sửa lỗi đăng nhập\nbằng Google", "sessionId": SESSION}),
            json!({"type": "assistant", "timestamp": "2026-10-17T08:01:00Z", "message": {"role": "assistant", "content": [
                {"type": "text", "text": "Mở file"},
                {"type": "tool_use", "name": "Edit", "input": {"file_path": "/Users/ha/shop/src/login.ts"}}
            ]}}),
            json!({"type": "assistant", "timestamp": "2026-10-17T08:02:00Z", "message": {"role": "assistant", "content": [
                {"type": "tool_use", "name": "Bash", "input": {"command": "pnpm test", "description": "Chạy test"}}
            ]}}),
            json!({"type": "user", "timestamp": "2026-10-17T08:02:30Z", "message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}}),
        ])
    }

    fn write_session(config: &Path, pid: u32, started_ms: u64) {
        fs::create_dir_all(config.join("sessions")).unwrap();
        let file = json!({"pid": pid, "sessionId": SESSION, "cwd": CWD, "startedAt": started_ms, "name": "Sửa login",
            "status": "busy", "entrypoint": "claude-desktop", "kind": "interactive"});
        fs::write(
            config.join(format!("sessions/{pid}.json")),
            file.to_string(),
        )
        .unwrap();
    }

    fn write_transcript(config: &Path, name: &str, body: &str) {
        let dir = config.join("projects").join(encode_project_dir(CWD));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{name}.jsonl")), body).unwrap();
    }

    #[test]
    fn encodes_like_claude_code() {
        assert_eq!(
            encode_project_dir(r"E:\Codes\xDev\xdev-hive"),
            "E--Codes-xDev-xdev-hive"
        );
        assert_eq!(
            encode_project_dir(r"E:\Codes\xDev\xdev-hive\.claude\worktrees\a"),
            "E--Codes-xDev-xdev-hive--claude-worktrees-a"
        );
        assert_eq!(encode_project_dir("/Users/ha/dự án"), "-Users-ha-d---n");
        // Ký tự ngoài BMP là hai đơn vị UTF-16 trong JavaScript.
        assert_eq!(encode_project_dir("/a😀b"), "-a--b");
    }

    #[test]
    fn claude_reads_session_file_then_transcript_tail() {
        let config = tmp("claude-session");
        let start = now() - 60;
        write_session(&config, 4242, start * 1000 + 300);
        write_transcript(&config, SESSION, &transcript());
        let a = claude_activity(&config, &[4240, 4242], Some("/elsewhere"), start).unwrap();
        assert_eq!(a.title.as_deref(), Some("Sửa login"));
        assert_eq!(a.status.as_deref(), Some("busy"));
        assert_eq!(a.prompt.as_deref(), Some("Sửa lỗi đăng nhập bằng Google"));
        assert_eq!(a.step.as_deref(), Some("Bash: Chạy test"));
        assert_eq!(a.at.as_deref(), Some("2026-10-17T08:02:00Z"));
        assert!(!a.guessed);
        assert_eq!(a.entrypoint.as_deref(), Some("claude-desktop"));
    }

    #[test]
    fn claude_ignores_session_file_of_reused_pid() {
        let config = tmp("claude-reused");
        let start = now() - 60;
        // File phiên của tiến trình cũ cùng pid, chạy 10 phút trước tiến trình này.
        write_session(&config, 4242, (start - 600) * 1000);
        write_transcript(
            &config,
            "0a0a0a0a-0000-0000-0000-000000000000",
            &transcript(),
        );
        let a = claude_activity(&config, &[4242], Some(CWD), start).unwrap();
        assert!(a.guessed);
        assert_eq!(a.title, None);
        assert_eq!(a.step.as_deref(), Some("Bash: Chạy test"));
        // Không transcript nào sửa sau khi tiến trình chạy: không đoán.
        assert_eq!(
            claude_activity(&config, &[4242], Some(CWD), now() + 3600),
            None
        );
    }

    #[test]
    fn claude_tail_skips_partial_first_line_and_bad_json() {
        let config = tmp("claude-tail");
        let start = now() - 60;
        write_session(&config, 7, start * 1000);
        let filler = json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "x".repeat(1000)}]}});
        let mut body: String = (0..300).map(|_| format!("{filler}\n")).collect();
        body.push_str("{not json\n");
        body.push_str(&transcript());
        write_transcript(&config, SESSION, &body);
        assert!(body.len() as u64 > TAIL);
        let a = claude_activity(&config, &[7], None, start).unwrap();
        assert_eq!(a.step.as_deref(), Some("Bash: Chạy test"));
    }

    #[test]
    fn codex_picks_newest_rollout_for_cwd() {
        let home = tmp("codex");
        let now = now();
        let start = now - 60;
        let (y, m, d) = civil_from_days((now / 86_400) as i64);
        let day = home.join(format!("sessions/{y:04}/{m:02}/{d:02}"));
        fs::create_dir_all(&day).unwrap();
        let meta = |cwd: &str| json!({"timestamp": "2026-10-17T08:00:00Z", "type": "session_meta", "payload": {"id": "x", "cwd": cwd, "base_instructions": {"text": "dài"}}});
        fs::write(
            day.join("rollout-2026-10-17T08-00-00-other.jsonl"),
            lines(&[meta("/Users/ha/other")]),
        )
        .unwrap();
        let body = lines(&[
            meta(r"C:\Users\Ha\Shop\"),
            json!({"timestamp": "2026-10-17T08:00:01Z", "type": "event_msg", "payload": {"type": "task_started", "turn_id": "1"}}),
            json!({"timestamp": "2026-10-17T08:00:02Z", "type": "event_msg", "payload": {"type": "user_message", "message": "Chạy   test\nrồi sửa"}}),
            json!({"timestamp": "2026-10-17T08:00:03Z", "type": "response_item", "payload": {"type": "function_call", "name": "shell",
                "arguments": "{\"command\":[\"bash\",\"-lc\",\"cargo test\"]}"}}),
        ]);
        fs::write(day.join("rollout-2026-10-17T08-00-00-mine.jsonl"), body).unwrap();
        let a = codex_activity(&home, r"c:\users\ha\shop", start, now).unwrap();
        assert_eq!(a.prompt.as_deref(), Some("Chạy test rồi sửa"));
        assert_eq!(a.step.as_deref(), Some("shell: cargo test"));
        assert_eq!(a.at.as_deref(), Some("2026-10-17T08:00:03Z"));
        assert_eq!(a.status.as_deref(), Some("busy"));
        assert!(a.guessed);
        assert_eq!(codex_activity(&home, "/Users/ha/none", start, now), None);
    }

    #[test]
    fn one_line_collapses_and_cuts() {
        assert_eq!(one_line("  a\n\n b\t c ", 300), "a b c");
        let long = "á".repeat(400);
        let cut = one_line(&long, 300);
        assert_eq!(cut.chars().count(), 300);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(20_743), (2026, 10, 17));
    }
}
