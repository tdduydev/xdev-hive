//! Phần riêng Windows của việc chuyển Claude Desktop: tìm bản cài (Squirrel hay MSIX), tìm hồ sơ thật, dò tiến trình,
//! thoát êm bằng `taskkill` (WM_CLOSE) và mở lại.
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
/// là tên gói. Nhận cả tên có tiền tố nhà phát hành (`Anthropic.Claude`) vì chưa chắc tên gói giữ nguyên qua các bản.
fn msix_family(local: &Path) -> Option<(String, PathBuf)> {
    let mut found: Vec<(String, PathBuf)> = std::fs::read_dir(local.join("Packages"))
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| Some((e.file_name().into_string().ok()?, e.path())))
        .filter(|(name, _)| {
            let package = name.split('_').next().unwrap_or("").to_ascii_lowercase();
            name.contains('_') && (package == "claude" || package.ends_with(".claude"))
        })
        .collect();
    found.sort();
    found.into_iter().next()
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Hồ sơ thật của Claude Desktop. Có gói MSIX thì hồ sơ có thể nằm ở chỗ Windows chuyển hướng tới hoặc ở `%APPDATA%`
/// (gói tắt chuyển hướng, hay app từng cài kiểu Squirrel): chọn nơi app ghi `config.json` gần nhất, vì app ghi file đó
/// mỗi lần chạy.
pub(super) fn profile(dirs: &Dirs) -> PathBuf {
    let roaming = dirs.roaming.join("Claude");
    let Some((_, data)) = msix_family(&dirs.local) else {
        return roaming;
    };
    let virtualized = data.join("LocalCache").join("Roaming").join("Claude");
    if !virtualized.is_dir() {
        return roaming;
    }
    match (
        modified(&virtualized.join("config.json")),
        modified(&roaming.join("config.json")),
    ) {
        (Some(v), Some(r)) if r > v => roaming,
        (None, Some(_)) => roaming,
        _ => virtualized,
    }
}

/// Gói MSIX trước (cách phân phối mới), rồi bản Squirrel.
pub(super) fn find_app(dirs: &Dirs) -> Option<App> {
    if let Some((family, data)) = msix_family(&dirs.local) {
        return Some(App::Msix { family, data });
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

/// Tiến trình chính của Claude Desktop từ dòng `pid<TAB>đường dẫn exe<TAB>dòng lệnh`. Tiến trình phụ của Electron
/// (`--type=renderer`, `--type=crashpad-handler`…) bỏ qua.
fn running_in(text: &str) -> Vec<u32> {
    let mut out: Vec<u32> = text
        .lines()
        .filter_map(|line| {
            let mut parts = line.trim_end_matches('\r').splitn(3, '\t');
            let pid = parts.next()?.trim().parse::<u32>().ok()?;
            let exe = parts.next()?;
            let command = parts.next().unwrap_or("");
            (is_desktop_exe(exe) && !command.contains("--type=")).then_some(pid)
        })
        .collect();
    out.sort_unstable();
    out.dedup();
    out
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

/// Chạy script PowerShell, trả stdout. Script truyền qua `-EncodedCommand` (UTF-16LE base64) để khỏi lo cách Windows
/// tách dấu nháy; stdout đặt UTF-8 để đường dẫn có chữ Việt không bị đổi mã.
fn powershell(script: &str) -> Option<String> {
    let script = format!("[Console]::OutputEncoding = [Text.Encoding]::UTF8\n{script}");
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    let out = hidden(Command::new("powershell.exe").args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        &encoded,
    ]))
    .output()
    .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `tasklist` nhanh hơn PowerShell nhiều: không có `claude.exe` nào thì khỏi hỏi đường dẫn. Màn gói đọc lại mỗi 10 giây.
fn any_claude_exe() -> bool {
    let Ok(out) = hidden(Command::new("tasklist").args([
        "/FI",
        "IMAGENAME eq claude.exe",
        "/FO",
        "CSV",
        "/NH",
    ]))
    .output() else {
        // Không chạy được tasklist thì để PowerShell quyết định.
        return true;
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|l| l.to_ascii_lowercase().starts_with("\"claude.exe\""))
}

pub(super) fn running() -> Vec<u32> {
    if !any_claude_exe() {
        return vec![];
    }
    powershell(
        "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)\" }",
    )
    .map(|out| running_in(&out))
    .unwrap_or_default()
}

fn taskkill(pid: u32, force: bool) {
    let pid = pid.to_string();
    let args: &[&str] = if force {
        &["/F", "/T", "/PID", &pid]
    } else {
        &["/PID", &pid]
    };
    let _ = hidden(Command::new("taskkill").args(args)).status();
}

/// Thoát êm: `taskkill` không `/F` gửi WM_CLOSE cho cửa sổ của app, app tự lưu và đóng file như khi bấm nút đóng.
/// Claude Desktop có thể chỉ thu xuống khay khi đóng cửa sổ; khi đó quá hạn thì trả false để giao diện hỏi buộc thoát.
/// `force` (người dùng đã đồng ý) thì `taskkill /F /T` cả cây tiến trình.
pub(super) fn quit(force: bool) -> Result<bool, String> {
    let now = running();
    if now.is_empty() {
        return Ok(true);
    }
    for pid in &now {
        taskkill(*pid, false);
    }
    let gone = wait_gone(running, QUIT_WAIT);
    if gone || !force {
        return Ok(gone);
    }
    for pid in running() {
        taskkill(pid, true);
    }
    Ok(wait_gone(running, Duration::from_secs(10)))
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
    powershell(&format!(
        "$p = Get-AppxPackage | Where-Object PackageFamilyName -eq '{family}' | Select-Object -First 1\n\
         if ($p) {{ $a = (Get-AppxPackageManifest $p).Package.Applications.Application | Select-Object -First 1; \"$($p.PackageFamilyName)!$($a.Id)\" }}"
    ))
    .map(|s| s.trim().to_string())
    .filter(|s| s.starts_with(&format!("{family}!")) && !s.ends_with('!'))
    .unwrap_or(fallback)
}

pub(super) fn launch(app: &App) -> Result<(), String> {
    let spawned = match app {
        App::Squirrel(exe) => Command::new(exe).spawn().map(|_| ()),
        // explorer.exe trả mã khác 0 cả khi mở được, nên chỉ xét lỗi lúc chạy lệnh.
        App::Msix { family, .. } => Command::new("explorer.exe")
            .arg(format!("shell:AppsFolder\\{}", app_user_model_id(family)))
            .status()
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
        assert_eq!(running_in(text), vec![4100, 4200]);
        assert!(is_desktop_exe(
            "C:/Users/Duy/AppData/Local/AnthropicClaude/claude.exe"
        ));
        assert!(!is_desktop_exe(
            "C:\\Users\\Duy\\AppData\\Local\\AnthropicClaude\\Update.exe"
        ));
    }

    #[test]
    fn suspicious_family_is_not_put_into_the_script() {
        assert_eq!(
            app_user_model_id("Claude_x'; Remove-Item C:\\ #"),
            "Claude_x'; Remove-Item C:\\ #!Claude"
        );
    }
}
