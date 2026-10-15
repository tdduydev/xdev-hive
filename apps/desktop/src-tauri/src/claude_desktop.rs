//! Claude Desktop (Claude.app) theo gói Claude của máy: mỗi gói một hồ sơ riêng ở `~/.xdev-hive/claude-desktop/<id>`,
//! mở bằng `--user-data-dir`. Đăng nhập CLI của gói không dùng lại được cho Claude Desktop (app giữ phiên web riêng),
//! nên người dùng đăng nhập một lần trong hồ sơ của gói, các lần sau mở thẳng vào tài khoản đó.
//!
//! Đã thử trên Claude.app 2.37337.1 (macOS): `open -n -a Claude --args --user-data-dir=<thư mục>` mở bản thứ hai độc
//! lập trong khi bản thường vẫn chạy, chỉ ghi vào thư mục đó, không mở file nào của hồ sơ gốc
//! (`~/Library/Application Support/Claude`). App không khoá một bản cho mỗi thư mục: mở lại cùng hồ sơ là hai tiến trình
//! cùng ghi một Cookies, nên trước khi mở phải dò tiến trình đang dùng hồ sơ.
//!
//! Hồ sơ gốc không bao giờ bị đọc, ghi hay xoá ở đây: mọi đường dẫn ghi hay xoá đều nằm dưới thư mục hồ sơ của Hive.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::profiles::home_dir;
use crate::sidecar_json;

/// Thư mục Chromium tự dựng lại khi thiếu. `claude-code` (bản Claude Code app tự tải, vài trăm MB) không nằm đây: xoá
/// thì app tải lại.
const CACHE_DIRS: [&str; 9] = [
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GraphiteDawnCache",
    "GPUPersistentCache",
    "ShaderCache",
    "GrShaderCache",
];

const UNSUPPORTED: &str =
    "Chưa hỗ trợ mở Claude Desktop theo gói trên hệ điều hành này (mới có cho macOS).";
const NOT_INSTALLED: &str = "Chưa thấy Claude Desktop trong /Applications hay ~/Applications. Cài Claude Desktop rồi thử lại.";

pub(crate) fn profiles_root(home: &Path) -> PathBuf {
    home.join(".xdev-hive").join("claude-desktop")
}

/// Hồ sơ của chính Claude Desktop: không bao giờ được trùng hay nằm trong hồ sơ của gói.
fn original_profile(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("Claude")
}

/// Id gói đi vào đường dẫn: chỉ nhận dạng id worker tạo (`claude-2`), để `..` hay `/` không đưa ra ngoài thư mục hồ sơ.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

pub(crate) fn profile_dir(home: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!("Id gói không hợp lệ: {id}"));
    }
    Ok(profiles_root(home).join(id))
}

/// Nơi thường cài Claude.app; bản cài cho riêng người dùng nằm trong ~/Applications.
fn app_candidates(home: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/Applications/Claude.app"),
        home.join("Applications").join("Claude.app"),
    ]
}

fn app_binary(bundle: &Path) -> PathBuf {
    bundle.join("Contents").join("MacOS").join("Claude")
}

fn find_app_in(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|b| app_binary(b).is_file()).cloned()
}

fn find_app(home: &Path) -> Option<PathBuf> {
    find_app_in(&app_candidates(home))
}

/// Tham số của `open`: `-n` để có bản mới bên cạnh Claude Desktop đang mở, `--args` chuyển cờ cho Electron.
fn launch_args(bundle: &Path, dir: &Path) -> Vec<String> {
    vec![
        "-n".into(),
        "-a".into(),
        bundle.display().to_string(),
        "--args".into(),
        format!("--user-data-dir={}", dir.display()),
    ]
}

/// Tiến trình chính của Claude Desktop đang dùng hồ sơ nào của Hive, từ `ps -axo pid=,command=`. Tiến trình phụ của
/// Electron (`--type=renderer`, `--type=gpu-process`…) mang cùng cờ nên bị bỏ, chỉ giữ tiến trình chính.
fn running_in(ps: &str, root: &Path) -> HashMap<String, u32> {
    let marker = format!("--user-data-dir={}/", root.display());
    let mut out = HashMap::new();
    for line in ps.lines() {
        let line = line.trim_start();
        let Some((pid, command)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let Ok(pid) = pid.parse::<u32>() else {
            continue;
        };
        if command.contains("--type=") || !command.contains("/Contents/MacOS/Claude ") {
            continue;
        }
        let Some(start) = command.find(&marker) else {
            continue;
        };
        let rest = &command[start + marker.len()..];
        let id = rest.split(char::is_whitespace).next().unwrap_or("");
        let id = id.trim_end_matches('/');
        if valid_id(id) {
            out.entry(id.to_string()).or_insert(pid);
        }
    }
    out
}

fn running(home: &Path) -> HashMap<String, u32> {
    let Ok(out) = Command::new("ps").args(["-axo", "pid=,command="]).output() else {
        return HashMap::new();
    };
    running_in(&String::from_utf8_lossy(&out.stdout), &profiles_root(home))
}

/// Dung lượng thư mục, không đi theo symlink để không đếm (hay về sau xoá) thứ nằm ngoài hồ sơ.
fn dir_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        return 0;
    }
    if meta.is_file() {
        return meta.len();
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|e| dir_size(&e.path()))
        .sum()
}

