//! Nhánh Git của một dự án trên máy (specs/026-desktop-git-branches): xem, đổi, tạo, fetch, pull, quét và dọn nhánh
//! qua `hive-worker branches`. Hợp đồng ở `contracts/branches-cli.md`.
//!
//! Dòng đầu stdin là JSON đầu vào; job và `list` giữ stdin để gửi `cancel` và danh sách thư mục đang dùng mới. Sidecar
//! được chạy bằng `std::process` thay vì `CommandChild` của plugin shell vì lệnh một lần phải đóng được stdin mà vẫn
//! giết được tiến trình khi treo.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::agents::classify::{Cli, Source};
use crate::{sidecar_command, sidecar_json, sidecar_json_stdin};

/// Tiến độ của job và sự kiện `worktree` của `list`; chỉ cửa sổ app nghe.
const EVENT: &str = "git-branches:event";
const TOKENS_ENV: &str = "HIVE_GIT_TOKENS";
/// Cùng dịch vụ keychain với kết nối Git của spec 016.
const SERVICE: &str = "dev.xdev.hive.git";
/// Sidecar được thêm chừng này sau `--timeout` để tự dừng git và báo lỗi trước khi Rust giết nó.
const GRACE_SECS: u64 = 30;
const BUSY_EVERY: Duration = Duration::from_secs(5);
const STDERR_MAX: usize = 4000;
const PATH_MAX: usize = 4096;
const NAME_MAX: usize = 1000;
const FOLDERS_MAX: usize = 1000;

const STATUS_SECS: u64 = 15;
const LIST_SECS: u64 = 30;
const SWITCH_SECS: u64 = 60;
const CREATE_SECS: u64 = 150;
const FETCH_SECS: u64 = 120;
const PULL_SECS: u64 = 120;
const SCAN_SECS: u64 = 150;
const CLEAN_SECS: u64 = 300;
const SETTINGS_SECS: u64 = 15;
const OPERATION_SECS: u64 = 150;

/// Job và `list` đang chạy theo id, để huỷ và gửi lại thư mục đang dùng.
#[derive(Default)]
pub struct BranchJobs {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    /// Hai lượt dọn cùng lúc có thể cùng xoá một nhánh mà lượt kia vừa kiểm.
    cleaning: AtomicBool,
}

static JOB_SEQ: AtomicU64 = AtomicU64::new(0);

/// Sidecar đang chạy: giữ stdin để ghi dòng sau, giữ tiến trình để giết khi treo.
pub(crate) struct Job {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
}

impl Job {
    fn send(&self, line: &str) -> Result<(), String> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "Không ghi được vào worker.")?;
        if let Some(w) = stdin.as_mut() {
            w.write_all(line.as_bytes())
                .and_then(|_| w.write_all(b"\n"))
                .and_then(|_| w.flush())
                .map_err(|e| format!("Không ghi được vào worker: {e}"))?;
        }
        Ok(())
    }

    fn close_stdin(&self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }
    }

    fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

/// Kết thúc của một lần chạy sidecar.
#[derive(Debug)]
pub(crate) struct Outcome {
    /// Đã in sự kiện `done`.
    finished: bool,
    timed_out: bool,
    success: bool,
    stderr: String,
}

type OnEnd = Box<dyn FnOnce(Outcome) + Send>;

struct Watch {
    last: Mutex<Instant>,
    stderr: Mutex<String>,
    finished: AtomicBool,
    timed_out: AtomicBool,
    end: Mutex<Option<OnEnd>>,
}

impl Watch {
    fn ended(&self) -> bool {
        self.end.lock().map(|e| e.is_none()).unwrap_or(true)
    }

    /// Luồng đọc stdout và đồng hồ có thể cùng kết thúc lần chạy; chỉ lần gọi đầu có tác dụng.
    fn finish(&self, success: bool) {
        let Some(end) = self.end.lock().ok().and_then(|mut e| e.take()) else {
            return;
        };
        let stderr = self.stderr.lock().map(|s| s.clone()).unwrap_or_default();
        end(Outcome {
            finished: self.finished.load(Ordering::SeqCst),
            timed_out: self.timed_out.load(Ordering::SeqCst),
            success,
            stderr,
        });
    }
}

fn not_responding(wait: Duration) -> String {
    format!("Worker không phản hồi sau {} giây.", wait.as_secs())
}

fn stderr_message(stderr: &str) -> String {
    let msg = stderr.trim();
    if msg.is_empty() {
        "Worker báo lỗi mà không có chi tiết.".into()
    } else {
        msg.to_string()
    }
}

