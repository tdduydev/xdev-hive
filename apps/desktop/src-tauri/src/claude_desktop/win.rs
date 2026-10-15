//! Phần riêng Windows của việc chuyển Claude Desktop: tìm bản cài (Squirrel hay MSIX), tìm hồ sơ thật, dò tiến trình,
//! thoát êm bằng `taskkill` (WM_CLOSE) và mở lại. Mọi lệnh ngoài đều có hạn chờ: PowerShell/WMI có lúc không trả lời,
//! bản 0.2.16 chờ chúng mãi nên lần chuyển treo và giữ khoá tới khi thoát Hive.
//!
//! Hai cách cài:
//! - Bản tải từ claude.ai kiểu cũ (Squirrel): `%LOCALAPPDATA%\AnthropicClaude\claude.exe`, hồ sơ `%APPDATA%\Claude`.
//! - Gói MSIX: chạy từ `C:\Program Files\WindowsApps\Claude_…`, dữ liệu ở `%LOCALAPPDATA%\Packages\<họ gói>`. Windows
//!   chuyển hướng phần app ghi vào `%APPDATA%` sang `<họ gói>\LocalCache\Roaming`, trừ khi gói tắt việc đó; app ngoài
//!   gói (như Hive) thấy đường dẫn thật, nên phải tự chọn đúng thư mục.
//!
//! Mã chỉ dùng std và lệnh có sẵn của Windows, biên dịch trên mọi hệ điều hành để test và clippy trên macOS kiểm được.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use base64::Engine;

use super::job::{Ctl, Step, output_within};
use super::{App, QUIT_WAIT, wait_gone};

pub(super) const NOT_INSTALLED: &str = "Chưa thấy Claude Desktop (bản cài từ claude.ai hay Microsoft Store). Cài Claude Desktop rồi thử lại.";

/// Thư mục AppData của người dùng; test dựng bằng thư mục nhà giả.
pub(super) struct Dirs {
    pub(super) roaming: PathBuf,
    pub(super) local: PathBuf,
}

impl Dirs {
    pub(super) fn from_env(home: &Path) -> Self {
        let env = |k: &str| {
            std::env::var_os(k)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        Self {
            roaming: env("APPDATA").unwrap_or_else(|| home.join("AppData").join("Roaming")),
            local: env("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local")),
        }
    }
}

fn squirrel_exe(dirs: &Dirs) -> PathBuf {
    dirs.local.join("AnthropicClaude").join("claude.exe")
}

/// Họ gói MSIX của Claude Desktop (`Claude_pzs8sxrjxfjjc`): tên thư mục trong `%LOCALAPPDATA%\Packages`, phần trước `_`
/// là tên gói. Nhận cả tên có tiền tố nhà phát hành (`Anthropic.Claude`) vì chưa chắc tên gói giữ nguyên qua các bản;
/// có thể còn sót họ gói của bản đã gỡ nên lấy hết.
fn msix_families(local: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(local.join("Packages")) else {
        return vec![];
    };
    let mut found: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| Some((e.file_name().into_string().ok()?, e.path())))
        .filter(|(name, _)| {
            let package = name.split('_').next().unwrap_or("").to_ascii_lowercase();
            name.contains('_') && (package == "claude" || package.ends_with(".claude"))
        })
        .collect();
    found.sort();
    found
}

fn virtualized(data: &Path) -> PathBuf {
    data.join("LocalCache").join("Roaming").join("Claude")
}

/// File app ghi mỗi lần chạy hay mỗi lần đăng nhập: `config.json`, `Local State` (Chromium ghi lúc thoát), Cookies.
pub(super) const MARKERS: [&str; 4] = ["config.json", "Local State", "Network/Cookies", "Cookies"];

/// Lần gần nhất app ghi vào hồ sơ `dir`.
pub(super) fn last_used(dir: &Path) -> Option<SystemTime> {
    MARKERS
        .iter()
        .filter_map(|m| {
            std::fs::metadata(super::at(dir, m))
                .and_then(|m| m.modified())
                .ok()
        })
        .max()
}

