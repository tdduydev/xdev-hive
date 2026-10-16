//! Phần riêng Windows của việc chuyển Claude Desktop: tìm bản cài (Squirrel hay MSIX), tìm hồ sơ thật, dò tiến trình,
//! thoát êm bằng WM_CLOSE và mở lại. Dò và đóng tiến trình gọi thẳng Win32 (không qua PowerShell/WMI hay `taskkill`:
//! có lúc không trả lời, bản 0.2.16 treo vì chúng và bản 0.2.17 đứng ở bước chờ thoát); lệnh ngoài còn lại có hạn chờ.
//!
//! Hai cách cài:
//! - Bản tải từ claude.ai kiểu cũ (Squirrel): `%LOCALAPPDATA%\AnthropicClaude\claude.exe`, hồ sơ `%APPDATA%\Claude`.
//! - Gói MSIX: chạy từ `C:\Program Files\WindowsApps\Claude_…`, dữ liệu ở `%LOCALAPPDATA%\Packages\<họ gói>`. Windows
//!   chuyển hướng phần app ghi vào `%APPDATA%` sang `<họ gói>\LocalCache\Roaming`, trừ khi gói tắt việc đó; app ngoài
//!   gói (như Hive) thấy đường dẫn thật, nên phải tự chọn đúng thư mục.
//!
//! Phần Win32 nằm trong `sys`, chỉ biên dịch trên Windows; phần còn lại biên dịch trên mọi hệ điều hành để test và
//! clippy trên macOS kiểm được.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use base64::Engine;

use super::job::{Ctl, Step, output_within};
use super::{App, wait_gone};
use crate::no_window::NoWindow;

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

/// Một tiến trình `claude.exe`. Không giữ dòng lệnh: đọc dòng lệnh của tiến trình khác phải qua WMI (chậm, có lúc
/// treo) hay đọc bộ nhớ của nó, và dòng lệnh có thể chứa đường dẫn hay tham số riêng của người dùng. Tiến trình phụ
/// của Electron nhận ra bằng tiến trình cha.
#[derive(Debug, PartialEq, Eq, Clone)]
pub(super) struct Proc {
    pub(super) pid: u32,
    pub(super) parent: u32,
    /// Rỗng khi không hỏi được đường dẫn (tiến trình vừa thoát, hay chạy quyền cao hơn).
    pub(super) exe: String,
}

impl Proc {
    pub(super) fn desktop(&self) -> bool {
        is_desktop_exe(&self.exe)
    }
}

/// Tiến trình chính của Claude Desktop: cha không phải tiến trình Claude Desktop (renderer, gpu, crashpad là con của
/// nó). Windows có thể dùng lại PID của cha đã thoát, nên không tìm được tiến trình chính nào thì lấy PID nhỏ nhất
/// thay vì coi là app đã tắt.
pub(super) fn mains(procs: &[Proc]) -> Vec<u32> {
    let desktop = desktop_pids(procs);
    let found: Vec<u32> = procs
        .iter()
        .filter(|p| p.desktop() && !desktop.contains(&p.parent))
        .map(|p| p.pid)
        .collect();
    if found.is_empty() {
        desktop.into_iter().min().into_iter().collect()
    } else {
        found
    }
}

/// Mọi tiến trình chạy từ thư mục cài của Claude Desktop, kể cả tiến trình phụ: chỉ khi không còn cái nào mới coi là
/// đã thoát, vì tiến trình phụ còn sống có thể còn giữ Cookies.
fn desktop_pids(procs: &[Proc]) -> Vec<u32> {
    let mut pids: Vec<u32> = procs
        .iter()
        .filter(|p| p.desktop())
        .map(|p| p.pid)
        .collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// Chạy script PowerShell, trả stdout; quá `within` là None. Script truyền qua `-EncodedCommand` (UTF-16LE base64) để
/// khỏi lo cách Windows tách dấu nháy; stdout đặt UTF-8 để đường dẫn có chữ Việt không bị đổi mã.
fn powershell(script: &str, within: Duration) -> Option<String> {
    let script = format!("[Console]::OutputEncoding = [Text.Encoding]::UTF8\n{script}");
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    let out = output_within(
        Command::new("powershell.exe").args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ]),
        within,
    )?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Dò và ra lệnh cho tiến trình; test thay bằng bản giả để không đụng PID có thật trên máy.
