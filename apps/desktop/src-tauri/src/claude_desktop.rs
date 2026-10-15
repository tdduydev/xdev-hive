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
//!
//! Đăng nhập trong hồ sơ thuộc gói nào thì so `lastKnownAccountUuid` với `oauthAccount.accountUuid` trong `.claude.json`
//! của từng gói (cùng một tài khoản claude.ai): người dùng không phải tự nói "app đang đăng nhập gói này", và đăng nhập
//! tài khoản lạ không bị lưu nhầm vào gói khác. Hồ sơ thật chỉ được đọc (app có thể đang chạy) để lưu đăng nhập vào gói
//! ngay khi người dùng vừa đăng nhập hay app vừa làm mới token, không đợi tới lần chuyển sau.

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
/// Nhịp xem hồ sơ thật có đổi không (chỉ stat vài file), và nhịp đối chiếu đủ dù không đổi (gói mới, gói vừa đăng nhập
/// Claude Code nên mới biết tài khoản).
const WATCH_EVERY: Duration = Duration::from_secs(15);
const WATCH_FULL: Duration = Duration::from_secs(300);

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
    save_auth_if(from, dest, || true).map(|_| ())
}

/// Như `save_auth`, nhưng bỏ bản vừa dựng (trả false, `dest` giữ nguyên) khi `still` báo hồ sơ đã đổi trong lúc chép.
fn save_auth_if(from: &Path, dest: &Path, still: impl Fn() -> bool) -> Result<bool, String> {
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
            std::fs::rename(dest, &old)?;
        }
        std::fs::rename(&tmp, dest)?;
        remove_entry(&old)
    })();
    swapped
        .map(|_| true)
        .map_err(|e| format!("Không lưu được bộ đăng nhập: {e}"))
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

