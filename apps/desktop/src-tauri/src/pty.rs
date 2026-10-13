//! Terminal nhúng của màn "Tài liệu từ code": PTY trên máy chạy Claude Code, Codex, Antigravity (`agy`) hay shell của
//! người dùng trong thư mục dự án, cửa sổ app vẽ bằng xterm.js. Khác PTY trong worker (spec 010, điều khiển từ xa):
//! ở đây chỉ cửa sổ app trên máy này gõ vào.
//!
//! Cửa sổ chỉ chọn loại CLI, id gói agent và thư mục; binary, cờ bỏ hỏi quyền và thư mục đăng nhập của gói lấy từ
//! `profiles.rs` (như "Mở CLI" của màn Gói agent), nên giao diện không đưa được lệnh hay đường dẫn tuỳ ý vào đây. Môi
//! trường dựng từ danh sách cho phép của `cli.rs`: token máy và biến HIVE_* không lọt vào terminal.

use crate::cli::{child_env, project_folder};
use crate::doctor::user_path;
use crate::profiles::{Account, Accounts, bypass_flag, cli_binary, cli_launch, home_dir};
use base64::Engine as _;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const DATA: &str = "pty:data";
pub const EXIT: &str = "pty:exit";
/// Mỗi terminal là một CLI đang chạy (vài trăm MB với agent): giới hạn để lỗi vòng lặp ở cửa sổ không mở vô hạn.
const MAX_OPEN: usize = 8;
/// Một lần gõ hay dán; dán lớn hơn thì xterm chia sẵn.
const MAX_WRITE: usize = 64 * 1024;

