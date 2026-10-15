//! Chuyển Claude Desktop (Claude.app) giữa các gói Claude của máy. Mọi gói dùng chung MỘT hồ sơ thật
//! `~/Library/Application Support/Claude`: chuyển gói chỉ đổi phần xác thực tài khoản, còn MCP, sessions, dự án, cấu
//! hình trên máy giữ nguyên. Mỗi gói chỉ lưu "bộ xác thực" của nó ở `~/.xdev-hive/claude-desktop/<id>/auth`.
//!
//! Tập file xác thực đã thử trên Claude.app 2.37337.1 (macOS), bằng bản chép của hồ sơ thật mở với `--user-data-dir`:
//! - Bỏ `Cookies` (+ `Cookies-journal`) và ba khoá `oauth:tokenCache`, `oauth:tokenCacheV2`, `lastKnownAccountUuid` của
//!   `config.json` thì app mở ở màn đăng nhập, dù Local Storage, IndexedDB, Session Storage còn nguyên.
//! - Giữ `Cookies` mà bỏ token trong `config.json`: phần web vẫn đăng nhập nhưng app đòi "sign in again".
//! - Chép đúng tập đó từ hồ sơ khác vào bản đã đăng xuất: đăng nhập đủ, sessions và dự án trên máy còn nguyên.
//! - Lúc đăng xuất app cắt `preferences` của `claude_desktop_config.json` (khoá theo tài khoản như
//!   `epitaxy-folder-permission-mode.<uuid>`) và đăng nhập lại không lấy lại hết, nên `preferences` đi cùng bộ xác thực.
//!   Các khoá khác của file đó (`mcpServers`…) dùng chung.
//!
//! Cookies và token mã hoá bằng khoá keychain "Claude Safe Storage" chung của app, nên bộ của gói này chép sang vẫn giải
//! mã được. Sessions (`claude-code-sessions/<tài khoản>/<tổ chức>`…) vốn tách theo tài khoản nên để nguyên.
//!
//! Chỉ ghi vào hồ sơ thật khi Claude.app đã thoát (app giữ Cookies và config.json đang mở, lúc thoát còn ghi lại). Lần
//! đầu chuyển, cả hồ sơ thật (trừ cache) được sao lưu sang `backup-<ngày>`; ngoài tập xác thực không file nào của hồ sơ
//! thật bị ghi hay xoá.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::AppHandle;

use crate::profiles::home_dir;
use crate::sidecar_json;

/// Thư mục Chromium tự dựng lại khi thiếu, và `claude-code` (bản Claude Code app tự tải, vài trăm MB, thiếu thì app tải
/// lại): không chép vào bản sao lưu.
const SKIP_IN_BACKUP: [&str; 10] = [
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GraphiteDawnCache",
    "GPUPersistentCache",
    "ShaderCache",
    "GrShaderCache",
    "claude-code",
];

/// File SQLite giữ phiên claude.ai. Journal đi cùng: journal cũ nằm lại cạnh Cookies của tài khoản khác sẽ làm hỏng nó.
const AUTH_FILES: [&str; 2] = ["Cookies", "Cookies-journal"];
/// Khoá của `config.json` giữ token OAuth của app và tài khoản đang đăng nhập; các khoá khác dùng chung.
const AUTH_KEYS: [&str; 3] = [
    "oauth:tokenCache",
    "oauth:tokenCacheV2",
    "lastKnownAccountUuid",
];
const CONFIG: &str = "config.json";
const DESKTOP_CONFIG: &str = "claude_desktop_config.json";
const PREFS_KEY: &str = "preferences";
/// `preferences` của gói trong bộ xác thực (hồ sơ thật giữ nó trong `claude_desktop_config.json`).
const BUNDLE_PREFS: &str = "preferences.json";

const BUNDLE_ID: &str = "com.anthropic.claudefordesktop";
/// Thoát êm có thể chậm khi app còn đang ghi; quá hạn thì hỏi người dùng có buộc thoát không.
const QUIT_WAIT: Duration = Duration::from_secs(20);

const UNSUPPORTED: &str =
    "Chưa hỗ trợ chuyển tài khoản Claude Desktop trên hệ điều hành này (mới có cho macOS).";
const NOT_INSTALLED: &str = "Chưa thấy Claude Desktop trong /Applications hay ~/Applications. Cài Claude Desktop rồi thử lại.";

/// Một lần chuyển một lúc: hai lần chuyển chồng nhau sẽ cùng ghi hồ sơ thật.
static SWITCHING: Mutex<()> = Mutex::new(());

pub(crate) fn profiles_root(home: &Path) -> PathBuf {
    home.join(".xdev-hive").join("claude-desktop")
}

/// Hồ sơ của chính Claude Desktop, dùng chung cho mọi gói.
fn real_profile(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("Claude")
}

/// Id gói đi vào đường dẫn: chỉ nhận dạng id worker tạo (`claude-2`), để `..` hay `/` không đưa ra ngoài thư mục của
/// Hive. `backup-…` là tên bản sao lưu nằm cùng thư mục.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('.')
        && !id.starts_with("backup-")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// Đường dẫn của Hive và hồ sơ thật; test dựng bằng thư mục nhà giả.
struct Paths {
    real: PathBuf,
    root: PathBuf,
}

impl Paths {
    fn new(home: &Path) -> Self {
        Self {
            real: real_profile(home),
            root: profiles_root(home),
        }
    }

    fn bundle(&self, id: &str) -> Result<PathBuf, String> {
        if !valid_id(id) {
            return Err(format!("Id gói không hợp lệ: {id}"));
        }
        Ok(self.root.join(id).join("auth"))
    }

    /// Bộ xác thực của hồ sơ thật ngay trước lần chuyển gần nhất: chép vào hỏng giữa chừng thì lấy lại từ đây.
    fn previous(&self) -> PathBuf {
        self.root.join(".previous").join("auth")
    }

    fn state(&self) -> PathBuf {
        self.root.join(".state.json")
    }
}