pub(super) trait System {
    /// Mọi tiến trình `claude.exe` (Claude Desktop và Claude Code CLI); None khi không dò được.
    fn processes(&self) -> Option<Vec<Proc>>;
    /// Gửi WM_CLOSE (như bấm nút đóng) cho cửa sổ đang hiện của `pids`, không chờ; trả số cửa sổ đã gửi.
    fn close_windows(&self, pids: &[u32]) -> usize;
    /// Buộc tắt `pid` nếu nó vẫn là Claude Desktop (PID có thể đã thuộc tiến trình khác).
    fn terminate(&self, pid: u32) -> bool;
}

/// Win32 gọi thẳng: bản 0.2.17 dò qua PowerShell/WMI và đóng qua `taskkill`, PowerShell khởi động chậm hay treo (Defender,
/// WMI) làm mỗi lần dò mất hàng chục giây và lần chuyển đứng ở bước chờ thoát.
struct Win32;

#[cfg(windows)]
impl System for Win32 {
    fn processes(&self) -> Option<Vec<Proc>> {
        sys::processes()
    }

    fn close_windows(&self, pids: &[u32]) -> usize {
        sys::close_windows(pids)
    }

    fn terminate(&self, pid: u32) -> bool {
        sys::terminate(pid, is_desktop_exe)
    }
}

/// Không phải Windows thì không có gì để dò (chẩn đoán trong test dựng hồ sơ Windows trên macOS).
#[cfg(not(windows))]
impl System for Win32 {
    fn processes(&self) -> Option<Vec<Proc>> {
        None
    }

    fn close_windows(&self, _: &[u32]) -> usize {
        0
    }

    fn terminate(&self, _: u32) -> bool {
        false
    }
}

#[cfg(windows)]
mod sys {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND, INVALID_HANDLE_VALUE, LPARAM};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
        QueryFullProcessImageNameW, TerminateProcess,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE,
    };
    use windows_sys::core::BOOL;

    use super::Proc;

    struct Handle(HANDLE);

    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: handle mở bằng OpenProcess hay CreateToolhelp32Snapshot, đóng đúng một lần.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn open(pid: u32, access: u32) -> Option<Handle> {
        // SAFETY: chỉ truyền số; handle null khi lỗi.
        let h = unsafe { OpenProcess(access, 0, pid) };
        (!h.is_null()).then_some(Handle(h))
    }

    fn image(h: &Handle) -> Option<String> {
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        // SAFETY: `len` là cỡ của `buf`; hàm ghi tối đa chừng đó ký tự và trả độ dài thật vào `len`.
        let ok = unsafe {
            QueryFullProcessImageNameW(h.0, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        };
        (ok != 0).then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }

    fn name(entry: &PROCESSENTRY32W) -> String {
        let file = &entry.szExeFile;
        let end = file.iter().position(|&c| c == 0).unwrap_or(file.len());
        String::from_utf16_lossy(&file[..end])
    }

    pub(super) fn processes() -> Option<Vec<Proc>> {
        // SAFETY: chụp danh sách tiến trình, không chặn; INVALID_HANDLE_VALUE khi lỗi.
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let snap = Handle(snap);
        // SAFETY: PROCESSENTRY32W chỉ gồm số và mảng số, toàn 0 là hợp lệ.
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        // SAFETY: `entry` có `dwSize` đúng như hàm đòi.
        if unsafe { Process32FirstW(snap.0, &mut entry) } == 0 {
            return None;
        }
        let mut out = vec![];
        loop {
            if name(&entry).eq_ignore_ascii_case("claude.exe") {
                let exe = open(entry.th32ProcessID, PROCESS_QUERY_LIMITED_INFORMATION)
                    .and_then(|h| image(&h))
                    .unwrap_or_default();
                out.push(Proc {
                    pid: entry.th32ProcessID,
                    parent: entry.th32ParentProcessID,
                    exe,
                });
            }
            // SAFETY: như Process32FirstW.
            if unsafe { Process32NextW(snap.0, &mut entry) } == 0 {
                return Some(out);
            }
        }
    }

    struct Close<'a> {
        pids: &'a [u32],
        sent: usize,
    }

    unsafe extern "system" fn close_one(hwnd: HWND, data: LPARAM) -> BOOL {
        // SAFETY: `data` là `&mut Close` truyền vào EnumWindows dưới đây, sống suốt lần duyệt.
        let close = unsafe { &mut *(data as *mut Close) };
        let mut pid = 0;
        // SAFETY: `hwnd` do EnumWindows đưa. PostMessage không chờ cửa sổ xử lý, app treo cũng không làm Hive treo.
        unsafe {
            GetWindowThreadProcessId(hwnd, &mut pid);
            if close.pids.contains(&pid)
                && IsWindowVisible(hwnd) != 0
                && PostMessageW(hwnd, WM_CLOSE, 0, 0) != 0
            {
                close.sent += 1;
            }
        }
        1
    }

    /// Chỉ cửa sổ đang hiện: cửa sổ ẩn của Chromium (khay, nhận thông báo hệ thống) nhận WM_CLOSE thì tự huỷ mà app vẫn
    /// chạy, có khi mất cả biểu tượng ở khay để người dùng tự thoát.
    pub(super) fn close_windows(pids: &[u32]) -> usize {
        let mut close = Close { pids, sent: 0 };
        // SAFETY: `close_one` chỉ dùng `close` trong lúc EnumWindows chạy.
        unsafe { EnumWindows(Some(close_one), &mut close as *mut Close as LPARAM) };
        close.sent
    }

    pub(super) fn terminate(pid: u32, owns: fn(&str) -> bool) -> bool {
        let Some(h) = open(pid, PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION) else {
            return false;
        };
        // SAFETY: handle vừa mở, có quyền PROCESS_TERMINATE; chỉ tắt khi đường dẫn vẫn là của app cần tắt.
        image(&h).is_some_and(|exe| owns(&exe)) && unsafe { TerminateProcess(h.0, 1) } != 0
    }
}

