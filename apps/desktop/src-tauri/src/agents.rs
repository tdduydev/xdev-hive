//! Màn Agent trên máy (spec 021): mọi tiến trình Claude Code, Codex, Antigravity đang chạy trên máy, ai mở cũng thấy.
//!
//! Đọc tiến trình bằng sysinfo: một API cho Windows, macOS, Linux, kể cả thư mục làm việc và môi trường của tiến trình
//! khác. Môi trường lọc ngay khi đọc, chỉ giữ ba biến; dòng lệnh chỉ dùng để nhận CLI và cờ, không trả về giao diện.
//! Mọi thứ ở đây chỉ về cửa sổ app, không gửi hub.

pub(crate) mod activity;
pub(crate) mod classify;
pub(crate) mod feed;

use activity::Activity;
use classify::{Cli, Context, HiveSession, Proc, Row, Source};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System, UpdateKind};
use tauri::{AppHandle, Manager};

/// Biến môi trường được giữ lại: thư mục đăng nhập của gói và mã dự án của Hive run. Token và biến khác bỏ ngay.
const ENV_KEYS: [&str; 3] = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "HIVE_PROJECT"];
/// `hive ls` chạy một tiến trình con: không gọi mỗi 3 giây.
const HIVE_TTL: Duration = Duration::from_secs(10);
/// Đọc file phiên của một agent tối đa mỗi ngần này.
const ACTIVITY_TTL: Duration = Duration::from_secs(5);
const STOP_GRACE: Duration = Duration::from_secs(5);

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub pid: u32,
    pub cli: Cli,
    pub background: bool,
    pub bypass: bool,
    /// Giây kể từ epoch; cùng pid gửi lại khi dừng để Rust nhận ra pid đã bị dùng lại.
    pub started_at: u64,
    /// Phần trăm của cả máy (như Task Manager), cộng cả cây con.
    pub cpu: f32,
    pub memory: u64,
    pub cwd: Option<String>,
    /// `CLAUDE_CONFIG_DIR` hay `CODEX_HOME` của tiến trình; None là đăng nhập mặc định.
    pub config_dir: Option<String>,
    pub hive_project: Option<String>,
    pub source: Source,
    pub own: bool,
    pub children: usize,
    pub activity: Option<Activity>,
}

#[derive(Serialize, Debug)]
pub struct Scan {
    pub agents: Vec<Agent>,
    /// Thư mục nhà, để giao diện khớp `~/…` của gói với đường dẫn thật.
    pub home: Option<String>,
}

#[derive(Serialize, Default, Debug, PartialEq, Eq)]
pub struct Counts {
    pub claude: usize,
    pub codex: usize,
    pub antigravity: usize,
}

/// Tiến trình đã đọc, kèm biến môi trường đã lọc của các agent.
struct Snapshot {
    procs: Vec<Proc>,
    env: HashMap<u32, Vec<(String, String)>>,
}

#[derive(Default)]
struct Inner {
    /// Giữ giữa hai lần đọc: CPU tính bằng chênh lệch giữa hai lần.
    sys: Option<System>,
    hive: Option<(Instant, Vec<HiveSession>)>,
    activity: HashMap<(u32, u64), (Instant, Option<Activity>)>,
}

#[derive(Default)]
pub struct Agents(Mutex<Inner>);

/// sysinfo trả phần trăm của một nhân (vượt 100 trên máy nhiều nhân); giao diện hiện phần của cả máy.
pub(crate) fn machine_cpu(cpu: f32, cores: usize) -> f32 {
    cpu / cores.max(1) as f32
}