/// Chạy sidecar, ghi `first` làm dòng đầu stdin. Mỗi dòng stdout là JSON được đưa cho `on_line`; dòng không phải JSON
/// bị bỏ. Không có dòng nào trong `wait` thì giết tiến trình. `on_end` được gọi đúng một lần.
pub(crate) fn start(
    mut cmd: Command,
    first: &str,
    wait: Duration,
    keep_stdin: bool,
    mut on_line: impl FnMut(Value) + Send + 'static,
    on_end: impl FnOnce(Outcome) + Send + 'static,
) -> Result<Arc<Job>, String> {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Không chạy được worker: {e}"))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let job = Arc::new(Job {
        stdin: Mutex::new(stdin),
        child: Mutex::new(child),
    });
    // Sidecar thoát ngay vì cờ sai có thể đã đóng stdin: lỗi ghi ở đây không quan trọng, stderr sẽ cho biết lý do.
    let _ = job.send(first);
    if !keep_stdin {
        job.close_stdin();
    }
    let watch = Arc::new(Watch {
        last: Mutex::new(Instant::now()),
        stderr: Mutex::new(String::new()),
        finished: AtomicBool::new(false),
        timed_out: AtomicBool::new(false),
        end: Mutex::new(Some(Box::new(on_end))),
    });

    if let Some(mut err) = stderr {
        let watch = watch.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            // Đọc tới hết để sidecar không kẹt vì ống stderr đầy, chỉ giữ phần đầu.
            while let Ok(n) = err.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if let Ok(mut s) = watch.stderr.lock()
                    && s.len() < STDERR_MAX
                {
                    s.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if s.len() > STDERR_MAX {
                        let mut cut = STDERR_MAX;
                        while !s.is_char_boundary(cut) {
                            cut -= 1;
                        }
                        s.truncate(cut);
                    }
                }
            }
        });
    }

    {
        let watch = watch.clone();
        let job = job.clone();
        let tick = (wait / 10).clamp(Duration::from_millis(10), Duration::from_secs(1));
        std::thread::spawn(move || {
            while !watch.ended() {
                std::thread::sleep(tick);
                let idle = watch.last.lock().map(|l| l.elapsed()).unwrap_or_default();
                if idle > wait && !watch.ended() {
                    watch.timed_out.store(true, Ordering::SeqCst);
                    job.kill();
                    if let Ok(mut child) = job.child.lock() {
                        let _ = child.wait();
                    }
                    job.close_stdin();
                    // Không chờ luồng đọc stdout: tiến trình cháu còn giữ ống thì nó chưa hết được. Chỉ chờ chút cho
                    // stderr đọc nốt phần đã ghi.
                    std::thread::sleep(Duration::from_millis(20));
                    watch.finish(false);
                    break;
                }
            }
        });
    }

    let job_ = job.clone();
    std::thread::spawn(move || {
        if let Some(out) = stdout {
            for line in BufReader::new(out).split(b'\n') {
                let Ok(line) = line else { break };
                if let Ok(mut last) = watch.last.lock() {
                    *last = Instant::now();
                }
                if watch.ended() {
                    continue;
                }
                let text = String::from_utf8_lossy(&line);
                if let Ok(v) = serde_json::from_str::<Value>(text.trim()) {
                    if v["type"] == "done" {
                        watch.finished.store(true, Ordering::SeqCst);
                    }
                    on_line(v);
                }
            }
        }
        let success = loop {
            match job_.child.lock().map(|mut c| c.try_wait()) {
                Ok(Ok(Some(status))) => break status.success(),
                Ok(Ok(None)) => std::thread::sleep(Duration::from_millis(20)),
                _ => break false,
            }
        };
        job_.close_stdin();
        // Luồng stderr có thể còn đọc nốt vài byte cuối sau khi tiến trình thoát.
        std::thread::sleep(Duration::from_millis(20));
        watch.finish(success);
    });
    Ok(job)
}

enum Once {
    Line(Value),
    End(Outcome),
}

fn once_error(o: &Outcome, wait: Duration) -> String {
    if o.timed_out {
        not_responding(wait)
    } else if !o.success {
        stderr_message(&o.stderr)
    } else {
        "Worker không trả kết quả.".into()
    }
}

/// Lệnh một lần: ghi `input`, đóng stdin, đọc JSON đầu tiên. Kết quả có `error` vẫn là `Ok`; `Err` chỉ khi sidecar
/// thoát lỗi hay không trả lời trong `wait`. Chặn luồng: gọi trong `spawn_blocking`.
pub(crate) fn run_json(cmd: Command, input: &Value, wait: Duration) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel();
    let tx_end = tx.clone();
    start(
        cmd,
        &input.to_string(),
        wait,
        false,
        move |v| {
            let _ = tx.send(Once::Line(v));
        },
        move |o| {
            let _ = tx_end.send(Once::End(o));
        },
    )?;
    let mut result = None;
    loop {
        match rx.recv() {
            Ok(Once::Line(v)) => {
                result.get_or_insert(v);
            }
            Ok(Once::End(o)) => {
                return match result {
                    Some(v) if o.success && !o.timed_out => Ok(v),
                    _ => Err(once_error(&o, wait)),
                };
            }
            Err(_) => return Err("Worker dừng mà không trả kết quả.".into()),
        }
    }
}

fn wait_for(timeout: u64) -> Duration {
    Duration::from_secs(timeout + GRACE_SECS)
}

fn arg(key: &str, value: impl std::fmt::Display) -> String {
    // `--key=value` để giá trị bắt đầu bằng `-` (tên nhánh lạ) không bị đọc thành cờ.
    format!("--{key}={value}")
}

fn flag(args: &mut Vec<String>, key: &str, on: bool) {
    if on {
        args.push(format!("--{key}"));
    }
}

fn base(sub: &str) -> Vec<String> {
    vec!["branches".into(), sub.into()]
}

fn with_timeout(mut args: Vec<String>, secs: u64) -> Vec<String> {
    args.push(arg("timeout", secs));
    args
}

fn folder_arg(folder: &str) -> Result<String, String> {
    let f = folder.trim();
    if f.is_empty()
        || f.len() > PATH_MAX
        || f.chars().any(char::is_control)
        || !Path::new(f).is_absolute()
    {
        return Err("Thư mục không hợp lệ.".into());
    }
    Ok(arg("folder", f))
}

fn folders_args(folders: &[String]) -> Result<Vec<String>, String> {
    if folders.is_empty() {
        return Err("Chọn ít nhất một dự án.".into());
    }
    if folders.len() > FOLDERS_MAX {
        return Err("Quá nhiều dự án.".into());
    }
    folders.iter().map(|f| folder_arg(f)).collect()
}