/// Các thư mục có thể là hồ sơ thật: hồ sơ chuyển hướng của từng gói MSIX (có thì mới tính), rồi `%APPDATA%\Claude`.
pub(super) fn candidates(dirs: &Dirs) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = msix_families(&dirs.local)
        .iter()
        .map(|(_, data)| virtualized(data))
        .filter(|d| d.is_dir())
        .collect();
    out.push(dirs.roaming.join("Claude"));
    out
}

/// Hồ sơ thật của Claude Desktop. Có gói MSIX thì hồ sơ có thể nằm ở chỗ Windows chuyển hướng tới hoặc ở `%APPDATA%`
/// (gói tắt chuyển hướng, hay app từng cài kiểu Squirrel): chọn nơi app ghi gần nhất. Bằng nhau hay chưa ghi gì thì
/// ưu tiên hồ sơ chuyển hướng: gói MSIX đang cài thì app đọc ở đó, ghi nhầm vào `%APPDATA%\Claude` là đổi đăng nhập
/// của hồ sơ app không dùng.
pub(super) fn profile(dirs: &Dirs) -> PathBuf {
    let mut best: Option<(PathBuf, Option<SystemTime>)> = None;
    for dir in candidates(dirs) {
        let used = last_used(&dir);
        if best.as_ref().is_none_or(|(_, b)| used > *b) {
            best = Some((dir, used));
        }
    }
    best.map_or_else(|| dirs.roaming.join("Claude"), |(d, _)| d)
}

/// Gói MSIX có hồ sơ đang dùng, rồi gói MSIX khác (cách phân phối mới), rồi bản Squirrel.
pub(super) fn find_app(dirs: &Dirs) -> Option<App> {
    let families = msix_families(&dirs.local);
    let real = profile(dirs);
    if let Some((family, data)) = families
        .iter()
        .find(|(_, data)| real.starts_with(data))
        .or(families.first())
    {
        return Some(App::Msix {
            family: family.clone(),
            data: data.clone(),
        });
    }
    let exe = squirrel_exe(dirs);
    exe.is_file().then_some(App::Squirrel(exe))
}

/// Tiến trình chạy từ thư mục cài của Claude Desktop. Claude Code CLI cũng tên `claude.exe` (`~\.local\bin`, npm,
/// WinGet) và worker chạy nó liên tục, nên phải xét đường dẫn chứ không chỉ tên.
fn is_desktop_exe(path: &str) -> bool {
    let p = path.to_ascii_lowercase().replace('/', "\\");
    if !p.ends_with("\\claude.exe") {
        return false;
    }
    if p.contains("\\anthropicclaude\\") {
        return true;
    }
    // `C:\Program Files\WindowsApps\Claude_1.0.0.0_x64__pzs8sxrjxfjjc\app\claude.exe`. `%LOCALAPPDATA%\Microsoft\
    // WindowsApps` chỉ chứa lối tắt, tiến trình thật chạy từ Program Files.
    p.split("\\windowsapps\\")
        .nth(1)
        .and_then(|rest| rest.split('\\').next())
        .is_some_and(|package| {
            let name = package.split('_').next().unwrap_or("");
            package.contains('_') && (name == "claude" || name.ends_with(".claude"))
        })
}

/// Một tiến trình `claude.exe`. Không giữ dòng lệnh: chẩn đoán chỉ cần loại tiến trình phụ, và dòng lệnh có thể chứa
/// đường dẫn hay tham số riêng của người dùng.
#[derive(Debug, PartialEq, Eq, Clone)]
pub(super) struct Proc {
    pub(super) pid: u32,
    pub(super) exe: String,
    /// `--type=` của tiến trình phụ Electron (`renderer`, `crashpad-handler`…); None là tiến trình chính.
    pub(super) kind: Option<String>,
}

impl Proc {
    pub(super) fn desktop(&self) -> bool {
        is_desktop_exe(&self.exe)
    }
}