fn cores() -> usize {
    std::thread::available_parallelism().map_or(1, |n| n.get())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn lossy(s: &std::ffi::OsStr) -> String {
    s.to_string_lossy().into_owned()
}

/// Đọc mọi tiến trình (tên, file chạy, dòng lệnh, cha, giờ bắt đầu, CPU, RAM, người dùng). `deep` thì đọc thêm thư
/// mục làm việc và môi trường, chỉ của agent, vì đọc môi trường của mọi tiến trình vừa chậm vừa thừa.
fn collect(sys: &mut System, deep: bool) -> Snapshot {
    let base = ProcessRefreshKind::nothing()
        .without_tasks()
        .with_cpu()
        .with_memory()
        .with_exe(UpdateKind::OnlyIfNotSet)
        .with_cmd(UpdateKind::OnlyIfNotSet)
        .with_user(UpdateKind::OnlyIfNotSet);
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, base);
    let me = sysinfo::get_current_pid()
        .ok()
        .and_then(|p| sys.process(p))
        .and_then(|p| p.user_id().cloned());
    let mut procs: Vec<Proc> = sys
        .processes()
        .values()
        .map(|p| to_proc(p, me.as_ref()))
        .collect();
    let mut env = HashMap::new();
    if !deep {
        return Snapshot { procs, env };
    }
    let agents: Vec<u32> = procs
        .iter()
        .filter(|p| classify::match_cli(p).is_some())
        .map(|p| p.pid)
        .collect();
    if agents.is_empty() {
        return Snapshot { procs, env };
    }
    let mut details = read_details(&agents);
    for p in procs.iter_mut() {
        if let Some(d) = details.remove(&p.pid) {
            p.cwd = d.cwd;
            env.insert(p.pid, d.env);
        }
    }
    Snapshot { procs, env }
}

/// Đọc lại vài pid, bỏ pid trùng trước: sysinfo 0.39 xoá mất pid xuất hiện hai lần trong danh sách khi bật xoá tiến
/// trình đã chết.
fn refresh_some(sys: &mut System, pids: &[Pid], kind: ProcessRefreshKind) {
    let mut pids = pids.to_vec();
    pids.sort_unstable();
    pids.dedup();
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&pids), true, kind);
}

/// Thư mục làm việc và biến môi trường đã lọc của một agent.
struct Details {
    cwd: Option<String>,
    env: Vec<(String, String)>,
}

/// Đọc thư mục làm việc và môi trường của các agent bằng một `System` dùng một lần: môi trường đầy đủ (có thể chứa
/// token) chỉ sống trong hàm này, ra ngoài chỉ còn ba biến được giữ.
fn read_details(pids: &[u32]) -> HashMap<u32, Details> {
    let mut sys = System::new();
    let list: Vec<Pid> = pids.iter().map(|p| Pid::from_u32(*p)).collect();
    let kind = ProcessRefreshKind::nothing()
        .without_tasks()
        .with_cwd(UpdateKind::Always)
        .with_environ(UpdateKind::Always);
    refresh_some(&mut sys, &list, kind);
    pids.iter()
        .filter_map(|pid| {
            let p = sys.process(Pid::from_u32(*pid)).filter(|p| p.exists())?;
            let env = p
                .environ()
                .iter()
                .filter_map(|kv| {
                    let kv = kv.to_string_lossy();
                    let (k, v) = kv.split_once('=')?;
                    ENV_KEYS
                        .iter()
                        .find(|key| k.eq_ignore_ascii_case(key))
                        .filter(|_| !v.is_empty())
                        .map(|key| ((*key).to_string(), v.to_string()))
                })
                .collect();
            let cwd = p.cwd().map(|c| lossy(c.as_os_str()));
            Some((*pid, Details { cwd, env }))
        })
        .collect()
}

/// Tiến trình sẽ dừng: phải vẫn là agent đang hiện, cùng giờ bắt đầu với dòng người dùng thấy (pid chưa bị dùng
/// lại) và cùng người dùng hệ điều hành với app. Trả cả cây, con cháu trước.
pub(crate) fn stop_targets(
    procs: &[Proc],
    rows: &[Row],
    pid: u32,
    started_at: u64,
) -> Result<Vec<u32>, String> {
    let row = rows
        .iter()
        .find(|r| r.pid == pid)
        .ok_or("Tiến trình này không còn là agent đang chạy.")?;
    if row.start != started_at {
        return Err("Agent đã thoát; pid này giờ là tiến trình khác.".into());
    }
    if !row.own {
        return Err("Chỉ dừng được agent chạy bằng tài khoản máy của bạn.".into());
    }
    Ok(classify::subtree(procs, pid))
}

