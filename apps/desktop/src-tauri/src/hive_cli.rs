//! Cài lệnh `hive` (đi kèm gói app làm sidecar) vào PATH của người dùng, để gõ `hive chat` hay `hive remote` trong
//! terminal mà không cần tải riêng.
//!
//! Chỉ ghi trong thư mục của người dùng, không bao giờ cần quyền quản trị:
//! - macOS, Linux: symlink `~/.local/bin/hive` trỏ vào file trong gói app. Symlink thay vì chép để app tự cập nhật
//!   thì lệnh `hive` đổi theo, không lệch bản với worker. Không dùng /usr/local/bin vì phải có sudo. Thư mục chưa có
//!   trong PATH thì báo cho giao diện hướng dẫn, app không tự sửa .zshrc hay .bashrc của người dùng.
//! - Windows: symlink cần quyền hoặc chế độ nhà phát triển, nên chép `hive.exe` vào `%LOCALAPPDATA%\xdev-hive\bin`
//!   (cùng thư mục mặc định của install.ps1, hai đường cài không đè nhau) rồi thêm thư mục đó vào PATH của người dùng.
//!   Bản chép không tự đổi theo app: chạy lại lệnh này sau khi app cập nhật (trạng thái báo `upToDate: false`).
//!
//! Gặp file `hive` do đường cài khác tạo (install.sh, go install) thì không ghi đè, báo lỗi rõ để người dùng tự chọn.

use std::path::{Path, PathBuf};

use serde::Serialize;

const EXE: &str = if cfg!(windows) { "hive.exe" } else { "hive" };

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HiveCliStatus {
    /// Gói app có file `hive` (bản dev chạy từ `cargo run` chưa dựng sidecar thì không có).
    available: bool,
    /// Nơi lệnh được cài (hoặc sẽ cài).
    path: Option<String>,
    installed: bool,
    /// Lệnh đã cài đúng là bản trong gói app hiện tại.
    up_to_date: bool,
    /// Thư mục chứa lệnh đã nằm trong PATH của người dùng.
    on_path: bool,
    /// Thư mục cần thêm vào PATH khi `on_path` là false.
    dir: Option<String>,
}

fn home() -> Option<PathBuf> {
    crate::profiles::home_dir()
}

/// File `hive` nằm cạnh binary của app (Contents/MacOS của .app, thư mục cài trên Windows và Linux).
fn bundled() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let path = exe.parent()?.join(EXE);
    path.is_file().then_some(path)
}

fn install_dir(home: &Path) -> PathBuf {
    if cfg!(windows) {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        base.join("xdev-hive").join("bin")
    } else {
        home.join(".local").join("bin")
    }
}

fn in_path(dir: &Path, path_var: &str) -> bool {
    let want = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    std::env::split_paths(path_var).any(|p| p == dir || p.canonicalize().is_ok_and(|c| c == want))
}

/// Thư mục `hive-worker` đứng cạnh: dấu hiệu file là của một gói app xDev Hive, không phải lệnh khác tên `hive`.
fn is_hive_bundle(file: &Path) -> bool {
    file.parent().is_some_and(|dir| {
        dir.join(if cfg!(windows) {
            "hive-worker.exe"
        } else {
            "hive-worker"
        })
        .exists()
    })
}

#[cfg(unix)]
fn link_matches(link: &Path, source: &Path) -> bool {
    std::fs::read_link(link).is_ok_and(|t| t == source)
}

#[cfg(not(unix))]
fn link_matches(link: &Path, source: &Path) -> bool {
    matches!((std::fs::read(link), std::fs::read(source)), (Ok(a), Ok(b)) if a == b)
}

fn status_at(dir: &Path, source: Option<&Path>, path_var: &str) -> HiveCliStatus {
    let target = dir.join(EXE);
    // symlink_metadata: symlink gãy (app đã dời chỗ) vẫn tính là "có file" để không báo nhầm là chưa cài.
    let present = std::fs::symlink_metadata(&target).is_ok();
    HiveCliStatus {
        available: source.is_some(),
        path: Some(target.display().to_string()),
        installed: present && target.exists(),
        up_to_date: source.is_some_and(|s| present && link_matches(&target, s)),
        on_path: in_path(dir, path_var),
        dir: Some(dir.display().to_string()),
    }
}