/// Tiến trình từ dòng `pid<TAB>đường dẫn exe<TAB>dòng lệnh`.
fn procs_in(text: &str) -> Vec<Proc> {
    let mut out: Vec<Proc> = text
        .lines()
        .filter_map(|line| {
            let mut parts = line.trim_end_matches('\r').splitn(3, '\t');
            let pid = parts.next()?.trim().parse::<u32>().ok()?;
            let exe = parts.next()?.to_string();
            let command = parts.next().unwrap_or("");
            let kind = command.split_once("--type=").map(|(_, rest)| {
                rest.split(|c: char| c.is_whitespace() || c == '"')
                    .next()
                    .unwrap_or("")
                    .to_string()
            });
            Some(Proc { pid, exe, kind })
        })
        .collect();
    out.sort_by_key(|p| p.pid);
    out.dedup_by_key(|p| p.pid);
    out
}

/// Tiến trình chính của Claude Desktop (bỏ tiến trình phụ của Electron).
fn mains(procs: &[Proc]) -> Vec<u32> {
    procs
        .iter()
        .filter(|p| p.desktop() && p.kind.is_none())
        .map(|p| p.pid)
        .collect()
}

/// Mọi tiến trình chạy từ thư mục cài của Claude Desktop, kể cả tiến trình phụ: chỉ khi không còn cái nào mới coi là
/// đã thoát, vì tiến trình phụ còn sống có thể còn giữ Cookies.
fn desktop_pids(procs: &[Proc]) -> Vec<u32> {
    procs
        .iter()
        .filter(|p| p.desktop())
        .map(|p| p.pid)
        .collect()
}

/// Lệnh console chạy từ app GUI: không mở cửa sổ đen.
fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// Chạy script PowerShell, trả stdout; quá `within` là None. Script truyền qua `-EncodedCommand` (UTF-16LE base64) để
/// khỏi lo cách Windows tách dấu nháy; stdout đặt UTF-8 để đường dẫn có chữ Việt không bị đổi mã.
fn powershell(script: &str, within: Duration) -> Option<String> {
    let script = format!("[Console]::OutputEncoding = [Text.Encoding]::UTF8\n{script}");
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    let out = output_within(
        hidden(Command::new("powershell.exe").args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ])),
        within,
    )?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `tasklist` nhanh hơn PowerShell nhiều: không có `claude.exe` nào thì khỏi hỏi đường dẫn. Màn gói đọc lại mỗi 10 giây.
fn any_claude_exe() -> bool {
    let Some(out) = output_within(
        hidden(Command::new("tasklist").args([
            "/FI",
            "IMAGENAME eq claude.exe",
            "/FO",
            "CSV",
            "/NH",
        ])),
        Duration::from_secs(5),
    ) else {
        // Không chạy được tasklist thì để PowerShell quyết định.
        return true;
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|l| l.to_ascii_lowercase().starts_with("\"claude.exe\""))
}

/// WMI có lúc treo hay bị tắt: giới hạn thời gian của nó, lỗi thì lấy `Get-Process` (có đường dẫn exe, không có dòng
/// lệnh nên mọi tiến trình coi là tiến trình chính).
const LIST_SCRIPT: &str = "\
try {
  Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" -OperationTimeoutSec 8 -ErrorAction Stop |
    ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)\" }
} catch {
  Get-Process -Name claude -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id)`t$($_.Path)`t\" }
}";

/// Mọi tiến trình `claude.exe` (Claude Desktop và Claude Code CLI); None khi không dò được.
pub(super) fn processes() -> Option<Vec<Proc>> {
    if !any_claude_exe() {
        return Some(vec![]);
    }
    powershell(LIST_SCRIPT, Duration::from_secs(15)).map(|out| procs_in(&out))
}

/// Tiến trình chính của Claude Desktop; None khi không dò được.
pub(super) fn running() -> Option<Vec<u32>> {
    processes().map(|p| mains(&p))
}

fn taskkill(args: &[&str]) {
    let _ = output_within(
        hidden(Command::new("taskkill").args(args)),
        Duration::from_secs(10),
    );
}