/// Chương trình chạy trong terminal, đã kiểm.
#[derive(Debug, PartialEq)]
pub struct Spawn {
    pub program: String,
    pub args: Vec<String>,
    /// Biến thư mục đăng nhập của gói (CLAUDE_CONFIG_DIR, CODEX_HOME).
    pub env: Option<(&'static str, String)>,
}

/// Shell đăng nhập của người dùng (`-l` để có PATH, alias của họ).
fn shell() -> Spawn {
    #[cfg(windows)]
    {
        Spawn {
            program: "powershell.exe".into(),
            args: vec!["-NoLogo".into()],
            env: None,
        }
    }
    #[cfg(not(windows))]
    {
        let fallback = if cfg!(target_os = "macos") {
            "/bin/zsh"
        } else {
            "/bin/bash"
        };
        let program = std::env::var("SHELL")
            .ok()
            .filter(|s| Path::new(s).is_absolute() && Path::new(s).is_file())
            .unwrap_or_else(|| fallback.into());
        Spawn {
            program,
            args: vec!["-l".into()],
            env: None,
        }
    }
}

/// Lệnh cho terminal: `cli` là "claude", "codex", "antigravity" hoặc "shell"; `plan` là danh sách gói của worker và id
/// gói người dùng chọn (không chọn thì dùng đăng nhập mặc định của CLI).
pub fn spawn_spec(
    cli: &str,
    plan: Option<(&[Account], &str)>,
    bypass: bool,
    home: Option<&Path>,
) -> Result<Spawn, String> {
    if cli == "shell" {
        if bypass || plan.is_some() {
            return Err("Shell không có gói agent hay chế độ bỏ hỏi quyền.".into());
        }
        return Ok(shell());
    }
    let binary =
        cli_binary(cli).ok_or_else(|| format!("App không mở được {cli} trong terminal."))?;
    if let Some((list, id)) = plan {
        let id = id.trim();
        if list
            .iter()
            .find(|a| a.id == id)
            .is_some_and(|a| a.cli != cli)
        {
            return Err(format!("Gói {id} không phải gói của {cli}."));
        }
        let launch = cli_launch(list, id, None, home, bypass)?;
        let mut argv = launch.argv.into_iter();
        return Ok(Spawn {
            program: argv.next().unwrap_or_else(|| binary.into()),
            args: argv.collect(),
            env: launch.env,
        });
    }
    let mut args = Vec::new();
    if bypass {
        args.push(
            bypass_flag(cli)
                .ok_or_else(|| format!("CLI {cli} không có chế độ bỏ hỏi quyền."))?
                .to_string(),
        );
    }
    Ok(Spawn {
        program: binary.into(),
        args,
        env: None,
    })
}

/// Môi trường của terminal: danh sách cho phép của `cli.rs`, PATH đăng nhập, kiểu terminal của xterm.js. App mở từ
/// Finder không có LANG: thiếu thì đặt UTF-8 để giao diện của CLI vẽ đúng chữ có dấu.
pub fn term_env(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
    path: &str,
    extra: Option<&(&'static str, String)>,
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = child_env(vars, path)
        .into_iter()
        .filter(|(k, _)| k != "TERM" && k != "COLORTERM")
        .collect();
    env.push(("TERM".into(), "xterm-256color".into()));
    env.push(("COLORTERM".into(), "truecolor".into()));
    if cfg!(unix) && !env.iter().any(|(k, _)| k == "LANG" || k == "LC_ALL") {
        env.push(("LANG".into(), "en_US.UTF-8".into()));
    }
    if let Some((key, value)) = extra {
        env.retain(|(k, _)| k != key);
        env.push((key.into(), value.into()));
    }
    env
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.clamp(2, 1000),
        rows: rows.clamp(1, 500),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Một terminal đang mở.
pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
}

impl Session {
    /// Giết cả nhóm tiến trình (CLI còn chạy rg, node, shell con), rồi đóng PTY.
    fn kill(mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid.and_then(|p| i32::try_from(p).ok()) {
            // SAFETY: tiến trình do PTY tạo là trưởng phiên và nhóm riêng (setsid); chỉ gửi tín hiệu, không đụng bộ nhớ.
            unsafe {
                libc::kill(-pid, libc::SIGHUP);
                libc::kill(-pid, libc::SIGTERM);
            }
        }
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            let mut cmd = std::process::Command::new("taskkill");
            cmd.args(["/T", "/F", "/PID", &pid.to_string()]);
            let _ = crate::doctor::run_with_timeout(cmd, Duration::from_secs(5));
        }
        let _ = self.killer.kill();
        drop(self.writer);
        drop(self.master);
    }
}

type Spawned = (
    Session,
    Box<dyn Read + Send>,
    Box<dyn portable_pty::Child + Send + Sync>,
);

/// Mở PTY và chạy lệnh trong `cwd`. Trả phiên, đầu đọc output và tiến trình con để chờ mã thoát.
pub fn spawn(
    spec: &Spawn,
    cwd: &Path,
    env: Vec<(OsString, OsString)>,
    cols: u16,
    rows: u16,
) -> Result<Spawned, String> {
    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|e| format!("Không mở được terminal: {e}"))?;
    let mut cmd = CommandBuilder::new(&spec.program);
    cmd.args(&spec.args);
    cmd.cwd(cwd);
    cmd.env_clear();
    for (k, v) in env {
        cmd.env(k, v);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        let text = e.to_string();
        if text.contains("No such file") || text.contains("not found") {
            format!(
                "Không thấy lệnh {} trên máy. Cài ở màn Môi trường.",
                spec.program
            )
        } else {
            format!("Không chạy được {}: {text}", spec.program)
        }
    })?;
    // Giữ đầu slave ở app thì đọc output không bao giờ hết khi CLI thoát.
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Không đọc được terminal: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Không ghi được vào terminal: {e}"))?;
    let session = Session {
        killer: child.clone_killer(),
        pid: child.process_id(),
        master: pair.master,
        writer,
    };
    Ok((session, reader, child))
}

#[derive(Default)]
pub struct Ptys(Mutex<HashMap<String, Session>>);

impl Ptys {
    /// Đóng cửa sổ hay thoát app: không để CLI chạy mồ côi.
    pub fn close_all(&self) {
        let sessions: Vec<Session> = match self.0.lock() {
            Ok(mut m) => m.drain().map(|(_, s)| s).collect(),
            Err(_) => return,
        };
        for s in sessions {
            s.kill();
        }
    }
}

static PTY_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone)]
struct Data {
    id: String,
    /// Byte thô mã base64: một ký tự UTF-8 có thể bị cắt giữa hai lần đọc, xterm.js tự ghép lại.
    data: String,
}

#[derive(Serialize, Clone)]
struct Exit {
    id: String,
    code: Option<u32>,
}

