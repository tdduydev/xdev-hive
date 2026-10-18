//! Khung "Hoạt động" của một agent (spec 021 phần 3): đọc theo đuôi file phiên của chính CLI (transcript Claude Code,
//! rollout Codex) để xem trực tiếp. Chỉ đọc, chỉ trên máy, không gửi hub. Định dạng là chi tiết nội bộ của CLI: dòng
//! lạ bỏ qua, không dòng nào đọc được thì báo "không đọc được phiên".

use serde::Serialize;
use serde_json::Value;
use std::path::Path;

/// Số mục lần đầu mở và mỗi lần "Tải thêm".
pub(crate) const PAGE: usize = 200;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    User,
    Assistant,
    Tool,
    Result,
    Error,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Giờ CLI ghi (ISO 8601).
    pub at: Option<String>,
    pub kind: Kind,
    /// Tên công cụ của mục Tool.
    pub tool: Option<String>,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Format {
    Claude,
    Codex,
}

/// Một đoạn file đã đọc: mục, vị trí byte đầu dòng đầu tiên và sau dòng cuối đã ghi xong, số dòng đọc được và số dòng
/// có dạng JSON của CLI.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Chunk {
    pub entries: Vec<Entry>,
    pub start: u64,
    pub end: u64,
    pub lines: usize,
    pub known: usize,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    /// File phiên đang đọc; giao diện gửi lại để Rust biết còn cùng file, Rust không mở theo đường dẫn này.
    pub path: Option<String>,
    pub entries: Vec<Entry>,
    /// Byte đầu của mục cũ nhất đã gửi: "Tải thêm" đọc trước vị trí này; 0 là hết.
    pub start: u64,
    /// Byte sau dòng cuối đã đọc: lần sau đọc tiếp từ đây.
    pub end: u64,
    /// Đọc lại từ đầu file khác (phiên mới, file bị ghi đè): giao diện thay danh sách.
    pub reset: bool,
    pub guessed: bool,
    pub readable: bool,
}

const MESSAGE_MAX: usize = 4000;
const TOOL_MAX: usize = 200;
const RESULT_MAX: usize = 600;
/// Mỗi lần đọc tiếp tối đa ngần này: agent ghi nhiều cũng không làm đứng app, lần sau đọc phần còn lại.
const FORWARD_MAX: u64 = 4 * 1024 * 1024;
/// "Tải thêm" lùi tối đa ngần này mỗi lần, kể cả khi chưa đủ mục (dòng kết quả công cụ có thể rất dài).
const BACKWARD_MAX: u64 = 8 * 1024 * 1024;
const BACKWARD_STEP: u64 = 256 * 1024;

/// Cắt chữ dài, giữ xuống dòng.
fn cut(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn entry(at: &Option<String>, kind: Kind, tool: Option<String>, text: String) -> Entry {
    Entry {
        at: at.clone(),
        kind,
        tool,
        text,
    }
}

/// Chữ của nội dung kết quả công cụ: chuỗi, hay mảng các khối `{type: "text"}`.
fn content_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|i| i.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Lệnh gạch chéo và output của nó Claude Code ghi như lời người dùng, bọc trong thẻ.
fn wrapped_command(s: &str) -> bool {
    let s = s.trim_start();
    s.starts_with("<command-") || s.starts_with("<local-command-")
}

fn claude(line: &Value) -> Vec<Entry> {
    let at = super::activity::text(line, "timestamp");
    if line.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return Vec::new();
    }
    let content = line.get("message").and_then(|m| m.get("content"));
    match line.get("type").and_then(Value::as_str) {
        Some("user") => match content {
            Some(Value::String(s)) if !wrapped_command(s) && !s.trim().is_empty() => {
                vec![entry(&at, Kind::User, None, cut(s, MESSAGE_MAX))]
            }
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(|i| match i.get("type").and_then(Value::as_str) {
                    Some("text") => i
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|t| !wrapped_command(t) && !t.trim().is_empty())
                        .map(|t| entry(&at, Kind::User, None, cut(t, MESSAGE_MAX))),
                    Some("tool_result") => {
                        let error = i.get("is_error").and_then(Value::as_bool) == Some(true);
                        let kind = if error { Kind::Error } else { Kind::Result };
                        let body = i.get("content").map(content_text).unwrap_or_default();
                        Some(entry(&at, kind, None, cut(&body, RESULT_MAX)))
                    }
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        },
        Some("assistant") => content
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|i| match i.get("type").and_then(Value::as_str) {
                Some("text") => i
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|t| !t.trim().is_empty())
                    .map(|t| entry(&at, Kind::Assistant, None, cut(t, MESSAGE_MAX))),
                Some("tool_use") => {
                    let name = super::activity::text(i, "name").unwrap_or_else(|| "tool".into());
                    let input = i.get("input").cloned().unwrap_or(Value::Null);
                    let detail =
                        super::activity::tool_detail(&input).unwrap_or_else(|| input.to_string());
                    Some(entry(
                        &at,
                        Kind::Tool,
                        Some(name),
                        super::activity::one_line(&detail, TOOL_MAX),
                    ))
                }
                // Suy nghĩ của model không hiện.
                _ => None,
            })
            .collect(),
        Some("system") if line.get("level").and_then(Value::as_str) == Some("error") => {
            let body = line.get("content").map(content_text).unwrap_or_default();
            vec![entry(&at, Kind::Error, None, cut(&body, RESULT_MAX))]
        }
        _ => Vec::new(),
    }
}