/// Gói đang dùng Claude Desktop và bản sao lưu lần đầu.
#[derive(Serialize, Deserialize, Default, Debug, PartialEq, Eq)]
struct State {
    #[serde(default)]
    active: Option<String>,
    /// Tên thư mục sao lưu trong thư mục của Hive.
    #[serde(default)]
    backup: Option<String>,
}

fn read_state(paths: &Paths) -> State {
    std::fs::read(paths.state())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_state(paths: &Paths, state: &State) -> Result<(), String> {
    create_private_dir(&paths.root).map_err(|e| format!("Không tạo được thư mục của Hive: {e}"))?;
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    write_atomic(&paths.state(), &bytes).map_err(|e| format!("Không lưu được trạng thái: {e}"))
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    // Bộ xác thực chứa cookie và token đăng nhập: chỉ người dùng hiện tại đọc được.
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

#[cfg(unix)]
fn make_private(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn make_private(_: &Path) -> std::io::Result<()> {
    Ok(())
}

fn tmp_of(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".hive-tmp");
    path.with_file_name(name)
}

/// Ghi qua file tạm cùng thư mục rồi đổi tên: app đọc file sau đó thấy bản cũ hoặc bản mới, không thấy bản ghi dở.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = tmp_of(path);
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    make_private(&tmp)?;
    std::fs::rename(&tmp, path)
}

fn copy_atomic(from: &Path, to: &Path) -> std::io::Result<()> {
    let tmp = tmp_of(to);
    std::fs::copy(from, &tmp)?;
    std::fs::File::open(&tmp)?.sync_all()?;
    make_private(&tmp)?;
    std::fs::rename(&tmp, to)
}

fn is_real_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
}

/// Đối tượng JSON trong file; thiếu file là đối tượng rỗng. File có mà không đọc được thì báo lỗi, để không ghi đè cấu
/// hình của người dùng bằng một bản thiếu.
fn read_object(path: &Path) -> Result<Map<String, Value>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(format!("Không đọc được {}: {e}", path.display())),
    };
    match serde_json::from_slice(&bytes) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(format!(
            "{} không phải JSON hợp lệ; không sửa.",
            path.display()
        )),
    }
}

/// Phần xác thực đọc từ một hồ sơ đầy đủ (hồ sơ thật, bản sao lưu, hồ sơ riêng kiểu cũ) hay từ một bộ xác thực.
struct Auth {
    dir: PathBuf,
    config: Map<String, Value>,
    prefs: Option<Value>,
}

fn read_auth(dir: &Path) -> Result<Auth, String> {
    let config = read_object(&dir.join(CONFIG))?
        .into_iter()
        .filter(|(k, _)| AUTH_KEYS.contains(&k.as_str()))
        .collect();
    let prefs = if is_real_file(&dir.join(BUNDLE_PREFS)) {
        let bytes = std::fs::read(dir.join(BUNDLE_PREFS)).map_err(|e| e.to_string())?;
        Some(serde_json::from_slice(&bytes).map_err(|e| e.to_string())?)
    } else {
        read_object(&dir.join(DESKTOP_CONFIG))?.remove(PREFS_KEY)
    };
    Ok(Auth {
        dir: dir.to_path_buf(),
        config,
        prefs,
    })
}