/// Mở terminal trong thư mục dự án, trả id; output đến qua `pty:data`, kết thúc bằng `pty:exit`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: AppHandle,
    cli: String,
    plan_id: Option<String>,
    bypass: Option<bool>,
    folder: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let home = home_dir();
    let cwd = project_folder(&folder, home.as_deref())?;
    let plan_id = plan_id.filter(|p| !p.trim().is_empty());
    let accounts = match &plan_id {
        Some(_) => {
            let Accounts { accounts } =
                crate::sidecar_json(&app, vec!["accounts".into(), "--json".into()], vec![]).await?;
            accounts
        }
        None => Vec::new(),
    };
    let spec = spawn_spec(
        &cli,
        plan_id.as_deref().map(|id| (accounts.as_slice(), id)),
        bypass.unwrap_or(false),
        home.as_deref(),
    )?;
    if app.state::<Ptys>().0.lock().map_or(0, |m| m.len()) >= MAX_OPEN {
        return Err(format!("Đã mở {MAX_OPEN} terminal. Đóng bớt rồi mở thêm."));
    }
    let env = term_env(std::env::vars_os(), user_path(), spec.env.as_ref());
    let (session, mut reader, mut child) = spawn(&spec, &cwd, env, cols, rows)?;
    let id = format!("pty-{}", PTY_SEQ.fetch_add(1, Ordering::Relaxed) + 1);
    app.state::<Ptys>()
        .0
        .lock()
        .map_err(|_| "Không ghi được terminal.")?
        .insert(id.clone(), session);

    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let (out_app, out_id) = (app.clone(), id.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // Chỉ cửa sổ app nghe; cửa sổ web của hub không nhận gì từ terminal của máy.
                    let _ = out_app.emit_to(
                        crate::APP,
                        DATA,
                        Data {
                            id: out_id.clone(),
                            data: base64::engine::general_purpose::STANDARD.encode(&buf[..n]),
                        },
                    );
                }
            }
        }
        let _ = done_tx.send(());
    });
    let exit_id = id.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        // Tiến trình cháu còn giữ terminal thì đầu đọc không hết: cho output cuối chút thời gian rồi báo thoát.
        let _ = done_rx.recv_timeout(Duration::from_millis(500));
        if let Some(s) = app
            .state::<Ptys>()
            .0
            .lock()
            .ok()
            .and_then(|mut m| m.remove(&exit_id))
        {
            s.kill();
        }
        let _ = app.emit_to(crate::APP, EXIT, Exit { id: exit_id, code });
    });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    if data.len() > MAX_WRITE {
        return Err("Dán quá dài cho một lần gõ.".into());
    }
    let state = app.state::<Ptys>();
    let mut map = state.0.lock().map_err(|_| "Không đọc được terminal.")?;
    let s = map.get_mut(&id).ok_or("Terminal đã đóng.")?;
    s.writer
        .write_all(data.as_bytes())
        .and_then(|_| s.writer.flush())
        .map_err(|e| format!("Không ghi được vào terminal: {e}"))
}

#[tauri::command]
pub fn pty_resize(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let state = app.state::<Ptys>();
    let map = state.0.lock().map_err(|_| "Không đọc được terminal.")?;
    if let Some(s) = map.get(&id) {
        s.master
            .resize(size(cols, rows))
            .map_err(|e| format!("Không đổi được cỡ terminal: {e}"))?;
    }
    Ok(())
}