fn cache_size(dir: &Path) -> u64 {
    CACHE_DIRS.iter().map(|n| dir_size(&dir.join(n))).sum()
}

/// Xoá các thư mục cache của một hồ sơ, trả số byte đã giải phóng. Bỏ qua symlink: chỉ xoá thư mục thật trong hồ sơ.
fn clean_cache(dir: &Path) -> u64 {
    let mut freed = 0;
    for name in CACHE_DIRS {
        let path = dir.join(name);
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_dir() || meta.file_type().is_symlink() {
            continue;
        }
        let size = dir_size(&path);
        if std::fs::remove_dir_all(&path).is_ok() {
            freed += size;
        }
    }
    freed
}

/// Kiểm thư mục sắp xoá: phải nằm ngay dưới thư mục hồ sơ của Hive, không là symlink, và (sau khi giải symlink của
/// các thư mục cha) không trùng hay nằm trong hồ sơ gốc của Claude Desktop.
fn safe_to_remove(home: &Path, dir: &Path) -> Result<(), String> {
    let root = profiles_root(home);
    if dir.parent() != Some(root.as_path()) {
        return Err("Thư mục hồ sơ nằm ngoài thư mục của Hive.".into());
    }
    let meta = std::fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("Hồ sơ không phải thư mục thật; không xoá.".into());
    }
    let real = dir.canonicalize().map_err(|e| e.to_string())?;
    let original = original_profile(home);
    let original = original.canonicalize().unwrap_or(original);
    if real.starts_with(&original) || original.starts_with(&real) {
        return Err("Thư mục trỏ vào hồ sơ gốc của Claude Desktop; không xoá.".into());
    }
    Ok(())
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    // Hồ sơ chứa cookie đăng nhập: chỉ người dùng hiện tại đọc được.
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Phần của một gói mà màn này cần, đọc từ `accounts --json`.
#[derive(Deserialize)]
struct Plan {
    id: String,
    cli: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    email: Option<String>,
}