/// Kết quả công cụ Codex: chuỗi, hay JSON `{output, metadata}` dạng chuỗi.
fn codex_output(raw: &str) -> String {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.get("output").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| raw.to_string())
}

fn codex(line: &Value) -> Vec<Entry> {
    let at = super::activity::text(line, "timestamp");
    let Some(p) = line.get("payload") else {
        return Vec::new();
    };
    let message = |kind: Kind, max: usize| {
        super::activity::text(p, "message")
            .map(|m| vec![entry(&at, kind, None, cut(&m, max))])
            .unwrap_or_default()
    };
    let kind = p.get("type").and_then(Value::as_str);
    match (line.get("type").and_then(Value::as_str), kind) {
        // Lời nhắn có cả ở response_item và event_msg: chỉ lấy event_msg để không hiện hai lần.
        (Some("event_msg"), Some("user_message")) => message(Kind::User, MESSAGE_MAX),
        (Some("event_msg"), Some("agent_message")) => message(Kind::Assistant, MESSAGE_MAX),
        (Some("event_msg"), Some("error" | "stream_error")) => message(Kind::Error, RESULT_MAX),
        (
            Some("response_item"),
            Some("function_call" | "custom_tool_call" | "local_shell_call"),
        ) => {
            let name = super::activity::text(p, "name").unwrap_or_else(|| "shell".into());
            let detail = super::activity::codex_call_detail(p).unwrap_or_default();
            vec![entry(
                &at,
                Kind::Tool,
                Some(name),
                super::activity::one_line(&detail, TOOL_MAX),
            )]
        }
        (Some("response_item"), Some("function_call_output" | "custom_tool_call_output")) => {
            let body = super::activity::text(p, "output")
                .map(|o| codex_output(&o))
                .unwrap_or_default();
            vec![entry(&at, Kind::Result, None, cut(&body, RESULT_MAX))]
        }
        _ => Vec::new(),
    }
}

pub(crate) fn entries(format: Format, line: &Value) -> Vec<Entry> {
    match format {
        Format::Claude => claude(line),
        Format::Codex => codex(line),
    }
}

/// Dòng có dạng của file phiên (đối tượng JSON có `type`), để phân biệt định dạng lạ với file chưa có gì.
fn known(line: &Value) -> bool {
    line.get("type").and_then(Value::as_str).is_some()
}

/// Đọc các dòng đã ghi xong trong `bytes` (bắt đầu ở byte `base` của file, đầu dòng), kèm vị trí đầu mỗi dòng.
fn parse_lines(bytes: &[u8], base: u64, format: Format) -> Vec<(u64, bool, Vec<Entry>)> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while let Some(nl) = bytes[pos..].iter().position(|b| *b == b'\n') {
        let line = &bytes[pos..pos + nl];
        let offset = base + pos as u64;
        pos += nl + 1;
        let text = String::from_utf8_lossy(line);
        if text.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(&text) {
            Ok(v) => out.push((offset, known(&v), entries(format, &v))),
            Err(_) => out.push((offset, false, Vec::new())),
        }
    }
    out
}