/// Thời gian chờ từng bước thoát; test dùng bản ngắn.
pub(super) struct Waits {
    /// Sau WM_CLOSE cho cửa sổ của tiến trình chính.
    pub(super) close: Duration,
    /// Sau WM_CLOSE cho cả cây tiến trình (`/T`, chưa `/F`).
    pub(super) tree: Duration,
    /// Sau `/F /T` (người dùng đã đồng ý).
    pub(super) kill: Duration,
}

const WAITS: Waits = Waits {
    close: Duration::from_secs(8),
    tree: QUIT_WAIT.saturating_sub(Duration::from_secs(8)),
    kill: Duration::from_secs(10),
};

/// Thoát Claude Desktop theo từng bậc, bậc nào cũng có hạn:
/// 1. `taskkill /PID` (không `/F`) gửi WM_CLOSE cho cửa sổ của tiến trình chính, như bấm nút đóng.
/// 2. Claude Desktop thường chỉ thu xuống khay khi đóng cửa sổ: gửi tiếp WM_CLOSE cho cả cây (`/T`, vẫn không `/F`).
/// 3. Còn chạy mà chưa có `force` thì trả false để giao diện hỏi người dùng có buộc thoát không.
/// 4. `force` (người dùng đã đồng ý): `/F /T` từng tiến trình của Claude Desktop.
///
/// Chỉ coi là đã thoát khi không còn tiến trình nào chạy từ thư mục cài; không dò được thì chưa coi là thoát. Luôn
/// nhắm theo PID, không dùng `/IM claude.exe`: tên đó trùng Claude Code CLI mà worker đang chạy.
pub(super) fn quit(force: bool, ctl: &Ctl) -> Result<bool, String> {
    quit_with(&processes, &taskkill, force, ctl, &WAITS)
}

/// `quit` với cách dò và cách gọi `taskkill` truyền vào, để test không gửi lệnh cho PID có thật trên máy.
pub(super) fn quit_with(
    list: &dyn Fn() -> Option<Vec<Proc>>,
    taskkill: &dyn Fn(&[&str]),
    force: bool,
    ctl: &Ctl,
    waits: &Waits,
) -> Result<bool, String> {
    let now = list().ok_or(
        "Không dò được Claude Desktop có đang chạy không (PowerShell không trả lời). Thoát Claude Desktop từ khay hệ thống rồi thử lại.",
    )?;
    if desktop_pids(&now).is_empty() {
        return Ok(true);
    }
    ctl.step(Step::Quitting);
    let gone = |d| wait_gone(|| list().map(|p| desktop_pids(&p)), d, ctl);
    // Đã đồng ý buộc thoát thì vẫn xin thoát êm trước, nhưng không chờ lâu.
    let soft = |d: Duration| {
        if force {
            d.min(Duration::from_secs(3))
        } else {
            d
        }
    };
    for pid in mains(&now) {
        taskkill(&["/PID", &pid.to_string()]);
    }
    if gone(soft(waits.close))? {
        return Ok(true);
    }
    for pid in mains(&now) {
        taskkill(&["/T", "/PID", &pid.to_string()]);
    }
    if gone(soft(waits.tree))? {
        return Ok(true);
    }
    if !force {
        return Ok(false);
    }
    ctl.step(Step::ForceQuitting);
    let left = list()
        .map(|p| desktop_pids(&p))
        .unwrap_or_else(|| desktop_pids(&now));
    for pid in left {
        taskkill(&["/F", "/T", "/PID", &pid.to_string()]);
    }
    gone(waits.kill)
}

/// Id ứng dụng MSIX (`<họ gói>!<Id trong manifest>`) để mở qua `shell:AppsFolder`. Không hỏi được thì đoán `!Claude`.
fn app_user_model_id(family: &str) -> String {
    let fallback = format!("{family}!Claude");
    // Họ gói đi vào script: chỉ nhận ký tự hợp lệ của tên gói, để không chèn được lệnh.
    if !family
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        return fallback;
    }
    powershell(
        &format!(
            "$p = Get-AppxPackage | Where-Object PackageFamilyName -eq '{family}' | Select-Object -First 1\n\
         if ($p) {{ $a = (Get-AppxPackageManifest $p).Package.Applications.Application | Select-Object -First 1; \"$($p.PackageFamilyName)!$($a.Id)\" }}"
        ),
        Duration::from_secs(15),
    )
    .map(|s| s.trim().to_string())
    .filter(|s| s.starts_with(&format!("{family}!")) && !s.ends_with('!'))
    .unwrap_or(fallback)
}