/// Tạo hoặc cập nhật lệnh `hive` trong `dir`. Chạy được lại nhiều lần.
#[cfg(unix)]
fn install_at(dir: &Path, source: &Path) -> Result<(), String> {
    let target = dir.join(EXE);
    std::fs::create_dir_all(dir).map_err(|e| {
        format!(
            "Không tạo được thư mục {}: {e}. Tự cài bằng: ln -s \"{}\" \"{}\"",
            dir.display(),
            source.display(),
            target.display()
        )
    })?;
    match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let old = std::fs::read_link(&target).unwrap_or_default();
            if old == source {
                return Ok(());
            }
            // Chỉ thay symlink đang trỏ vào một gói app xDev Hive khác hoặc đã gãy (app dời chỗ); symlink tới lệnh
            // `hive` của nguồn khác là của người dùng.
            if old.exists() && !is_hive_bundle(&old) {
                return Err(format!(
                    "{} đã trỏ tới {}, không phải app xDev Hive. Xoá nó nếu muốn dùng hive của app.",
                    target.display(),
                    old.display()
                ));
            }
            std::fs::remove_file(&target)
                .map_err(|e| format!("Không thay được {}: {e}", target.display()))?;
        }
        Ok(_) => {
            return Err(format!(
                "{} đã có (cài bằng install.sh hoặc go install). Xoá nó nếu muốn dùng hive của app.",
                target.display()
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Không đọc được {}: {e}", target.display())),
    }
    std::os::unix::fs::symlink(source, &target).map_err(|e| {
        format!(
            "Không ghi được {}: {e}. Tự cài bằng: ln -s \"{}\" \"{}\"",
            target.display(),
            source.display(),
            target.display()
        )
    })
}

#[cfg(windows)]
fn install_at(dir: &Path, source: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let target = dir.join(EXE);
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Không tạo được thư mục {}: {e}", dir.display()))?;
    // Windows không ghi đè được file đang chạy nhưng đổi tên được: dời bản cũ sang .old như install.ps1.
    if target.exists() {
        let old = target.with_extension("exe.old");
        let _ = std::fs::remove_file(&old);
        std::fs::rename(&target, &old)
            .map_err(|e| format!("Không thay được {}: {e}", target.display()))?;
    }
    std::fs::copy(source, &target)
        .map_err(|e| format!("Không chép được hive vào {}: {e}", target.display()))?;
    // PATH của người dùng sửa qua .NET để Windows phát thông báo đổi môi trường; thư mục đi qua biến môi trường để
    // không phải ghép vào chuỗi lệnh.
    let script = "$d=$env:HIVE_BIN_DIR;$p=[Environment]::GetEnvironmentVariable('Path','User');\
        if(-not (($p -split ';') -contains $d)){[Environment]::SetEnvironmentVariable('Path',(@($p,$d)|Where-Object{$_}) -join ';','User')}";
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("HIVE_BIN_DIR", dir)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| {
            format!(
                "Không chạy được PowerShell để thêm {} vào PATH: {e}",
                dir.display()
            )
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Không thêm được {} vào PATH của người dùng.",
            dir.display()
        ))
    }
}

fn current_status() -> Result<HiveCliStatus, String> {
    let home = home().ok_or("Không xác định được thư mục home của người dùng.")?;
    Ok(status_at(
        &install_dir(&home),
        bundled().as_deref(),
        crate::doctor::user_path(),
    ))
}

/// Lệnh `hive` đã cài vào PATH chưa, và có đúng bản trong app không.
#[tauri::command]
pub(crate) async fn hive_cli_status() -> Result<HiveCliStatus, String> {
    tauri::async_runtime::spawn_blocking(current_status)
        .await
        .map_err(|e| e.to_string())?
}