fn read_range(path: &Path, from: u64, len: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(from))?;
    let mut buf = Vec::new();
    file.take(len).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Các dòng ghi xong từ byte `from` (đầu dòng) tới hết file, tối đa `FORWARD_MAX`.
pub(crate) fn read_forward(path: &Path, format: Format, from: u64) -> std::io::Result<Chunk> {
    let buf = read_range(path, from, FORWARD_MAX)?;
    let complete = match buf.iter().rposition(|b| *b == b'\n') {
        Some(i) => i + 1,
        // Một dòng dài hơn cả giới hạn: bỏ qua phần đã đọc để không kẹt ở đó mãi.
        None if buf.len() as u64 >= FORWARD_MAX => buf.len(),
        None => 0,
    };
    let parsed = parse_lines(&buf[..complete], from, format);
    Ok(Chunk {
        lines: parsed.len(),
        known: parsed.iter().filter(|(_, k, _)| *k).count(),
        entries: parsed.into_iter().flat_map(|(_, _, e)| e).collect(),
        start: from,
        end: from + complete as u64,
    })
}

/// `want` mục cuối trước byte `before` (đầu dòng hay cuối file). `start` là byte đầu dòng cũ nhất đã lấy.
pub(crate) fn read_backward(
    path: &Path,
    format: Format,
    before: u64,
    want: usize,
) -> std::io::Result<Chunk> {
    let len = std::fs::metadata(path)?.len().min(before);
    let mut window = BACKWARD_STEP.min(len);
    loop {
        let lo = len - window;
        let buf = read_range(path, lo, window)?;
        // Bỏ dòng đầu bị cắt (trừ khi đọc từ đầu file) và dòng cuối chưa ghi xong.
        let head = if lo == 0 {
            0
        } else {
            buf.iter()
                .position(|b| *b == b'\n')
                .map_or(buf.len(), |i| i + 1)
        };
        let tail = buf
            .iter()
            .rposition(|b| *b == b'\n')
            .map_or(head, |i| i + 1)
            .max(head);
        let parsed = parse_lines(&buf[head..tail], lo + head as u64, format);
        let total: usize = parsed.iter().map(|(_, _, e)| e.len()).sum();
        if total >= want || lo == 0 || window >= BACKWARD_MAX {
            let mut taken = 0usize;
            let mut first = parsed.len();
            for (i, (_, _, e)) in parsed.iter().enumerate().rev() {
                if taken >= want {
                    break;
                }
                taken += e.len();
                first = i;
            }
            let start = parsed
                .get(first)
                .map_or(if lo == 0 { 0 } else { lo + head as u64 }, |(o, _, _)| *o);
            let start = if first == 0 && lo == 0 { 0 } else { start };
            let kept = &parsed[first..];
            return Ok(Chunk {
                lines: kept.len(),
                known: kept.iter().filter(|(_, k, _)| *k).count(),
                entries: kept.iter().flat_map(|(_, _, e)| e.clone()).collect(),
                start,
                end: lo + tail as u64,
            });
        }
        window = (window * 2).min(len);
    }
}

fn path_text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn feed(path: &Path, guessed: bool, chunk: Chunk, reset: bool) -> Feed {
    Feed {
        path: Some(path_text(path)),
        readable: chunk.lines == 0 || chunk.known > 0,
        entries: chunk.entries,
        start: chunk.start,
        end: chunk.end,
        reset,
        guessed,
    }
}

fn unreadable(reset: bool) -> Feed {
    Feed {
        path: None,
        entries: Vec::new(),
        start: 0,
        end: 0,
        reset,
        guessed: false,
        readable: false,
    }
}