/// Tài khoản claude.ai đang đăng nhập trong hồ sơ hay bộ xác thực `dir`. `lastKnownAccountUuid` có thể còn lại sau khi
/// đăng xuất, nên phải còn token hay Cookies mới tính là đang đăng nhập.
fn account_of(dir: &Path) -> Option<String> {
    let config = read_object(&dir.join(CONFIG)).ok()?;
    let token = ["oauth:tokenCache", "oauth:tokenCacheV2"]
        .iter()
        .any(|k| config.get(*k).is_some_and(|v| !v.is_null()));
    if !token && !has_login(dir) {
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

fn stamp(dir: &Path) -> Stamp {
    [CONFIG, DESKTOP_CONFIG, AUTH_FILES[0], AUTH_FILES[1]]
        .iter()
        .map(|f| {
            std::fs::metadata(dir.join(f))
                .ok()
                .map(|m| (m.len(), m.modified().unwrap_or(UNIX_EPOCH)))
        })
        .collect()
}

fn same_auth(a: &Path, b: &Path) -> Result<bool, String> {
    let (x, y) = (read_auth(a)?, read_auth(b)?);
    let cookies = |d: &Path| std::fs::read(d.join(AUTH_FILES[0])).ok();
    Ok(x.config == y.config && x.prefs == y.prefs && cookies(a) == cookies(b))
}

/// Lưu đăng nhập của hồ sơ thật vào bộ của gói khi khác bộ đã lưu (vừa đăng nhập, app vừa làm mới token: token cũ đã
/// bị xoay vòng, nạp lại sẽ bắt đăng nhập). App đang chạy (`live`) thì chỉ nhận bản chép khi không có giao dịch SQLite dở
/// và không file nào đổi trong lúc chép; false là chưa lưu, lần sau thử lại.
fn refresh_bundle(real: &Path, bundle: &Path, live: bool) -> Result<bool, String> {
    if same_auth(real, bundle)? {
        return Ok(true);
    }
    if !live {
        return save_auth(real, bundle).map(|_| true);
    }
    let before = stamp(real);
    if before[3].is_some_and(|(len, _)| len > 0) {
        return Ok(false);
    }
    save_auth_if(real, bundle, || stamp(real) == before)
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
    if let Some(uuid) = account_of(&paths.real) {
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
            settled &= refresh_bundle(&paths.real, &paths.bundle(&id)?, live)?;
        }
    }
    if let Some(uuid) = account_of(&paths.previous())
        && let Some(o) = owner_of(owners, &uuid, None)
    {
        let bundle = paths.bundle(&o.id)?;
        if !has_login(&bundle) {
            save_auth(&paths.previous(), &bundle)?;
        }
    }
    if state != before {
        write_state(paths, &state)?;
    }
    Ok(settled)
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
/// lưu). Claude.app phải đã thoát. Đăng nhập hiện tại lưu vào gói có tài khoản đó (`owners`), không mặc nhiên vào gói
/// đang dùng.
fn swap_auth(
    paths: &Paths,
    state: &mut State,
    target: Option<&str>,
    owners: &[Owner],
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
    let account = account_of(&paths.real);
    if let Some(id) = login_home(owners, account.as_deref(), state.active.as_deref()) {
        save_auth(&paths.real, &paths.bundle(&id)?)?;
    }
    if let Err(e) = load_auth(&source, &paths.real) {
        let _ = load_auth(&paths.previous(), &paths.real);
        return Err(e);
    }
    state.active = target.map(str::to_string);
    state.mismatch = None;
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
    /// None khi Claude Desktop chưa đăng nhập (màn đăng nhập) hay chưa cài.
    signed_in: Option<SignedIn>,
    mismatch: Option<Mismatch>,
    /// false: có đăng nhập chưa lưu được vì app đang ghi hồ sơ; trình theo dõi thử lại sớm.
    #[serde(skip)]
    settled: bool,
}

fn view(
    paths: &Paths,
    plans: &[Plan],
    owners: &[Owner],
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
            account_known: owners.iter().any(|o| o.id == p.id && o.uuid.is_some()),
        })
        .collect();
    let signed_in = account_of(&paths.real).map(|uuid| {
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
        signed_in,
        mismatch: state.mismatch,
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
        let supported = cfg!(target_os = "macos");
        let bundle = if supported { find_app(&home) } else { None };
        let pid = if supported {
            running(&home).real.first().copied()
        } else {
            None
        };
        let paths = Paths::new(&home);
        let owners = owners(&home, &plans);
        // Đang chuyển thì để lần sau: lần chuyển tự lưu đăng nhập và đang ghi hồ sơ thật.
        let settled = !supported
            || match SWITCHING.try_lock() {
                Ok(_guard) => reconcile(&paths, &owners, pid.is_some()).unwrap_or_else(|e| {
                    eprintln!("Không gắn được đăng nhập Claude Desktop vào gói: {e}");
                    true
                }),
                Err(_) => false,
            };
        ProfilesView {
            settled,
            ..view(&paths, &plans, &owners, bundle.as_deref(), supported, pid)
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
    let real = real_profile(&home);
    let mut seen: Option<Stamp> = None;
    let mut last = Instant::now();
    loop {
        tokio::time::sleep(WATCH_EVERY).await;
        if !real.is_dir() {
            continue;
        }
        let now = stamp(&real);
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
fn switch_blocking(
    home: &Path,
    target: Option<&str>,
    owners: &[Owner],
    force: bool,
) -> Result<Switched, String> {
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
    // Gói "đang dùng" mà app lại đăng nhập tài khoản khác: chuyển thật để nạp lại đăng nhập của gói.
    let account = account_of(&paths.real);
    let foreign = account.is_some()
        && login_home(owners, account.as_deref(), target) != target.map(str::to_string);
    if target.is_some() && state.active.as_deref() == target && !foreign {
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
    let swapped = swap_auth(&paths, &mut state, target, owners, SystemTime::now());
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
    let owners = owners(&home, &plans);
    let done = tauri::async_runtime::spawn_blocking(move || {
        switch_blocking(&home, Some(&id), &owners, force)
    })
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
    // Không đọc được danh sách gói thì vẫn khôi phục được: đăng nhập hiện tại lưu vào gói đang dùng như trước.
    let owners = owners(&home, &claude_plans(&app).await.unwrap_or_default());
    let done =
        tauri::async_runtime::spawn_blocking(move || switch_blocking(&home, None, &owners, force))
            .await
            .map_err(|e| e.to_string())??;
    let _ = load(&app).await;
    Ok(done)
}

/// Đóng thông báo "đăng nhập không phải tài khoản của gói".
#[tauri::command]
pub async fn dismiss_claude_desktop_mismatch(app: AppHandle) -> Result<ProfilesView, String> {
    let home = need_home()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let paths = Paths::new(&home);
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

    /// Người dùng đăng nhập tài khoản `who` trong app: Cookies và token mới, khoá khác của config.json giữ nguyên.
    fn sign_in(dir: &Path, who: &str) {
        put(&dir.join("Cookies"), &format!("cookies-{who}"));
        let mut config = read_object(&dir.join(CONFIG)).unwrap();
        config.insert("oauth:tokenCache".into(), format!("v10-{who}").into());
        config.insert("oauth:tokenCacheV2".into(), format!("v10b-{who}").into());
        config.insert("lastKnownAccountUuid".into(), format!("uuid-{who}").into());
        put(&dir.join(CONFIG), &Value::Object(config).to_string());
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
            mismatch: None,
        };
        swap_auth(&paths, &mut state, Some("claude-2"), &[], UNIX_EPOCH + T0).unwrap();
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

        swap_auth(&paths, &mut state, Some("claude-1"), &[], UNIX_EPOCH + T0).unwrap();
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
        swap_auth(&paths, &mut state, Some("claude-3"), &[], UNIX_EPOCH + T0).unwrap();
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
        sign_in(&paths.real, "c");
        swap_auth(&paths, &mut state, Some("claude-4"), &[], UNIX_EPOCH + T0).unwrap();
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
        swap_auth(&paths, &mut state, Some("claude-2"), &[], UNIX_EPOCH + T0).unwrap();
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
        sign_in(&paths.real, "c");
        put(
            &paths.real.join("claude-code-sessions/uuid-c/new.json"),
            "new",
        );
        swap_auth(&paths, &mut state, None, &[], UNIX_EPOCH + T0).unwrap();
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
            mismatch: None,
        };
        let err =
            swap_auth(&paths, &mut state, Some("claude-2"), &[], UNIX_EPOCH + T0).unwrap_err();
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
        assert!(swap_auth(&paths, &mut state, None, &[], UNIX_EPOCH + T0).is_err());
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
            config_dir: None,
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
                mismatch: None,
            },
        )
        .unwrap();
        let plans = [
            plan("claude-1", "claude", "Duy Max", Some("duy@example.com")),
            plan("codex-1", "codex", "Codex", None),
            plan("claude-2", "claude", "", Some("")),
        ];
        let app = PathBuf::from("/Applications/Claude.app");
        let v = view(&paths, &plans, &[], Some(&app), true, Some(42));
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
            Some(NOT_INSTALLED)
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
            email: who.map(|w| format!("{w}@example.com")),
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
            r#"{"projects":{"/x":{}},"oauthAccount":{"accountUuid":"uuid-a","emailAddress":"a@example.com"}}"#,
        );
        put(
            &home.join(".xdev-hive/accounts/claude-2/.claude.json"),
            r#"{"oauthAccount":null}"#,
        );
        let mut c2 = plan("claude-2", "claude", "", Some("b@example.com"));
        c2.config_dir = Some("~/.xdev-hive/accounts/claude-2".into());
        let plans = [
            plan("claude-1", "claude", "", Some("a@example.com")),
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
                    email: Some("b@example.com".into())
                },
            ]
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn signed_out_profile_has_no_account_even_with_last_known_uuid() {
        let home = temp_home("signedout");
        let dir = home.join("p");
        put(
            &dir.join(CONFIG),
            r#"{"lastKnownAccountUuid":"uuid-a","locale":"vi-VN"}"#,
        );
        assert_eq!(account_of(&dir), None);
        sign_in(&dir, "a");
        assert_eq!(account_of(&dir).as_deref(), Some("uuid-a"));
        assert_eq!(short_uuid("296f5a0d-1111-2222"), "296f5a0d…");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn signed_in_profile_is_adopted_by_the_plan_with_the_same_account() {
        let home = temp_home("adopt");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "b");
        let before = shared(&paths.real);
        assert!(reconcile(&paths, &abc(), true).unwrap());
        let state = read_state(&paths);
        assert_eq!(state.active.as_deref(), Some("claude-2"));
        assert_eq!(state.mismatch, None);
        let b = paths.bundle("claude-2").unwrap();
        assert_eq!(read(&b.join("Cookies")), "cookies-b");
        assert_eq!(json(&b.join(CONFIG))["oauth:tokenCacheV2"], "v10b-b");
        assert!(!paths.bundle("claude-1").unwrap().exists());
        // Chỉ đọc hồ sơ thật.
        assert_eq!(shared(&paths.real), before);
        assert_eq!(account(&paths.real).0, "cookies-b");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn previous_login_becomes_the_bundle_of_its_plan() {
        // Máy đã chuyển sang claude-3 trước khi có tự gắn: đăng nhập ban đầu (claude-1) chỉ nằm ở .previous.
        let home = temp_home("previous");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "a");
        let mut state = State::default();
        swap_auth(&paths, &mut state, Some("claude-3"), &[], UNIX_EPOCH + T0).unwrap();
        assert!(!paths.bundle("claude-1").unwrap().exists());
        assert_eq!(account_of(&paths.real), None);

        assert!(reconcile(&paths, &abc(), false).unwrap());
        let c1 = paths.bundle("claude-1").unwrap();
        assert_eq!(read(&c1.join("Cookies")), "cookies-a");
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
        put(&c1.join("Cookies"), "cookies-a-newer");
        reconcile(&paths, &abc(), false).unwrap();
        assert_eq!(read(&c1.join("Cookies")), "cookies-a-newer");

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
        assert_eq!(account(&paths.real).0, "cookies-a-newer");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn login_after_switching_to_a_new_plan_is_saved_right_away() {
        let home = temp_home("login");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "a");
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
        assert!(!has_login(&paths.bundle("claude-3").unwrap()));

        sign_in(&paths.real, "c");
        assert!(reconcile(&paths, &abc(), true).unwrap());
        let c3 = paths.bundle("claude-3").unwrap();
        assert_eq!(read(&c3.join("Cookies")), "cookies-c");
        assert_eq!(json(&c3.join(CONFIG))["oauth:tokenCache"], "v10-c");
        assert_eq!(read_state(&paths).active.as_deref(), Some("claude-3"));
        assert_eq!(read_state(&paths).mismatch, None);
        no_temp_files(paths.bundle("claude-3").unwrap().parent().unwrap());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn login_with_another_plans_account_goes_to_that_plan_and_is_reported() {
        let home = temp_home("wrongplan");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "b");
        let mut state = State::default();
        swap_auth(
            &paths,
            &mut state,
            Some("claude-3"),
            &abc(),
            UNIX_EPOCH + T0,
        )
        .unwrap();
        sign_in(&paths.real, "a");
        reconcile(&paths, &abc(), true).unwrap();
        let state = read_state(&paths);
        assert_eq!(
            state.mismatch,
            Some(Mismatch {
                account: "a@example.com".into(),
                expected: "claude-3".into(),
                adopted: Some("claude-1".into()),
            })
        );
        assert_eq!(state.active.as_deref(), Some("claude-1"));
        assert_eq!(
            read(&paths.bundle("claude-1").unwrap().join("Cookies")),
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

    #[test]
    fn login_with_an_unknown_account_is_never_saved_into_the_waiting_plan() {
        let home = temp_home("stranger");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "b");
        let mut state = State::default();
        swap_auth(
            &paths,
            &mut state,
            Some("claude-3"),
            &abc(),
            UNIX_EPOCH + T0,
        )
        .unwrap();
        sign_in(&paths.real, "z");
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
        assert_eq!(read(&paths.previous().join("Cookies")), "cookies-z");
        assert_eq!(account(&paths.real).0, "cookies-b");

        // Đăng xuất rồi đăng nhập đúng tài khoản thì hết thông báo.
        let mut state = read_state(&paths);
        state.active = Some("claude-3".into());
        state.mismatch = Some(Mismatch {
            account: "uuid-z".into(),
            expected: "claude-3".into(),
            adopted: None,
        });
        write_state(&paths, &state).unwrap();
        sign_in(&paths.real, "c");
        reconcile(&paths, &abc(), true).unwrap();
        assert_eq!(read_state(&paths).mismatch, None);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn plan_with_unknown_account_still_trusts_the_active_plan() {
        let home = temp_home("unknown");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "x");
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
            read(&paths.bundle("claude-4").unwrap().join("Cookies")),
            "cookies-x"
        );
        assert_eq!(read_state(&paths).mismatch, None);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn token_refreshed_by_the_app_updates_the_plan_bundle() {
        let home = temp_home("rotate");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "a");
        let other = home.join("other");
        fake_profile(&other, "b");
        save_auth(&other, &paths.bundle("claude-2").unwrap()).unwrap();
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
        put(&paths.real.join("Cookies"), "cookies-b-rotated");
        assert!(reconcile(&paths, &abc(), true).unwrap());
        assert_eq!(
            json(&b.join(CONFIG))["oauth:tokenCacheV2"],
            "v10b-b-rotated"
        );
        assert_eq!(read(&b.join("Cookies")), "cookies-b-rotated");

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

    #[test]
    fn live_copy_waits_while_the_cookie_database_is_mid_transaction() {
        let home = temp_home("live");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "a");
        put(&paths.real.join("Cookies-journal"), "hot");
        let bundle = paths.bundle("claude-1").unwrap();
        assert!(!refresh_bundle(&paths.real, &bundle, true).unwrap());
        assert!(!bundle.exists());
        assert!(!reconcile(&paths, &abc(), true).unwrap());
        // App đã thoát thì không có ai ghi xen: chép luôn.
        assert!(refresh_bundle(&paths.real, &bundle, false).unwrap());
        assert_eq!(read(&bundle.join("Cookies")), "cookies-a");
        // Hồ sơ đổi giữa lúc chép: bỏ bản chép, bộ cũ giữ nguyên.
        put(&paths.real.join("Cookies-journal"), "");
        put(&paths.real.join("Cookies"), "cookies-a2");
        assert!(!save_auth_if(&paths.real, &bundle, || false).unwrap());
        assert_eq!(read(&bundle.join("Cookies")), "cookies-a");
        no_temp_files(bundle.parent().unwrap());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn switching_saves_the_current_login_into_its_own_plan() {
        let home = temp_home("ownplan");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "a");
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
            read(&paths.bundle("claude-1").unwrap().join("Cookies")),
            "cookies-a"
        );
        assert!(!paths.bundle("claude-3").unwrap().exists());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn view_shows_the_signed_in_account_and_its_plan() {
        let home = temp_home("signedin");
        let paths = Paths::new(&home);
        fake_profile(&paths.real, "b");
        let plans = [
            plan("claude-1", "claude", "Max", Some("a@example.com")),
            plan("claude-2", "claude", "Pro", Some("b@example.com")),
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
                email: Some("b@example.com".into()),
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
        sign_in(&paths.real, "z");
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

    #[test]
    fn tray_label_shows_email_and_in_use_mark() {
        let mut p = ProfileView {
            id: "claude-1".into(),
            label: "Duy Max".into(),
            email: Some("duy@example.com".into()),
            saved: true,
            active: false,
            account_known: true,
        };
        assert_eq!(tray_label(&p, false), "Duy Max (duy@example.com)");
        p.active = true;
        assert_eq!(tray_label(&p, false), "Duy Max (duy@example.com) · đang dùng");
        assert_eq!(tray_label(&p, true), "Duy Max (duy@example.com) · in use");
    }
}