/// Mọi tiến trình `claude.exe` (Claude Desktop và Claude Code CLI); None khi không dò được.
pub(super) fn processes() -> Option<Vec<Proc>> {
    Win32.processes()
}

/// Tiến trình chính của Claude Desktop; None khi không dò được.
pub(super) fn running() -> Option<Vec<u32>> {
    processes().map(|p| mains(&p))
}

/// Thời gian chờ từng bước thoát; test dùng bản ngắn.
pub(super) struct Waits {
    /// Sau WM_CLOSE: Claude Desktop thường chỉ thu xuống khay khi đóng cửa sổ, nên không chờ lâu rồi hỏi người dùng.
    pub(super) close: Duration,
    /// Không có cửa sổ nào để đóng (app đang ở khay): xin thoát êm không được, chỉ chờ người dùng đang tự thoát.
    pub(super) hidden: Duration,
    /// Sau khi buộc tắt (người dùng đã đồng ý).
    pub(super) kill: Duration,
}

const WAITS: Waits = Waits {
    close: Duration::from_secs(10),
    hidden: Duration::from_secs(3),
    kill: Duration::from_secs(10),
};

const NOT_LISTED: &str = "Không dò được Claude Desktop có đang chạy không. Thoát Claude Desktop từ khay hệ thống rồi thử lại.";

/// Thoát Claude Desktop, bậc nào cũng có hạn:
/// 1. WM_CLOSE cho cửa sổ đang hiện của mọi tiến trình Claude Desktop, như bấm nút đóng. Người dùng tự thoát từ khay
///    trong lúc chờ thì nhận ra ở lần dò kế (nửa giây).
/// 2. Còn chạy mà chưa có `force` thì trả false để giao diện hỏi người dùng có buộc thoát không.
/// 3. `force` (người dùng đã đồng ý): vẫn xin thoát êm trước nhưng chờ ngắn, rồi buộc tắt tiến trình chính trước, tiến
///    trình phụ sau.
///
/// Chỉ coi là đã thoát khi không còn tiến trình nào chạy từ thư mục cài; không dò được thì chưa coi là thoát. Luôn
/// nhắm theo PID và đường dẫn, không theo tên `claude.exe`: tên đó trùng Claude Code CLI mà worker đang chạy.
pub(super) fn quit(force: bool, ctl: &Ctl) -> Result<bool, String> {
    quit_with(&Win32, force, ctl, &WAITS)
}