/// Tên nhánh, ref: không rỗng, không ký tự điều khiển. Git tự kiểm phần còn lại (`check-ref-format`).
fn name_arg(key: &str, value: &str, what: &str) -> Result<String, String> {
    let v = value.trim();
    if v.is_empty() {
        return Err(format!("Thiếu {what}."));
    }
    if v.len() > NAME_MAX || v.chars().any(char::is_control) {
        return Err(format!("{} không hợp lệ.", capitalize(what)));
    }
    Ok(arg(key, v))
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_uppercase().chain(c).collect())
        .unwrap_or_default()
}

/// Mã commit đầy đủ (SHA-1 hay SHA-256): merge, rebase lên đúng mã người dùng đã xem.
fn sha_arg(key: &str, value: &str) -> Result<String, String> {
    let v = value.trim();
    if !matches!(v.len(), 40 | 64) || !v.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Mã commit không hợp lệ.".into());
    }
    Ok(arg(key, v.to_ascii_lowercase()))
}

pub fn status_args(folders: &[String]) -> Result<Vec<String>, String> {
    let mut v = base("status");
    v.extend(folders_args(folders)?);
    Ok(with_timeout(v, STATUS_SECS))
}

fn folder_only(sub: &str, folder: &str, secs: u64) -> Result<Vec<String>, String> {
    let mut v = base(sub);
    v.push(folder_arg(folder)?);
    Ok(with_timeout(v, secs))
}

pub fn switch_args(
    folder: &str,
    branch: Option<&str>,
    track: Option<&str>,
    carry: bool,
    confirm_busy: bool,
) -> Result<Vec<String>, String> {
    let mut v = base("switch");
    v.push(folder_arg(folder)?);
    match (branch, track) {
        (Some(b), None) => v.push(name_arg("branch", b, "tên nhánh")?),
        (None, Some(t)) => v.push(name_arg("track", t, "nhánh remote")?),
        _ => return Err("Chọn một nhánh để chuyển sang.".into()),
    }
    flag(&mut v, "carry", carry);
    flag(&mut v, "confirm-busy", confirm_busy);
    Ok(with_timeout(v, SWITCH_SECS))
}

#[allow(clippy::too_many_arguments)]
pub fn create_args(
    folder: &str,
    name: &str,
    base_ref: &str,
    switch_to: bool,
    fetch: bool,
    carry: bool,
    confirm_busy: bool,
    dry_run: bool,
) -> Result<Vec<String>, String> {
    let mut v = base("create");
    v.push(folder_arg(folder)?);
    v.push(name_arg("name", name, "tên nhánh")?);
    v.push(name_arg("base", base_ref, "nhánh gốc")?);
    flag(&mut v, "switch", switch_to);
    flag(&mut v, "fetch", fetch);
    flag(&mut v, "carry", carry);
    flag(&mut v, "confirm-busy", confirm_busy);
    flag(&mut v, "dry-run", dry_run);
    Ok(with_timeout(v, CREATE_SECS))
}

pub fn pull_args(folder: &str, confirm_busy: bool) -> Result<Vec<String>, String> {
    let mut v = base("pull");
    v.push(folder_arg(folder)?);
    flag(&mut v, "confirm-busy", confirm_busy);
    Ok(with_timeout(v, PULL_SECS))
}

pub fn scan_args(folders: &[String], fetch: bool) -> Result<Vec<String>, String> {
    let mut v = base("scan");
    v.extend(folders_args(folders)?);
    flag(&mut v, "no-fetch", !fetch);
    Ok(with_timeout(v, SCAN_SECS))
}

pub fn merge_args(
    folder: &str,
    onto: &str,
    onto_name: &str,
    ff: bool,
    confirm_busy: bool,
) -> Result<Vec<String>, String> {
    let mut v = base("merge");
    v.push(folder_arg(folder)?);
    v.push(sha_arg("onto", onto)?);
    v.push(name_arg("onto-name", onto_name, "nhánh đích")?);
    flag(&mut v, "ff", ff);
    flag(&mut v, "confirm-busy", confirm_busy);
    Ok(with_timeout(v, OPERATION_SECS))
}