/// Gỡ thư mục của Hive (bộ tạm, bộ cũ); symlink thì chỉ gỡ link.
fn remove_entry(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Lưu bộ xác thực của hồ sơ `from` vào `dest`: dựng ở thư mục tạm rồi đổi tên, nên `dest` luôn là một bộ đủ.
fn save_auth(from: &Path, dest: &Path) -> Result<(), String> {
    let auth = read_auth(from)?;
    let parent = dest.parent().ok_or("Đường dẫn bộ xác thực không hợp lệ.")?;
    create_private_dir(parent).map_err(|e| e.to_string())?;
    let tmp = tmp_of(dest);
    remove_entry(&tmp).map_err(|e| e.to_string())?;
    let built = (|| -> std::io::Result<()> {
        create_private_dir(&tmp)?;
        for name in AUTH_FILES {
            if is_real_file(&from.join(name)) {
                std::fs::copy(from.join(name), tmp.join(name))?;
                make_private(&tmp.join(name))?;
            }
        }
        write_atomic(&tmp.join(CONFIG), &serde_json::to_vec_pretty(&auth.config)?)?;
        if let Some(prefs) = &auth.prefs {
            write_atomic(&tmp.join(BUNDLE_PREFS), &serde_json::to_vec_pretty(prefs)?)?;
        }
        Ok(())
    })();
    if let Err(e) = built {
        let _ = remove_entry(&tmp);
        return Err(format!("Không lưu được bộ đăng nhập: {e}"));
    }
    let mut old = dest.as_os_str().to_os_string();
    old.push(".old");
    let old = PathBuf::from(old);
    let swapped = (|| -> std::io::Result<()> {
        remove_entry(&old)?;
        if std::fs::symlink_metadata(dest).is_ok() {
            std::fs::rename(dest, &old)?;
        }
        std::fs::rename(&tmp, dest)?;
        remove_entry(&old)
    })();
    swapped.map_err(|e| format!("Không lưu được bộ đăng nhập: {e}"))
}

/// Đưa bộ xác thực `from` vào hồ sơ thật. File xác thực không có trong bộ thì bị gỡ khỏi hồ sơ (gói chưa đăng nhập mở
/// ở màn đăng nhập); `preferences` không có trong bộ thì để nguyên. Đọc và kiểm hết trước khi ghi file đầu tiên.
fn load_auth(from: &Path, real: &Path) -> Result<(), String> {
    let auth = if from.exists() {
        read_auth(from)?
    } else {
        Auth {
            dir: from.to_path_buf(),
            config: Map::new(),
            prefs: None,
        }
    };
    let mut config = read_object(&real.join(CONFIG))?;
    for key in AUTH_KEYS {
        config.remove(key);
    }
    config.extend(auth.config);
    let desktop = match auth.prefs {
        Some(prefs) => {
            let mut d = read_object(&real.join(DESKTOP_CONFIG))?;
            d.insert(PREFS_KEY.into(), prefs);
            Some(d)
        }
        None => None,
    };
    let written = (|| -> std::io::Result<()> {
        for name in AUTH_FILES {
            let src = auth.dir.join(name);
            if is_real_file(&src) {
                copy_atomic(&src, &real.join(name))?;
            } else if std::fs::symlink_metadata(real.join(name)).is_ok() {
                std::fs::remove_file(real.join(name))?;
            }
        }
        write_atomic(&real.join(CONFIG), &serde_json::to_vec_pretty(&config)?)?;
        if let Some(d) = &desktop {
            write_atomic(&real.join(DESKTOP_CONFIG), &serde_json::to_vec_pretty(d)?)?;
        }
        Ok(())
    })();
    written.map_err(|e| format!("Không ghi được đăng nhập vào hồ sơ Claude Desktop: {e}"))
}

/// Chép cả cây, symlink giữ nguyên là symlink (không đi theo ra ngoài hồ sơ), bỏ cache ở cấp đầu.
fn copy_tree(from: &Path, to: &Path, top: bool) -> std::io::Result<()> {
    create_private_dir(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if top && SKIP_IN_BACKUP.iter().any(|s| name == *s) {
            continue;
        }
        let meta = std::fs::symlink_metadata(entry.path())?;
        let dest = to.join(&name);
        if meta.file_type().is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(std::fs::read_link(entry.path())?, &dest)?;
        } else if meta.is_dir() {
            copy_tree(&entry.path(), &dest, false)?;
        } else if meta.is_file() {
            std::fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}

/// `backup-20261015-132200` theo giờ UTC: tên sắp đúng thứ tự thời gian và không trùng khi sao lưu lại cùng ngày.
fn backup_name(now: SystemTime) -> String {
    let secs = now.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let (days, rest) = ((secs / 86_400) as i64, secs % 86_400);
    // Đổi số ngày từ 1970 ra ngày tháng năm (thuật toán civil_from_days của Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "backup-{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// Sao lưu cả hồ sơ thật (trừ cache) một lần, trước lần ghi đầu tiên vào hồ sơ.
fn ensure_backup(paths: &Paths, state: &mut State, now: SystemTime) -> Result<(), String> {
    if state
        .backup
        .as_ref()
        .is_some_and(|b| paths.root.join(b).is_dir())
    {
        return Ok(());
    }
    if !paths.real.is_dir() {
        return Ok(());
    }
    let name = backup_name(now);
    let dest = paths.root.join(&name);
    let tmp = tmp_of(&dest);
    remove_entry(&tmp).map_err(|e| e.to_string())?;
    if let Err(e) = copy_tree(&paths.real, &tmp, true).and_then(|_| std::fs::rename(&tmp, &dest)) {
        let _ = remove_entry(&tmp);
        return Err(format!("Không sao lưu được hồ sơ Claude Desktop: {e}"));
    }
    state.backup = Some(name);
    write_state(paths, state)
}

/// Đổi tài khoản của hồ sơ thật sang gói `target` (None: về đăng nhập lúc chưa dùng tính năng này, lấy từ bản sao
/// lưu). Claude.app phải đã thoát.
fn swap_auth(
    paths: &Paths,
    state: &mut State,
    target: Option<&str>,
    now: SystemTime,
) -> Result<(), String> {
    let source = match target {
        Some(id) => paths.bundle(id)?,
        None => paths.root.join(
            state
                .backup
                .as_deref()
                .ok_or("Chưa có bản sao lưu ban đầu để khôi phục.")?,
        ),
    };
    ensure_backup(paths, state, now)?;
    std::fs::create_dir_all(&paths.real)
        .map_err(|e| format!("Không tạo được hồ sơ Claude Desktop: {e}"))?;
    save_auth(&paths.real, &paths.previous())?;
    if let Some(active) = &state.active {
        save_auth(&paths.real, &paths.bundle(active)?)?;
    }
    if let Err(e) = load_auth(&source, &paths.real) {
        let _ = load_auth(&paths.previous(), &paths.real);
        return Err(e);
    }
    state.active = target.map(str::to_string);
    write_state(paths, state)
}

fn has_login(bundle: &Path) -> bool {
    is_real_file(&bundle.join("Cookies"))
}

/// Thư mục gói còn dạng hồ sơ riêng `--user-data-dir` của bản trước: có file Chromium nằm thẳng trong đó.
fn legacy_profiles(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return vec![];
    };
    let mut out: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|id| valid_id(id))
        .filter(|id| {
            let dir = root.join(id);
            ["Cookies", "Local State", "Preferences"]
                .iter()
                .any(|f| dir.join(f).exists())
        })
        .collect();
    out.sort();
    out
}

/// Đổi hồ sơ riêng kiểu cũ của một gói thành bộ xác thực: giữ đăng nhập (nếu gói chưa có bộ), bỏ phần còn lại.
fn migrate_legacy(paths: &Paths, id: &str) -> Result<(), String> {
    let bundle = paths.bundle(id)?;
    let dir = bundle.parent().ok_or("Đường dẫn gói không hợp lệ.")?;
    let meta = std::fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("Hồ sơ cũ không phải thư mục thật; không đụng tới.".into());
    }
    let real = dir.canonicalize().map_err(|e| e.to_string())?;
    let original = paths.real.canonicalize().unwrap_or(paths.real.clone());
    if real.starts_with(&original) || original.starts_with(&real) {
        return Err("Thư mục trỏ vào hồ sơ thật của Claude Desktop; không đụng tới.".into());
    }
    if has_login(dir) && !has_login(&bundle) {
        save_auth(dir, &bundle)?;
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() == "auth" {
            continue;
        }
        remove_entry(&entry.path())
            .map_err(|e| format!("Không dọn được hồ sơ cũ của {id}: {e}"))?;
    }
    Ok(())
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

/// Tiến trình chính của Claude.app từ `ps -axo pid=,command=`, chia theo hồ sơ: dùng hồ sơ thật (không có
/// `--user-data-dir`) hay hồ sơ riêng kiểu cũ của Hive (id gói). Tiến trình phụ của Electron (`--type=renderer`…) bỏ qua.
#[derive(Default, Debug, PartialEq, Eq)]
struct Running {
    real: Vec<u32>,
    legacy: HashMap<String, u32>,
}

fn running_in(ps: &str, root: &Path) -> Running {
    let marker = format!("--user-data-dir={}/", root.display());
    let mut out = Running::default();
    for line in ps.lines() {
        let line = line.trim_start();
        let Some((pid, command)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let Ok(pid) = pid.parse::<u32>() else {
            continue;
        };
        let main = command.ends_with("Claude.app/Contents/MacOS/Claude")
            || command.contains("Claude.app/Contents/MacOS/Claude ");
        if !main || command.contains("--type=") {
            continue;
        }
        if !command.contains("--user-data-dir=") {
            out.real.push(pid);
            continue;
        }
        let Some(start) = command.find(&marker) else {
            continue;
        };
        let rest = &command[start + marker.len()..];
        let id = rest.split(char::is_whitespace).next().unwrap_or("");
        let id = id.trim_end_matches('/');
        if valid_id(id) {
            out.legacy.entry(id.to_string()).or_insert(pid);
        }
    }
    out
}

fn running(home: &Path) -> Running {
    let Ok(out) = Command::new("ps").args(["-axo", "pid=,command="]).output() else {
        return Running::default();
    };
    running_in(&String::from_utf8_lossy(&out.stdout), &profiles_root(home))
}

fn wait_gone(home: &Path, within: Duration) -> bool {
    let until = Instant::now() + within;
    loop {
        if running(home).real.is_empty() {
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Thoát Claude Desktop bằng lệnh Quit của AppleScript như Cmd+Q, để app tự lưu và đóng file. `force` (người dùng đã
/// đồng ý) thì quá hạn sẽ gửi SIGTERM rồi SIGKILL. Trả false khi app vẫn chạy.
fn quit_app(home: &Path, force: bool) -> Result<bool, String> {
    let now = running(home);
    if let Some(id) = now.legacy.keys().next() {
        return Err(format!(
            "Claude Desktop đang mở bằng hồ sơ riêng (bản cũ) của gói {id}. Thoát cửa sổ đó (Cmd+Q) rồi thử lại."
        ));
    }
    if now.real.is_empty() {
        return Ok(true);
    }
    // osascript chờ app trả lời; app hỏi lại trước khi thoát thì lệnh treo, nên không chờ nó mà dò tiến trình.
    let mut script = Command::new("osascript")
        .args([
            "-e",
            &format!("tell application id \"{BUNDLE_ID}\" to quit"),
        ])
        .spawn()
        .map_err(|e| format!("Không gửi được lệnh thoát cho Claude Desktop: {e}"))?;
    let gone = wait_gone(home, QUIT_WAIT);
    if script.try_wait().ok().flatten().is_none() {
        let _ = script.kill();
    }
    let _ = script.wait();
    if gone || !force {
        return Ok(gone);
    }
    for signal in ["-TERM", "-KILL"] {
        for pid in running(home).real {
            let _ = Command::new("kill")
                .args([signal, &pid.to_string()])
                .status();
        }
        if wait_gone(home, Duration::from_secs(5)) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn launch(bundle: &Path) -> Result<(), String> {
    let status = Command::new("open")
        .arg("-a")
        .arg(bundle)
        .status()
        .map_err(|e| format!("Không mở được Claude Desktop: {e}"))?;
    if !status.success() {
        return Err("Không mở được Claude Desktop.".into());
    }
    Ok(())
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
    /// Đã lưu đăng nhập Claude Desktop của gói; chưa thì chuyển sang sẽ mở ở màn đăng nhập.
    saved: bool,
    /// Gói Claude Desktop đang dùng.
    pub(crate) active: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfilesView {
    supported: bool,
    /// Claude.app tìm thấy; None khi chưa cài.
    pub(crate) app: Option<String>,
    /// Vì sao chưa chuyển được (chưa hỗ trợ, chưa cài); None khi chuyển được.
    note: Option<String>,
    /// PID Claude Desktop đang chạy bằng hồ sơ thật.
    running: Option<u32>,
    /// Bản sao lưu cả hồ sơ lúc mới dùng; None khi chưa chuyển lần nào.
    backup: Option<String>,
    /// Gói còn hồ sơ riêng kiểu cũ (`--user-data-dir`) cần đổi sang bộ xác thực.
    legacy: Vec<String>,
    pub(crate) profiles: Vec<ProfileView>,
}

fn view(
    paths: &Paths,
    plans: &[Plan],
    app: Option<&Path>,
    supported: bool,
    pid: Option<u32>,
) -> ProfilesView {
    let state = read_state(paths);
    let profiles = plans
        .iter()
        .filter(|p| p.cli == "claude" && valid_id(&p.id))
        .map(|p| ProfileView {
            id: p.id.clone(),
            label: if p.label.trim().is_empty() {
                p.id.clone()
            } else {
                p.label.clone()
            },
            email: p.email.clone().filter(|e| !e.is_empty()),
            saved: paths.bundle(&p.id).is_ok_and(|b| has_login(&b)),
            active: state.active.as_deref() == Some(p.id.as_str()),
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
        note,
        running: pid,
        backup: state
            .backup
            .map(|b| paths.root.join(b))
            .filter(|b| b.is_dir())
            .map(|b| b.display().to_string()),
        legacy: legacy_profiles(&paths.root),
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

/// Gói Claude của máy, gói Claude Desktop đang dùng và bản sao lưu. Cũng làm mới mục "Chuyển Claude Desktop sang…" của
/// khay, để khay theo kịp khi người dùng thêm hay xoá gói.
pub(crate) async fn load(app: &AppHandle) -> Result<ProfilesView, String> {
    let plans = claude_plans(app).await?;
    let home = need_home()?;
    let v = tauri::async_runtime::spawn_blocking(move || {
        let supported = cfg!(target_os = "macos");
        let bundle = if supported { find_app(&home) } else { None };
        let pid = if supported {
            running(&home).real.first().copied()
        } else {
            None
        };
        view(
            &Paths::new(&home),
            &plans,
            bundle.as_deref(),
            supported,
            pid,
        )
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

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SwitchStatus {
    Switched,
    /// Gói đã là gói đang dùng; chỉ mở Claude Desktop nếu đang tắt.
    Already,
    /// Claude Desktop chưa thoát sau thời gian chờ: chưa đổi gì, hỏi người dùng có buộc thoát không.
    StillRunning,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Switched {
    pub(crate) status: SwitchStatus,
    /// Gói chưa lưu đăng nhập: Claude Desktop mở ở màn đăng nhập.
    pub(crate) needs_login: bool,
}

/// Chuyển Claude Desktop sang gói `target` (None: khôi phục đăng nhập ban đầu): thoát app, đổi bộ xác thực, mở lại.
fn switch_blocking(home: &Path, target: Option<&str>, force: bool) -> Result<Switched, String> {
    let _guard = SWITCHING
        .try_lock()
        .map_err(|_| "Đang chuyển Claude Desktop; chờ lần chuyển trước xong.".to_string())?;
    let bundle = find_app(home).ok_or(NOT_INSTALLED)?;
    let paths = Paths::new(home);
    let mut state = read_state(&paths);
    let needs_login = match target {
        Some(id) => !has_login(&paths.bundle(id)?),
        None => false,
    };
    if target.is_some() && state.active.as_deref() == target {
        if running(home).real.is_empty() {
            launch(&bundle)?;
        }
        return Ok(Switched {
            status: SwitchStatus::Already,
            needs_login: false,
        });
    }
    // Kiểm trước khi thoát app: thiếu bản sao lưu thì đừng tắt Claude Desktop của người dùng vô ích.
    if target.is_none()
        && !state
            .backup
            .as_ref()
            .is_some_and(|b| paths.root.join(b).is_dir())
    {
        return Err("Chưa có bản sao lưu ban đầu để khôi phục.".into());
    }
    if !quit_app(home, force)? {
        return Ok(Switched {
            status: SwitchStatus::StillRunning,
            needs_login,
        });
    }
    // Đổi hỏng thì hồ sơ đã về đăng nhập cũ (swap_auth tự lấy lại): vẫn mở lại app như trước khi bấm.
    let swapped = swap_auth(&paths, &mut state, target, SystemTime::now());
    launch(&bundle)?;
    swapped?;
    Ok(Switched {
        status: SwitchStatus::Switched,
        needs_login,
    })
}

/// Chuyển Claude Desktop sang một gói Claude. Cửa sổ chỉ gửi id gói; đường dẫn do Rust dựng.
pub(crate) async fn switch(app: &AppHandle, id: &str, force: bool) -> Result<Switched, String> {
    if !cfg!(target_os = "macos") {
        return Err(UNSUPPORTED.into());
    }
    let id = id.trim().to_string();
    let plans = claude_plans(app).await?;
    if !plans.iter().any(|p| p.id == id && p.cli == "claude") {
        return Err(format!("Không có gói Claude {id}."));
    }
    let home = need_home()?;
    let done =
        tauri::async_runtime::spawn_blocking(move || switch_blocking(&home, Some(&id), force))
            .await
            .map_err(|e| e.to_string())??;
    let _ = load(app).await;
    Ok(done)
}

#[tauri::command]
pub async fn switch_claude_desktop(
    app: AppHandle,
    profile_id: String,
    force: bool,
) -> Result<Switched, String> {
    switch(&app, &profile_id, force).await
}

/// Về đăng nhập trước khi dùng tính năng này (lấy từ bản sao lưu ban đầu). Đăng nhập hiện tại lưu vào gói đang dùng.
#[tauri::command]
pub async fn restore_claude_desktop(app: AppHandle, force: bool) -> Result<Switched, String> {
    if !cfg!(target_os = "macos") {
        return Err(UNSUPPORTED.into());
    }
    let home = need_home()?;
    let done = tauri::async_runtime::spawn_blocking(move || switch_blocking(&home, None, force))
        .await
        .map_err(|e| e.to_string())??;
    let _ = load(&app).await;
    Ok(done)
}

/// Ghi nhận Claude Desktop đang đăng nhập đúng gói này (lúc mới dùng tính năng), để lần chuyển sau lưu đăng nhập hiện
/// tại vào gói thay vì bắt đăng nhập lại. Không ghi gì vào hồ sơ thật.
#[tauri::command]
pub async fn adopt_claude_desktop(
    app: AppHandle,
    profile_id: String,
) -> Result<ProfilesView, String> {
    let home = need_home()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let paths = Paths::new(&home);
        let id = profile_id.trim();
        paths.bundle(id)?;
        let mut state = read_state(&paths);
        if state.active.is_some() {
            return Err("Đã có gói đang dùng Claude Desktop; dùng nút chuyển gói.".into());
        }
        state.active = Some(id.to_string());
        write_state(&paths, &state)
    })
    .await
    .map_err(|e| e.to_string())??;
    load(&app).await
}

/// Xoá đăng nhập Claude Desktop đã lưu của một gói không dùng; lần chuyển sau sang gói đó phải đăng nhập lại.
#[tauri::command]
pub async fn forget_claude_desktop(
    app: AppHandle,
    profile_id: String,
) -> Result<ProfilesView, String> {
    let home = need_home()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let paths = Paths::new(&home);
        let id = profile_id.trim();
        let bundle = paths.bundle(id)?;
        if read_state(&paths).active.as_deref() == Some(id) {
            return Err("Gói này đang dùng Claude Desktop; chuyển sang gói khác trước.".into());
        }
        remove_entry(&bundle).map_err(|e| format!("Không xoá được đăng nhập đã lưu: {e}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    load(&app).await
}

/// Đổi mọi hồ sơ riêng kiểu cũ thành bộ xác thực (người dùng đã đồng ý bỏ phần còn lại của các hồ sơ đó).
#[tauri::command]
pub async fn migrate_claude_desktop_profiles(app: AppHandle) -> Result<ProfilesView, String> {
    let home = need_home()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let paths = Paths::new(&home);
        let open = running(&home).legacy;
        for id in legacy_profiles(&paths.root) {
            if open.contains_key(&id) {
                return Err(format!(
                    "Claude Desktop đang mở bằng hồ sơ riêng của gói {id}. Thoát cửa sổ đó (Cmd+Q) rồi thử lại."
                ));
            }
            migrate_legacy(&paths, &id)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    load(&app).await
}

/// Chữ của một mục khay: tên gói, email nếu có, và dấu đang dùng.
pub(crate) fn tray_label(p: &ProfileView, en: bool) -> String {
    let mut s = p.label.clone();
    if let Some(email) = &p.email
        && email != &p.label
    {
        s.push_str(&format!(" ({email})"));
    }
    if p.active {
        s.push_str(if en { " · in use" } else { " · đang dùng" });
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

    fn put(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn json(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    /// Hồ sơ giả đủ file xác thực và file dùng chung, đăng nhập tài khoản `who`.
    fn fake_profile(dir: &Path, who: &str) {
        put(&dir.join("Cookies"), &format!("cookies-{who}"));
        put(&dir.join("Cookies-journal"), "");
        put(
            &dir.join(CONFIG),
            &serde_json::json!({
                "oauth:tokenCache": format!("v10-{who}"),
                "oauth:tokenCacheV2": format!("v10b-{who}"),
                "lastKnownAccountUuid": format!("uuid-{who}"),
                "locale": "vi-VN",
                "bootFrameLayout": {"sidebarWidth": 280},
            })
            .to_string(),
        );
        put(
            &dir.join(DESKTOP_CONFIG),
            &serde_json::json!({
                "mcpServers": {"hive": {"command": "hive"}},
                "coworkUserFilesPath": "/Users/a/Claude",
                "preferences": {"sidebarMode": format!("mode-{who}")},
            })
            .to_string(),
        );
        put(
            &dir.join("claude-code-sessions/uuid-a/org/s.json"),
            "session A",
        );
        put(&dir.join("local-agent-mode-sessions/x.json"), "agent");
        put(&dir.join("Local Storage/leveldb/000005.ldb"), "ls");
        put(&dir.join("IndexedDB/https_claude.ai_0/a.log"), "idb");
        put(&dir.join("Cache/Cache_Data/big"), "cache");
        put(&dir.join("claude-code/2.1/claude"), "binary");
    }

    /// Mọi file dùng chung của hồ sơ, để so trước và sau khi chuyển.
    fn shared(dir: &Path) -> Vec<(String, String)> {
        let mut out = vec![];
        for f in [
            "claude-code-sessions/uuid-a/org/s.json",
            "local-agent-mode-sessions/x.json",
            "Local Storage/leveldb/000005.ldb",
            "IndexedDB/https_claude.ai_0/a.log",
            "Cache/Cache_Data/big",
        ] {
            out.push((f.to_string(), read(&dir.join(f))));
        }
        let mut config = json(&dir.join(CONFIG));
        for k in AUTH_KEYS {
            config.as_object_mut().unwrap().remove(k);
        }
        out.push((CONFIG.into(), config.to_string()));
        let mut desktop = json(&dir.join(DESKTOP_CONFIG));
        desktop.as_object_mut().unwrap().remove(PREFS_KEY);
        out.push((DESKTOP_CONFIG.into(), desktop.to_string()));
        out
    }

    fn account(dir: &Path) -> (String, Value, Value) {
        let c = json(&dir.join(CONFIG));
        (
            read(&dir.join("Cookies")),
            c["oauth:tokenCacheV2"].clone(),
            json(&dir.join(DESKTOP_CONFIG))["preferences"]["sidebarMode"].clone(),
        )
    }

    fn no_temp_files(dir: &Path) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let name = entry.unwrap().file_name().into_string().unwrap();
            assert!(!name.ends_with(".hive-tmp"), "{name}");
            assert!(!name.ends_with(".old"), "{name}");
        }
    }

    const T0: Duration = Duration::from_secs(1_791_984_120); // 2026-10-14 13:22:00 UTC

    #[test]
    fn ids_stay_under_hive_and_skip_reserved_names() {
        let paths = Paths::new(Path::new("/Users/a"));
        assert_eq!(
            paths.bundle("claude-2").unwrap(),
            Path::new("/Users/a/.xdev-hive/claude-desktop/claude-2/auth")
        );
        for bad in [
            "",
            "..",
            "../x",
            "a/b",
            "a\\b",
            ".previous",
            "backup-20261015",
            "x y",
            &"a".repeat(65),
        ] {
            assert!(paths.bundle(bad).is_err(), "{bad:?}");
        }
        assert!(!paths.real.starts_with(&paths.root));
    }

    #[test]
    fn backup_name_is_sortable_utc_time() {
        assert_eq!(backup_name(UNIX_EPOCH + T0), "backup-20261014-132200");
        assert_eq!(backup_name(UNIX_EPOCH), "backup-19700101-000000");
        // 29/02 của năm nhuận.
        assert_eq!(
            backup_name(UNIX_EPOCH + Duration::from_secs(1_709_164_800)),
            "backup-20240229-000000"
        );
    }

    #[test]
    fn switching_a_b_a_swaps_only_the_login() {
        let home = temp_home("switch");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "a");
        let before = shared(&paths.real);
        // Gói B đã đăng nhập từ trước: bộ của B lấy từ một hồ sơ khác.
        let other = home.join("other");
        fake_profile(&other, "b");
        save_auth(&other, &paths.bundle("claude-2").unwrap()).unwrap();

        let mut state = State {
            active: Some("claude-1".into()),
            backup: None,
        };
        swap_auth(&paths, &mut state, Some("claude-2"), UNIX_EPOCH + T0).unwrap();
        assert_eq!(state.active.as_deref(), Some("claude-2"));
        assert_eq!(
            account(&paths.real),
            ("cookies-b".into(), "v10b-b".into(), "mode-b".into())
        );
        assert_eq!(
            json(&paths.real.join(CONFIG))["lastKnownAccountUuid"],
            "uuid-b"
        );
        assert_eq!(shared(&paths.real), before, "file dùng chung giữ nguyên");
        // Đăng nhập của A đã lưu vào gói A.
        let a = paths.bundle("claude-1").unwrap();
        assert_eq!(read(&a.join("Cookies")), "cookies-a");
        assert_eq!(json(&a.join(CONFIG))["oauth:tokenCache"], "v10-a");
        assert_eq!(json(&a.join(BUNDLE_PREFS))["sidebarMode"], "mode-a");
        assert!(
            json(&a.join(CONFIG)).get("locale").is_none(),
            "bộ chỉ có khoá xác thực"
        );

        swap_auth(&paths, &mut state, Some("claude-1"), UNIX_EPOCH + T0).unwrap();
        assert_eq!(
            account(&paths.real),
            ("cookies-a".into(), "v10b-a".into(), "mode-a".into())
        );
        assert_eq!(shared(&paths.real), before);
        assert_eq!(read_state(&paths), state);
        no_temp_files(&paths.real);
        no_temp_files(&paths.root.join("claude-1"));
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn plan_without_login_opens_signed_out_and_keeps_everything_else() {
        let home = temp_home("signin");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "a");
        let before = shared(&paths.real);
        let mut state = State::default();
        swap_auth(&paths, &mut state, Some("claude-3"), UNIX_EPOCH + T0).unwrap();
        assert!(!paths.real.join("Cookies").exists());
        assert!(!paths.real.join("Cookies-journal").exists());
        let config = json(&paths.real.join(CONFIG));
        for k in AUTH_KEYS {
            assert!(config.get(k).is_none(), "{k}");
        }
        // preferences để nguyên cho app tự xử lý lúc đăng nhập.
        assert_eq!(
            json(&paths.real.join(DESKTOP_CONFIG))["preferences"]["sidebarMode"],
            "mode-a"
        );
        assert_eq!(shared(&paths.real), before);
        assert_eq!(state.active.as_deref(), Some("claude-3"));

        // Người dùng đăng nhập trong app; lần chuyển sau lưu đăng nhập đó cho claude-3.
        put(&paths.real.join("Cookies"), "cookies-c");
        swap_auth(&paths, &mut state, Some("claude-4"), UNIX_EPOCH + T0).unwrap();
        assert!(has_login(&paths.bundle("claude-3").unwrap()));
        assert_eq!(
            read(&paths.bundle("claude-3").unwrap().join("Cookies")),
            "cookies-c"
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn first_switch_backs_up_the_whole_profile_once_and_restore_brings_the_login_back() {
        let home = temp_home("backup");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "a");
        let mut state = State::default();
        swap_auth(&paths, &mut state, Some("claude-2"), UNIX_EPOCH + T0).unwrap();
        let name = state.backup.clone().unwrap();
        assert_eq!(name, "backup-20261014-132200");
        let backup = paths.root.join(&name);
        assert_eq!(read(&backup.join("Cookies")), "cookies-a");
        assert_eq!(
            read(&backup.join("claude-code-sessions/uuid-a/org/s.json")),
            "session A"
        );
        assert!(!backup.join("Cache").exists(), "không chép cache");
        assert!(!backup.join("claude-code").exists());

        // Lần sau không sao lưu lại, dù giờ khác.
        swap_auth(
            &paths,
            &mut state,
            Some("claude-3"),
            UNIX_EPOCH + T0 + Duration::from_secs(3600),
        )
        .unwrap();
        assert_eq!(state.backup.as_deref(), Some(name.as_str()));
        assert_eq!(
            std::fs::read_dir(&paths.root)
                .unwrap()
                .filter(|e| e
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("backup-"))
                .count(),
            1
        );

        // Khôi phục: về tài khoản ban đầu, không gói nào đang dùng; đăng nhập (trống) của claude-3 vẫn được lưu.
        put(&paths.real.join("Cookies"), "cookies-c");
        put(
            &paths.real.join("claude-code-sessions/uuid-c/new.json"),
            "new",
        );
        swap_auth(&paths, &mut state, None, UNIX_EPOCH + T0).unwrap();
        assert_eq!(state.active, None);
        assert_eq!(account(&paths.real).0, "cookies-a");
        assert_eq!(json(&paths.real.join(CONFIG))["oauth:tokenCache"], "v10-a");
        assert_eq!(
            read(&paths.real.join("claude-code-sessions/uuid-c/new.json")),
            "new",
            "khôi phục chỉ đổi đăng nhập, không xoá dữ liệu mới"
        );
        assert_eq!(
            read(&paths.bundle("claude-3").unwrap().join("Cookies")),
            "cookies-c"
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn broken_config_aborts_before_touching_the_profile() {
        let home = temp_home("broken");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "a");
        let other = home.join("other");
        fake_profile(&other, "b");
        save_auth(&other, &paths.bundle("claude-2").unwrap()).unwrap();
        put(&paths.real.join(DESKTOP_CONFIG), "{không phải json");
        let mut state = State {
            active: Some("claude-1".into()),
            backup: None,
        };
        let err = swap_auth(&paths, &mut state, Some("claude-2"), UNIX_EPOCH + T0).unwrap_err();
        assert!(err.contains("không phải JSON"), "{err}");
        assert_eq!(read(&paths.real.join("Cookies")), "cookies-a");
        assert_eq!(read(&paths.real.join(DESKTOP_CONFIG)), "{không phải json");
        assert_eq!(state.active.as_deref(), Some("claude-1"));
        no_temp_files(&paths.real);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn restore_without_backup_is_refused() {
        let home = temp_home("nobackup");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "a");
        let mut state = State::default();
        assert!(swap_auth(&paths, &mut state, None, UNIX_EPOCH + T0).is_err());
        assert_eq!(read(&paths.real.join("Cookies")), "cookies-a");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn saved_logins_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_home("perm");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "a");
        let bundle = paths.bundle("claude-1").unwrap();
        save_auth(&paths.real, &bundle).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&bundle), 0o700);
        assert_eq!(mode(bundle.parent().unwrap()), 0o700);
        for f in ["Cookies", "Cookies-journal", CONFIG, BUNDLE_PREFS] {
            assert_eq!(mode(&bundle.join(f)), 0o600, "{f}");
        }
        // Lưu lại đè bộ cũ, không để thư mục tạm.
        put(&paths.real.join("Cookies"), "cookies-a2");
        save_auth(&paths.real, &bundle).unwrap();
        assert_eq!(read(&bundle.join("Cookies")), "cookies-a2");
        no_temp_files(bundle.parent().unwrap());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn legacy_profile_becomes_a_login_bundle() {
        let home = temp_home("legacy");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "a");
        let real_before = shared(&paths.real);
        let old = paths.root.join("claude-2");
        fake_profile(&old, "b");
        std::fs::create_dir_all(paths.root.join("claude-5").join("auth")).unwrap();
        assert_eq!(legacy_profiles(&paths.root), vec!["claude-2".to_string()]);
        migrate_legacy(&paths, "claude-2").unwrap();
        let names: Vec<_> = std::fs::read_dir(&old)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["auth"]);
        assert_eq!(read(&old.join("auth").join("Cookies")), "cookies-b");
        assert_eq!(
            json(&old.join("auth").join(BUNDLE_PREFS))["sidebarMode"],
            "mode-b"
        );
        assert!(legacy_profiles(&paths.root).is_empty());
        assert_eq!(shared(&paths.real), real_before);
        assert_eq!(read(&paths.real.join("Cookies")), "cookies-a");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn legacy_migration_never_touches_the_real_profile_through_a_symlink() {
        let home = temp_home("legacylink");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "a");
        std::fs::create_dir_all(&paths.root).unwrap();
        std::os::unix::fs::symlink(&paths.real, paths.root.join("claude-1")).unwrap();
        assert!(migrate_legacy(&paths, "claude-1").is_err());
        assert_eq!(read(&paths.real.join("Cookies")), "cookies-a");
        assert!(paths.real.join("Local Storage/leveldb/000005.ldb").exists());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn finds_app_in_applications_or_home() {
        let home = temp_home("find");
        let user_app = home.join("Applications").join("Claude.app");
        let missing = home.join("nowhere").join("Claude.app");
        assert_eq!(find_app_in(&[missing.clone(), user_app.clone()]), None);
        put(&app_binary(&user_app), "x");
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
    fn running_splits_real_and_legacy_main_processes() {
        let root = Path::new("/Users/a/.xdev-hive/claude-desktop");
        let ps = "\
  412 /Applications/Claude.app/Contents/MacOS/Claude
  413 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer
  500 /Applications/Claude.app/Contents/MacOS/Claude --user-data-dir=/Users/a/.xdev-hive/claude-desktop/claude-2
  501 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer --user-data-dir=/Users/a/.xdev-hive/claude-desktop/claude-2
  600 /Users/a/Applications/Claude.app/Contents/MacOS/Claude --user-data-dir=/Users/a/.xdev-hive/claude-desktop/claude-3 --foo
  700 /Applications/Claude.app/Contents/MacOS/Claude --user-data-dir=/tmp/other
  800 /usr/bin/vim /Users/a/.xdev-hive/claude-desktop/claude-4/x --user-data-dir=/Users/a/.xdev-hive/claude-desktop/claude-4
  900 /usr/local/bin/claude --print
  bad line
";
        assert_eq!(
            running_in(ps, root),
            Running {
                real: vec![412],
                legacy: HashMap::from([
                    ("claude-2".to_string(), 500),
                    ("claude-3".to_string(), 600)
                ]),
            }
        );
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
    fn view_lists_claude_plans_with_saved_and_active() {
        let home = temp_home("view");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "a");
        save_auth(&paths.real, &paths.bundle("claude-1").unwrap()).unwrap();
        write_state(
            &paths,
            &State {
                active: Some("claude-2".into()),
                backup: Some("backup-gone".into()),
            },
        )
        .unwrap();
        let plans = [
            plan("claude-1", "claude", "Duy Max", Some("duy@example.com")),
            plan("codex-1", "codex", "Codex", None),
            plan("claude-2", "claude", "", Some("")),
        ];
        let app = PathBuf::from("/Applications/Claude.app");
        let v = view(&paths, &plans, Some(&app), true, Some(42));
        assert_eq!(v.note, None);
        assert_eq!(v.running, Some(42));
        assert_eq!(v.backup, None, "bản sao lưu đã mất thì không báo có");
        assert_eq!(
            v.profiles
                .iter()
                .map(|p| (p.id.as_str(), p.label.as_str(), p.saved, p.active))
                .collect::<Vec<_>>(),
            vec![
                ("claude-1", "Duy Max", true, false),
                ("claude-2", "claude-2", false, true)
            ]
        );
        assert_eq!(v.profiles[1].email, None);
        assert_eq!(
            view(&paths, &plans, None, true, None).note.as_deref(),
            Some(NOT_INSTALLED)
        );
        assert_eq!(
            view(&paths, &plans, None, false, None).note.as_deref(),
            Some(UNSUPPORTED)
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn tray_label_shows_email_and_in_use_mark() {
        let mut p = ProfileView {
            id: "claude-1".into(),
            label: "Duy Max".into(),
            email: Some("duy@example.com".into()),
            saved: true,
            active: false,
        };
        assert_eq!(tray_label(&p, false), "Duy Max (duy@example.com)");
        p.active = true;
        assert_eq!(tray_label(&p, false), "Duy Max (duy@example.com) · đang dùng");
        assert_eq!(tray_label(&p, true), "Duy Max (duy@example.com) · in use");
    }
}