/// Dừng cả cây đã kiểm. Windows: TerminateProcess từng tiến trình (CLI console không nhận lời đóng nhẹ). macOS, Linux:
/// SIGTERM để CLI tự dọn, chờ tối đa 5 giây rồi SIGKILL tiến trình còn sống mà giờ bắt đầu chưa đổi.
fn kill_tree(sys: &mut System, targets: &[u32], starts: &HashMap<u32, u64>) {
    let same = |sys: &System, pid: u32| {
        sys.process(Pid::from_u32(pid))
            .filter(|p| p.exists() && starts.get(&pid) == Some(&p.start_time()))
            .is_some()
    };
    let kill = |sys: &System, pid: u32| {
        if same(sys, pid)
            && let Some(p) = sys.process(Pid::from_u32(pid))
        {
            let _ = p.kill();
        }
    };
    if cfg!(windows) {
        for pid in targets {
            kill(sys, *pid);
        }
        return;
    }
    for pid in targets {
        if let Some(p) = sys.process(Pid::from_u32(*pid)) {
            let _ = p.kill_with(Signal::Term);
        }
    }
    let pids: Vec<Pid> = targets.iter().map(|p| Pid::from_u32(*p)).collect();
    let deadline = Instant::now() + STOP_GRACE;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(200));
        refresh_some(sys, &pids, ProcessRefreshKind::nothing().without_tasks());
        if !targets.iter().any(|pid| same(sys, *pid)) {
            return;
        }
    }
    for pid in targets {
        kill(sys, *pid);
    }
}

fn env_of<'a>(snap: &'a Snapshot, row: &Row, key: &str) -> Option<&'a str> {
    row.pids.iter().find_map(|pid| {
        snap.env
            .get(pid)?
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    })
}

fn config_key(cli: Cli) -> Option<&'static str> {
    match cli {
        Cli::Claude => Some("CLAUDE_CONFIG_DIR"),
        Cli::Codex => Some("CODEX_HOME"),
        Cli::Antigravity => None,
    }
}

/// Tiến trình sysinfo đã đọc thành `Proc`; thư mục làm việc và môi trường đọc riêng (`read_details`).
fn to_proc(p: &sysinfo::Process, me: Option<&sysinfo::Uid>) -> Proc {
    Proc {
        pid: p.pid().as_u32(),
        parent: p.parent().map(Pid::as_u32),
        name: lossy(p.name()),
        exe: p.exe().map(|e| lossy(e.as_os_str())),
        cmd: p.cmd().iter().map(|a| lossy(a)).collect(),
        cwd: None,
        start: p.start_time(),
        cpu: p.cpu_usage(),
        memory: p.memory(),
        own: me.is_some() && p.user_id() == me,
    }
}

type FeedTarget = (Option<feed::Format>, Option<(PathBuf, bool)>);

/// Dòng agent của khung Hoạt động: cùng cách gộp với thẻ (shim và con cùng CLI là một dòng), kiểm tiến trình còn đó,
/// cùng giờ bắt đầu, vẫn là agent và cùng người dùng với app.
pub(crate) fn feed_row(
    procs: &[Proc],
    rows: &[Row],
    pid: u32,
    started_at: u64,
) -> Result<Row, String> {
    let Some(row) = rows.iter().find(|r| r.pid == pid && r.start == started_at) else {
        let alive = procs.iter().any(|p| p.pid == pid && p.start == started_at);
        return Err(if alive {
            "Tiến trình này không còn là agent.".into()
        } else {
            "Agent đã thoát.".into()
        });
    };
    if !row.own {
        return Err("Chỉ xem được agent chạy bằng tài khoản máy của bạn.".into());
    }
    Ok(row.clone())
}