/// "Cài lệnh hive vào PATH". Trả trạng thái sau khi cài; `onPath: false` nghĩa là người dùng còn phải thêm `dir` vào
/// PATH của shell (Windows thì app đã thêm, cần mở terminal mới).
#[tauri::command]
pub(crate) async fn hive_cli_install() -> Result<HiveCliStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let source = bundled().ok_or("Gói app này không có lệnh hive (bản dựng thiếu sidecar).")?;
        let home = home().ok_or("Không xác định được thư mục home của người dùng.")?;
        let dir = install_dir(&home);
        install_at(&dir, &source)?;
        current_status()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hive-cli-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Gói app giả: thư mục có hive và hive-worker cạnh nhau.
    fn fake_bundle(root: &Path, name: &str) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("hive-worker"), "w").unwrap();
        std::fs::write(dir.join("hive"), "h").unwrap();
        dir.join("hive")
    }

    #[test]
    fn installs_symlink_and_is_idempotent() {
        let root = scratch("install");
        let source = fake_bundle(&root, "app");
        let bin = root.join("home/.local/bin");
        install_at(&bin, &source).unwrap();
        install_at(&bin, &source).unwrap();
        assert_eq!(std::fs::read_link(bin.join("hive")).unwrap(), source);
        let status = status_at(&bin, Some(&source), &bin.display().to_string());
        assert!(status.installed && status.up_to_date && status.on_path);
    }

    #[test]
    fn reports_dir_missing_from_path() {
        let root = scratch("path");
        let source = fake_bundle(&root, "app");
        let bin = root.join("bin");
        install_at(&bin, &source).unwrap();
        let status = status_at(&bin, Some(&source), "/usr/bin:/bin");
        assert!(status.installed && !status.on_path);
    }

    #[test]
    fn replaces_link_into_a_moved_or_other_app_bundle() {
        let root = scratch("moved");
        let old = fake_bundle(&root, "old-app");
        let new = fake_bundle(&root, "new-app");
        let bin = root.join("bin");
        install_at(&bin, &old).unwrap();
        install_at(&bin, &new).unwrap();
        assert_eq!(std::fs::read_link(bin.join("hive")).unwrap(), new);
        // App cũ đã bị xoá: symlink gãy cũng được thay.
        std::fs::remove_dir_all(root.join("new-app")).unwrap();
        let again = fake_bundle(&root, "third-app");
        install_at(&bin, &again).unwrap();
        assert_eq!(std::fs::read_link(bin.join("hive")).unwrap(), again);
    }

    #[test]
    fn keeps_a_hive_installed_by_other_means() {
        let root = scratch("foreign");
        let source = fake_bundle(&root, "app");
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("hive"), "install.sh").unwrap();
        let err = install_at(&bin, &source).unwrap_err();
        assert!(err.contains("đã có"), "{err}");
        assert_eq!(
            std::fs::read_to_string(bin.join("hive")).unwrap(),
            "install.sh"
        );
        // Symlink tới lệnh hive không thuộc gói app nào cũng giữ nguyên.
        std::fs::remove_file(bin.join("hive")).unwrap();
        let other = root.join("other/hive");
        std::fs::create_dir_all(other.parent().unwrap()).unwrap();
        std::fs::write(&other, "x").unwrap();
        std::os::unix::fs::symlink(&other, bin.join("hive")).unwrap();
        assert!(
            install_at(&bin, &source)
                .unwrap_err()
                .contains("không phải app")
        );
        assert_eq!(std::fs::read_link(bin.join("hive")).unwrap(), other);
    }

    #[test]
    fn explains_when_the_dir_is_not_writable() {
        let root = scratch("readonly");
        let source = fake_bundle(&root, "app");
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let mut perms = std::fs::metadata(&bin).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o555);
        std::fs::set_permissions(&bin, perms).unwrap();
        let result = install_at(&bin, &source);
        let mut perms = std::fs::metadata(&bin).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
        std::fs::set_permissions(&bin, perms).unwrap();
        // Chạy bằng root thì thư mục 0o555 vẫn ghi được; chỉ kiểm thông báo khi có lỗi.
        if let Err(e) = result {
            assert!(e.contains("ln -s"), "{e}");
        }
    }

    #[test]
    fn status_without_bundled_hive() {
        let root = scratch("nobundle");
        let status = status_at(&root.join("bin"), None, "");
        assert!(!status.available && !status.installed && !status.up_to_date);
    }
}
