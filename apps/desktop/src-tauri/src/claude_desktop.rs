//! Chuyển Claude Desktop giữa các gói Claude của máy (macOS và Windows). Mọi gói dùng chung MỘT hồ sơ thật
//! (`~/Library/Application Support/Claude`, Windows `%APPDATA%\Claude`): chuyển gói chỉ đổi phần xác thực tài khoản, còn
//! MCP, sessions, dự án, cấu hình trên máy giữ nguyên. Mỗi gói chỉ lưu "bộ xác thực" của nó ở
//! `~/.xdev-hive/claude-desktop/<id>/auth`. Phần chung (bảng file, sao lưu, lưu/nạp bộ xác thực) ở đây; tìm app, dò
//! tiến trình, thoát và mở lại ở `mac.rs`, `win.rs`.
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
//!
//! Đăng nhập trong hồ sơ thuộc gói nào thì so `lastKnownAccountUuid` với `oauthAccount.accountUuid` trong `.claude.json`
//! của từng gói (cùng một tài khoản claude.ai): người dùng không phải tự nói "app đang đăng nhập gói này", và đăng nhập
//! tài khoản lạ không bị lưu nhầm vào gói khác. Hồ sơ thật chỉ được đọc (app có thể đang chạy) để lưu đăng nhập vào gói
//! ngay khi người dùng vừa đăng nhập hay app vừa làm mới token, không đợi tới lần chuyển sau.
//!
//! Windows [giả định từ cách Electron/Chromium lưu, chưa thử trên máy thật]: cookie nằm ở `Network\Cookies` (Chromium
//! dời vào đó khi chạy dịch vụ mạng trong sandbox; bản cũ để ở gốc hồ sơ). Cookie và token `safeStorage` mã hoá bằng khoá
//! AES trong `Local State` (`os_crypt.encrypted_key`, bọc DPAPI theo người dùng Windows), không dùng Credential Manager.
//! Cùng người dùng, cùng hồ sơ nên bộ của gói này chép sang vẫn giải mã được, với điều kiện `Local State` giữ nguyên: nó
//! thuộc phần dùng chung, không bao giờ bị ghi.

mod backup;
mod diagnose;
mod job;
mod mac;
mod win;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::AppHandle;

use crate::profiles::home_dir;
use crate::sidecar_json;
use job::{Ctl, Step};

/// Hệ điều hành có Claude Desktop mà tính năng hỗ trợ. Mọi nhánh đều biên dịch trên mọi máy để test được cả hai bố cục.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Os {
    Mac,
    Windows,
}

const CURRENT: Option<Os> = if cfg!(target_os = "macos") {
    Some(Os::Mac)
} else if cfg!(windows) {
    Some(Os::Windows)
} else {
    None
};

pub(crate) const SUPPORTED: bool = CURRENT.is_some();

/// Bản Claude Desktop đã cài.
#[derive(Debug, Clone, PartialEq, Eq)]
enum App {
    /// Claude.app.
    Mac(PathBuf),
    /// Windows, bản tải từ claude.ai kiểu cũ: `claude.exe` của Squirrel.
    Squirrel(PathBuf),
    /// Windows, gói MSIX: họ gói và thư mục dữ liệu `%LOCALAPPDATA%\Packages\<họ gói>`.
    Msix { family: String, data: PathBuf },
}

impl App {
    fn shown(&self) -> String {
        match self {
            App::Mac(p) | App::Squirrel(p) => p.display().to_string(),
            App::Msix { family, .. } => format!("shell:AppsFolder\\{family}"),
        }
    }
}

impl Os {
    fn find_app(self, home: &Path) -> Option<App> {
        match self {
            Os::Mac => mac::find_app(home),
            Os::Windows => win::find_app(&win::Dirs::from_env(home)),
        }
    }

    /// Tiến trình Claude Desktop đang chạy; hồ sơ riêng kiểu cũ chỉ có trên macOS.
    fn running(self, home: &Path) -> Running {
        match self {
            Os::Mac => mac::running(home).unwrap_or_default(),
            Os::Windows => Running {
                real: win::running().unwrap_or_default(),
                legacy: HashMap::new(),
            },
        }
    }

    /// Thoát êm Claude Desktop; `force` (người dùng đã đồng ý) thì buộc thoát khi quá hạn. Trả false khi app vẫn chạy.
    fn quit(self, home: &Path, force: bool, ctl: &Ctl) -> Result<bool, String> {
        match self {
            Os::Mac => mac::quit(home, force, ctl),
            Os::Windows => win::quit(force, ctl),
        }
    }

    fn launch(self, app: &App) -> Result<(), String> {
        match app {
            App::Mac(bundle) => mac::launch(bundle),
            _ => win::launch(app),
        }
    }

    fn not_installed(self) -> &'static str {
        match self {
            Os::Mac => mac::NOT_INSTALLED,
            Os::Windows => win::NOT_INSTALLED,
        }
    }
}

/// Báo trên khay khi Claude Desktop không chịu thoát (khay không hỏi được "buộc thoát?").
pub(crate) fn still_running_text(en: bool) -> &'static str {
    match (CURRENT, en) {
        (Some(Os::Windows), true) => {
            "Claude Desktop did not quit. Quit it (right-click the Claude icon in the system tray → Quit) and try again."
        }
        (Some(Os::Windows), false) => {
            "Claude Desktop chưa thoát. Thoát nó (chuột phải biểu tượng Claude ở khay hệ thống → Quit) rồi thử lại."
        }
        (_, true) => "Claude Desktop did not quit. Quit it (Cmd+Q) and try again.",
        (_, false) => "Claude Desktop chưa thoát. Thoát nó (Cmd+Q) rồi thử lại.",
    }
}

/// File SQLite giữ phiên claude.ai, đường dẫn tương đối trong hồ sơ. Journal đi cùng: journal cũ nằm lại cạnh Cookies của
/// tài khoản khác sẽ làm hỏng nó.
const MAC_AUTH_FILES: &[&str] = &["Cookies", "Cookies-journal"];
/// Windows: Chromium để cookie ở `Network\`; hồ sơ chưa dời (bản Electron cũ) còn ở gốc. Lấy cả hai: file nào có thì
/// lưu, bộ không có thì gỡ khỏi hồ sơ, nên hồ sơ luôn khớp đúng bộ đã lưu.
const WIN_AUTH_FILES: &[&str] = &[
    "Network/Cookies",
    "Network/Cookies-journal",
    "Cookies",
    "Cookies-journal",
];
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

/// Thoát êm có thể chậm khi app còn đang ghi; quá hạn thì hỏi người dùng có buộc thoát không.
const QUIT_WAIT: Duration = Duration::from_secs(20);
/// Nhịp xem hồ sơ thật có đổi không (chỉ stat vài file), và nhịp đối chiếu đủ dù không đổi (gói mới, gói vừa đăng nhập
/// Claude Code nên mới biết tài khoản).
const WATCH_EVERY: Duration = Duration::from_secs(15);
const WATCH_FULL: Duration = Duration::from_secs(300);

const UNSUPPORTED: &str = "Chưa hỗ trợ chuyển tài khoản Claude Desktop trên hệ điều hành này (mới có cho macOS và Windows).";

/// Một lần ghi hồ sơ thật một lúc (lần chuyển, đối chiếu đăng nhập). Lần chuyển panic giữa chừng làm khoá bị đầu độc:
/// vẫn dùng tiếp, vì bản 0.2.16 coi khoá đầu độc là "đang chuyển" mãi tới khi thoát Hive. Việc "đang có lần chuyển" và
/// Huỷ nằm ở `job`.
static SWITCHING: Mutex<()> = Mutex::new(());