pub(super) fn quit_with(
    sys: &dyn System,
    force: bool,
    ctl: &Ctl,
    waits: &Waits,
) -> Result<bool, String> {
    let now = sys.processes().ok_or(NOT_LISTED)?;
    let pids = desktop_pids(&now);
    if pids.is_empty() {
        return Ok(true);
    }
    ctl.step(Step::Quitting);
    let gone = |d| wait_gone(|| sys.processes().map(|p| desktop_pids(&p)), d, ctl);
    let soft = if sys.close_windows(&pids) == 0 {
        waits.hidden
    } else {
        waits.close
    };
    let soft = if force { soft.min(waits.hidden) } else { soft };
    if gone(soft)? {
        return Ok(true);
    }
    if !force {
        return Ok(false);
    }
    ctl.step(Step::ForceQuitting);
    let left = sys.processes().unwrap_or(now);
    let first = mains(&left);
    for pid in first
        .iter()
        .chain(desktop_pids(&left).iter().filter(|p| !first.contains(p)))
    {
        sys.terminate(*pid);
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
        App::Squirrel(exe) => Command::new(exe).no_window().spawn().map(|_| ()),
        App::Msix { family, .. } => Command::new("explorer.exe")
            .arg(format!("shell:AppsFolder\\{}", app_user_model_id(family)))
            .no_window()
            .spawn()
            .map(|_| ()),
        App::Mac(_) => return Err("Không phải bản Claude Desktop cho Windows.".into()),
    };
    spawned.map_err(|e| format!("Không mở được Claude Desktop: {e}"))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::time::Instant;

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

    const SQUIRREL: &str =
        "C:\\Users\\Duy\\AppData\\Local\\AnthropicClaude\\app-0.14.10\\claude.exe";
    const MSIX: &str =
        "C:\\Program Files\\WindowsApps\\Claude_1.0.3218.0_x64__pzs8sxrjxfjjc\\app\\claude.exe";
    const CLI: &str = "C:\\Users\\Duy\\.local\\bin\\claude.exe";

    fn proc(pid: u32, parent: u32, exe: &str) -> Proc {
        Proc {
            pid,
            parent,
            exe: exe.into(),
        }
    }

    #[test]
    fn desktop_processes_are_told_apart_from_the_claude_code_cli() {
        let procs = [
            proc(4100, 900, SQUIRREL),
            proc(4101, 4100, SQUIRREL),
            proc(4200, 900, MSIX),
            proc(4201, 4200, MSIX),
            // Claude Code CLI do Claude Desktop chạy (MCP, agent) vẫn không phải Claude Desktop.
            proc(5000, 4100, CLI),
            proc(
                5001,
                900,
                "C:\\Users\\Duy\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_x\\claude.exe",
            ),
            proc(
                5002,
                900,
                "C:\\Program Files\\WindowsApps\\Microsoft.Foo_1_x64__abc\\claude.exe",
            ),
            proc(6000, 900, ""),
        ];
        assert_eq!(mains(&procs), vec![4100, 4200]);
        assert_eq!(desktop_pids(&procs), vec![4100, 4101, 4200, 4201]);
        // Cha đã thoát và PID của nó được dùng lại cho tiến trình phụ: vẫn có một tiến trình chính.
        assert_eq!(
            mains(&[proc(7, 8, SQUIRREL), proc(8, 7, SQUIRREL)]),
            vec![7]
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

    /// Claude Desktop giả: dò chậm hay lỗi theo kịch bản, cửa sổ nhận WM_CLOSE mà có thoát hay không, tự thoát sau vài
    /// lần dò (người dùng bấm Quit ở khay), không chịu chết khi bị buộc tắt.
    #[derive(Default)]
    struct Fake {
        procs: Mutex<Vec<Proc>>,
        /// Số cửa sổ đang hiện; 0 là app nằm ở khay.
        windows: usize,
        /// WM_CLOSE làm app thoát thật.
        closes: bool,
        /// Còn chạy thêm chừng này lần dò rồi tự thoát.
        quits_after: Option<u32>,
        /// Lần dò thứ mấy (từ 0) trả None.
        fails_at: Vec<u32>,
        unkillable: bool,
        list_delay: Duration,
        polls: AtomicU32,
        sent: Mutex<Vec<String>>,
    }

    impl Fake {
        fn running(windows: usize) -> Self {
            Self {
                procs: Mutex::new(vec![
                    proc(4100, 900, SQUIRREL),
                    proc(4101, 4100, SQUIRREL),
                    proc(5000, 4100, CLI),
                ]),
                windows,
                ..Self::default()
            }
        }

        fn sent(&self) -> Vec<String> {
            self.sent.lock().unwrap().clone()
        }
    }

    impl System for Fake {
        fn processes(&self) -> Option<Vec<Proc>> {
            std::thread::sleep(self.list_delay);
            let n = self.polls.fetch_add(1, Ordering::SeqCst);
            if self.fails_at.contains(&n) {
                return None;
            }
            if self.quits_after.is_some_and(|q| n >= q) {
                self.procs.lock().unwrap().retain(|p| !p.desktop());
            }
            Some(self.procs.lock().unwrap().clone())
        }

        fn close_windows(&self, pids: &[u32]) -> usize {
            self.sent.lock().unwrap().push(format!("close {pids:?}"));
            if self.closes {
                self.procs.lock().unwrap().retain(|p| !p.desktop());
            }
            self.windows
        }

        fn terminate(&self, pid: u32) -> bool {
            self.sent.lock().unwrap().push(format!("kill {pid}"));
            if !self.unkillable {
                self.procs.lock().unwrap().retain(|p| p.pid != pid);
            }
            !self.unkillable
        }
    }

    const SHORT: Waits = Waits {
        close: Duration::from_millis(600),
        hidden: Duration::from_millis(200),
        kill: Duration::from_millis(300),
    };

    /// App thu xuống khay, không bao giờ thoát: chờ có hạn rồi báo vẫn chạy để giao diện hỏi; không bao giờ đụng Claude
    /// Code CLI. Đồng ý buộc thoát thì tắt tiến trình chính trước.
    #[test]
    fn app_that_never_quits_is_asked_about_within_the_close_wait() {
        let fake = Fake::running(1);
        let started = Instant::now();
        assert_eq!(quit_with(&fake, false, &Ctl::idle(), &SHORT), Ok(false));
        let took = started.elapsed();
        assert!(
            took >= SHORT.close && took < Duration::from_secs(5),
            "{took:?}"
        );
        assert_eq!(fake.sent(), ["close [4100, 4101]"]);

        let fake = Fake::running(1);
        let started = Instant::now();
        assert_eq!(quit_with(&fake, true, &Ctl::idle(), &SHORT), Ok(true));
        assert!(
            started.elapsed() < SHORT.close,
            "đã đồng ý thì không chờ đủ lâu như lần đầu"
        );
        assert_eq!(
            fake.sent(),
            ["close [4100, 4101]", "kill 4100", "kill 4101"]
        );
        assert_eq!(fake.procs.lock().unwrap().clone(), [proc(5000, 4100, CLI)]);

        let stubborn = Fake {
            unkillable: true,
            ..Fake::running(1)
        };
        assert_eq!(quit_with(&stubborn, true, &Ctl::idle(), &SHORT), Ok(false));
    }

    /// App đang ở khay (không cửa sổ nào để đóng): xin thoát êm không được, hỏi người dùng sau `hidden` chứ không chờ đủ
    /// `close`.
    #[test]
    fn app_in_the_tray_is_asked_about_sooner() {
        let fake = Fake::running(0);
        let started = Instant::now();
        assert_eq!(quit_with(&fake, false, &Ctl::idle(), &SHORT), Ok(false));
        let took = started.elapsed();
        assert!(took >= SHORT.hidden && took < SHORT.close, "{took:?}");
    }

    /// Người dùng tự thoát Claude Desktop (khay → Quit) trong lúc chờ, hay WM_CLOSE làm app thoát: đi tiếp ngay ở lần dò
    /// kế, không chờ hết hạn.
    #[test]
    fn quitting_by_hand_is_noticed_at_the_next_poll() {
        let long = Waits {
            close: Duration::from_secs(60),
            hidden: Duration::from_secs(60),
            kill: Duration::from_secs(60),
        };
        let fake = Fake {
            quits_after: Some(2),
            ..Fake::running(1)
        };
        let started = Instant::now();
        assert_eq!(quit_with(&fake, false, &Ctl::idle(), &long), Ok(true));
        assert!(started.elapsed() < Duration::from_secs(3));

        let fake = Fake {
            closes: true,
            ..Fake::running(1)
        };
        let started = Instant::now();
        assert_eq!(quit_with(&fake, false, &Ctl::idle(), &long), Ok(true));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(fake.sent(), ["close [4100, 4101]"]);

        let none = Fake {
            procs: Mutex::new(vec![proc(5000, 900, CLI)]),
            ..Fake::default()
        };
        assert_eq!(quit_with(&none, false, &Ctl::idle(), &long), Ok(true));
        assert_eq!(
            none.sent(),
            Vec::<String>::new(),
            "chỉ có Claude Code CLI: không đóng gì"
        );
    }

    /// Dò lỗi không tính là đã thoát; dò chậm vẫn xong trong hạn; Huỷ thì dừng ngay.
    #[test]
    fn failed_or_slow_listing_is_bounded_and_cancellable() {
        let fake = Fake {
            fails_at: vec![0],
            ..Fake::running(1)
        };
        assert_eq!(
            quit_with(&fake, true, &Ctl::idle(), &SHORT),
            Err(NOT_LISTED.to_string())
        );
        let flaky = Fake {
            fails_at: vec![1],
            quits_after: Some(2),
            ..Fake::running(1)
        };
        assert_eq!(
            quit_with(&flaky, false, &Ctl::idle(), &SHORT),
            Ok(true),
            "lần dò lỗi không tính là đã thoát, lần sau mới tính"
        );
        assert!(flaky.polls.load(Ordering::SeqCst) >= 3);
        let all_fail = Fake {
            fails_at: (1..1000).collect(),
            ..Fake::running(1)
        };
        assert_eq!(quit_with(&all_fail, false, &Ctl::idle(), &SHORT), Ok(false));

        let slow = Fake {
            list_delay: Duration::from_millis(150),
            ..Fake::running(1)
        };
        let started = Instant::now();
        assert_eq!(quit_with(&slow, false, &Ctl::idle(), &SHORT), Ok(false));
        assert!(started.elapsed() < Duration::from_secs(3));

        let cancel = AtomicBool::new(false);
        let steps = Mutex::new(vec![]);
        let report = |s: Step, _: Option<u8>| {
            steps.lock().unwrap().push(s);
            cancel.store(true, Ordering::SeqCst);
        };
        let ctl = Ctl::new(&cancel, &report);
        let long = Waits {
            close: Duration::from_secs(60),
            hidden: Duration::from_secs(60),
            kill: Duration::from_secs(60),
        };
        let started = Instant::now();
        assert_eq!(
            quit_with(&Fake::running(1), true, &ctl, &long),
            Err(super::super::job::CANCELLED.to_string())
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(*steps.lock().unwrap(), vec![Step::Quitting]);
    }

    /// Trên Windows thật: dò bằng Win32 trả về ngay và thấy tiến trình con vừa chạy; buộc tắt chỉ tắt tiến trình có
    /// đường dẫn được nhận, PID của tiến trình khác thì để yên.
    #[cfg(windows)]
    #[test]
    fn win32_lists_fast_and_terminates_only_owned_processes() {
        let started = Instant::now();
        let listed = Win32.processes().expect("Toolhelp phải dò được");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(
            listed
                .iter()
                .all(|p| p.exe.to_ascii_lowercase().ends_with("claude.exe") || p.exe.is_empty())
        );

        let mut child = Command::new("ping")
            .args(["-n", "600", "127.0.0.1"])
            .no_window()
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        assert_eq!(sys::close_windows(&[pid]), 0, "ping không có cửa sổ");
        assert!(
            !sys::terminate(pid, is_desktop_exe),
            "không phải Claude Desktop"
        );
        assert!(child.try_wait().unwrap().is_none());
        assert!(sys::terminate(pid, |exe| exe
            .to_ascii_lowercase()
            .ends_with("ping.exe")));
        let until = Instant::now() + Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < until, "ping chưa bị tắt");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn suspicious_family_is_not_put_into_the_script() {
        assert_eq!(
            app_user_model_id("Claude_x'; Remove-Item C:\\ #"),
            "Claude_x'; Remove-Item C:\\ #!Claude"
        );
    }
}