/// File phiên của một agent cho khung Hoạt động, tìm lại từ pid ở mỗi lần đọc. Giao diện chỉ gửi pid, giờ bắt đầu và
/// file đang xem (để giữ phiên khi thư mục có hai phiên); Rust chỉ mở file chính nó tìm ra.
fn feed_target(
    sys: &mut System,
    pid: u32,
    started_at: u64,
    cursor: Option<&str>,
) -> Result<FeedTarget, String> {
    let snap = collect(sys, false);
    let ctx = Context {
        app_pid: std::process::id(),
        hive: &[],
    };
    let rows = classify::rows(&snap.procs, &ctx);
    let row = feed_row(&snap.procs, &rows, pid, started_at)?;
    let details = read_details(&row.pids);
    let cwd = row
        .pids
        .iter()
        .find_map(|p| details.get(p).and_then(|d| d.cwd.clone()));
    let config = config_key(row.m.cli).and_then(|key| {
        row.pids.iter().find_map(|p| {
            details
                .get(p)?
                .env
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| PathBuf::from(v))
        })
    });
    let home = crate::profiles::home_dir();
    let dir = |default: &str| {
        config
            .clone()
            .or_else(|| home.as_ref().map(|h| h.join(default)))
    };
    let now = now_secs();
    Ok(match row.m.cli {
        Cli::Claude => (
            Some(feed::Format::Claude),
            dir(".claude")
                .and_then(|c| {
                    activity::claude_transcripts(&c, &row.pids, cwd.as_deref(), row.start)
                })
                .and_then(|(list, guessed)| feed::pick(&list, cursor, now).map(|p| (p, guessed))),
        ),
        Cli::Codex => (
            Some(feed::Format::Codex),
            dir(".codex")
                .zip(cwd.as_deref())
                .and_then(|(h, c)| {
                    feed::pick(
                        &activity::codex_rollouts(&h, c, row.start, now),
                        cursor,
                        now,
                    )
                })
                .map(|p| (p, true)),
        ),
        Cli::Antigravity => (None, None),
    })
}

/// Chạy `f` với `System` dùng chung của màn Agent (đọc lại nhẹ vì tên, dòng lệnh chỉ đọc một lần mỗi tiến trình).
fn with_sys<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut System) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<Agents>();
    let mut inner = state.0.lock().map_err(|_| "Không đọc được tiến trình.")?;
    f(inner.sys.get_or_insert_with(System::new))
}

fn read_activity(row: &Row, config: Option<&str>, home: Option<&Path>) -> Option<Activity> {
    let dir = |default: &str| {
        config
            .map(PathBuf::from)
            .or_else(|| home.map(|h| h.join(default)))
    };
    match row.m.cli {
        Cli::Claude => {
            activity::claude_activity(&dir(".claude")?, &row.pids, row.cwd.as_deref(), row.start)
        }
        Cli::Codex => {
            activity::codex_activity(&dir(".codex")?, row.cwd.as_deref()?, row.start, now_secs())
        }
        Cli::Antigravity => None,
    }
}

fn to_agents(
    snap: &Snapshot,
    rows: Vec<Row>,
    home: Option<&Path>,
    cache: &mut HashMap<(u32, u64), (Instant, Option<Activity>)>,
) -> Vec<Agent> {
    let cores = cores();
    cache.retain(|(pid, start), _| rows.iter().any(|r| r.pid == *pid && r.start == *start));
    rows.into_iter()
        .map(|row| {
            let config = config_key(row.m.cli).and_then(|k| env_of(snap, &row, k));
            let activity = if row.own {
                let key = (row.pid, row.start);
                match cache.get(&key) {
                    Some((at, a)) if at.elapsed() < ACTIVITY_TTL => a.clone(),
                    _ => {
                        let a = read_activity(&row, config, home);
                        cache.insert(key, (Instant::now(), a.clone()));
                        a
                    }
                }
            } else {
                None
            };
            // Phiên Code của Claude Desktop có thể chạy dưới tiến trình trung gian: file phiên nói rõ ai mở.
            let source = match (&row.source, activity.as_ref()) {
                (Source::Terminal, Some(a))
                    if a.entrypoint.as_deref() == Some("claude-desktop") =>
                {
                    Source::ClaudeDesktop
                }
                (s, _) => s.clone(),
            };
            Agent {
                pid: row.pid,
                cli: row.m.cli,
                background: row.m.background,
                bypass: row.m.bypass,
                started_at: row.start,
                cpu: machine_cpu(row.cpu, cores),
                memory: row.memory,
                cwd: row.cwd.clone(),
                config_dir: config.map(str::to_string),
                hive_project: env_of(snap, &row, "HIVE_PROJECT").map(str::to_string),
                source,
                own: row.own,
                children: row.children,
                activity,
            }
        })
        .collect()
}