/// Mở app mà không chờ: explorer.exe có lúc không trả về khi app mở chậm, và trả mã khác 0 cả khi mở được, nên chỉ
/// xét lỗi lúc chạy lệnh.
pub(super) fn launch(app: &App) -> Result<(), String> {
    let spawned = match app {
        App::Squirrel(exe) => Command::new(exe).spawn().map(|_| ()),
        App::Msix { family, .. } => Command::new("explorer.exe")
            .arg(format!("shell:AppsFolder\\{}", app_user_model_id(family)))
            .spawn()
            .map(|_| ()),
        App::Mac(_) => return Err("Không phải bản Claude Desktop cho Windows.".into()),
    };
    spawned.map_err(|e| format!("Không mở được Claude Desktop: {e}"))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{put, temp_home};
    use super::*;

    fn dirs(home: &Path) -> Dirs {
        Dirs {
            roaming: home.join("AppData").join("Roaming"),
            local: home.join("AppData").join("Local"),
        }
    }

    #[test]
    fn finds_msix_package_before_squirrel() {
        let home = temp_home("win-find");
        let d = dirs(&home);
        assert_eq!(find_app(&d), None);
        put(&squirrel_exe(&d), "exe");
        assert_eq!(find_app(&d), Some(App::Squirrel(squirrel_exe(&d))));
        for other in [
            "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
            "ClaudeCode",
            "Foo.Claudette_x",
        ] {
            std::fs::create_dir_all(d.local.join("Packages").join(other)).unwrap();
        }
        assert_eq!(find_app(&d), Some(App::Squirrel(squirrel_exe(&d))));
        let data = d.local.join("Packages").join("Claude_pzs8sxrjxfjjc");
        std::fs::create_dir_all(&data).unwrap();
        assert_eq!(
            find_app(&d),
            Some(App::Msix {
                family: "Claude_pzs8sxrjxfjjc".into(),
                data
            })
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn profile_follows_where_the_app_writes() {
        let home = temp_home("win-profile");
        let d = dirs(&home);
        let roaming = d.roaming.join("Claude");
        assert_eq!(profile(&d), roaming, "chưa cài gì: %APPDATA%\\Claude");
        let data = d.local.join("Packages").join("Claude_pzs8sxrjxfjjc");
        std::fs::create_dir_all(&data).unwrap();
        assert_eq!(profile(&d), roaming, "gói chưa ghi gì qua chuyển hướng");
        let virtualized = data.join("LocalCache").join("Roaming").join("Claude");
        put(&virtualized.join("config.json"), "{}");
        assert_eq!(profile(&d), virtualized);
        // Gói tắt chuyển hướng (hay app chạy kiểu Squirrel gần đây hơn): app ghi vào %APPDATA%.
        put(&roaming.join("config.json"), "{}");
        let later = SystemTime::now() + Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(roaming.join("config.json"))
            .unwrap()
            .set_modified(later)
            .unwrap();
        assert_eq!(profile(&d), roaming);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn desktop_processes_are_told_apart_from_the_claude_code_cli() {
        let text = "\
4100\tC:\\Users\\Duy\\AppData\\Local\\AnthropicClaude\\app-0.14.10\\claude.exe\t\"C:\\Users\\Duy\\AppData\\Local\\AnthropicClaude\\app-0.14.10\\claude.exe\"\r
4101\tC:\\Users\\Duy\\AppData\\Local\\AnthropicClaude\\app-0.14.10\\claude.exe\t\"…\\claude.exe\" --type=renderer --lang=vi\r
4200\tC:\\Program Files\\WindowsApps\\Claude_1.0.3218.0_x64__pzs8sxrjxfjjc\\app\\claude.exe\t\"C:\\Program Files\\WindowsApps\\Claude_1.0.3218.0_x64__pzs8sxrjxfjjc\\app\\claude.exe\"
4201\tC:\\Program Files\\WindowsApps\\Claude_1.0.3218.0_x64__pzs8sxrjxfjjc\\app\\claude.exe\tclaude.exe --type=crashpad-handler
5000\tC:\\Users\\Duy\\.local\\bin\\claude.exe\tclaude --print
5001\tC:\\Users\\Duy\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_x\\claude.exe\tclaude
5002\tC:\\Program Files\\WindowsApps\\Microsoft.Foo_1_x64__abc\\claude.exe\t
6000\t\t
bad line
";
        let procs = procs_in(text);
        assert_eq!(mains(&procs), vec![4100, 4200]);
        assert_eq!(desktop_pids(&procs), vec![4100, 4101, 4200, 4201]);
        let kinds: Vec<_> = procs.iter().map(|p| p.kind.as_deref()).collect();
        assert_eq!(
            kinds,
            [
                None,
                Some("renderer"),
                None,
                Some("crashpad-handler"),
                None,
                None,
                None,
                None
            ]
        );
        assert!(is_desktop_exe(
            "C:/Users/Duy/AppData/Local/AnthropicClaude/claude.exe"
        ));
        assert!(!is_desktop_exe(
            "C:\\Users\\Duy\\AppData\\Local\\AnthropicClaude\\Update.exe"
        ));
    }

    fn touch(path: &Path, at: SystemTime) {
        put(path, "x");
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(at)
            .unwrap();
    }

    /// Gói MSIX: hồ sơ ở `Packages\<họ gói>\LocalCache\Roaming\Claude`. Còn sót họ gói của bản cũ hay `%APPDATA%\Claude`
    /// của bản Squirrel thì chọn nơi app ghi gần nhất (`Local State`, Cookies chứ không riêng `config.json`), và app mở
    /// lại là gói có hồ sơ đó.
    #[test]
    fn msix_profile_is_the_one_the_app_wrote_last() {
        let home = temp_home("win-msix");
        let d = dirs(&home);
        let base = SystemTime::now() - Duration::from_secs(3600);
        let t = |s| base + Duration::from_secs(s);
        let old = d.local.join("Packages").join("Anthropic.Claude_aaa");
        let new = d.local.join("Packages").join("Claude_pzs8sxrjxfjjc");
        let roaming = d.roaming.join("Claude");
        touch(&virtualized(&old).join("config.json"), t(10));
        touch(&virtualized(&new).join("config.json"), t(5));
        touch(&roaming.join("config.json"), t(20));
        assert_eq!(profile(&d), roaming);
        touch(&virtualized(&new).join("Network").join("Cookies"), t(30));
        assert_eq!(profile(&d), virtualized(&new));
        assert_eq!(
            find_app(&d),
            Some(App::Msix {
                family: "Claude_pzs8sxrjxfjjc".into(),
                data: new.clone()
            })
        );
        touch(&virtualized(&old).join("Local State"), t(40));
        assert_eq!(profile(&d), virtualized(&old));
        assert_eq!(
            candidates(&d),
            vec![virtualized(&old), virtualized(&new), roaming.clone()]
        );
        // Bằng giờ: giữ hồ sơ chuyển hướng, không ghi nhầm vào %APPDATA%\Claude.
        touch(&roaming.join("config.json"), t(40));
        assert_eq!(profile(&d), virtualized(&old));
        std::fs::remove_dir_all(&home).unwrap();
    }

    fn proc(pid: u32, kind: Option<&str>) -> Proc {
        Proc {
            pid,
            exe: "C:\\Users\\Duy\\AppData\\Local\\AnthropicClaude\\app-1\\claude.exe".into(),
            kind: kind.map(str::to_string),
        }
    }

    const SHORT: Waits = Waits {
        close: Duration::from_millis(200),
        tree: Duration::from_millis(200),
        kill: Duration::from_millis(200),
    };

    /// App thu xuống khay, không bao giờ thoát: mỗi bậc chờ có hạn, chưa đồng ý buộc thoát thì báo vẫn chạy, Huỷ thì dừng
    /// ngay; không dò được tiến trình thì báo lỗi chứ không coi là đã thoát.
    #[test]
    fn app_that_never_quits_is_bounded_and_cancellable() {
        let stuck = || Some(vec![proc(4100, None), proc(4101, Some("renderer"))]);
        let sent = std::sync::Mutex::new(Vec::<String>::new());
        let record = |args: &[&str]| sent.lock().unwrap().push(args.join(" "));
        let started = std::time::Instant::now();
        assert_eq!(
            quit_with(&stuck, &record, false, &Ctl::idle(), &SHORT),
            Ok(false)
        );
        assert_eq!(*sent.lock().unwrap(), ["/PID 4100", "/T /PID 4100"]);
        sent.lock().unwrap().clear();
        assert_eq!(
            quit_with(&stuck, &record, true, &Ctl::idle(), &SHORT),
            Ok(false)
        );
        assert_eq!(
            *sent.lock().unwrap(),
            [
                "/PID 4100",
                "/T /PID 4100",
                "/F /T /PID 4100",
                "/F /T /PID 4101"
            ]
        );
        assert!(started.elapsed() < Duration::from_secs(30));

        let unknown = || None;
        assert!(quit_with(&unknown, &record, true, &Ctl::idle(), &SHORT).is_err());
        let flaky = std::sync::atomic::AtomicU32::new(0);
        let gone_after_unknown = || match flaky.fetch_add(1, std::sync::atomic::Ordering::SeqCst) {
            0 => Some(vec![proc(4100, None)]),
            1 => None,
            _ => Some(vec![]),
        };
        assert_eq!(
            quit_with(&gone_after_unknown, &record, false, &Ctl::idle(), &SHORT),
            Ok(true),
            "lần dò lỗi không tính là đã thoát, lần sau mới tính"
        );
        assert!(flaky.load(std::sync::atomic::Ordering::SeqCst) >= 3);

        let cancel = std::sync::atomic::AtomicBool::new(false);
        let steps = std::sync::Mutex::new(vec![]);
        let report = |s: Step, _: Option<u8>| {
            steps.lock().unwrap().push(s);
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        };
        let ctl = Ctl::new(&cancel, &report);
        let long = Waits {
            close: Duration::from_secs(60),
            tree: Duration::from_secs(60),
            kill: Duration::from_secs(60),
        };
        let started = std::time::Instant::now();
        assert_eq!(
            quit_with(&stuck, &record, true, &ctl, &long),
            Err(super::super::job::CANCELLED.to_string())
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(*steps.lock().unwrap(), vec![Step::Quitting]);
    }

    /// Trên Windows thật: tiến trình console không có cửa sổ thì `taskkill` không `/F` không đóng được (như app nằm ở
    /// khay). Không đồng ý thì nó còn sống; đồng ý thì `/F /T` đóng nó trong hạn.
    #[cfg(windows)]
    #[test]
    fn stuck_process_is_only_killed_with_consent() {
        let child = std::sync::Mutex::new(
            hidden(Command::new("ping").args(["-n", "600", "127.0.0.1"]))
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let pid = child.lock().unwrap().id();
        let list = || {
            let alive = child.lock().unwrap().try_wait().unwrap().is_none();
            Some(if alive { vec![proc(pid, None)] } else { vec![] })
        };
        assert_eq!(
            quit_with(&list, &taskkill, false, &Ctl::idle(), &SHORT),
            Ok(false)
        );
        assert!(child.lock().unwrap().try_wait().unwrap().is_none());
        let waits = Waits {
            kill: Duration::from_secs(10),
            ..SHORT
        };
        assert_eq!(
            quit_with(&list, &taskkill, true, &Ctl::idle(), &waits),
            Ok(true)
        );
    }

    #[test]
    fn suspicious_family_is_not_put_into_the_script() {
        assert_eq!(
            app_user_model_id("Claude_x'; Remove-Item C:\\ #"),
            "Claude_x'; Remove-Item C:\\ #!Claude"
        );
    }
}
