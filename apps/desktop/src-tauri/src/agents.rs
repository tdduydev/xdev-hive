//! Màn Agent trên máy (spec 021): mọi tiến trình Claude Code, Codex, Antigravity đang chạy trên máy, ai mở cũng thấy.
//!
//! Đọc tiến trình bằng sysinfo: một API cho Windows, macOS, Linux, kể cả thư mục làm việc và môi trường của tiến trình
//! khác. Môi trường lọc ngay khi đọc, chỉ giữ ba biến; dòng lệnh chỉ dùng để nhận CLI và cờ, không trả về giao diện.
//! Mọi thứ ở đây chỉ về cửa sổ app, không gửi hub.

pub(crate) mod activity;
pub(crate) mod classify;

use activity::Activity;
use classify::{Cli, Context, HiveSession, Proc, Row, Source};
use serde::Serialize;
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
        .map(|p| Proc {
            pid: p.pid().as_u32(),
            parent: p.parent().map(Pid::as_u32),
            name: lossy(p.name()),
            exe: p.exe().map(|e| lossy(e.as_os_str())),
            cmd: p.cmd().iter().map(|a| lossy(a)).collect(),
            cwd: None,
            start: p.start_time(),
            cpu: p.cpu_usage(),
            memory: p.memory(),
            own: me.is_some() && p.user_id() == me.as_ref(),
        })
        .collect();
    let mut env = HashMap::new();
    if !deep {
        return Snapshot { procs, env };
    }
    let agents: Vec<Pid> = procs
        .iter()
        .filter(|p| classify::match_cli(p).is_some())
        .map(|p| Pid::from_u32(p.pid))
        .collect();
    if agents.is_empty() {
        return Snapshot { procs, env };
    }
    let extra = ProcessRefreshKind::nothing()
        .without_tasks()
        .with_cwd(UpdateKind::Always)
        .with_environ(UpdateKind::OnlyIfNotSet);
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&agents), false, extra);
    for p in procs.iter_mut() {
        let Some(sp) = agents
            .contains(&Pid::from_u32(p.pid))
            .then(|| sys.process(Pid::from_u32(p.pid)))
            .flatten()
        else {
            continue;
        };
        p.cwd = sp.cwd().map(|c| lossy(c.as_os_str()));
        let kept: Vec<(String, String)> = sp
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
        env.insert(p.pid, kept);
    }
    Snapshot { procs, env }
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
            .filter(|p| starts.get(&pid) == Some(&p.start_time()))
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
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
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
    let ptys = app.state::<crate::pty::Ptys>().pids();
    let read = app.clone();
    let (snap, under_worker) = blocking(move || {
        let state = read.state::<Agents>();
        let mut inner = state.0.lock().map_err(|_| "Không đọc được tiến trình.")?;
        let snap = collect(inner.sys.get_or_insert_with(System::new), true);
        let ctx = Context {
            app_pid: std::process::id(),
            ptys: &ptys,
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
    let ptys = app.state::<crate::pty::Ptys>().pids();
    let read = app.clone();
    blocking(move || {
        let ctx = Context {
            app_pid: std::process::id(),
            ptys: &ptys,
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
            ptys: &[],
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
            ptys: &[],
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
        ptys: &[],
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
    fn cpu_is_share_of_machine() {
        assert_eq!(machine_cpu(400.0, 8), 50.0);
        assert_eq!(machine_cpu(30.0, 0), 30.0);
    }
}