/// Phiên của `hive ls --json` (spec 010): pid, id phiên, mã phiên trên hub. Lỗi (worker cũ, chưa đăng ký) thì rỗng.
fn parse_hive(list: &serde_json::Value) -> Vec<HiveSession> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            Some(HiveSession {
                id: s.get("id")?.as_str()?.to_string(),
                pid: u32::try_from(s.get("pid")?.as_u64()?).ok()?,
                hub_id: s
                    .get("hubId")
                    .and_then(|h| h.as_str())
                    .filter(|h| !h.is_empty())
                    .map(str::to_string),
            })
        })
        .collect()
}

async fn hive_sessions(app: &AppHandle) -> Vec<HiveSession> {
    let cached = app.state::<Agents>().0.lock().ok().and_then(|inner| {
        inner
            .hive
            .as_ref()
            .filter(|(at, _)| at.elapsed() < HIVE_TTL)
            .map(|(_, s)| s.clone())
    });
    if let Some(sessions) = cached {
        return sessions;
    }
    let sessions = crate::remote::hive_json(app, &["ls", "--json"])
        .await
        .map(|v| parse_hive(&v))
        .unwrap_or_default();
    if let Ok(mut inner) = app.state::<Agents>().0.lock() {
        inner.hive = Some((Instant::now(), sessions.clone()));
    }
    sessions
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

/// Mọi agent trên máy, kèm việc đang làm đọc từ file phiên của chính CLI.
#[tauri::command]
pub async fn machine_agents(app: AppHandle) -> Result<Scan, String> {
    let read = app.clone();
    let (snap, under_worker) = blocking(move || {
        let state = read.state::<Agents>();
        let mut inner = state.0.lock().map_err(|_| "Không đọc được tiến trình.")?;
        let snap = collect(inner.sys.get_or_insert_with(System::new), true);
        let ctx = Context {
            app_pid: std::process::id(),
            hive: &[],
        };
        let under = classify::rows(&snap.procs, &ctx)
            .iter()
            .any(|r| r.under_worker);
        Ok::<_, String>((snap, under))
    })
    .await??;
    let hive = if under_worker {
        hive_sessions(&app).await
    } else {
        Vec::new()
    };
    let read = app.clone();
    blocking(move || {
        let ctx = Context {
            app_pid: std::process::id(),
            hive: &hive,
        };
        let rows = classify::rows(&snap.procs, &ctx);
        let home = crate::profiles::home_dir();
        let state = read.state::<Agents>();
        let mut inner = state.0.lock().map_err(|_| "Không đọc được tiến trình.")?;
        let agents = to_agents(&snap, rows, home.as_deref(), &mut inner.activity);
        Ok(Scan {
            agents,
            home: home.map(|h| h.to_string_lossy().into_owned()),
        })
    })
    .await?
}

/// Số agent theo CLI cho màn Máy này: không đọc thư mục, môi trường hay file phiên.
#[tauri::command]
pub async fn machine_agent_counts(app: AppHandle) -> Result<Counts, String> {
    blocking(move || {
        let state = app.state::<Agents>();
        let mut inner = state.0.lock().map_err(|_| "Không đọc được tiến trình.")?;
        let snap = collect(inner.sys.get_or_insert_with(System::new), false);
        let ctx = Context {
            app_pid: std::process::id(),
            hive: &[],
        };
        let mut counts = Counts::default();
        for row in classify::rows(&snap.procs, &ctx) {
            match row.m.cli {
                Cli::Claude => counts.claude += 1,
                Cli::Codex => counts.codex += 1,
                Cli::Antigravity => counts.antigravity += 1,
            }
        }
        Ok(counts)
    })
    .await?
}

/// Dừng một agent và cả cây của nó, sau khi kiểm lại pid, giờ bắt đầu và người dùng.
#[tauri::command]
pub async fn machine_agent_stop(app: AppHandle, pid: u32, started_at: u64) -> Result<(), String> {
    blocking(move || {
        let state = app.state::<Agents>();
        let mut inner = state.0.lock().map_err(|_| "Không đọc được tiến trình.")?;
        let sys = inner.sys.get_or_insert_with(System::new);
        let snap = collect(sys, false);
        let ctx = Context {
            app_pid: std::process::id(),
            hive: &[],
        };
        let rows = classify::rows(&snap.procs, &ctx);
        let targets = stop_targets(&snap.procs, &rows, pid, started_at)?;
        let starts: HashMap<u32, u64> = snap.procs.iter().map(|p| (p.pid, p.start)).collect();
        kill_tree(sys, &targets, &starts);
        Ok(())
    })
    .await?
}

/// Vị trí khung Hoạt động đã đọc tới: file (chỉ để so) và byte sau dòng cuối.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedCursor {
    path: String,
    end: u64,
}