/// Đóng tab terminal: giết CLI; `pty:exit` vẫn đến như khi CLI tự thoát.
#[tauri::command]
pub fn pty_close(app: AppHandle, id: String) -> Result<(), String> {
    let session = app
        .state::<Ptys>()
        .0
        .lock()
        .map_err(|_| "Không đọc được terminal.")?
        .remove(&id);
    if let Some(s) = session {
        s.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plans() -> Vec<Account> {
        let plan = |id: &str, cli: &str, dir: Option<&str>| Account {
            id: id.into(),
            cli: cli.into(),
            config_dir: dir.map(String::from),
        };
        vec![
            plan("claude-1", "claude", None),
            plan(
                "claude-2",
                "claude",
                Some("/Users/ha/.xdev-hive/accounts/claude-2"),
            ),
            plan("codex-2", "codex", Some("/opt/codex-2")),
            plan("antigravity-1", "antigravity", None),
        ]
    }

    #[test]
    fn spawn_uses_fixed_binaries_flags_and_plan_folders() {
        let list = plans();
        assert_eq!(
            spawn_spec("claude", None, false, None).unwrap(),
            Spawn {
                program: "claude".into(),
                args: vec![],
                env: None
            }
        );
        assert_eq!(
            spawn_spec("codex", None, true, None).unwrap().args,
            ["--dangerously-bypass-approvals-and-sandbox"]
        );
        let agy = spawn_spec("antigravity", Some((&list, "antigravity-1")), true, None).unwrap();
        assert_eq!(
            (agy.program.as_str(), agy.args),
            ("agy", vec!["--dangerously-skip-permissions".to_string()])
        );
        let claude = spawn_spec("claude", Some((&list, "claude-2")), false, None).unwrap();
        assert_eq!(
            claude.env,
            Some((
                "CLAUDE_CONFIG_DIR",
                "/Users/ha/.xdev-hive/accounts/claude-2".to_string()
            ))
        );
        let codex = spawn_spec("codex", Some((&list, "codex-2")), false, None).unwrap();
        assert_eq!(codex.env, Some(("CODEX_HOME", "/opt/codex-2".to_string())));
        // Gói của CLI khác, gói không có, CLI lạ, shell kèm cờ: từ chối.
        assert!(spawn_spec("codex", Some((&list, "claude-1")), false, None).is_err());
        assert!(spawn_spec("claude", Some((&list, "claude-9")), false, None).is_err());
        assert!(spawn_spec("/bin/sh", None, false, None).is_err());
        assert!(spawn_spec("gemini", None, false, None).is_err());
        assert!(spawn_spec("shell", None, true, None).is_err());
        assert!(spawn_spec("shell", Some((&list, "claude-1")), false, None).is_err());
        assert!(
            !spawn_spec("shell", None, false, None)
                .unwrap()
                .program
                .is_empty()
        );
    }

    #[test]
    fn terminal_env_keeps_allowlist_and_sets_term() {
        let vars = vec![
            (OsString::from("HOME"), OsString::from("/Users/ha")),
            (OsString::from("TERM"), OsString::from("dumb")),
            (
                OsString::from("HIVE_MACHINE_TOKEN"),
                OsString::from("hwm_x"),
            ),
            (OsString::from("CLAUDE_CONFIG_DIR"), OsString::from("/old")),
        ];
        let extra = ("CLAUDE_CONFIG_DIR", "/plan".to_string());
        let env = term_env(vars, "/usr/bin", Some(&extra));
        let get = |k: &str| {
            env.iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.to_string_lossy().into_owned())
        };
        assert_eq!(get("TERM").as_deref(), Some("xterm-256color"));
        assert_eq!(get("CLAUDE_CONFIG_DIR").as_deref(), Some("/plan"));
        assert_eq!(get("PATH").as_deref(), Some("/usr/bin"));
        assert_eq!(get("HIVE_MACHINE_TOKEN"), None);
        assert_eq!(env.iter().filter(|(k, _)| k == "TERM").count(), 1);
    }

    #[cfg(unix)]
    fn echo_spec(program: &str, args: &[&str]) -> Spawn {
        Spawn {
            program: program.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: None,
        }
    }

    #[cfg(unix)]
    #[test]
    fn runs_a_command_in_a_pty_and_reads_its_output() {
        let dir = std::env::temp_dir();
        let env = term_env(Vec::new(), "/usr/bin:/bin", None);
        let (session, mut reader, mut child) = spawn(
            &echo_spec("/bin/sh", &["-c", "printf 'xin chào %s' \"$TERM\"; pwd"]),
            &dir,
            env,
            80,
            24,
        )
        .unwrap();
        let mut out = Vec::new();
        let reading = std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                out.extend_from_slice(&buf[..n]);
            }
            out
        });
        assert_eq!(child.wait().unwrap().exit_code(), 0);
        // Đóng PTY để đầu đọc hết (macOS giữ đầu đọc tới khi master đóng).
        drop(session);
        let text = String::from_utf8_lossy(&reading.join().unwrap()).into_owned();
        assert!(text.contains("xin chào xterm-256color"), "{text}");
    }

    #[cfg(unix)]
    #[test]
    fn closing_kills_the_running_program() {
        let env = term_env(Vec::new(), "/usr/bin:/bin", None);
        let (session, _reader, mut child) = spawn(
            &echo_spec("/bin/sh", &["-c", "sleep 30"]),
            &std::env::temp_dir(),
            env,
            80,
            24,
        )
        .unwrap();
        let started = std::time::Instant::now();
        session.kill();
        let _ = child.wait();
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