#[derive(Deserialize)]
struct Plans {
    accounts: Vec<Plan>,
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileView {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) email: Option<String>,
    dir: String,
    /// Đã mở Claude Desktop bằng hồ sơ này ít nhất một lần (có Cookies); chưa thì nút ghi "Đăng nhập…".
    used: bool,
    bytes: u64,
    cache_bytes: u64,
    pub(crate) pid: Option<u32>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfilesView {
    supported: bool,
    /// Claude.app tìm thấy; None khi chưa cài.
    pub(crate) app: Option<String>,
    root: String,
    /// Vì sao chưa mở được (chưa hỗ trợ, chưa cài); None khi mở được.
    note: Option<String>,
    pub(crate) profiles: Vec<ProfileView>,
}

fn view(
    home: &Path,
    plans: &[Plan],
    app: Option<&Path>,
    supported: bool,
    pids: &HashMap<String, u32>,
) -> ProfilesView {
    let profiles = plans
        .iter()
        .filter(|p| p.cli == "claude" && valid_id(&p.id))
        .map(|p| {
            let dir = profiles_root(home).join(&p.id);
            ProfileView {
                id: p.id.clone(),
                label: if p.label.trim().is_empty() {
                    p.id.clone()
                } else {
                    p.label.clone()
                },
                email: p.email.clone().filter(|e| !e.is_empty()),
                used: dir.join("Cookies").is_file(),
                bytes: dir_size(&dir),
                cache_bytes: cache_size(&dir),
                pid: pids.get(&p.id).copied(),
                dir: dir.display().to_string(),
            }
        })
        .collect();
    let note = if !supported {
        Some(UNSUPPORTED.to_string())
    } else if app.is_none() {
        Some(NOT_INSTALLED.to_string())
    } else {
        None
    };
    ProfilesView {
        supported,
        app: app.map(|a| a.display().to_string()),
        root: profiles_root(home).display().to_string(),
        note,
        profiles,
    }
}

fn need_home() -> Result<PathBuf, String> {
    home_dir().ok_or_else(|| "Không tìm thấy thư mục nhà của người dùng.".to_string())
}

async fn claude_plans(app: &AppHandle) -> Result<Vec<Plan>, String> {
    let Plans { accounts } =
        sidecar_json(app, vec!["accounts".into(), "--json".into()], vec![]).await?;
    Ok(accounts)
}

/// Gói Claude của máy kèm hồ sơ Claude Desktop của từng gói (dung lượng, cache, tiến trình đang mở). Cũng làm mới mục
/// "Mở Claude Desktop bằng…" của khay, để khay theo kịp khi người dùng thêm hay xoá gói.
pub(crate) async fn load(app: &AppHandle) -> Result<ProfilesView, String> {
    let plans = claude_plans(app).await?;
    let home = need_home()?;
    let v = tauri::async_runtime::spawn_blocking(move || {
        let supported = cfg!(target_os = "macos");
        let bundle = if supported { find_app(&home) } else { None };
        let pids = if supported {
            running(&home)
        } else {
            HashMap::new()
        };
        view(&home, &plans, bundle.as_deref(), supported, &pids)
    })
    .await
    .map_err(|e| e.to_string())?;
    crate::set_claude_tray(app, &v);
    Ok(v)
}

#[tauri::command]
pub async fn claude_desktop_profiles(app: AppHandle) -> Result<ProfilesView, String> {
    load(&app).await
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Opened {
    /// Hồ sơ đã có Claude Desktop đang mở: không mở bản thứ hai cùng ghi một hồ sơ.
    pub(crate) already: bool,
    pub(crate) pid: Option<u32>,
}

/// Mở Claude Desktop bằng hồ sơ của một gói Claude. Cửa sổ chỉ gửi id gói; đường dẫn app và hồ sơ do Rust dựng.
pub(crate) async fn open(app: &AppHandle, id: &str) -> Result<Opened, String> {
    if !cfg!(target_os = "macos") {
        return Err(UNSUPPORTED.into());
    }
    let id = id.trim().to_string();
    let plans = claude_plans(app).await?;
    if !plans.iter().any(|p| p.id == id && p.cli == "claude") {
        return Err(format!("Không có gói Claude {id}."));
    }
    let home = need_home()?;
    let opened = tauri::async_runtime::spawn_blocking(move || -> Result<Opened, String> {
        let bundle = find_app(&home).ok_or(NOT_INSTALLED)?;
        let dir = profile_dir(&home, &id)?;
        if let Some(pid) = running(&home).get(&id) {
            return Ok(Opened {
                already: true,
                pid: Some(*pid),
            });
        }
        create_private_dir(&dir).map_err(|e| format!("Không tạo được thư mục hồ sơ: {e}"))?;
        let status = Command::new("open")
            .args(launch_args(&bundle, &dir))
            .status()
            .map_err(|e| format!("Không mở được Claude Desktop: {e}"))?;
        if !status.success() {
            return Err("Không mở được Claude Desktop.".into());
        }
        Ok(Opened {
            already: false,
            pid: None,
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    // Khay ghi "đang mở" theo PID; app cần vài giây mới hiện tiến trình, giao diện tự đọc lại sau đó.
    Ok(opened)
}

#[tauri::command]
pub async fn open_claude_desktop(app: AppHandle, profile_id: String) -> Result<Opened, String> {
    open(&app, &profile_id).await
}

/// Thao tác trên hồ sơ cần Claude Desktop của gói đã tắt: Chromium giữ file cache và Cookies đang mở.
fn closed_profile(id: &str) -> Result<(PathBuf, PathBuf), String> {
    let home = need_home()?;
    let dir = profile_dir(&home, id.trim())?;
    if running(&home).contains_key(id.trim()) {
        return Err("Claude Desktop của gói này đang mở. Thoát nó (Cmd+Q) rồi thử lại.".into());
    }
    Ok((home, dir))
}

/// Xoá hồ sơ Claude Desktop của một gói (đăng xuất khỏi gói đó); lần mở sau là đăng nhập lại từ đầu.
#[tauri::command]
pub async fn reset_claude_desktop_profile(
    app: AppHandle,
    profile_id: String,
) -> Result<ProfilesView, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let (home, dir) = closed_profile(&profile_id)?;
        if !dir.exists() {
            return Ok(());
        }
        safe_to_remove(&home, &dir)?;
        std::fs::remove_dir_all(&dir).map_err(|e| format!("Không xoá được hồ sơ: {e}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    load(&app).await
}

/// Dọn cache của hồ sơ một gói; giữ đăng nhập. Trả số byte đã giải phóng.
#[tauri::command]
pub async fn claude_desktop_cleanup_cache(profile_id: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
        let (_, dir) = closed_profile(&profile_id)?;
        Ok(clean_cache(&dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Chữ của một mục khay: tên gói, email nếu có, và dấu đang mở.
pub(crate) fn tray_label(p: &ProfileView, en: bool) -> String {
    let mut s = p.label.clone();
    if let Some(email) = &p.email
        && email != &p.label
    {
        s.push_str(&format!(" ({email})"));
    }
    if p.pid.is_some() {
        s.push_str(if en { " · open" } else { " · đang mở" });
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("hive-claude-desktop-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, bytes: usize) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, vec![b'x'; bytes]).unwrap();
    }

    fn plan(id: &str, cli: &str, label: &str, email: Option<&str>) -> Plan {
        Plan {
            id: id.into(),
            cli: cli.into(),
            label: label.into(),
            email: email.map(Into::into),
        }
    }

    #[test]
    fn profile_dir_stays_under_hive() {
        let home = Path::new("/Users/a");
        assert_eq!(
            profile_dir(home, "claude-2").unwrap(),
            Path::new("/Users/a/.xdev-hive/claude-desktop/claude-2")
        );
        for bad in [
            "",
            "..",
            "../x",
            "a/b",
            "a\\b",
            ".hidden",
            "x y",
            &"a".repeat(65),
        ] {
            assert!(profile_dir(home, bad).is_err(), "{bad:?}");
        }
        assert_ne!(
            profiles_root(home),
            original_profile(home),
            "hồ sơ của gói không được là hồ sơ gốc"
        );
    }

    #[test]
    fn finds_app_in_applications_or_home() {
        let home = temp_home("find");
        let user_app = home.join("Applications").join("Claude.app");
        let missing = home.join("nowhere").join("Claude.app");
        assert_eq!(find_app_in(&[missing.clone(), user_app.clone()]), None);
        write(&app_binary(&user_app), 1);
        assert_eq!(
            find_app_in(&[missing, user_app.clone()]),
            Some(user_app.clone())
        );
        assert_eq!(
            app_candidates(&home),
            vec![PathBuf::from("/Applications/Claude.app"), user_app]
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn launch_opens_a_new_instance_with_the_profile() {
        assert_eq!(
            launch_args(
                Path::new("/Applications/Claude.app"),
                Path::new("/Users/a/.xdev-hive/claude-desktop/claude-2")
            ),
            [
                "-n",
                "-a",
                "/Applications/Claude.app",
                "--args",
                "--user-data-dir=/Users/a/.xdev-hive/claude-desktop/claude-2"
            ]
        );
    }

    #[test]
    fn running_keeps_main_processes_of_hive_profiles_only() {
        let root = Path::new("/Users/a/.xdev-hive/claude-desktop");
        let ps = "\
  412 /Applications/Claude.app/Contents/MacOS/Claude
  500 /Applications/Claude.app/Contents/MacOS/Claude --user-data-dir=/Users/a/.xdev-hive/claude-desktop/claude-2
  501 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer --user-data-dir=/Users/a/.xdev-hive/claude-desktop/claude-2
  600 /Users/a/Applications/Claude.app/Contents/MacOS/Claude --user-data-dir=/Users/a/.xdev-hive/claude-desktop/claude-3 --foo
  700 /Applications/Claude.app/Contents/MacOS/Claude --user-data-dir=/tmp/other
  800 /usr/bin/vim /Users/a/.xdev-hive/claude-desktop/claude-4/x --user-data-dir=/Users/a/.xdev-hive/claude-desktop/claude-4
  bad line
";
        let got = running_in(ps, root);
        assert_eq!(
            got,
            HashMap::from([("claude-2".to_string(), 500), ("claude-3".to_string(), 600)])
        );
    }

    #[test]
    fn view_lists_claude_plans_with_sizes_and_pids() {
        let home = temp_home("view");
        let dir = profiles_root(&home).join("claude-1");
        write(&dir.join("Cookies"), 100);
        write(&dir.join("Cache").join("Cache_Data").join("a"), 300);
        write(&dir.join("Code Cache").join("js").join("b"), 50);
        let plans = [
            plan("claude-1", "claude", "Duy Max", Some("duy@fpt.com")),
            plan("codex-1", "codex", "Codex", None),
            plan("claude-2", "claude", "", Some("")),
        ];
        let app = PathBuf::from("/Applications/Claude.app");
        let pids = HashMap::from([("claude-1".to_string(), 42)]);
        let v = view(&home, &plans, Some(&app), true, &pids);
        assert_eq!(v.note, None);
        assert_eq!(v.app.as_deref(), Some("/Applications/Claude.app"));
        assert_eq!(v.profiles.len(), 2);
        let first = &v.profiles[0];
        assert_eq!(
            (
                first.id.as_str(),
                first.used,
                first.bytes,
                first.cache_bytes,
                first.pid
            ),
            ("claude-1", true, 450, 350, Some(42))
        );
        let second = &v.profiles[1];
        assert_eq!(
            (
                second.label.as_str(),
                second.email.as_deref(),
                second.used,
                second.bytes
            ),
            ("claude-2", None, false, 0)
        );
        assert_eq!(
            view(&home, &plans, None, true, &pids).note.as_deref(),
            Some(NOT_INSTALLED)
        );
        assert_eq!(
            view(&home, &plans, None, false, &pids).note.as_deref(),
            Some(UNSUPPORTED)
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn clean_cache_keeps_login_and_claude_code() {
        let home = temp_home("clean");
        let dir = profiles_root(&home).join("claude-1");
        write(&dir.join("Cookies"), 10);
        write(&dir.join("claude-code").join("bin"), 1000);
        write(&dir.join("Cache").join("a"), 300);
        write(&dir.join("GPUCache").join("b"), 20);
        assert_eq!(clean_cache(&dir), 320);
        assert!(dir.join("Cookies").is_file());
        assert!(dir.join("claude-code").join("bin").is_file());
        assert!(!dir.join("Cache").exists());
        assert_eq!(clean_cache(&dir), 0);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_symlinks_out_of_the_profile() {
        let home = temp_home("link");
        let outside = home.join("outside");
        write(&outside.join("keep"), 500);
        let dir = profiles_root(&home).join("claude-1");
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("Cache")).unwrap();
        assert_eq!(dir_size(&dir), 0);
        assert_eq!(clean_cache(&dir), 0);
        assert!(outside.join("keep").is_file());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn reset_refuses_anything_but_a_real_hive_profile() {
        let home = temp_home("reset");
        let original = original_profile(&home);
        write(&original.join("Cookies"), 10);
        let root = profiles_root(&home);
        std::fs::create_dir_all(&root).unwrap();

        // Hồ sơ của gói là symlink tới hồ sơ gốc: không xoá.
        let linked = root.join("claude-1");
        std::os::unix::fs::symlink(&original, &linked).unwrap();
        assert!(safe_to_remove(&home, &linked).is_err());

        // Thư mục hồ sơ của Hive bị trỏ vào hồ sơ gốc: hồ sơ của gói nằm trong hồ sơ gốc, không xoá.
        let home2 = temp_home("reset2");
        let original2 = original_profile(&home2);
        std::fs::create_dir_all(original2.join("claude-2")).unwrap();
        std::fs::create_dir_all(home2.join(".xdev-hive")).unwrap();
        std::os::unix::fs::symlink(&original2, profiles_root(&home2)).unwrap();
        assert!(safe_to_remove(&home2, &profiles_root(&home2).join("claude-2")).is_err());

        assert!(safe_to_remove(&home, &home.join("elsewhere")).is_err());
        let real = root.join("claude-3");
        write(&real.join("Cookies"), 10);
        assert!(safe_to_remove(&home, &real).is_ok());
        assert!(original.join("Cookies").is_file());
        std::fs::remove_dir_all(&home).unwrap();
        std::fs::remove_dir_all(&home2).unwrap();
    }

    #[test]
    fn tray_label_shows_email_and_open_mark() {
        let mut p = ProfileView {
            id: "claude-1".into(),
            label: "Duy Max".into(),
            email: Some("duy@fpt.com".into()),
            dir: String::new(),
            used: true,
            bytes: 0,
            cache_bytes: 0,
            pid: None,
        };
        assert_eq!(tray_label(&p, false), "Duy Max (duy@fpt.com)");
        p.pid = Some(1);
        assert_eq!(tray_label(&p, false), "Duy Max (duy@fpt.com) · đang mở");
        assert_eq!(tray_label(&p, true), "Duy Max (duy@fpt.com) · open");
    }
}