/// Khoá ghi hồ sơ nếu đang rảnh.
fn try_switching() -> Option<MutexGuard<'static, ()>> {
    match SWITCHING.try_lock() {
        Ok(g) => Some(g),
        Err(TryLockError::Poisoned(p)) => Some(p.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}

pub(crate) fn profiles_root(home: &Path) -> PathBuf {
    home.join(".xdev-hive").join("claude-desktop")
}

/// Đường dẫn tương đối dạng `Network/Cookies` trong `dir`, tách theo từng phần để đúng dấu phân cách của Windows.
fn at(dir: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(dir.to_path_buf(), |p, part| p.join(part))
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

/// Đường dẫn của Hive, hồ sơ thật và bảng file xác thực theo hệ điều hành; test dựng bằng thư mục nhà giả.
struct Paths {
    os: Os,
    real: PathBuf,
    root: PathBuf,
}

impl Paths {
    fn mac(home: &Path) -> Self {
        Self {
            os: Os::Mac,
            real: mac::profile(home),
            root: profiles_root(home),
        }
    }

    fn windows(home: &Path, dirs: &win::Dirs) -> Self {
        Self {
            os: Os::Windows,
            real: win::profile(dirs),
            root: profiles_root(home),
        }
    }

    /// Bố cục của máy này. Hệ điều hành chưa hỗ trợ vẫn cần danh sách gói cho màn hình (không ghi gì), nên lấy bố cục
    /// macOS.
    fn current(home: &Path) -> Self {
        match CURRENT {
            Some(Os::Windows) => Self::windows(home, &win::Dirs::from_env(home)),
            _ => Self::mac(home),
        }
    }

    fn auth_files(&self) -> &'static [&'static str] {
        match self.os {
            Os::Mac => MAC_AUTH_FILES,
            Os::Windows => WIN_AUTH_FILES,
        }
    }

    /// Hồ sơ hay bộ xác thực có cookie đăng nhập (journal không tính).
    fn has_login(&self, dir: &Path) -> bool {
        self.auth_files()
            .iter()
            .filter(|f| !f.ends_with("-journal"))
            .any(|f| is_real_file(&at(dir, f)))
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
#[derive(Serialize, Deserialize, Default, Debug, PartialEq, Eq, Clone)]
struct State {
    #[serde(default)]
    active: Option<String>,
    /// Tên thư mục sao lưu trong thư mục của Hive.
    #[serde(default)]
    backup: Option<String>,
    /// Lần đăng nhập gần nhất không phải tài khoản của gói đang chờ; giữ tới khi người dùng đóng thông báo hay chuyển gói.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mismatch: Option<Mismatch>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Mismatch {
    /// Email (hay uuid rút gọn) của tài khoản Claude Desktop đang đăng nhập.
    account: String,
    /// Gói lẽ ra đang đăng nhập.
    expected: String,
    /// Gói có tài khoản đó, đã nhận đăng nhập; None khi tài khoản không thuộc gói nào nên không lưu.
    adopted: Option<String>,
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

/// Windows: thư mục trong hồ sơ người dùng đã chỉ người dùng (và SYSTEM, Administrators) đọc được, thư mục con kế thừa.
#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Windows khoá file đang mở: app vừa thoát, trình quét virus hay Windows Search có thể còn giữ Cookies thêm một lúc.
/// Lỗi ACCESS_DENIED (5), SHARING_VIOLATION (32), LOCK_VIOLATION (33) thì chờ rồi thử lại; hệ khác không khoá kiểu này.
fn retry_locked<T>(mut op: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    const TRIES: u32 = 20;
    for _ in 1..TRIES {
        match op() {
            Err(e) if cfg!(windows) && matches!(e.raw_os_error(), Some(5 | 32 | 33)) => {
                std::thread::sleep(Duration::from_millis(250));
            }
            r => return r,
        }
    }
    op()
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
/// `rename` của Rust trên Windows thay file đích trong một bước (MoveFileEx/REPLACE_EXISTING), như ReplaceFileW.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = tmp_of(path);
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    make_private(&tmp)?;
    retry_locked(|| std::fs::rename(&tmp, path))
}

fn copy_atomic(from: &Path, to: &Path) -> std::io::Result<()> {
    let tmp = tmp_of(to);
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    retry_locked(|| std::fs::copy(from, &tmp))?;
    // Mở để ghi: Windows chỉ cho FlushFileBuffers trên handle có quyền ghi.
    std::fs::File::options()
        .write(true)
        .open(&tmp)?
        .sync_all()?;
    make_private(&tmp)?;
    retry_locked(|| std::fs::rename(&tmp, to))
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
fn save_auth(from: &Path, dest: &Path, files: &[&str]) -> Result<(), String> {
    save_auth_if(from, dest, files, || true).map(|_| ())
}

/// Như `save_auth`, nhưng bỏ bản vừa dựng (trả false, `dest` giữ nguyên) khi `still` báo hồ sơ đã đổi trong lúc chép.
fn save_auth_if(
    from: &Path,
    dest: &Path,
    files: &[&str],
    still: impl Fn() -> bool,
) -> Result<bool, String> {
    let auth = read_auth(from)?;
    let parent = dest.parent().ok_or("Đường dẫn bộ xác thực không hợp lệ.")?;
    create_private_dir(parent).map_err(|e| e.to_string())?;
    let tmp = tmp_of(dest);
    remove_entry(&tmp).map_err(|e| e.to_string())?;
    let built = (|| -> std::io::Result<()> {
        create_private_dir(&tmp)?;
        for name in files {
            let (src, dst) = (at(from, name), at(&tmp, name));
            if is_real_file(&src) {
                if let Some(parent) = dst.parent() {
                    create_private_dir(parent)?;
                }
                retry_locked(|| std::fs::copy(&src, &dst))?;
                make_private(&dst)?;
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
    if !still() {
        let _ = remove_entry(&tmp);
        return Ok(false);
    }
    let mut old = dest.as_os_str().to_os_string();
    old.push(".old");
    let old = PathBuf::from(old);
    let swapped = (|| -> std::io::Result<()> {
        remove_entry(&old)?;
        if std::fs::symlink_metadata(dest).is_ok() {
            retry_locked(|| std::fs::rename(dest, &old))?;
        }
        retry_locked(|| std::fs::rename(&tmp, dest))?;
        remove_entry(&old)
    })();
    swapped
        .map(|_| true)
        .map_err(|e| format!("Không lưu được bộ đăng nhập: {e}"))
}

/// Đưa bộ xác thực `from` vào hồ sơ thật. File xác thực không có trong bộ thì bị gỡ khỏi hồ sơ (gói chưa đăng nhập mở
/// ở màn đăng nhập); `preferences` không có trong bộ thì để nguyên. Đọc và kiểm hết trước khi ghi file đầu tiên.
fn load_auth(from: &Path, real: &Path, files: &[&str]) -> Result<(), String> {
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
        for name in files {
            let (src, dst) = (at(&auth.dir, name), at(real, name));
            if is_real_file(&src) {
                copy_atomic(&src, &dst)?;
            } else if std::fs::symlink_metadata(&dst).is_ok() {
                retry_locked(|| std::fs::remove_file(&dst))?;
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

/// Tài khoản claude.ai đang đăng nhập trong hồ sơ hay bộ xác thực `dir`. `lastKnownAccountUuid` có thể còn lại sau khi
/// đăng xuất, nên phải còn token hay Cookies mới tính là đang đăng nhập.
fn account_of(paths: &Paths, dir: &Path) -> Option<String> {
    let config = read_object(&dir.join(CONFIG)).ok()?;
    let token = ["oauth:tokenCache", "oauth:tokenCacheV2"]
        .iter()
        .any(|k| config.get(*k).is_some_and(|v| !v.is_null()));
    if !token && !paths.has_login(dir) {
        return None;
    }
    config
        .get("lastKnownAccountUuid")?
        .as_str()
        .filter(|u| !u.is_empty())
        .map(str::to_string)
}

/// Một gói Claude và tài khoản claude.ai của nó (Claude Code và Claude Desktop cùng uuid).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Owner {
    id: String,
    /// None khi gói chưa đăng nhập Claude Code hay đăng nhập bằng token (không có `oauthAccount`): khi đó tin gói đang
    /// dùng như trước.
    uuid: Option<String>,
    email: Option<String>,
}

/// `.claude.json` của gói: thư mục cấu hình rỗng là đăng nhập mặc định `~/.claude.json`.
fn plan_json(home: &Path, config_dir: Option<&str>) -> PathBuf {
    let dir = match config_dir.map(str::trim).filter(|d| !d.is_empty()) {
        None => return home.join(".claude.json"),
        Some("~") => home.to_path_buf(),
        Some(d) => d
            .strip_prefix("~/")
            .or_else(|| d.strip_prefix("~\\"))
            .map_or_else(|| PathBuf::from(d), |rest| home.join(rest)),
    };
    dir.join(".claude.json")
}

/// `oauthAccount.accountUuid`; file có thể vài MB (lịch sử dự án) nên chỉ giải mã đúng trường cần.
fn plan_account(path: &Path) -> Option<String> {
    #[derive(Deserialize)]
    struct File {
        #[serde(rename = "oauthAccount")]
        oauth_account: Option<Account>,
    }
    #[derive(Deserialize)]
    struct Account {
        #[serde(rename = "accountUuid")]
        account_uuid: Option<String>,
    }
    let file: File = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    file.oauth_account?.account_uuid.filter(|u| !u.is_empty())
}

fn owners(home: &Path, plans: &[Plan]) -> Vec<Owner> {
    plans
        .iter()
        .filter(|p| p.cli == "claude" && valid_id(&p.id))
        .map(|p| Owner {
            id: p.id.clone(),
            uuid: plan_account(&plan_json(home, p.config_dir.as_deref())),
            email: p.email.clone().filter(|e| !e.is_empty()),
        })
        .collect()
}

/// Gói của tài khoản `uuid`; hai gói cùng một tài khoản thì ưu tiên gói đang dùng.
fn owner_of<'a>(owners: &'a [Owner], uuid: &str, active: Option<&str>) -> Option<&'a Owner> {
    let same = || owners.iter().filter(|o| o.uuid.as_deref() == Some(uuid));
    same()
        .find(|o| Some(o.id.as_str()) == active)
        .or_else(|| same().next())
}

/// Gói nhận đăng nhập `account` của hồ sơ: gói cùng tài khoản; không gói nào khớp thì gói đang dùng, trừ khi biết chắc
/// gói đó là tài khoản khác (để đăng nhập lạ không đè lên đăng nhập đã lưu của gói). None khi hồ sơ chưa đăng nhập.
fn login_home(owners: &[Owner], account: Option<&str>, active: Option<&str>) -> Option<String> {
    let uuid = account?;
    if let Some(o) = owner_of(owners, uuid, active) {
        return Some(o.id.clone());
    }
    let active = active?;
    match owners.iter().find(|o| o.id == active) {
        Some(Owner { uuid: Some(_), .. }) => None,
        _ => Some(active.to_string()),
    }
}

fn short_uuid(uuid: &str) -> String {
    match uuid.get(..8) {
        Some(head) if uuid.len() > 8 => format!("{head}…"),
        _ => uuid.to_string(),
    }
}

/// Kích thước và giờ sửa của các file xác thực: so trước và sau khi chép để biết app có ghi xen vào không, và để trình
/// theo dõi biết hồ sơ vừa đổi mà không phải đọc nội dung.
type Stamp = Vec<Option<(u64, SystemTime)>>;

fn stamp(paths: &Paths, dir: &Path) -> Stamp {
    [CONFIG, DESKTOP_CONFIG]
        .iter()
        .chain(paths.auth_files())
        .map(|f| {
            std::fs::metadata(at(dir, f))
                .ok()
                .map(|m| (m.len(), m.modified().unwrap_or(UNIX_EPOCH)))
        })
        .collect()
}

fn same_auth(paths: &Paths, a: &Path, b: &Path) -> Result<bool, String> {
    let (x, y) = (read_auth(a)?, read_auth(b)?);
    let cookies = |d: &Path| {
        paths
            .auth_files()
            .iter()
            .filter(|f| !f.ends_with("-journal"))
            .map(|f| std::fs::read(at(d, f)).ok())
            .collect::<Vec<_>>()
    };
    Ok(x.config == y.config && x.prefs == y.prefs && cookies(a) == cookies(b))
}

/// Lưu đăng nhập của hồ sơ thật vào bộ của gói khi khác bộ đã lưu (vừa đăng nhập, app vừa làm mới token: token cũ đã
/// bị xoay vòng, nạp lại sẽ bắt đăng nhập). App đang chạy (`live`) thì chỉ nhận bản chép khi không có giao dịch SQLite dở
/// và không file nào đổi trong lúc chép; false là chưa lưu, lần sau thử lại.
fn refresh_bundle(paths: &Paths, bundle: &Path, live: bool) -> Result<bool, String> {
    let (real, files) = (&paths.real, paths.auth_files());
    if same_auth(paths, real, bundle)? {
        return Ok(true);
    }
    if !live {
        return save_auth(real, bundle, files).map(|_| true);
    }
    let before = stamp(paths, real);
    // Stamp xếp CONFIG, DESKTOP_CONFIG rồi tới bảng file xác thực.
    let hot = files
        .iter()
        .zip(&before[2..])
        .any(|(f, s)| f.ends_with("-journal") && s.is_some_and(|(len, _)| len > 0));
    if hot {
        return Ok(false);
    }
    save_auth_if(real, bundle, files, || stamp(paths, real) == before)
}

/// Gắn đăng nhập trên máy vào đúng gói, không ghi gì vào hồ sơ thật:
/// - hồ sơ thật đăng nhập tài khoản của gói nào thì gói đó là gói đang dùng, và bộ của gói được cập nhật;
/// - đăng nhập không phải của gói đang chờ thì ghi lại để báo người dùng;
/// - đăng nhập trước lần chuyển gần nhất (`.previous`) khớp một gói chưa có bộ thì thành bộ của gói đó (máy đã chuyển
///   trước khi có tự gắn: đăng nhập ban đầu chỉ nằm ở `.previous`).
///
/// Trả false khi có bản chép phải bỏ vì app đang ghi.
fn reconcile(paths: &Paths, owners: &[Owner], live: bool) -> Result<bool, String> {
    let mut state = read_state(paths);
    let before = state.clone();
    let mut settled = true;
    if let Some(uuid) = account_of(paths, &paths.real) {
        let expected = state.active.clone();
        let owner = owner_of(owners, &uuid, expected.as_deref());
        match (owner, expected.as_deref()) {
            (Some(o), Some(e)) if o.id != e && owners.iter().any(|x| x.id == e) => {
                state.mismatch = Some(Mismatch {
                    account: o.email.clone().unwrap_or_else(|| short_uuid(&uuid)),
                    expected: e.to_string(),
                    adopted: Some(o.id.clone()),
                });
            }
            (Some(o), _) => {
                if state.mismatch.as_ref().is_some_and(|m| m.expected == o.id) {
                    state.mismatch = None;
                }
            }
            (None, Some(e)) if login_home(owners, Some(&uuid), Some(e)).is_none() => {
                state.mismatch = Some(Mismatch {
                    account: short_uuid(&uuid),
                    expected: e.to_string(),
                    adopted: None,
                });
            }
            (None, _) => {}
        }
        if let Some(o) = owner {
            state.active = Some(o.id.clone());
        }
        if let Some(id) = login_home(owners, Some(&uuid), state.active.as_deref()) {
            settled &= refresh_bundle(paths, &paths.bundle(&id)?, live)?;
        }
    }
    if let Some(uuid) = account_of(paths, &paths.previous())
        && let Some(o) = owner_of(owners, &uuid, None)
    {
        let bundle = paths.bundle(&o.id)?;
        if !paths.has_login(&bundle) {
            save_auth(&paths.previous(), &bundle, paths.auth_files())?;
        }
    }
    if state != before {
        write_state(paths, &state)?;
    }
    Ok(settled)
}

/// `backup-20261015-132200` theo giờ UTC: tên sắp đúng thứ tự thời gian và không trùng khi sao lưu lại cùng ngày.
fn backup_name(now: SystemTime) -> String {
    format!("backup-{}", utc_stamp(now))
}

/// `20261015-132200`, giờ UTC.
fn utc_stamp(now: SystemTime) -> String {
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
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// Sao lưu cả hồ sơ thật (trừ cache) một lần, trước lần ghi đầu tiên vào hồ sơ.
fn ensure_backup(
    paths: &Paths,
    state: &mut State,
    now: SystemTime,
    ctl: &Ctl,
) -> Result<(), String> {
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
    ctl.step(Step::BackingUp);
    let copied = backup::copy(&paths.real, &tmp, paths.auth_files(), ctl).and_then(|_| {
        retry_locked(|| std::fs::rename(&tmp, &dest))
            .map_err(|e| format!("Không sao lưu được hồ sơ Claude Desktop: {e}"))
    });
    if let Err(e) = copied {
        let _ = remove_entry(&tmp);
        return Err(if backup::cancelled(&e) || e.starts_with("Sao lưu") {
            e
        } else {
            format!("Không sao lưu được hồ sơ Claude Desktop: {e}")
        });
    }
    state.backup = Some(name);
    write_state(paths, state)
}

/// Đổi tài khoản của hồ sơ thật sang gói `target` (None: về đăng nhập lúc chưa dùng tính năng này, lấy từ bản sao
/// lưu). Claude Desktop phải đã thoát. Đăng nhập hiện tại lưu vào gói có tài khoản đó (`owners`), không mặc nhiên vào
/// gói đang dùng. Huỷ được tới khi ghi xong trạng thái; huỷ sau khi đã nạp đăng nhập mới thì lấy lại đăng nhập cũ.
fn swap_auth(
    paths: &Paths,
    state: &mut State,
    target: Option<&str>,
    owners: &[Owner],
    now: SystemTime,
    ctl: &Ctl,
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
    ensure_backup(paths, state, now, ctl)?;
    ctl.check()?;
    ctl.step(Step::Swapping);
    std::fs::create_dir_all(&paths.real)
        .map_err(|e| format!("Không tạo được hồ sơ Claude Desktop: {e}"))?;
    let files = paths.auth_files();
    save_auth(&paths.real, &paths.previous(), files)?;
    let account = account_of(paths, &paths.real);
    if let Some(id) = login_home(owners, account.as_deref(), state.active.as_deref()) {
        save_auth(&paths.real, &paths.bundle(&id)?, files)?;
    }
    ctl.check()?;
    if let Err(e) = load_auth(&source, &paths.real, files).and_then(|_| ctl.check()) {
        let _ = load_auth(&paths.previous(), &paths.real, files);
        return Err(e);
    }
    state.active = target.map(str::to_string);
    state.mismatch = None;
    write_state(paths, state)
}

const NOT_ACTIVE: &str =
    "Gói này không phải gói đang dùng Claude Desktop; dùng Quên đăng nhập cho gói không dùng.";

/// Đăng xuất Claude Desktop khỏi gói đang dùng `id`: xoá bộ xác thực đã lưu của gói và phần xác thực trong hồ sơ thật
/// (Cookies, token, `lastKnownAccountUuid`), giữ mọi thứ khác. Claude Desktop phải đã thoát. Hồ sơ đang đăng nhập tài
/// khoản của gói khác thì lưu cho gói đó trước. Huỷ được tới lúc xoá bộ của gói; ghi hồ sơ hỏng thì lấy lại đăng nhập cũ.
fn sign_out_auth(
    paths: &Paths,
    state: &mut State,
    id: &str,
    owners: &[Owner],
    now: SystemTime,
    ctl: &Ctl,
) -> Result<(), String> {
    let bundle = paths.bundle(id)?;
    if state.active.as_deref() != Some(id) {
        return Err(NOT_ACTIVE.into());
    }
    ensure_backup(paths, state, now, ctl)?;
    ctl.check()?;
    ctl.step(Step::Swapping);
    std::fs::create_dir_all(&paths.real)
        .map_err(|e| format!("Không tạo được hồ sơ Claude Desktop: {e}"))?;
    let files = paths.auth_files();
    save_auth(&paths.real, &paths.previous(), files)?;
    let account = account_of(paths, &paths.real);
    if let Some(other) = login_home(owners, account.as_deref(), Some(id)).filter(|o| o != id) {
        save_auth(&paths.real, &paths.bundle(&other)?, files)?;
    }
    ctl.check()?;
    remove_entry(&bundle).map_err(|e| format!("Không xoá được đăng nhập đã lưu: {e}"))?;
    // Bộ vừa xoá không còn nên nạp nó là gỡ phần xác thực khỏi hồ sơ.
    if let Err(e) = load_auth(&bundle, &paths.real, files) {
        let _ = load_auth(&paths.previous(), &paths.real, files);
        return Err(e);
    }
    // `.previous` giữ đúng đăng nhập vừa bỏ: để lại thì `reconcile` dựng lại bộ của gói từ nó.
    let _ = remove_entry(&paths.previous());
    state.mismatch = None;
    write_state(paths, state)
}

/// Quên đăng nhập đã lưu của gói không dùng `id`.
fn forget_bundle(paths: &Paths, id: &str) -> Result<(), String> {
    let bundle = paths.bundle(id)?;
    if read_state(paths).active.as_deref() == Some(id) {
        return Err("Gói này đang dùng Claude Desktop; dùng Đăng xuất Claude Desktop.".into());
    }
    let account = account_of(paths, &bundle);
    remove_entry(&bundle).map_err(|e| format!("Không xoá được đăng nhập đã lưu: {e}"))?;
    // Đăng nhập trước lần chuyển gần nhất là của gói này thì `reconcile` sẽ dựng lại bộ vừa quên từ `.previous`.
    if account.is_some() && account_of(paths, &paths.previous()) == account {
        remove_entry(&paths.previous())
            .map_err(|e| format!("Không xoá được đăng nhập đã lưu: {e}"))?;
    }
    Ok(())
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
    if paths.has_login(dir) && !paths.has_login(&bundle) {
        save_auth(dir, &bundle, paths.auth_files())?;
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

/// Tiến trình chính của Claude Desktop, chia theo hồ sơ: hồ sơ thật, hay hồ sơ riêng kiểu cũ của Hive (id gói, chỉ có
/// trên macOS).
#[derive(Default, Debug, PartialEq, Eq)]
struct Running {
    real: Vec<u32>,
    legacy: HashMap<String, u32>,
}

/// Dò `pids` tới khi rỗng hay quá hạn; dò lỗi (None) không tính là đã thoát. Bấm Huỷ thì dừng ngay.
fn wait_gone(
    mut pids: impl FnMut() -> Option<Vec<u32>>,
    within: Duration,
    ctl: &Ctl,
) -> Result<bool, String> {
    let until = Instant::now() + within;
    loop {
        if pids().is_some_and(|p| p.is_empty()) {
            return Ok(true);
        }
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Ok(false);
        }
        ctl.sleep(left.min(Duration::from_millis(500)))?;
    }
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
    /// Thư mục cấu hình Claude Code của gói (dạng `~/…`); thiếu là đăng nhập mặc định.
    #[serde(default, rename = "configDir")]
    config_dir: Option<String>,
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
    /// Biết tài khoản claude.ai của gói (từ `.claude.json`) nên Hive tự gắn đăng nhập; chưa biết thì người dùng tự
    /// ghi nhận được.
    account_known: bool,
}

/// Tài khoản Claude Desktop đang đăng nhập.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignedIn {
    /// uuid rút gọn, để nhận ra khi không có email.
    account: String,
    email: Option<String>,
    /// Gói có tài khoản này; None khi không gói nào khớp.
    plan: Option<String>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfilesView {
    supported: bool,
    /// Claude Desktop tìm thấy (Claude.app, claude.exe hay gói Microsoft Store); None khi chưa cài.
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
    /// None khi Claude Desktop chưa đăng nhập (màn đăng nhập) hay chưa cài.
    signed_in: Option<SignedIn>,
    mismatch: Option<Mismatch>,
    /// Lần chuyển đang chạy (cả từ khay), để cửa sổ mở sau vẫn thấy tiến độ và nút Huỷ.
    switching: Option<job::Progress>,
    /// false: có đăng nhập chưa lưu được vì app đang ghi hồ sơ; trình theo dõi thử lại sớm.
    #[serde(skip)]
    settled: bool,
}

fn view(
    paths: &Paths,
    plans: &[Plan],
    owners: &[Owner],
    app: Option<&App>,
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
            saved: paths.bundle(&p.id).is_ok_and(|b| paths.has_login(&b)),
            active: state.active.as_deref() == Some(p.id.as_str()),
            account_known: owners.iter().any(|o| o.id == p.id && o.uuid.is_some()),
        })
        .collect();
    let signed_in = account_of(paths, &paths.real).map(|uuid| {
        let owner = owner_of(owners, &uuid, state.active.as_deref());
        SignedIn {
            account: short_uuid(&uuid),
            email: owner.and_then(|o| o.email.clone()),
            plan: owner.map(|o| o.id.clone()),
        }
    });
    let note = if !supported {
        Some(UNSUPPORTED.to_string())
    } else if app.is_none() {
        Some(paths.os.not_installed().to_string())
    } else {
        None
    };
    ProfilesView {
        supported,
        app: app.map(App::shown),
        note,
        running: pid,
        backup: state
            .backup
            .map(|b| paths.root.join(b))
            .filter(|b| b.is_dir())
            .map(|b| b.display().to_string()),
        legacy: legacy_profiles(&paths.root),
        profiles,
        signed_in,
        mismatch: state.mismatch,
        switching: job::progress(),
        settled: true,
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

/// Gói Claude của máy, gói Claude Desktop đang dùng và bản sao lưu; trước đó gắn đăng nhập trên máy vào đúng gói
/// (`reconcile`). Cũng làm mới mục "Chuyển Claude Desktop sang…" của khay, để khay theo kịp khi người dùng thêm hay xoá
/// gói.
pub(crate) async fn load(app: &AppHandle) -> Result<ProfilesView, String> {
    let plans = claude_plans(app).await?;
    let home = need_home()?;
    let v = tauri::async_runtime::spawn_blocking(move || {
        let found = CURRENT.and_then(|os| os.find_app(&home));
        let pid = CURRENT.and_then(|os| os.running(&home).real.first().copied());
        let paths = Paths::current(&home);
        let owners = owners(&home, &plans);
        // Đang chuyển thì để lần sau: lần chuyển tự lưu đăng nhập và đang ghi hồ sơ thật.
        let settled = !SUPPORTED
            || match try_switching() {
                Some(_guard) => reconcile(&paths, &owners, pid.is_some()).unwrap_or_else(|e| {
                    eprintln!("Không gắn được đăng nhập Claude Desktop vào gói: {e}");
                    true
                }),
                None => false,
            };
        ProfilesView {
            settled,
            ..view(&paths, &plans, &owners, found.as_ref(), SUPPORTED, pid)
        }
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

/// Theo dõi hồ sơ Claude Desktop để lưu đăng nhập vào gói ngay khi người dùng vừa đăng nhập hay app vừa làm mới token,
/// kể cả khi màn gói không mở. Mỗi nhịp chỉ stat vài file; đọc danh sách gói (gọi worker) khi hồ sơ đổi hay đã lâu.
pub(crate) async fn watch(app: AppHandle) {
    let Some(home) = home_dir() else {
        return;
    };
    let paths = Paths::current(&home);
    let mut seen: Option<Stamp> = None;
    let mut last = Instant::now();
    loop {
        tokio::time::sleep(WATCH_EVERY).await;
        if !paths.real.is_dir() {
            continue;
        }
        let now = stamp(&paths, &paths.real);
        if seen.as_ref() == Some(&now) && last.elapsed() < WATCH_FULL {
            continue;
        }
        last = Instant::now();
        seen = match load(&app).await {
            Ok(v) if !v.settled => None,
            _ => Some(now),
        };
    }
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
/// Mọi bước có hạn và hỏi `ctl` để Huỷ được; đã thoát app thì luôn mở lại, kể cả khi lỗi hay huỷ.
fn switch_blocking(
    home: &Path,
    target: Option<&str>,
    owners: &[Owner],
    force: bool,
    ctl: &Ctl,
) -> Result<Switched, String> {
    // Chờ lượt đối chiếu đăng nhập của trình theo dõi (chỉ chép vài file) thay vì báo bận.
    let _guard = job::lock(&SWITCHING);
    let os = CURRENT.ok_or(UNSUPPORTED)?;
    let app = os.find_app(home).ok_or(os.not_installed())?;
    let paths = Paths::current(home);
    let mut state = read_state(&paths);
    let needs_login = match target {
        Some(id) => !paths.has_login(&paths.bundle(id)?),
        None => false,
    };
    // Gói "đang dùng" mà app lại đăng nhập tài khoản khác: chuyển thật để nạp lại đăng nhập của gói.
    let account = account_of(&paths, &paths.real);
    let foreign = account.is_some()
        && login_home(owners, account.as_deref(), target) != target.map(str::to_string);
    if target.is_some() && state.active.as_deref() == target && !foreign {
        if os.running(home).real.is_empty() {
            ctl.step(Step::Launching);
            os.launch(&app)?;
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
    ctl.check()?;
    match os.quit(home, force, ctl) {
        Ok(true) => {}
        Ok(false) => {
            return Ok(Switched {
                status: SwitchStatus::StillRunning,
                needs_login,
            });
        }
        // Huỷ hay lỗi giữa lúc thoát: app có thể đã tắt một phần; tắt hẳn rồi thì mở lại như trước khi bấm.
        Err(e) => {
            if os.running(home).real.is_empty() {
                let _ = os.launch(&app);
            }
            return Err(e);
        }
    }
    // Đổi hỏng hay bị huỷ thì hồ sơ đã về đăng nhập cũ (swap_auth tự lấy lại): vẫn mở lại app như trước khi bấm.
    let swapped = swap_auth(&paths, &mut state, target, owners, SystemTime::now(), ctl);
    ctl.step(Step::Launching);
    os.launch(&app)?;
    swapped?;
    Ok(Switched {
        status: SwitchStatus::Switched,
        needs_login,
    })
}

/// Đăng xuất Claude Desktop khỏi gói đang dùng: thoát app, gỡ đăng nhập, mở lại ở màn đăng nhập. Như lần chuyển, mọi
/// bước có hạn, Huỷ được, và đã thoát app thì luôn mở lại.
fn sign_out_blocking(
    home: &Path,
    id: &str,
    owners: &[Owner],
    force: bool,
    ctl: &Ctl,
) -> Result<Switched, String> {
    let _guard = job::lock(&SWITCHING);
    let os = CURRENT.ok_or(UNSUPPORTED)?;
    let app = os.find_app(home).ok_or(os.not_installed())?;
    let paths = Paths::current(home);
    let mut state = read_state(&paths);
    // Kiểm trước khi thoát app, như lần chuyển.
    if state.active.as_deref() != Some(id) {
        return Err(NOT_ACTIVE.into());
    }
    ctl.check()?;
    match os.quit(home, force, ctl) {
        Ok(true) => {}
        Ok(false) => {
            return Ok(Switched {
                status: SwitchStatus::StillRunning,
                needs_login: true,
            });
        }
        Err(e) => {
            if os.running(home).real.is_empty() {
                let _ = os.launch(&app);
            }
            return Err(e);
        }
    }
    let done = sign_out_auth(&paths, &mut state, id, owners, SystemTime::now(), ctl);
    ctl.step(Step::Launching);
    os.launch(&app)?;
    done?;
    Ok(Switched {
        status: SwitchStatus::Switched,
        needs_login: true,
    })
}

/// Chạy một lần chuyển trên luồng chặn, giữ chỗ "đang chuyển" tới khi xong. Lỗi được ghi lại cho chẩn đoán.
async fn run_switch(
    busy: job::Busy,
    home: PathBuf,
    target: Option<String>,
    owners: Vec<Owner>,
    force: bool,
) -> Result<Switched, String> {
    run_job(busy, move |ctl| {
        switch_blocking(&home, target.as_deref(), &owners, force, ctl)
    })
    .await
}

/// Chạy `work` (chuyển, khôi phục, đăng xuất) trên luồng chặn, giữ chỗ "đang chuyển" tới khi xong.
async fn run_job(
    busy: job::Busy,
    work: impl FnOnce(&Ctl) -> Result<Switched, String> + Send + 'static,
) -> Result<Switched, String> {
    let done = tauri::async_runtime::spawn_blocking(move || {
        let _busy = busy;
        work(&Ctl::job())
    })
    .await
    .map_err(|e| format!("Lần chuyển Claude Desktop dừng giữa chừng: {e}"))
    .and_then(|r| r);
    if let Err(e) = &done {
        job::record_error(e);
    }
    done
}

/// Chuyển Claude Desktop sang một gói Claude. Cửa sổ chỉ gửi id gói; đường dẫn do Rust dựng.
pub(crate) async fn switch(app: &AppHandle, id: &str, force: bool) -> Result<Switched, String> {
    if !SUPPORTED {
        return Err(UNSUPPORTED.into());
    }
    let id = id.trim().to_string();
    // Giữ chỗ trước khi hỏi worker: bấm lần hai trong lúc đó cũng thấy "đang chuyển".
    let busy = job::begin(Some(&id))?;
    let plans = claude_plans(app).await?;
    if !plans.iter().any(|p| p.id == id && p.cli == "claude") {
        return Err(format!("Không có gói Claude {id}."));
    }
    let home = need_home()?;
    let owners = owners(&home, &plans);
    let done = run_switch(busy, home, Some(id), owners, force).await;
    let _ = load(app).await;
    done
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
    if !SUPPORTED {
        return Err(UNSUPPORTED.into());
    }
    let busy = job::begin(None)?;
    let home = need_home()?;
    // Không đọc được danh sách gói thì vẫn khôi phục được: đăng nhập hiện tại lưu vào gói đang dùng như trước.
    let owners = owners(&home, &claude_plans(&app).await.unwrap_or_default());
    let done = run_switch(busy, home, None, owners, force).await;
    let _ = load(&app).await;
    done
}

/// Đăng xuất Claude Desktop khỏi gói đang dùng; app mở lại ở màn đăng nhập. Gói vẫn là gói đang dùng, nên lần đăng nhập
/// sau được lưu cho gói.
#[tauri::command]
pub async fn sign_out_claude_desktop(
    app: AppHandle,
    profile_id: String,
    force: bool,
) -> Result<Switched, String> {
    if !SUPPORTED {
        return Err(UNSUPPORTED.into());
    }
    let id = profile_id.trim().to_string();
    let busy = job::begin(Some(&id))?;
    let plans = claude_plans(&app).await?;
    if !plans.iter().any(|p| p.id == id && p.cli == "claude") {
        return Err(format!("Không có gói Claude {id}."));
    }
    let home = need_home()?;
    let owners = owners(&home, &plans);
    let done = run_job(busy, move |ctl| {
        sign_out_blocking(&home, &id, &owners, force, ctl)
    })
    .await;
    let _ = load(&app).await;
    done
}

/// Tiến độ lần chuyển đang chạy; None khi không có. `async` để không chạy trên luồng chính (lệnh đồng bộ của Tauri chạy
/// ở đó): luồng chính bận thì cửa sổ vẫn hỏi được tiến độ và bấm được Huỷ.
#[tauri::command]
pub async fn claude_desktop_switch_progress() -> Option<job::Progress> {
    job::progress()
}

/// Bấm Huỷ: lần chuyển dừng ở bước kế tiếp và lấy lại đăng nhập cũ. false khi không còn gì để huỷ.
#[tauri::command]
pub async fn cancel_claude_desktop_switch() -> bool {
    job::cancel()
}

/// Thông tin chẩn đoán dạng chữ để người dùng chép gửi hỗ trợ: đường dẫn, cỡ, tiến trình, lỗi gần nhất. Không đọc nội
/// dung file đăng nhập hay token.
#[tauri::command]
pub async fn claude_desktop_diagnose() -> Result<String, String> {
    let home = need_home()?;
    tauri::async_runtime::spawn_blocking(move || diagnose::report(&home))
        .await
        .map_err(|e| e.to_string())
}

/// Đóng thông báo "đăng nhập không phải tài khoản của gói".
#[tauri::command]
pub async fn dismiss_claude_desktop_mismatch(app: AppHandle) -> Result<ProfilesView, String> {
    let home = need_home()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let paths = Paths::current(&home);
        let mut state = read_state(&paths);
        if state.mismatch.take().is_some() {
            write_state(&paths, &state)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    load(&app).await
}

/// Phương án dự phòng cho gói chưa biết tài khoản claude.ai (Claude Code đăng nhập bằng token, không có
/// `oauthAccount`): người dùng ghi nhận Claude Desktop đang đăng nhập đúng gói này, Hive lưu đăng nhập đó cho gói. Không
/// ghi gì vào hồ sơ thật.
#[tauri::command]
pub async fn adopt_claude_desktop(
    app: AppHandle,
    profile_id: String,
) -> Result<ProfilesView, String> {
    let home = need_home()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let paths = Paths::current(&home);
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
        forget_bundle(&Paths::current(&home), profile_id.trim())
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
        let paths = Paths::current(&home);
        let open = CURRENT
            .map(|os| os.running(&home).legacy)
            .unwrap_or_default();
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

    fn swap_auth(
        paths: &Paths,
        state: &mut State,
        target: Option<&str>,
        owners: &[Owner],
        now: SystemTime,
    ) -> Result<(), String> {
        super::swap_auth(paths, state, target, owners, now, &Ctl::idle())
    }

    pub(super) fn temp_home(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("hive-claude-desktop-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub(super) fn put(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn json(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    /// Bố cục macOS và Windows, mỗi bố cục một thư mục nhà giả: phần chung chạy cho cả hai trên mọi máy.
    fn layouts(name: &str) -> Vec<(PathBuf, Paths)> {
        let mac = temp_home(&format!("{name}-mac"));
        let win = temp_home(&format!("{name}-win"));
        let dirs = win::Dirs {
            roaming: win.join("AppData").join("Roaming"),
            local: win.join("AppData").join("Local"),
        };
        let paths = Paths::windows(&win, &dirs);
        vec![(mac.clone(), Paths::mac(&mac)), (win, paths)]
    }

    /// File cookie chính của bố cục (`Cookies`, Windows `Network\Cookies`).
    fn cookies(paths: &Paths, dir: &Path) -> PathBuf {
        at(dir, paths.auth_files()[0])
    }

    /// Hồ sơ giả đủ file xác thực và file dùng chung, đăng nhập tài khoản `who`.
    fn fake_profile(paths: &Paths, dir: &Path, who: &str) {
        put(&cookies(paths, dir), &format!("cookies-{who}"));
        put(&at(dir, paths.auth_files()[1]), "");
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
        for (f, body) in SHARED {
            put(&at(dir, f), body);
        }
        put(&dir.join("Cache/Cache_Data/big"), "cache");
        put(&dir.join("claude-code/2.1/claude"), "binary");
    }

    /// File dùng chung của hồ sơ giả. `Local State` giữ khoá mã hoá cookie trên Windows: đổi nó là mọi bộ đã lưu hết
    /// giải mã được.
    const SHARED: [(&str, &str); 7] = [
        ("claude-code-sessions/uuid-a/org/s.json", "session A"),
        ("local-agent-mode-sessions/x.json", "agent"),
        ("Local Storage/leveldb/000005.ldb", "ls"),
        ("IndexedDB/https_claude.ai_0/a.log", "idb"),
        (
            "Local State",
            r#"{"os_crypt":{"encrypted_key":"RFBBUEk="}}"#,
        ),
        ("Network/TransportSecurity", "hsts"),
        ("Network/Network Persistent State", "net"),
    ];

    /// Người dùng đăng nhập tài khoản `who` trong app: Cookies và token mới, khoá khác của config.json giữ nguyên.
    fn sign_in(paths: &Paths, dir: &Path, who: &str) {
        put(&cookies(paths, dir), &format!("cookies-{who}"));
        let mut config = read_object(&dir.join(CONFIG)).unwrap();
        config.insert("oauth:tokenCache".into(), format!("v10-{who}").into());
        config.insert("oauth:tokenCacheV2".into(), format!("v10b-{who}").into());
        config.insert("lastKnownAccountUuid".into(), format!("uuid-{who}").into());
        put(&dir.join(CONFIG), &Value::Object(config).to_string());
    }

    /// Mọi file dùng chung của hồ sơ, để so trước và sau khi chuyển.
    fn shared(dir: &Path) -> Vec<(String, String)> {
        let mut out = vec![];
        for (f, _) in SHARED {
            out.push((f.to_string(), read(&at(dir, f))));
        }
        out.push(("Cache".into(), read(&dir.join("Cache/Cache_Data/big"))));
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

    fn account(paths: &Paths, dir: &Path) -> (String, Value, Value) {
        let c = json(&dir.join(CONFIG));
        (
            read(&cookies(paths, dir)),
            c["oauth:tokenCacheV2"].clone(),
            json(&dir.join(DESKTOP_CONFIG))["preferences"]["sidebarMode"].clone(),
        )
    }

    fn no_temp_files(dir: &Path) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().into_string().unwrap();
            assert!(!name.ends_with(".hive-tmp"), "{name}");
            assert!(!name.ends_with(".old"), "{name}");
            if entry.file_type().unwrap().is_dir() {
                no_temp_files(&entry.path());
            }
        }
    }

    const T0: Duration = Duration::from_secs(1_791_984_120); // 2026-10-14 13:22:00 UTC

    #[test]
    fn ids_stay_under_hive_and_skip_reserved_names() {
        let paths = Paths::mac(Path::new("/Users/a"));
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
    fn profile_and_auth_files_follow_the_os() {
        let (mac, win) = (Path::new("/Users/a"), Path::new("C:/Users/a"));
        assert_eq!(
            Paths::mac(mac).real,
            mac.join("Library/Application Support/Claude")
        );
        let dirs = win::Dirs {
            roaming: win.join("AppData").join("Roaming"),
            local: win.join("AppData").join("Local"),
        };
        let paths = Paths::windows(win, &dirs);
        assert_eq!(paths.real, dirs.roaming.join("Claude"));
        assert_eq!(paths.root, win.join(".xdev-hive").join("claude-desktop"));
        assert_eq!(
            cookies(&paths, &paths.real),
            dirs.roaming.join("Claude").join("Network").join("Cookies")
        );
        assert!(!paths.auth_files().iter().any(|f| f.contains("Local State")));
    }

    #[test]
    fn switching_a_b_a_swaps_only_the_login() {
        for (home, paths) in layouts("switch") {
            fake_profile(&paths, &paths.real, "a");
            let before = shared(&paths.real);
            // Gói B đã đăng nhập từ trước: bộ của B lấy từ một hồ sơ khác.
            let other = home.join("other");
            fake_profile(&paths, &other, "b");
            save_auth(
                &other,
                &paths.bundle("claude-2").unwrap(),
                paths.auth_files(),
            )
            .unwrap();

            let mut state = State {
                active: Some("claude-1".into()),
                backup: None,
                mismatch: None,
            };
            swap_auth(&paths, &mut state, Some("claude-2"), &[], UNIX_EPOCH + T0).unwrap();
            assert_eq!(state.active.as_deref(), Some("claude-2"));
            assert_eq!(
                account(&paths, &paths.real),
                ("cookies-b".into(), "v10b-b".into(), "mode-b".into())
            );
            assert_eq!(
                json(&paths.real.join(CONFIG))["lastKnownAccountUuid"],
                "uuid-b"
            );
            assert_eq!(shared(&paths.real), before, "file dùng chung giữ nguyên");
            // Đăng nhập của A đã lưu vào gói A.
            let a = paths.bundle("claude-1").unwrap();
            assert_eq!(read(&cookies(&paths, &a)), "cookies-a");
            assert_eq!(json(&a.join(CONFIG))["oauth:tokenCache"], "v10-a");
            assert_eq!(json(&a.join(BUNDLE_PREFS))["sidebarMode"], "mode-a");
            assert!(
                json(&a.join(CONFIG)).get("locale").is_none(),
                "bộ chỉ có khoá xác thực"
            );
            assert!(!a.join("Local State").exists(), "bộ không mang khoá chung");

            swap_auth(&paths, &mut state, Some("claude-1"), &[], UNIX_EPOCH + T0).unwrap();
            assert_eq!(
                account(&paths, &paths.real),
                ("cookies-a".into(), "v10b-a".into(), "mode-a".into())
            );
            assert_eq!(shared(&paths.real), before);
            assert_eq!(read_state(&paths), state);
            no_temp_files(&paths.real);
            no_temp_files(&paths.root.join("claude-1"));
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn plan_without_login_opens_signed_out_and_keeps_everything_else() {
        for (home, paths) in layouts("signin") {
            fake_profile(&paths, &paths.real, "a");
            let before = shared(&paths.real);
            let mut state = State::default();
            swap_auth(&paths, &mut state, Some("claude-3"), &[], UNIX_EPOCH + T0).unwrap();
            for f in paths.auth_files() {
                assert!(!at(&paths.real, f).exists(), "{f}");
            }
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
            sign_in(&paths, &paths.real, "c");
            swap_auth(&paths, &mut state, Some("claude-4"), &[], UNIX_EPOCH + T0).unwrap();
            let c = paths.bundle("claude-3").unwrap();
            assert!(paths.has_login(&c));
            assert_eq!(read(&cookies(&paths, &c)), "cookies-c");
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    /// Hồ sơ Windows chưa dời cookie vào `Network\` (Electron cũ) vẫn lưu và nạp đúng; cookie cũ ở gốc của tài khoản
    /// trước không nằm lại cạnh cookie mới.
    #[test]
    fn windows_profile_with_cookies_at_the_root_still_switches() {
        let (home, paths) = layouts("winroot").pop().unwrap();
        fake_profile(&paths, &paths.real, "a");
        std::fs::remove_dir_all(paths.real.join("Network")).unwrap();
        put(&paths.real.join("Cookies"), "cookies-a-old");
        put(&paths.real.join("Local State"), "key");
        let other = home.join("other");
        fake_profile(&paths, &other, "b");
        save_auth(
            &other,
            &paths.bundle("claude-2").unwrap(),
            paths.auth_files(),
        )
        .unwrap();
        let mut state = State {
            active: Some("claude-1".into()),
            backup: None,
            mismatch: None,
        };
        swap_auth(&paths, &mut state, Some("claude-2"), &[], UNIX_EPOCH + T0).unwrap();
        assert_eq!(read(&cookies(&paths, &paths.real)), "cookies-b");
        assert!(!paths.real.join("Cookies").exists());
        assert_eq!(read(&paths.real.join("Local State")), "key");
        let a = paths.bundle("claude-1").unwrap();
        assert_eq!(read(&a.join("Cookies")), "cookies-a-old");
        assert!(paths.has_login(&a));

        swap_auth(&paths, &mut state, Some("claude-1"), &[], UNIX_EPOCH + T0).unwrap();
        assert_eq!(read(&paths.real.join("Cookies")), "cookies-a-old");
        assert!(!cookies(&paths, &paths.real).exists());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn first_switch_backs_up_the_whole_profile_once_and_restore_brings_the_login_back() {
        for (home, paths) in layouts("backup") {
            fake_profile(&paths, &paths.real, "a");
            let mut state = State::default();
            swap_auth(&paths, &mut state, Some("claude-2"), &[], UNIX_EPOCH + T0).unwrap();
            let name = state.backup.clone().unwrap();
            assert_eq!(name, "backup-20261014-132200");
            let backup = paths.root.join(&name);
            assert_eq!(read(&cookies(&paths, &backup)), "cookies-a");
            assert_eq!(
                read(&backup.join("claude-code-sessions/uuid-a/org/s.json")),
                "session A"
            );
            assert!(backup.join("Local State").exists());
            assert!(!backup.join("Cache").exists(), "không chép cache");
            assert!(!backup.join("claude-code").exists());

            // Lần sau không sao lưu lại, dù giờ khác.
            swap_auth(
                &paths,
                &mut state,
                Some("claude-3"),
                &[],
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
            sign_in(&paths, &paths.real, "c");
            put(
                &paths.real.join("claude-code-sessions/uuid-c/new.json"),
                "new",
            );
            swap_auth(&paths, &mut state, None, &[], UNIX_EPOCH + T0).unwrap();
            assert_eq!(state.active, None);
            assert_eq!(account(&paths, &paths.real).0, "cookies-a");
            assert_eq!(json(&paths.real.join(CONFIG))["oauth:tokenCache"], "v10-a");
            assert_eq!(
                read(&paths.real.join("claude-code-sessions/uuid-c/new.json")),
                "new",
                "khôi phục chỉ đổi đăng nhập, không xoá dữ liệu mới"
            );
            assert_eq!(
                read(&cookies(&paths, &paths.bundle("claude-3").unwrap())),
                "cookies-c"
            );
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    /// Huỷ giữa lúc sao lưu hay lúc đổi đăng nhập: hồ sơ giữ đăng nhập cũ, không còn bản sao lưu dở, trạng thái không đổi.
    #[test]
    fn cancel_midway_keeps_the_previous_login() {
        use std::sync::atomic::{AtomicBool, Ordering};
        for at_step in [Step::BackingUp, Step::Swapping] {
            for (home, paths) in layouts("cancel") {
                fake_profile(&paths, &paths.real, "a");
                put(
                    &cookies(&paths, &paths.bundle("claude-2").unwrap()),
                    "cookies-b",
                );
                let cancel = AtomicBool::new(false);
                let report = |s: Step, _: Option<u8>| {
                    if s == at_step {
                        cancel.store(true, Ordering::SeqCst);
                    }
                };
                let mut state = State::default();
                let err = super::swap_auth(
                    &paths,
                    &mut state,
                    Some("claude-2"),
                    &[],
                    UNIX_EPOCH + T0,
                    &Ctl::new(&cancel, &report),
                )
                .unwrap_err();
                assert_eq!(err, job::CANCELLED);
                assert_eq!(account(&paths, &paths.real).0, "cookies-a");
                assert_eq!(read_state(&paths).active, None);
                if at_step == Step::BackingUp {
                    assert_eq!(state.backup, None);
                    assert!(!paths.root.join("backup-20261014-132200").exists());
                }
                no_temp_files(&paths.root);
                // Lần sau chạy bình thường.
                swap_auth(&paths, &mut state, Some("claude-2"), &[], UNIX_EPOCH + T0).unwrap();
                assert_eq!(account(&paths, &paths.real).0, "cookies-b");
                std::fs::remove_dir_all(&home).unwrap();
            }
        }
    }

    #[test]
    fn broken_config_aborts_before_touching_the_profile() {
        for (home, paths) in layouts("broken") {
            fake_profile(&paths, &paths.real, "a");
            let other = home.join("other");
            fake_profile(&paths, &other, "b");
            save_auth(
                &other,
                &paths.bundle("claude-2").unwrap(),
                paths.auth_files(),
            )
            .unwrap();
            put(&paths.real.join(DESKTOP_CONFIG), "{không phải json");
            let mut state = State {
                active: Some("claude-1".into()),
                backup: None,
                mismatch: None,
            };
            let err =
                swap_auth(&paths, &mut state, Some("claude-2"), &[], UNIX_EPOCH + T0).unwrap_err();
            assert!(err.contains("không phải JSON"), "{err}");
            assert_eq!(read(&cookies(&paths, &paths.real)), "cookies-a");
            assert_eq!(read(&paths.real.join(DESKTOP_CONFIG)), "{không phải json");
            assert_eq!(state.active.as_deref(), Some("claude-1"));
            no_temp_files(&paths.real);
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn restore_without_backup_is_refused() {
        for (home, paths) in layouts("nobackup") {
            fake_profile(&paths, &paths.real, "a");
            let mut state = State::default();
            assert!(swap_auth(&paths, &mut state, None, &[], UNIX_EPOCH + T0).is_err());
            assert_eq!(read(&cookies(&paths, &paths.real)), "cookies-a");
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn saved_logins_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_home("perm");
        let paths = Paths::mac(&home);
        fake_profile(&paths, &paths.real, "a");
        let bundle = paths.bundle("claude-1").unwrap();
        save_auth(&paths.real, &bundle, paths.auth_files()).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&bundle), 0o700);
        assert_eq!(mode(bundle.parent().unwrap()), 0o700);
        for f in ["Cookies", "Cookies-journal", CONFIG, BUNDLE_PREFS] {
            assert_eq!(mode(&bundle.join(f)), 0o600, "{f}");
        }
        // Lưu lại đè bộ cũ, không để thư mục tạm.
        put(&paths.real.join("Cookies"), "cookies-a2");
        save_auth(&paths.real, &bundle, paths.auth_files()).unwrap();
        assert_eq!(read(&bundle.join("Cookies")), "cookies-a2");
        no_temp_files(bundle.parent().unwrap());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn legacy_profile_becomes_a_login_bundle() {
        let home = temp_home("legacy");
        let paths = Paths::mac(&home);
        fake_profile(&paths, &paths.real, "a");
        let real_before = shared(&paths.real);
        let old = paths.root.join("claude-2");
        fake_profile(&paths, &old, "b");
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
        let paths = Paths::mac(&home);
        fake_profile(&paths, &paths.real, "a");
        std::fs::create_dir_all(&paths.root).unwrap();
        std::os::unix::fs::symlink(&paths.real, paths.root.join("claude-1")).unwrap();
        assert!(migrate_legacy(&paths, "claude-1").is_err());
        assert_eq!(read(&paths.real.join("Cookies")), "cookies-a");
        assert!(paths.real.join("Local Storage/leveldb/000005.ldb").exists());
        std::fs::remove_dir_all(&home).unwrap();
    }

    fn plan(id: &str, cli: &str, label: &str, email: Option<&str>) -> Plan {
        Plan {
            id: id.into(),
            cli: cli.into(),
            label: label.into(),
            email: email.map(Into::into),
            config_dir: None,
        }
    }

    #[test]
    fn view_lists_claude_plans_with_saved_and_active() {
        let home = temp_home("view");
        let paths = Paths::mac(&home);
        fake_profile(&paths, &paths.real, "a");
        save_auth(
            &paths.real,
            &paths.bundle("claude-1").unwrap(),
            paths.auth_files(),
        )
        .unwrap();
        write_state(
            &paths,
            &State {
                active: Some("claude-2".into()),
                backup: Some("backup-gone".into()),
                mismatch: None,
            },
        )
        .unwrap();
        let plans = [
            plan("claude-1", "claude", "Duy Max", Some("duy@fpt.com")),
            plan("codex-1", "codex", "Codex", None),
            plan("claude-2", "claude", "", Some("")),
        ];
        let app = App::Mac(PathBuf::from("/Applications/Claude.app"));
        let v = view(&paths, &plans, &[], Some(&app), true, Some(42));
        assert_eq!(v.app.as_deref(), Some("/Applications/Claude.app"));
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
            view(&paths, &plans, &[], None, true, None).note.as_deref(),
            Some(mac::NOT_INSTALLED)
        );
        assert_eq!(
            view(&paths, &plans, &[], None, false, None).note.as_deref(),
            Some(UNSUPPORTED)
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    fn owner(id: &str, who: Option<&str>) -> Owner {
        Owner {
            id: id.into(),
            uuid: who.map(|w| format!("uuid-{w}")),
            email: who.map(|w| format!("{w}@fpt.com")),
        }
    }

    /// claude-1 là tài khoản a, claude-2 là b, claude-3 là c.
    fn abc() -> Vec<Owner> {
        vec![
            owner("claude-1", Some("a")),
            owner("claude-2", Some("b")),
            owner("claude-3", Some("c")),
        ]
    }

    #[test]
    fn plan_account_comes_from_its_claude_json() {
        let home = temp_home("owners");
        assert_eq!(plan_json(&home, None), home.join(".claude.json"));
        assert_eq!(plan_json(&home, Some("")), home.join(".claude.json"));
        assert_eq!(
            plan_json(&home, Some("~/.xdev-hive/accounts/claude-2")),
            home.join(".xdev-hive/accounts/claude-2/.claude.json")
        );
        assert_eq!(
            plan_json(&home, Some("/opt/c3")),
            Path::new("/opt/c3/.claude.json")
        );
        put(
            &home.join(".claude.json"),
            r#"{"projects":{"/x":{}},"oauthAccount":{"accountUuid":"uuid-a","emailAddress":"a@fpt.com"}}"#,
        );
        put(
            &home.join(".xdev-hive/accounts/claude-2/.claude.json"),
            r#"{"oauthAccount":null}"#,
        );
        let mut c2 = plan("claude-2", "claude", "", Some("b@fpt.com"));
        c2.config_dir = Some("~/.xdev-hive/accounts/claude-2".into());
        let plans = [
            plan("claude-1", "claude", "", Some("a@fpt.com")),
            c2,
            plan("codex-1", "codex", "", None),
        ];
        assert_eq!(
            owners(&home, &plans),
            vec![
                owner("claude-1", Some("a")),
                Owner {
                    id: "claude-2".into(),
                    uuid: None,
                    email: Some("b@fpt.com".into())
                },
            ]
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn signed_out_profile_has_no_account_even_with_last_known_uuid() {
        for (home, paths) in layouts("signedout") {
            let dir = home.join("p");
            put(
                &dir.join(CONFIG),
                r#"{"lastKnownAccountUuid":"uuid-a","locale":"vi-VN"}"#,
            );
            assert_eq!(account_of(&paths, &dir), None);
            sign_in(&paths, &dir, "a");
            assert_eq!(account_of(&paths, &dir).as_deref(), Some("uuid-a"));
            assert_eq!(short_uuid("296f5a0d-1111-2222"), "296f5a0d…");
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn signed_in_profile_is_adopted_by_the_plan_with_the_same_account() {
        for (home, paths) in layouts("adopt") {
            fake_profile(&paths, &paths.real, "b");
            let before = shared(&paths.real);
            assert!(reconcile(&paths, &abc(), true).unwrap());
            let state = read_state(&paths);
            assert_eq!(state.active.as_deref(), Some("claude-2"));
            assert_eq!(state.mismatch, None);
            let b = paths.bundle("claude-2").unwrap();
            assert_eq!(read(&cookies(&paths, &b)), "cookies-b");
            assert_eq!(json(&b.join(CONFIG))["oauth:tokenCacheV2"], "v10b-b");
            assert!(!paths.bundle("claude-1").unwrap().exists());
            // Chỉ đọc hồ sơ thật.
            assert_eq!(shared(&paths.real), before);
            assert_eq!(account(&paths, &paths.real).0, "cookies-b");
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn previous_login_becomes_the_bundle_of_its_plan() {
        // Máy đã chuyển sang claude-3 trước khi có tự gắn: đăng nhập ban đầu (claude-1) chỉ nằm ở .previous.
        for (home, paths) in layouts("previous") {
            fake_profile(&paths, &paths.real, "a");
            let mut state = State::default();
            swap_auth(&paths, &mut state, Some("claude-3"), &[], UNIX_EPOCH + T0).unwrap();
            assert!(!paths.bundle("claude-1").unwrap().exists());
            assert_eq!(account_of(&paths, &paths.real), None);

            assert!(reconcile(&paths, &abc(), false).unwrap());
            let c1 = paths.bundle("claude-1").unwrap();
            assert_eq!(read(&cookies(&paths, &c1)), "cookies-a");
            assert_eq!(json(&c1.join(CONFIG))["lastKnownAccountUuid"], "uuid-a");
            assert_eq!(json(&c1.join(BUNDLE_PREFS))["sidebarMode"], "mode-a");
            let state = read_state(&paths);
            assert_eq!(
                state.active.as_deref(),
                Some("claude-3"),
                "vẫn chờ đăng nhập claude-3"
            );
            assert_eq!(state.mismatch, None);

            // Bộ đã có thì .previous không đè lên.
            put(&cookies(&paths, &c1), "cookies-a-newer");
            reconcile(&paths, &abc(), false).unwrap();
            assert_eq!(read(&cookies(&paths, &c1)), "cookies-a-newer");

            // Chuyển về claude-1: đăng nhập lại có sẵn, không bắt đăng nhập.
            let mut state = read_state(&paths);
            swap_auth(
                &paths,
                &mut state,
                Some("claude-1"),
                &abc(),
                UNIX_EPOCH + T0,
            )
            .unwrap();
            assert_eq!(account(&paths, &paths.real).0, "cookies-a-newer");
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn login_after_switching_to_a_new_plan_is_saved_right_away() {
        for (home, paths) in layouts("login") {
            fake_profile(&paths, &paths.real, "a");
            let mut state = State::default();
            swap_auth(
                &paths,
                &mut state,
                Some("claude-3"),
                &abc(),
                UNIX_EPOCH + T0,
            )
            .unwrap();
            // App ở màn đăng nhập: chưa có gì để lưu.
            assert!(reconcile(&paths, &abc(), true).unwrap());
            assert!(!paths.has_login(&paths.bundle("claude-3").unwrap()));

            sign_in(&paths, &paths.real, "c");
            assert!(reconcile(&paths, &abc(), true).unwrap());
            let c3 = paths.bundle("claude-3").unwrap();
            assert_eq!(read(&cookies(&paths, &c3)), "cookies-c");
            assert_eq!(json(&c3.join(CONFIG))["oauth:tokenCache"], "v10-c");
            assert_eq!(read_state(&paths).active.as_deref(), Some("claude-3"));
            assert_eq!(read_state(&paths).mismatch, None);
            no_temp_files(paths.bundle("claude-3").unwrap().parent().unwrap());
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn login_with_another_plans_account_goes_to_that_plan_and_is_reported() {
        for (home, paths) in layouts("wrongplan") {
            fake_profile(&paths, &paths.real, "b");
            let mut state = State::default();
            swap_auth(
                &paths,
                &mut state,
                Some("claude-3"),
                &abc(),
                UNIX_EPOCH + T0,
            )
            .unwrap();
            sign_in(&paths, &paths.real, "a");
            reconcile(&paths, &abc(), true).unwrap();
            let state = read_state(&paths);
            assert_eq!(
                state.mismatch,
                Some(Mismatch {
                    account: "a@fpt.com".into(),
                    expected: "claude-3".into(),
                    adopted: Some("claude-1".into()),
                })
            );
            assert_eq!(state.active.as_deref(), Some("claude-1"));
            assert_eq!(
                read(&cookies(&paths, &paths.bundle("claude-1").unwrap())),
                "cookies-a"
            );
            assert!(!paths.bundle("claude-3").unwrap().exists());
            // Thông báo giữ qua các lần đối chiếu sau, hết khi chuyển gói.
            reconcile(&paths, &abc(), true).unwrap();
            assert!(read_state(&paths).mismatch.is_some());
            let mut state = read_state(&paths);
            swap_auth(
                &paths,
                &mut state,
                Some("claude-3"),
                &abc(),
                UNIX_EPOCH + T0,
            )
            .unwrap();
            assert_eq!(read_state(&paths).mismatch, None);
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn login_with_an_unknown_account_is_never_saved_into_the_waiting_plan() {
        for (home, paths) in layouts("stranger") {
            fake_profile(&paths, &paths.real, "b");
            let mut state = State::default();
            swap_auth(
                &paths,
                &mut state,
                Some("claude-3"),
                &abc(),
                UNIX_EPOCH + T0,
            )
            .unwrap();
            sign_in(&paths, &paths.real, "z");
            reconcile(&paths, &abc(), true).unwrap();
            let state = read_state(&paths);
            assert_eq!(state.active.as_deref(), Some("claude-3"));
            assert_eq!(
                state.mismatch,
                Some(Mismatch {
                    account: "uuid-z".into(),
                    expected: "claude-3".into(),
                    adopted: None,
                })
            );
            assert!(!paths.bundle("claude-3").unwrap().exists());
            // Chuyển đi cũng không lưu tài khoản lạ vào claude-3 (chỉ còn ở .previous).
            let mut state = read_state(&paths);
            swap_auth(
                &paths,
                &mut state,
                Some("claude-2"),
                &abc(),
                UNIX_EPOCH + T0,
            )
            .unwrap();
            assert!(!paths.bundle("claude-3").unwrap().exists());
            assert_eq!(read(&cookies(&paths, &paths.previous())), "cookies-z");
            assert_eq!(account(&paths, &paths.real).0, "cookies-b");

            // Đăng xuất rồi đăng nhập đúng tài khoản thì hết thông báo.
            let mut state = read_state(&paths);
            state.active = Some("claude-3".into());
            state.mismatch = Some(Mismatch {
                account: "uuid-z".into(),
                expected: "claude-3".into(),
                adopted: None,
            });
            write_state(&paths, &state).unwrap();
            sign_in(&paths, &paths.real, "c");
            reconcile(&paths, &abc(), true).unwrap();
            assert_eq!(read_state(&paths).mismatch, None);
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn plan_with_unknown_account_still_trusts_the_active_plan() {
        for (home, paths) in layouts("unknown") {
            fake_profile(&paths, &paths.real, "x");
            let owners = vec![owner("claude-1", Some("a")), owner("claude-4", None)];
            write_state(
                &paths,
                &State {
                    active: Some("claude-4".into()),
                    ..State::default()
                },
            )
            .unwrap();
            reconcile(&paths, &owners, true).unwrap();
            assert_eq!(
                read(&cookies(&paths, &paths.bundle("claude-4").unwrap())),
                "cookies-x"
            );
            assert_eq!(read_state(&paths).mismatch, None);
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn token_refreshed_by_the_app_updates_the_plan_bundle() {
        for (home, paths) in layouts("rotate") {
            fake_profile(&paths, &paths.real, "a");
            let other = home.join("other");
            fake_profile(&paths, &other, "b");
            save_auth(
                &other,
                &paths.bundle("claude-2").unwrap(),
                paths.auth_files(),
            )
            .unwrap();
            let mut state = State::default();
            swap_auth(
                &paths,
                &mut state,
                Some("claude-2"),
                &abc(),
                UNIX_EPOCH + T0,
            )
            .unwrap();
            let b = paths.bundle("claude-2").unwrap();
            // Vừa nạp: bộ và hồ sơ như nhau, không ghi lại.
            let mtime = std::fs::metadata(b.join(CONFIG))
                .unwrap()
                .modified()
                .unwrap();
            assert!(reconcile(&paths, &abc(), true).unwrap());
            assert_eq!(
                std::fs::metadata(b.join(CONFIG))
                    .unwrap()
                    .modified()
                    .unwrap(),
                mtime
            );

            // App làm mới token và cookie sau khi mở lại.
            let mut config = read_object(&paths.real.join(CONFIG)).unwrap();
            config.insert("oauth:tokenCacheV2".into(), "v10b-b-rotated".into());
            put(&paths.real.join(CONFIG), &Value::Object(config).to_string());
            put(&cookies(&paths, &paths.real), "cookies-b-rotated");
            assert!(reconcile(&paths, &abc(), true).unwrap());
            assert_eq!(
                json(&b.join(CONFIG))["oauth:tokenCacheV2"],
                "v10b-b-rotated"
            );
            assert_eq!(read(&cookies(&paths, &b)), "cookies-b-rotated");

            // Chuyển đi rồi về: nạp token mới, không phải token đã bị xoay vòng.
            let mut state = read_state(&paths);
            swap_auth(
                &paths,
                &mut state,
                Some("claude-1"),
                &abc(),
                UNIX_EPOCH + T0,
            )
            .unwrap();
            swap_auth(
                &paths,
                &mut state,
                Some("claude-2"),
                &abc(),
                UNIX_EPOCH + T0,
            )
            .unwrap();
            assert_eq!(
                json(&paths.real.join(CONFIG))["oauth:tokenCacheV2"],
                "v10b-b-rotated"
            );
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn live_copy_waits_while_the_cookie_database_is_mid_transaction() {
        for (home, paths) in layouts("live") {
            fake_profile(&paths, &paths.real, "a");
            put(&at(&paths.real, paths.auth_files()[1]), "hot");
            let bundle = paths.bundle("claude-1").unwrap();
            assert!(!refresh_bundle(&paths, &bundle, true).unwrap());
            assert!(!bundle.exists());
            assert!(!reconcile(&paths, &abc(), true).unwrap());
            // App đã thoát thì không có ai ghi xen: chép luôn.
            assert!(refresh_bundle(&paths, &bundle, false).unwrap());
            assert_eq!(read(&cookies(&paths, &bundle)), "cookies-a");
            // Hồ sơ đổi giữa lúc chép: bỏ bản chép, bộ cũ giữ nguyên.
            put(&at(&paths.real, paths.auth_files()[1]), "");
            put(&cookies(&paths, &paths.real), "cookies-a2");
            assert!(!save_auth_if(&paths.real, &bundle, paths.auth_files(), || false).unwrap());
            assert_eq!(read(&cookies(&paths, &bundle)), "cookies-a");
            no_temp_files(bundle.parent().unwrap());
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn switching_saves_the_current_login_into_its_own_plan() {
        for (home, paths) in layouts("ownplan") {
            fake_profile(&paths, &paths.real, "a");
            // Trạng thái cũ ghi nhầm claude-3 đang dùng trong khi app đăng nhập tài khoản của claude-1.
            let mut state = State {
                active: Some("claude-3".into()),
                ..State::default()
            };
            swap_auth(
                &paths,
                &mut state,
                Some("claude-2"),
                &abc(),
                UNIX_EPOCH + T0,
            )
            .unwrap();
            assert_eq!(
                read(&cookies(&paths, &paths.bundle("claude-1").unwrap())),
                "cookies-a"
            );
            assert!(!paths.bundle("claude-3").unwrap().exists());
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn view_shows_the_signed_in_account_and_its_plan() {
        for (home, paths) in layouts("signedin") {
            fake_profile(&paths, &paths.real, "b");
            let plans = [
                plan("claude-1", "claude", "Max", Some("a@fpt.com")),
                plan("claude-2", "claude", "Pro", Some("b@fpt.com")),
                plan("claude-4", "claude", "Token", None),
            ];
            let owners = vec![
                owner("claude-1", Some("a")),
                owner("claude-2", Some("b")),
                owner("claude-4", None),
            ];
            reconcile(&paths, &owners, false).unwrap();
            let v = view(&paths, &plans, &owners, None, true, None);
            assert_eq!(
                v.signed_in,
                Some(SignedIn {
                    account: "uuid-b".into(),
                    email: Some("b@fpt.com".into()),
                    plan: Some("claude-2".into()),
                })
            );
            assert_eq!(
                v.profiles
                    .iter()
                    .map(|p| (p.id.as_str(), p.saved, p.active, p.account_known))
                    .collect::<Vec<_>>(),
                vec![
                    ("claude-1", false, false, true),
                    ("claude-2", true, true, true),
                    ("claude-4", false, false, false),
                ]
            );
            sign_in(&paths, &paths.real, "z");
            assert_eq!(
                view(&paths, &plans, &owners, None, true, None).signed_in,
                Some(SignedIn {
                    account: "uuid-z".into(),
                    email: None,
                    plan: None,
                })
            );
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    fn sign_out(
        paths: &Paths,
        state: &mut State,
        id: &str,
        owners: &[Owner],
    ) -> Result<(), String> {
        sign_out_auth(paths, state, id, owners, UNIX_EPOCH + T0, &Ctl::idle())
    }

    #[test]
    fn signing_out_removes_only_the_login_of_the_plan_in_use() {
        for (home, paths) in layouts("signout") {
            fake_profile(&paths, &paths.real, "a");
            let before = shared(&paths.real);
            let other = home.join("other");
            fake_profile(&paths, &other, "b");
            let (c1, c2) = (
                paths.bundle("claude-1").unwrap(),
                paths.bundle("claude-2").unwrap(),
            );
            save_auth(&paths.real, &c1, paths.auth_files()).unwrap();
            save_auth(&other, &c2, paths.auth_files()).unwrap();
            let mut state = State {
                active: Some("claude-1".into()),
                ..State::default()
            };

            sign_out(&paths, &mut state, "claude-1", &abc()).unwrap();
            for f in paths.auth_files() {
                assert!(!at(&paths.real, f).exists(), "{f}");
            }
            let config = json(&paths.real.join(CONFIG));
            for k in AUTH_KEYS {
                assert!(config.get(k).is_none(), "{k}");
            }
            assert_eq!(shared(&paths.real), before, "mọi thứ khác giữ nguyên");
            assert_eq!(account_of(&paths, &paths.real), None);
            assert!(!c1.exists(), "bộ đã lưu của gói bị xoá");
            assert_eq!(
                read(&cookies(&paths, &c2)),
                "cookies-b",
                "gói khác không bị đụng"
            );
            assert_eq!(read_state(&paths).active.as_deref(), Some("claude-1"));
            assert!(state.backup.is_some(), "sao lưu trước lần ghi đầu");

            // Đăng nhập cũ không quay lại qua `.previous`.
            assert!(reconcile(&paths, &abc(), false).unwrap());
            assert!(!c1.exists());
            // Lần đăng nhập sau trong app được lưu cho gói đang dùng.
            sign_in(&paths, &paths.real, "a");
            reconcile(&paths, &abc(), false).unwrap();
            assert_eq!(read(&cookies(&paths, &c1)), "cookies-a");
            no_temp_files(&paths.root);
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn signing_out_keeps_another_plans_login_and_refuses_plans_not_in_use() {
        for (home, paths) in layouts("signout-other") {
            // Hồ sơ đang đăng nhập tài khoản của claude-2 dù gói đang dùng là claude-1.
            fake_profile(&paths, &paths.real, "b");
            let mut state = State {
                active: Some("claude-1".into()),
                ..State::default()
            };
            assert_eq!(
                sign_out(&paths, &mut state, "claude-2", &abc()).unwrap_err(),
                NOT_ACTIVE
            );
            assert_eq!(account(&paths, &paths.real).0, "cookies-b", "chưa đổi gì");

            sign_out(&paths, &mut state, "claude-1", &abc()).unwrap();
            assert_eq!(account_of(&paths, &paths.real), None);
            let c2 = paths.bundle("claude-2").unwrap();
            assert_eq!(read(&cookies(&paths, &c2)), "cookies-b");
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn cancelled_sign_out_keeps_the_login() {
        use std::sync::atomic::{AtomicBool, Ordering};
        for (home, paths) in layouts("signout-cancel") {
            fake_profile(&paths, &paths.real, "a");
            let c1 = paths.bundle("claude-1").unwrap();
            save_auth(&paths.real, &c1, paths.auth_files()).unwrap();
            let cancel = AtomicBool::new(false);
            let report = |s: Step, _: Option<u8>| {
                if s == Step::Swapping {
                    cancel.store(true, Ordering::SeqCst);
                }
            };
            let mut state = State {
                active: Some("claude-1".into()),
                ..State::default()
            };
            let err = sign_out_auth(
                &paths,
                &mut state,
                "claude-1",
                &abc(),
                UNIX_EPOCH + T0,
                &Ctl::new(&cancel, &report),
            )
            .unwrap_err();
            assert_eq!(err, job::CANCELLED);
            assert_eq!(account(&paths, &paths.real).0, "cookies-a");
            assert_eq!(read(&cookies(&paths, &c1)), "cookies-a");
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn forgotten_login_does_not_come_back_from_previous() {
        for (home, paths) in layouts("forget") {
            fake_profile(&paths, &paths.real, "a");
            let other = home.join("other");
            fake_profile(&paths, &other, "b");
            save_auth(
                &other,
                &paths.bundle("claude-2").unwrap(),
                paths.auth_files(),
            )
            .unwrap();
            let mut state = State {
                active: Some("claude-1".into()),
                ..State::default()
            };
            swap_auth(
                &paths,
                &mut state,
                Some("claude-2"),
                &abc(),
                UNIX_EPOCH + T0,
            )
            .unwrap();
            let c1 = paths.bundle("claude-1").unwrap();
            assert!(paths.has_login(&c1));
            assert!(
                forget_bundle(&paths, "claude-2").is_err(),
                "gói đang dùng thì đăng xuất"
            );

            forget_bundle(&paths, "claude-1").unwrap();
            assert!(!c1.exists());
            reconcile(&paths, &abc(), false).unwrap();
            assert!(!c1.exists(), "`.previous` không dựng lại bộ vừa quên");
            assert_eq!(account(&paths, &paths.real).0, "cookies-b");
            std::fs::remove_dir_all(&home).unwrap();
        }
    }

    #[test]
    fn tray_label_shows_email_and_in_use_mark() {
        let mut p = ProfileView {
            id: "claude-1".into(),
            label: "Duy Max".into(),
            email: Some("duy@fpt.com".into()),
            saved: true,
            active: false,
            account_known: true,
        };
        assert_eq!(tray_label(&p, false), "Duy Max (duy@fpt.com)");
        p.active = true;
        assert_eq!(tray_label(&p, false), "Duy Max (duy@fpt.com) · đang dùng");
        assert_eq!(tray_label(&p, true), "Duy Max (duy@fpt.com) · in use");
    }
}