/// Khung Hoạt động (spec 021 phần 3): đọc tiếp file phiên của agent từ chỗ giao diện đã có; mới mở thì trang cuối.
#[tauri::command]
pub async fn machine_agent_feed(
    app: AppHandle,
    pid: u32,
    started_at: u64,
    cursor: Option<FeedCursor>,
) -> Result<feed::Feed, String> {
    blocking(move || {
        let current = cursor.as_ref().map(|c| c.path.as_str());
        let (format, file) = with_sys(&app, |sys| feed_target(sys, pid, started_at, current))?;
        let Some(format) = format else {
            return Ok(feed::next(None, feed::Format::Claude, None));
        };
        let file = file.as_ref().map(|(p, guessed)| (p.as_path(), *guessed));
        let cursor = cursor.as_ref().map(|c| (c.path.as_str(), c.end));
        Ok(feed::next(file, format, cursor))
    })
    .await?
}

/// "Tải thêm" của khung Hoạt động: trang trước byte `before` của file đang xem.
#[tauri::command]
pub async fn machine_agent_feed_older(
    app: AppHandle,
    pid: u32,
    started_at: u64,
    path: String,
    before: u64,
) -> Result<feed::Feed, String> {
    blocking(move || {
        let (format, file) = with_sys(&app, |sys| feed_target(sys, pid, started_at, Some(&path)))?;
        let Some(format) = format else {
            return Ok(feed::next(None, feed::Format::Claude, None));
        };
        let file = file.as_ref().map(|(p, guessed)| (p.as_path(), *guessed));
        Ok(feed::older(file, format, &path, before))
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, parent: u32, exe: &str, start: u64, own: bool) -> Proc {
        Proc {
            pid,
            parent: (parent != 0).then_some(parent),
            name: exe.rsplit('/').next().unwrap_or(exe).into(),
            exe: Some(exe.into()),
            cmd: vec![exe.into()],
            start,
            own,
            ..Proc::default()
        }
    }

    const NONE: Context<'static> = Context {
        app_pid: 0,
        hive: &[],
    };

    #[test]
    fn stop_refuses_unknown_reused_or_foreign() {
        let procs = vec![
            proc(10, 1, "/bin/claude", 500, true),
            proc(11, 10, "/bin/rg", 501, true),
            proc(20, 1, "/bin/codex", 600, false),
            proc(30, 1, "/bin/zsh", 700, true),
        ];
        let rows = classify::rows(&procs, &NONE);
        assert!(stop_targets(&procs, &rows, 30, 700).is_err());
        assert!(stop_targets(&procs, &rows, 99, 1).is_err());
        let reused = stop_targets(&procs, &rows, 10, 499).unwrap_err();
        assert!(reused.contains("đã thoát"), "{reused}");
        assert!(stop_targets(&procs, &rows, 20, 600).is_err());
        assert_eq!(stop_targets(&procs, &rows, 10, 500).unwrap(), vec![11, 10]);
    }

    #[test]
    fn real_scan_finds_this_process() {
        let mut sys = System::new();
        let snap = collect(&mut sys, false);
        let me = snap
            .procs
            .iter()
            .find(|p| p.pid == std::process::id())
            .expect("tiến trình test có trong danh sách");
        assert!(me.own);
        assert!(me.start > 0);
        assert!(me.exe.is_some());
    }

    #[test]
    fn read_details_reads_several_pids_at_once() {
        // sysinfo bỏ mất tiến trình còn sống khi đọc nhiều pid một lần mà bật xoá tiến trình đã chết.
        let spawn = || {
            std::process::Command::new(if cfg!(windows) { "cmd" } else { "/bin/sh" })
                .args(if cfg!(windows) {
                    ["/C", "ping -n 6 127.0.0.1 >NUL"]
                } else {
                    ["-c", "sleep 5"]
                })
                .spawn()
                .unwrap()
        };
        let (mut a, mut b) = (spawn(), spawn());
        let me = std::process::id();
        let details = read_details(&[a.id(), b.id(), me]);
        for c in [&mut a, &mut b] {
            let _ = c.kill();
            let _ = c.wait();
        }
        for pid in [a.id(), b.id(), me] {
            assert!(details.contains_key(&pid), "thiếu {pid}");
        }
    }

    #[test]
    fn feed_target_checks_start_time_and_that_it_is_an_agent() {
        let mut sys = System::new();
        let me = collect(&mut sys, false)
            .procs
            .into_iter()
            .find(|p| p.pid == std::process::id())
            .unwrap();
        let reused = feed_target(&mut sys, me.pid, me.start + 1000, None).unwrap_err();
        assert!(reused.contains("đã thoát"), "{reused}");
        let not_agent = feed_target(&mut sys, me.pid, me.start, None).unwrap_err();
        assert!(not_agent.contains("không còn là agent"), "{not_agent}");
    }

    #[test]
    fn feed_row_uses_the_whole_shim_row_like_the_card() {
        let mut node = proc(10, 1, "/usr/bin/node", 500, true);
        node.cmd = vec![
            "/usr/bin/node".into(),
            "/usr/lib/node_modules/@openai/codex/bin/codex.js".into(),
        ];
        let procs = vec![
            node,
            proc(
                11,
                10,
                "/usr/lib/node_modules/@openai/codex/vendor/codex-x86_64-unknown-linux-musl",
                501,
                true,
            ),
            proc(20, 1, "/bin/claude", 600, false),
            proc(30, 1, "/bin/zsh", 700, true),
        ];
        let rows = classify::rows(&procs, &NONE);
        assert_eq!(feed_row(&procs, &rows, 10, 500).unwrap().pids, vec![10, 11]);
        assert!(
            feed_row(&procs, &rows, 10, 499)
                .unwrap_err()
                .contains("đã thoát")
        );
        assert!(
            feed_row(&procs, &rows, 99, 1)
                .unwrap_err()
                .contains("đã thoát")
        );
        assert!(
            feed_row(&procs, &rows, 30, 700)
                .unwrap_err()
                .contains("không còn là agent")
        );
        assert!(
            feed_row(&procs, &rows, 20, 600)
                .unwrap_err()
                .contains("tài khoản máy")
        );
    }

    #[test]
    fn cpu_is_share_of_machine() {
        assert_eq!(machine_cpu(400.0, 8), 50.0);
        assert_eq!(machine_cpu(30.0, 0), 30.0);
    }

    #[cfg(unix)]
    #[test]
    fn details_keep_only_allowed_env_and_nothing_stays_in_the_shared_system() {
        let dir = std::env::temp_dir();
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 5"])
            .current_dir(&dir)
            .env("CLAUDE_CONFIG_DIR", "/plans/claude-2")
            .env("HIVE_RUN_TOKEN", "hwr_secret")
            .spawn()
            .unwrap();
        let pid = child.id();
        // Ngay sau spawn, tiến trình con có thể chưa exec: /proc/<pid>/environ khi đó vẫn là môi trường của tiến trình
        // cha (không có CLAUDE_CONFIG_DIR). Đọc lại tới khi thấy môi trường của chính nó, tối đa khoảng 2 giây.
        let mut details = read_details(&[pid]);
        for _ in 0..100 {
            if details.get(&pid).is_some_and(|d| !d.env.is_empty()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
            details = read_details(&[pid]);
        }
        let _ = child.kill();
        let _ = child.wait();
        let d = details.get(&pid).expect("đọc được tiến trình con");
        assert_eq!(
            d.cwd.as_deref().map(Path::new),
            Some(dir.canonicalize().unwrap().as_path())
        );
        assert_eq!(
            d.env,
            vec![(
                "CLAUDE_CONFIG_DIR".to_string(),
                "/plans/claude-2".to_string()
            )]
        );
        // System giữ giữa các lần đọc không đọc môi trường nào.
        let mut sys = System::new();
        let _ = collect(&mut sys, true);
        assert!(sys.processes().values().all(|p| p.environ().is_empty()));
    }
}