/// Lần đọc tiếp của khung Hoạt động. `resolved` là file phiên Rust tự tìm từ pid; `cursor` là file và vị trí giao diện
/// đã có. Cùng file và file không ngắn đi thì đọc tiếp; khác thì đọc lại trang cuối của file mới.
pub(crate) fn next(
    resolved: Option<(&Path, bool)>,
    format: Format,
    cursor: Option<(&str, u64)>,
) -> Feed {
    let Some((path, guessed)) = resolved else {
        return unreadable(cursor.is_some());
    };
    let len = std::fs::metadata(path).map(|m| m.len()).ok();
    if let (Some((p, end)), Some(len)) = (cursor, len)
        && p == path_text(path)
        && end <= len
    {
        return match read_forward(path, format, end) {
            Ok(c) => feed(path, guessed, c, false),
            Err(_) => unreadable(true),
        };
    }
    match read_backward(path, format, u64::MAX, PAGE) {
        Ok(c) => feed(path, guessed, c, cursor.is_some()),
        Err(_) => unreadable(cursor.is_some()),
    }
}

/// "Tải thêm": trang trước byte `before` của đúng file đang xem; file đã đổi thì như lần đọc đầu.
pub(crate) fn older(
    resolved: Option<(&Path, bool)>,
    format: Format,
    path: &str,
    before: u64,
) -> Feed {
    let Some((file, guessed)) = resolved else {
        return unreadable(true);
    };
    if path != path_text(file) {
        return next(resolved, format, Some((path, u64::MAX)));
    }
    match read_backward(file, format, before, PAGE) {
        Ok(c) => feed(file, guessed, c, false),
        Err(_) => unreadable(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hive-feed-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn lines(values: &[Value]) -> String {
        values.iter().map(|v| format!("{v}\n")).collect()
    }

    fn kinds(e: &[Entry]) -> Vec<Kind> {
        e.iter().map(|x| x.kind).collect()
    }

    const T: &str = "2026-10-18T08:00:00Z";

    #[test]
    fn claude_lines_become_entries() {
        let user = json!({"type": "user", "timestamp": T, "message": {"role": "user", "content": "Sửa lỗi đăng nhập"}});
        let e = entries(Format::Claude, &user);
        assert_eq!(
            e,
            vec![Entry {
                at: Some(T.into()),
                kind: Kind::User,
                tool: None,
                text: "Sửa lỗi đăng nhập".into()
            }]
        );
        // Dòng hệ thống chèn vào và lệnh gạch chéo không phải lời người dùng.
        let meta = json!({"type": "user", "isMeta": true, "message": {"content": "<system-reminder>x</system-reminder>"}});
        assert!(entries(Format::Claude, &meta).is_empty());
        let slash =
            json!({"type": "user", "message": {"content": "<command-name>/clear</command-name>"}});
        assert!(entries(Format::Claude, &slash).is_empty());

        let assistant = json!({"type": "assistant", "timestamp": T, "message": {"content": [
            {"type": "thinking", "thinking": "bí mật suy nghĩ"},
            {"type": "text", "text": "Tôi sẽ chạy test."},
            {"type": "tool_use", "name": "Bash", "input": {"command": "pnpm test", "description": "Chạy test"}},
            {"type": "tool_use", "name": "Edit", "input": {"file_path": "/a/src/login.ts", "old_string": "x"}}
        ]}});
        let e = entries(Format::Claude, &assistant);
        assert_eq!(kinds(&e), vec![Kind::Assistant, Kind::Tool, Kind::Tool]);
        assert_eq!(e[1].tool.as_deref(), Some("Bash"));
        assert_eq!(e[1].text, "Chạy test");
        assert_eq!(e[2].text, "login.ts");
        assert!(!e.iter().any(|x| x.text.contains("suy nghĩ")));

        let results = json!({"type": "user", "timestamp": T, "message": {"content": [
            {"type": "tool_result", "content": "12 tests passed"},
            {"type": "tool_result", "is_error": true, "content": [{"type": "text", "text": "command not found"}]}
        ]}});
        let e = entries(Format::Claude, &results);
        assert_eq!(kinds(&e), vec![Kind::Result, Kind::Error]);
        assert_eq!(e[0].text, "12 tests passed");
        assert_eq!(e[1].text, "command not found");

        let api = json!({"type": "system", "level": "error", "timestamp": T, "content": "API Error: 529 overloaded"});
        assert_eq!(kinds(&entries(Format::Claude, &api)), vec![Kind::Error]);
        for other in [
            json!({"type": "last-prompt", "lastPrompt": "x"}),
            json!({"type": "custom-title", "customTitle": "x"}),
            json!({"type": "system", "level": "info", "content": "hook ok"}),
        ] {
            assert!(entries(Format::Claude, &other).is_empty(), "{other}");
        }
    }

    #[test]
    fn codex_lines_become_entries() {
        let line =
            |kind: &str, payload: Value| json!({"timestamp": T, "type": kind, "payload": payload});
        let all = [
            line("session_meta", json!({"cwd": "/a"})),
            line(
                "event_msg",
                json!({"type": "user_message", "message": "Chạy test"}),
            ),
            // Codex ghi lời nhắn hai lần (response_item và event_msg): chỉ lấy event_msg.
            line(
                "response_item",
                json!({"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Chạy test"}]}),
            ),
            line(
                "event_msg",
                json!({"type": "agent_reasoning", "text": "nghĩ"}),
            ),
            line(
                "response_item",
                json!({"type": "function_call", "name": "shell", "arguments": "{\"command\":[\"bash\",\"-lc\",\"cargo test\"]}"}),
            ),
            line(
                "response_item",
                json!({"type": "function_call_output", "output": "{\"output\":\"test result: ok\",\"metadata\":{\"exit_code\":0}}"}),
            ),
            line(
                "response_item",
                json!({"type": "custom_tool_call", "name": "apply_patch", "input": "*** Begin Patch\n*** Update File: a.rs"}),
            ),
            line(
                "event_msg",
                json!({"type": "agent_message", "message": "Xong."}),
            ),
            line(
                "event_msg",
                json!({"type": "error", "message": "stream disconnected"}),
            ),
        ];
        let e: Vec<Entry> = all.iter().flat_map(|l| entries(Format::Codex, l)).collect();
        assert_eq!(
            kinds(&e),
            vec![
                Kind::User,
                Kind::Tool,
                Kind::Result,
                Kind::Tool,
                Kind::Assistant,
                Kind::Error
            ]
        );
        assert_eq!(
            (e[1].tool.as_deref(), e[1].text.as_str()),
            (Some("shell"), "cargo test")
        );
        assert_eq!(e[2].text, "test result: ok");
        assert_eq!(
            (e[3].tool.as_deref(), e[3].text.as_str()),
            (Some("apply_patch"), "*** Begin Patch")
        );
        assert_eq!(e[5].text, "stream disconnected");
        assert!(e.iter().all(|x| x.at.as_deref() == Some(T)));
    }

    #[test]
    fn long_text_is_cut() {
        let long = "á".repeat(10_000);
        let user = json!({"type": "user", "message": {"content": long}});
        let e = entries(Format::Claude, &user);
        assert_eq!(e[0].text.chars().count(), 4000);
        assert!(e[0].text.ends_with('…'));
        let result = json!({"type": "user", "message": {"content": [{"type": "tool_result", "content": "x\n".repeat(2000)}]}});
        assert!(entries(Format::Claude, &result)[0].text.chars().count() <= 600);
    }

    fn claude_line(i: usize) -> Value {
        json!({"type": "user", "timestamp": T, "message": {"content": format!("lời nhắc {i}")}})
    }

    #[test]
    fn forward_reads_only_complete_lines() {
        let dir = tmp("forward");
        let path = dir.join("s.jsonl");
        let mut body = lines(&[claude_line(1), claude_line(2)]);
        let third = claude_line(3).to_string();
        body.push_str(&third[..10]);
        fs::write(&path, &body).unwrap();
        let c = read_forward(&path, Format::Claude, 0).unwrap();
        assert_eq!(c.entries.len(), 2);
        assert_eq!(c.end as usize, body.len() - 10);
        // Dòng thứ ba ghi xong: lần sau đọc tiếp từ `end`.
        let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "{}", &third[10..]).unwrap();
        let c2 = read_forward(&path, Format::Claude, c.end).unwrap();
        assert_eq!(c2.entries.len(), 1);
        assert_eq!(c2.entries[0].text, "lời nhắc 3");
        assert_eq!(c2.end, fs::metadata(&path).unwrap().len());
    }

    #[test]
    fn backward_pages_from_the_end() {
        let dir = tmp("backward");
        let path = dir.join("s.jsonl");
        let all: Vec<Value> = (1..=50).map(claude_line).collect();
        fs::write(&path, lines(&all)).unwrap();
        let len = fs::metadata(&path).unwrap().len();
        let last = read_backward(&path, Format::Claude, len, 10).unwrap();
        assert_eq!(last.entries.len(), 10);
        assert_eq!(last.entries[0].text, "lời nhắc 41");
        assert_eq!(last.entries[9].text, "lời nhắc 50");
        assert_eq!(last.end, len);
        let older = read_backward(&path, Format::Claude, last.start, 10).unwrap();
        assert_eq!(older.entries[0].text, "lời nhắc 31");
        assert_eq!(older.end, last.start);
        let first = read_backward(&path, Format::Claude, 200, 100).unwrap();
        assert_eq!(first.start, 0);
    }

    #[test]
    fn next_follows_the_file_and_resets_on_new_or_shorter_file() {
        let dir = tmp("next");
        let a = dir.join("a.jsonl");
        fs::write(&a, lines(&[claude_line(1), claude_line(2)])).unwrap();
        let first = next(Some((&a, false)), Format::Claude, None);
        assert!(first.readable && !first.reset);
        assert_eq!(first.entries.len(), 2);
        assert_eq!(first.start, 0);
        let path = first.path.clone().unwrap();

        let mut f = fs::OpenOptions::new().append(true).open(&a).unwrap();
        writeln!(f, "{}", claude_line(3)).unwrap();
        let more = next(Some((&a, false)), Format::Claude, Some((&path, first.end)));
        assert!(!more.reset);
        assert_eq!(more.entries.len(), 1);

        // Phiên mới (`/clear`): file khác trong cùng thư mục.
        let b = dir.join("b.jsonl");
        fs::write(&b, lines(&[claude_line(9)])).unwrap();
        let moved = next(Some((&b, false)), Format::Claude, Some((&path, more.end)));
        assert!(moved.reset);
        assert_eq!(moved.entries[0].text, "lời nhắc 9");

        // File bị ghi đè ngắn hơn chỗ đã đọc.
        fs::write(&a, lines(&[claude_line(7)])).unwrap();
        let rewritten = next(Some((&a, false)), Format::Claude, Some((&path, more.end)));
        assert!(rewritten.reset);
        assert_eq!(rewritten.entries[0].text, "lời nhắc 7");

        // Đường dẫn gửi lên không khớp file Rust tự tìm: không đọc tiếp theo nó.
        let forged = next(Some((&a, false)), Format::Claude, Some(("/etc/passwd", 0)));
        assert!(forged.reset);
        assert_eq!(forged.path.as_deref(), Some(path.as_str()));
    }

    #[test]
    fn unknown_or_missing_session_is_not_readable() {
        let dir = tmp("unknown");
        let odd = dir.join("odd.jsonl");
        fs::write(&odd, "not json\n{\"x\":1}\n").unwrap();
        assert!(!next(Some((&odd, false)), Format::Claude, None).readable);
        let none = next(None, Format::Codex, None);
        assert!(!none.readable);
        assert_eq!(none.path, None);
    }

    #[test]
    fn older_reads_before_and_ignores_a_foreign_path() {
        let dir = tmp("older");
        let a = dir.join("a.jsonl");
        let all: Vec<Value> = (1..=300).map(claude_line).collect();
        fs::write(&a, lines(&all)).unwrap();
        let first = next(Some((&a, false)), Format::Claude, None);
        assert_eq!(first.entries.len(), PAGE);
        let path = first.path.clone().unwrap();
        let o = older(Some((&a, false)), Format::Claude, &path, first.start);
        assert_eq!(o.entries.len(), 100);
        assert_eq!(o.start, 0);
        assert_eq!(o.entries[99].text, "lời nhắc 100");
        let forged = older(Some((&a, false)), Format::Claude, "/etc/passwd", 10);
        assert!(forged.reset);
    }
}