pub fn rebase_args(
    folder: &str,
    onto: &str,
    onto_name: &str,
    confirm_rewrite: bool,
    confirm_busy: bool,
) -> Result<Vec<String>, String> {
    let mut v = base("rebase");
    v.push(folder_arg(folder)?);
    v.push(sha_arg("onto", onto)?);
    v.push(name_arg("onto-name", onto_name, "nhánh đích")?);
    flag(&mut v, "confirm-rewrite", confirm_rewrite);
    flag(&mut v, "confirm-busy", confirm_busy);
    Ok(with_timeout(v, OPERATION_SECS))
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct BusyDir {
    path: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

/// Agent thấy trên máy, phần cần cho danh sách thư mục đang dùng.
pub(crate) struct AgentDir {
    cwd: String,
    cli: Cli,
    pid: u32,
    /// Agent của lượt chạy do worker mở: nằm trong worktree dưới `DataDir()`, sidecar tự đánh dấu `hiveWorker`.
    worker_run: bool,
}

fn cli_name(cli: Cli) -> &'static str {
    match cli {
        Cli::Claude => "claude",
        Cli::Codex => "codex",
        Cli::Antigravity => "antigravity",
    }
}

pub(crate) fn busy_list(terminals: &[(String, PathBuf)], agents: &[AgentDir]) -> Vec<BusyDir> {
    let mut out: Vec<BusyDir> = Vec::new();
    for a in agents.iter().filter(|a| !a.worker_run && !a.cwd.is_empty()) {
        out.push(BusyDir {
            path: a.cwd.clone(),
            kind: "agent",
            label: Some(format!("{} (pid {})", cli_name(a.cli), a.pid)),
        });
    }
    for (_, folder) in terminals {
        let path = folder.to_string_lossy().into_owned();
        if !out.iter().any(|b| b.kind == "terminal" && b.path == path) {
            out.push(BusyDir {
                path,
                kind: "terminal",
                label: None,
            });
        }
    }
    out
}

/// Thư mục đang có agent (spec 021) hay terminal của app. Đọc tiến trình lỗi thì chỉ còn terminal: sidecar vẫn chặn
/// được phần nó tự biết (worktree của worker).
async fn busy_dirs(app: &AppHandle) -> Vec<BusyDir> {
    let terminals = app.state::<crate::pty::Ptys>().folders();
    let agents: Vec<AgentDir> = crate::agents::machine_agents(app.clone())
        .await
        .map(|scan| {
            scan.agents
                .into_iter()
                .filter_map(|a| {
                    Some(AgentDir {
                        cwd: a.cwd?,
                        cli: a.cli,
                        pid: a.pid,
                        worker_run: matches!(a.source, Source::Run { .. }),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    busy_list(&terminals, &agents)
}

async fn busy_input(app: &AppHandle) -> Value {
    json!({ "busy": busy_dirs(app).await })
}

/// Host của URL remote: `https://…`, `ssh://…` hay dạng scp `git@host:đường/dẫn`. Viết thường để so.
fn remote_host(remote: &str) -> Option<String> {
    let remote = remote.trim();
    if let Ok(url) = url::Url::parse(remote)
        && let Some(host) = url.host_str().filter(|h| !h.is_empty())
    {
        return Some(host.to_ascii_lowercase());
    }
    let (user_host, _) = remote.split_once(':')?;
    if user_host.contains('/') {
        return None;
    }
    let host = user_host.rsplit('@').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Kết nối Git tại máy (`gitgroups --json`) có host trùng host của một origin. Chỉ so host, không so cổng: origin SSH
/// và kết nối HTTPS của cùng máy chủ khác cổng.
pub(crate) fn matching_hosts<'a>(hosts: &'a Value, origins: &[String]) -> Vec<&'a Value> {
    let wanted: Vec<String> = origins.iter().filter_map(|o| remote_host(o)).collect();
    hosts
        .as_array()
        .into_iter()
        .flatten()
        .filter(|h| {
            h["id"].as_str().is_some_and(|id| !id.is_empty())
                && h["url"]
                    .as_str()
                    .and_then(remote_host)
                    .is_some_and(|host| wanted.contains(&host))
        })
        .collect()
}

/// Origin của từng thư mục quét: lấy từ danh sách dự án của worker (đã bỏ thông tin đăng nhập). Thư mục không có trong
/// danh sách thì không có token: quét vẫn chạy với bằng chứng git.
fn origins_of(projects: &Value, folders: &[String]) -> Vec<String> {
    projects["projects"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| {
            p["folder"]
                .as_str()
                .is_some_and(|f| folders.iter().any(|x| same_folder(x, f)))
        })
        .filter_map(|p| p["origin"].as_str().map(String::from))
        .collect()
}

fn same_folder(a: &str, b: &str) -> bool {
    let a = a.trim().trim_end_matches(['/', '\\']);
    let b = b.trim().trim_end_matches(['/', '\\']);
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Token cho bằng chứng từ GitHub/GitLab (FR-030), như `git_group_sync`. Thiếu token hay lỗi helper thì bỏ qua host đó:
/// sidecar dùng bằng chứng git.
async fn scan_tokens(app: &AppHandle, folders: &[String]) -> Vec<(&'static str, String)> {
    let projects: Value = sidecar_json(app, vec!["projects".into(), "--json".into()], vec![])
        .await
        .unwrap_or(Value::Null);
    let origins = origins_of(&projects, folders);
    if origins.is_empty() {
        return vec![];
    }
    let view: Value = sidecar_json(app, vec!["gitgroups".into(), "--json".into()], vec![])
        .await
        .unwrap_or(Value::Null);
    let mut tokens = serde_json::Map::new();
    for h in matching_hosts(&view["hosts"], &origins) {
        let id = h["id"].as_str().unwrap_or_default();
        let token = if h["authMode"] == "git" {
            crate::git_credentials::credential(
                h["kind"].as_str().unwrap_or(""),
                h["url"].as_str().unwrap_or(""),
            )
            .await
            .ok()
        } else {
            keyring::Entry::new(SERVICE, id)
                .ok()
                .and_then(|e| e.get_password().ok())
        };
        if let Some(t) = token {
            tokens.insert(id.to_string(), Value::String(t));
        }
    }
    if tokens.is_empty() {
        vec![]
    } else {
        vec![(TOKENS_ENV, Value::Object(tokens).to_string())]
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    job_id: String,
    event: Value,
}

fn emit(app: &AppHandle, job_id: &str, event: Value) {
    let _ = app.emit_to(
        crate::APP,
        EVENT,
        Envelope {
            job_id: job_id.to_string(),
            event,
        },
    );
}

fn next_id() -> String {
    format!("branches-{}", JOB_SEQ.fetch_add(1, Ordering::Relaxed) + 1)
}

fn job(app: &AppHandle, id: &str) -> Option<Arc<Job>> {
    app.state::<BranchJobs>()
        .jobs
        .lock()
        .ok()
        .and_then(|jobs| jobs.get(id).cloned())
}

fn forget(app: &AppHandle, id: &str) {
    if let Ok(mut jobs) = app.state::<BranchJobs>().jobs.lock() {
        jobs.remove(id);
    }
}

/// Giữ khoá trong lúc chạy: sidecar thoát ngay thì `forget` ở luồng khác chờ tới khi mục đã vào bảng rồi mới gỡ.
fn register(
    app: &AppHandle,
    id: &str,
    run: impl FnOnce() -> Result<Arc<Job>, String>,
) -> Result<(), String> {
    let jobs = app.state::<BranchJobs>();
    let mut map = jobs.jobs.lock().map_err(|_| "Không ghi được thao tác.")?;
    map.insert(id.to_string(), run()?);
    Ok(())
}

/// Gửi lại thư mục đang dùng tới khi job xong: agent mở hay đóng giữa chừng vẫn được kiểm ở bước sau.
fn refresh_busy(app: &AppHandle, id: &str) {
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(BUSY_EVERY).await;
            if job(&app, &id).is_none() {
                break;
            }
            let line = busy_input(&app).await.to_string();
            match job(&app, &id) {
                Some(j) => {
                    let _ = j.send(&line);
                }
                None => break,
            }
        }
    });
}

/// Job: trả id ngay; mỗi dòng stdout thành một `git-branches:event`. Sidecar dừng mà không in `done` thì phát `exit`.
async fn start_job(
    app: &AppHandle,
    args: Vec<String>,
    env: Vec<(&str, String)>,
    input: Value,
    timeout: u64,
    busy: bool,
    on_done: impl FnOnce() + Send + 'static,
) -> Result<String, String> {
    let cmd = sidecar_command(app, args, env).await?;
    let id = next_id();
    let wait = wait_for(timeout);
    let (line_app, line_id) = (app.clone(), id.clone());
    let (end_app, end_id) = (app.clone(), id.clone());
    register(app, &id, || {
        start(
            cmd,
            &input.to_string(),
            wait,
            true,
            move |v| emit(&line_app, &line_id, v),
            move |o| {
                forget(&end_app, &end_id);
                on_done();
                if !o.finished {
                    let message = if o.timed_out {
                        not_responding(wait)
                    } else {
                        stderr_message(&o.stderr)
                    };
                    emit(
                        &end_app,
                        &end_id,
                        json!({ "type": "exit", "message": message }),
                    );
                }
            },
        )
    })?;
    if busy {
        refresh_busy(app, &id);
    }
    Ok(id)
}

/// Trạng thái nhanh của nhiều repo cho cột nhánh ở màn Dự án; không gọi mạng.
#[tauri::command]
pub async fn git_branches_status(app: AppHandle, folders: Vec<String>) -> Result<Value, String> {
    sidecar_json_stdin(
        &app,
        status_args(&folders)?,
        vec![],
        json!({}),
        wait_for(STATUS_SECS),
    )
    .await
}

/// Nhánh, remote và worktree của một repo. Trả dòng đầu kèm `jobId`; trạng thái từng worktree đến sau qua
/// `git-branches:event` (`worktree`, rồi `done`).
#[tauri::command]
pub async fn git_branches_list(app: AppHandle, folder: String) -> Result<Value, String> {
    let args = folder_only("list", &folder, LIST_SECS)?;
    let input = busy_input(&app).await;
    let cmd = sidecar_command(&app, args, vec![]).await?;
    let id = next_id();
    let wait = wait_for(LIST_SECS);
    let (tx, rx) = mpsc::channel::<Result<Value, String>>();
    let tx_end = tx.clone();
    let got_first = Arc::new(AtomicBool::new(false));
    let first_seen = got_first.clone();
    let mut first = Some(tx);
    let (line_app, line_id) = (app.clone(), id.clone());
    let (end_app, end_id) = (app.clone(), id.clone());
    register(&app, &id, || {
        start(
            cmd,
            &input.to_string(),
            wait,
            true,
            move |v| match first.take() {
                Some(tx) => {
                    first_seen.store(true, Ordering::SeqCst);
                    let _ = tx.send(Ok(v));
                }
                None => emit(&line_app, &line_id, v),
            },
            move |o| {
                forget(&end_app, &end_id);
                if !got_first.load(Ordering::SeqCst) {
                    let _ = tx_end.send(Err(once_error(&o, wait)));
                } else if !o.finished {
                    let message = if o.timed_out {
                        not_responding(wait)
                    } else {
                        stderr_message(&o.stderr)
                    };
                    emit(
                        &end_app,
                        &end_id,
                        json!({ "type": "exit", "message": message }),
                    );
                }
            },
        )
    })?;
    let first = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "Worker dừng mà không trả kết quả.".to_string())??;
    refresh_busy(&app, &id);
    let mut result = first;
    match result.as_object_mut() {
        Some(obj) => {
            obj.insert("jobId".into(), Value::String(id));
        }
        None => return Err("Không đọc được kết quả của worker.".into()),
    }
    Ok(result)
}

#[tauri::command]
pub async fn git_branches_switch(
    app: AppHandle,
    folder: String,
    branch: Option<String>,
    track: Option<String>,
    carry: bool,
    confirm_busy: bool,
) -> Result<Value, String> {
    let args = switch_args(
        &folder,
        branch.as_deref(),
        track.as_deref(),
        carry,
        confirm_busy,
    )?;
    let input = busy_input(&app).await;
    sidecar_json_stdin(&app, args, vec![], input, wait_for(SWITCH_SECS)).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn git_branches_create(
    app: AppHandle,
    folder: String,
    name: String,
    base: String,
    switch_to: bool,
    fetch: bool,
    carry: bool,
    confirm_busy: bool,
    dry_run: bool,
) -> Result<Value, String> {
    let args = create_args(
        &folder,
        &name,
        &base,
        switch_to,
        fetch,
        carry,
        confirm_busy,
        dry_run,
    )?;
    let input = busy_input(&app).await;
    sidecar_json_stdin(&app, args, vec![], input, wait_for(CREATE_SECS)).await
}

/// Fetch mọi remote của repo bằng credential của máy; không truyền token.
#[tauri::command]
pub async fn git_branches_fetch(app: AppHandle, folder: String) -> Result<String, String> {
    let args = folder_only("fetch", &folder, FETCH_SECS)?;
    start_job(&app, args, vec![], json!({}), FETCH_SECS, false, || {}).await
}

#[tauri::command]
pub async fn git_branches_pull(
    app: AppHandle,
    folder: String,
    confirm_busy: bool,
) -> Result<String, String> {
    let args = pull_args(&folder, confirm_busy)?;
    let input = busy_input(&app).await;
    start_job(&app, args, vec![], input, PULL_SECS, true, || {}).await
}

/// Quét ứng viên dọn. Token chỉ cho host trùng origin của các repo quét (FR-030).
#[tauri::command]
pub async fn git_branches_scan(
    app: AppHandle,
    folders: Vec<String>,
    fetch: bool,
) -> Result<String, String> {
    let args = scan_args(&folders, fetch)?;
    let env = scan_tokens(&app, &folders).await;
    let input = busy_input(&app).await;
    start_job(&app, args, env, input, SCAN_SECS, true, || {}).await
}

/// Dọn các mục người dùng chọn. Một lượt dọn cùng lúc.
#[tauri::command]
pub async fn git_branches_clean(
    app: AppHandle,
    items: Vec<Value>,
    fetched: HashMap<String, Vec<String>>,
) -> Result<String, String> {
    if items.is_empty() {
        return Err("Chọn ít nhất một nhánh để dọn.".into());
    }
    let state = app.state::<BranchJobs>();
    if state
        .cleaning
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Đang dọn nhánh.".into());
    }
    let mut input = busy_input(&app).await;
    input["items"] = Value::Array(items);
    input["fetched"] = json!(fetched);
    let done_app = app.clone();
    let started = start_job(
        &app,
        with_timeout(base("clean"), CLEAN_SECS),
        vec![],
        input,
        CLEAN_SECS,
        true,
        move || {
            done_app
                .state::<BranchJobs>()
                .cleaning
                .store(false, Ordering::SeqCst);
        },
    )
    .await;
    if started.is_err() {
        state.cleaning.store(false, Ordering::SeqCst);
    }
    started
}

/// Huỷ job hay `list`: sidecar dừng lệnh đọc, mạng ngay; lệnh ghi đang chạy chạy hết.
#[tauri::command]
pub fn git_branches_cancel(app: AppHandle, job_id: String) -> Result<(), String> {
    match job(&app, &job_id) {
        Some(j) => j.send("cancel").map_err(|e| format!("Không huỷ được: {e}")),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn git_branches_settings(app: AppHandle) -> Result<Value, String> {
    let args = with_timeout(base("settings"), SETTINGS_SECS);
    sidecar_json_stdin(&app, args, vec![], json!({}), wait_for(SETTINGS_SECS)).await
}

#[tauri::command]
pub async fn git_branches_settings_set(app: AppHandle, settings: Value) -> Result<Value, String> {
    if !settings.is_object() {
        return Err("Cài đặt không hợp lệ.".into());
    }
    let args = with_timeout(base("settings-set"), SETTINGS_SECS);
    let input = json!({ "settings": settings });
    sidecar_json_stdin(&app, args, vec![], input, wait_for(SETTINGS_SECS)).await
}

#[tauri::command]
pub async fn git_branches_merge(
    app: AppHandle,
    folder: String,
    onto: String,
    onto_name: String,
    ff: bool,
    confirm_busy: bool,
) -> Result<Value, String> {
    let args = merge_args(&folder, &onto, &onto_name, ff, confirm_busy)?;
    let input = busy_input(&app).await;
    sidecar_json_stdin(&app, args, vec![], input, wait_for(OPERATION_SECS)).await
}

#[tauri::command]
pub async fn git_branches_rebase(
    app: AppHandle,
    folder: String,
    onto: String,
    onto_name: String,
    confirm_rewrite: bool,
    confirm_busy: bool,
) -> Result<Value, String> {
    let args = rebase_args(&folder, &onto, &onto_name, confirm_rewrite, confirm_busy)?;
    let input = busy_input(&app).await;
    sidecar_json_stdin(&app, args, vec![], input, wait_for(OPERATION_SECS)).await
}

#[tauri::command]
pub async fn git_branches_continue(app: AppHandle, folder: String) -> Result<Value, String> {
    let args = folder_only("continue", &folder, OPERATION_SECS)?;
    let input = busy_input(&app).await;
    sidecar_json_stdin(&app, args, vec![], input, wait_for(OPERATION_SECS)).await
}

#[tauri::command]
pub async fn git_branches_abort(app: AppHandle, folder: String) -> Result<Value, String> {
    let args = folder_only("abort", &folder, OPERATION_SECS)?;
    let input = busy_input(&app).await;
    sidecar_json_stdin(&app, args, vec![], input, wait_for(OPERATION_SECS)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn abs(p: &str) -> String {
        if cfg!(windows) {
            format!("C:\\{}", p.replace('/', "\\"))
        } else {
            format!("/{p}")
        }
    }

    #[test]
    fn builds_flags_with_equals_and_always_passes_timeout() {
        let shop = abs("code/shop");
        assert_eq!(
            status_args(&[shop.clone(), abs("code/api")]).unwrap(),
            vec![
                "branches".to_string(),
                "status".into(),
                format!("--folder={shop}"),
                format!("--folder={}", abs("code/api")),
                "--timeout=15".into(),
            ]
        );
        assert_eq!(
            switch_args(&shop, None, Some("origin/feature/x"), true, false).unwrap(),
            vec![
                "branches".to_string(),
                "switch".into(),
                format!("--folder={shop}"),
                "--track=origin/feature/x".into(),
                "--carry".into(),
                "--timeout=60".into(),
            ]
        );
        // Tên bắt đầu bằng `-` đi trong giá trị cờ, không thành cờ.
        let create =
            create_args(&shop, "-x", "origin/main", true, true, false, true, true).unwrap();
        assert_eq!(
            &create[2..],
            &[
                format!("--folder={shop}"),
                "--name=-x".into(),
                "--base=origin/main".into(),
                "--switch".into(),
                "--fetch".into(),
                "--confirm-busy".into(),
                "--dry-run".into(),
                "--timeout=150".into(),
            ]
        );
        assert_eq!(
            scan_args(std::slice::from_ref(&shop), false)
                .unwrap()
                .last()
                .unwrap(),
            "--timeout=150"
        );
        assert!(
            scan_args(std::slice::from_ref(&shop), false)
                .unwrap()
                .contains(&"--no-fetch".into())
        );
        assert!(
            !scan_args(std::slice::from_ref(&shop), true)
                .unwrap()
                .contains(&"--no-fetch".into())
        );
        assert_eq!(
            pull_args(&shop, true).unwrap()[2..],
            [
                format!("--folder={shop}"),
                "--confirm-busy".into(),
                "--timeout=120".into()
            ]
        );
        let sha = "A".repeat(40);
        assert_eq!(
            merge_args(&shop, &sha, "origin/main", true, false).unwrap()[3..],
            [
                format!("--onto={}", "a".repeat(40)),
                "--onto-name=origin/main".into(),
                "--ff".into(),
                "--timeout=150".into(),
            ]
        );
        assert!(
            rebase_args(&shop, &"b".repeat(64), "origin/main", true, true)
                .unwrap()
                .contains(&"--confirm-rewrite".into())
        );
    }

    #[test]
    fn rejects_bad_arguments_before_running_the_worker() {
        let shop = abs("code/shop");
        assert!(status_args(&[]).is_err());
        assert!(
            status_args(&["code/shop".into()]).is_err(),
            "đường dẫn tương đối"
        );
        assert!(status_args(&[format!("{shop}\n--x")]).is_err());
        assert!(switch_args(&shop, None, None, false, false).is_err());
        assert!(switch_args(&shop, Some("a"), Some("origin/a"), false, false).is_err());
        assert!(switch_args(&shop, Some("  "), None, false, false).is_err());
        assert!(create_args(&shop, "a\u{7}b", "main", false, false, false, false, false).is_err());
        assert!(merge_args(&shop, "main", "origin/main", false, false).is_err());
        assert!(merge_args(&shop, &"g".repeat(40), "origin/main", false, false).is_err());
        assert!(rebase_args(&shop, &"a".repeat(41), "origin/main", false, false).is_err());
    }

    #[test]
    fn busy_list_has_agents_and_terminals_but_not_worker_runs() {
        let terminals = vec![
            ("pty-1".to_string(), PathBuf::from(abs("code/shop"))),
            ("pty-2".to_string(), PathBuf::from(abs("code/shop"))),
        ];
        let agents = vec![
            AgentDir {
                cwd: abs("code/shop/.claude/worktrees/a"),
                cli: Cli::Claude,
                pid: 4242,
                worker_run: false,
            },
            AgentDir {
                cwd: abs("data/worktrees/run-1"),
                cli: Cli::Codex,
                pid: 7,
                worker_run: true,
            },
        ];
        let list = busy_list(&terminals, &agents);
        assert_eq!(
            serde_json::to_value(&list).unwrap(),
            json!([
                {"path": abs("code/shop/.claude/worktrees/a"), "kind": "agent", "label": "claude (pid 4242)"},
                {"path": abs("code/shop"), "kind": "terminal"},
            ])
        );
    }

    #[test]
    fn tokens_only_for_connections_on_the_origin_host() {
        let hosts = json!([
            {"id": "aaaaaaaaaaaa", "kind": "gitlab", "url": "https://GitLab.example.invalid", "authMode": "token"},
            {"id": "bbbbbbbbbbbb", "kind": "github", "url": "https://github.com", "authMode": "git"},
            {"id": "cccccccccccc", "kind": "gitlab", "url": "https://192.0.2.10:8443", "authMode": "token"},
            {"id": "", "kind": "gitlab", "url": "https://other.example.invalid"},
        ]);
        let ids = |origins: &[&str]| -> Vec<String> {
            let origins: Vec<String> = origins.iter().map(|s| s.to_string()).collect();
            matching_hosts(&hosts, &origins)
                .iter()
                .map(|h| h["id"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(
            ids(&["git@gitlab.example.invalid:team/shop.git"]),
            ["aaaaaaaaaaaa"]
        );
        assert_eq!(
            ids(&["ssh://git@192.0.2.10:2222/team/api.git"]),
            ["cccccccccccc"]
        );
        assert_eq!(
            ids(&[
                "https://github.com/acme/app.git",
                "https://gitlab.example.invalid/x/y"
            ]),
            ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]
        );
        assert!(ids(&["https://other.example.invalid/x.git"]).is_empty());
        assert!(ids(&["/srv/git/local.git", "../relative"]).is_empty());
        assert!(ids(&[]).is_empty());
    }

    #[test]
    fn origins_come_only_from_scanned_folders() {
        let shop = abs("code/shop");
        let projects = json!({"projects": [
            {"folder": shop, "origin": "https://gitlab.example.invalid/team/shop.git"},
            {"folder": abs("code/api"), "origin": "https://github.com/acme/api.git"},
            {"folder": abs("code/none")},
        ]});
        assert_eq!(
            origins_of(&projects, &[format!("{shop}/"), abs("code/none")]),
            ["https://gitlab.example.invalid/team/shop.git"]
        );
        assert!(origins_of(&Value::Null, &[shop]).is_empty());
    }

    #[cfg(unix)]
    mod fake_sidecar {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        /// Sidecar giả là một script sh nhỏ trong thư mục tạm.
        fn script(name: &str, body: &str) -> Command {
            let dir =
                std::env::temp_dir().join(format!("hive-branches-{}-{name}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("hive-worker");
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            Command::new(path)
        }

        #[test]
        fn one_shot_writes_the_first_line_closes_stdin_and_reads_json() {
            // `cat` chỉ hết khi stdin đã đóng.
            let cmd = script(
                "once",
                r#"read line; cat >/dev/null; printf 'noise\n{"got":%s}\n' "$line""#,
            );
            let input = json!({"busy": [{"path": "/x", "kind": "agent"}]});
            let v = run_json(cmd, &input, Duration::from_secs(10)).unwrap();
            assert_eq!(v, json!({"got": input}));
        }

        #[test]
        fn business_errors_are_results_and_exit_codes_are_errors() {
            let cmd = script(
                "error",
                r#"echo '{"error":{"code":"dirty","message":"Bẩn"}}'"#,
            );
            let v = run_json(cmd, &json!({}), Duration::from_secs(10)).unwrap();
            assert_eq!(v["error"]["code"], "dirty");

            let cmd = script("exit2", "echo 'thiếu cờ --folder' >&2; exit 2");
            assert_eq!(
                run_json(cmd, &json!({}), Duration::from_secs(10)).unwrap_err(),
                "thiếu cờ --folder"
            );
            let cmd = script("panic", "echo '{\"partial\":true}'; exit 3");
            assert_eq!(
                run_json(cmd, &json!({}), Duration::from_secs(10)).unwrap_err(),
                "Worker báo lỗi mà không có chi tiết."
            );
        }

        #[test]
        fn one_shot_that_hangs_is_killed_after_the_wait() {
            let cmd = script("hang", "exec sleep 30");
            let started = Instant::now();
            let err = run_json(cmd, &json!({}), Duration::from_millis(300)).unwrap_err();
            assert_eq!(err, "Worker không phản hồi sau 0 giây.");
            assert!(started.elapsed() < Duration::from_secs(5));
        }

        fn collect(
            cmd: Command,
            wait: Duration,
        ) -> (Arc<Job>, mpsc::Receiver<Value>, mpsc::Receiver<Outcome>) {
            let (tx, lines) = mpsc::channel();
            let (end_tx, end) = mpsc::channel();
            let job = start(
                cmd,
                "{}",
                wait,
                true,
                move |v| {
                    let _ = tx.send(v);
                },
                move |o| {
                    let _ = end_tx.send(o);
                },
            )
            .unwrap();
            (job, lines, end)
        }

        #[test]
        fn job_streams_events_and_stops_on_cancel() {
            let cmd = script(
                "cancel",
                r#"read first
echo '{"type":"progress","done":0}'
while read line; do
  case "$line" in
    cancel) echo '{"type":"done","cancelled":true}'; exit 0 ;;
    *) printf '{"type":"seen","line":%s}\n' "$line" ;;
  esac
done"#,
            );
            let (job, lines, end) = collect(cmd, Duration::from_secs(10));
            let t = Duration::from_secs(5);
            assert_eq!(lines.recv_timeout(t).unwrap()["type"], "progress");
            job.send(r#"{"busy":[]}"#).unwrap();
            assert_eq!(lines.recv_timeout(t).unwrap()["line"], json!({"busy": []}));
            job.send("cancel").unwrap();
            assert_eq!(lines.recv_timeout(t).unwrap()["cancelled"], true);
            let o = end.recv_timeout(t).unwrap();
            assert!(o.finished && o.success && !o.timed_out, "{o:?}");
        }

        #[test]
        fn job_timer_restarts_on_each_line_and_kills_a_silent_job() {
            // Mỗi dòng cách nhau ngắn hơn giới hạn: không bị giết dù cả job dài hơn giới hạn.
            let cmd = script(
                "steady",
                r#"for i in 1 2 3 4 5 6; do echo '{"type":"progress"}'; sleep 0.2; done; echo '{"type":"done"}'"#,
            );
            let (_job, lines, end) = collect(cmd, Duration::from_secs(1));
            let o = end.recv_timeout(Duration::from_secs(10)).unwrap();
            assert!(o.finished && !o.timed_out, "{o:?}");
            assert_eq!(lines.try_iter().count(), 7);

            let cmd = script(
                "silent",
                r#"echo '{"type":"progress"}'; echo 'git: lỗi' >&2; exec sleep 30"#,
            );
            let started = Instant::now();
            // Đủ rộng để sh kịp in trước khi bị giết khi máy đang bận.
            let (_job, lines, end) = collect(cmd, Duration::from_secs(1));
            let o = end.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(o.timed_out && !o.finished && !o.success, "{o:?}");
            assert_eq!(o.stderr.trim(), "git: lỗi");
            assert_eq!(lines.try_iter().count(), 1);
            assert!(started.elapsed() < Duration::from_secs(5));
        }

        #[test]
        fn job_that_dies_without_done_reports_stderr() {
            let cmd = script(
                "die",
                r#"echo '{"type":"progress"}'; echo 'panic: boom' >&2; exit 1"#,
            );
            let (_job, _lines, end) = collect(cmd, Duration::from_secs(10));
            let o = end.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(!o.finished && !o.success && !o.timed_out, "{o:?}");
            assert_eq!(stderr_message(&o.stderr), "panic: boom");
        }

        #[test]
        fn missing_sidecar_is_an_error() {
            let cmd = Command::new(std::env::temp_dir().join("hive-branches-missing/hive-worker"));
            assert!(
                run_json(cmd, &json!({}), Duration::from_secs(1))
                    .unwrap_err()
                    .starts_with("Không chạy được worker")
            );
        }
    }
}
