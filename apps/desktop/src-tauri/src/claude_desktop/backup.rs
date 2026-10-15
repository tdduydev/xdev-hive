//! Bản sao lưu hồ sơ thật trước lần chuyển đầu tiên. Hồ sơ Claude Desktop trên Windows có thể vài GB (cache Chromium,
//! ảnh máy ảo của Cowork, bản Claude Code app tự tải) và trình quét virus soi từng file chép: bản 0.2.16 chép hết, không
//! hạn, nên lần chuyển đầu trông như treo. Giờ bỏ phần app tự dựng lại, có giới hạn cỡ và thời gian, báo phần trăm và
//! huỷ được. Thứ phải giữ là phần khôi phục đăng nhập cần (`read_auth` đọc từ bản sao lưu): file xác thực, `config.json`,
//! `claude_desktop_config.json`.

use std::path::Path;
use std::time::Instant;

use super::job::{CANCELLED, Ctl, Step};
use super::{CONFIG, DESKTOP_CONFIG, at, create_private_dir, retry_locked};

/// Thư mục cache của Chromium, ở mọi cấp (`Service Worker/CacheStorage`, `Partitions/<tên>/Cache`…): app dựng lại khi
/// thiếu.
const CACHES: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GraphiteDawnCache",
    "GPUPersistentCache",
    "ShaderCache",
    "GrShaderCache",
    "CacheStorage",
    "ScriptCache",
];

/// Ở gốc hồ sơ: bản Claude Code app tự tải (vài trăm MB), ảnh máy ảo, báo cáo crash, log, blob tạm. Thiếu thì app tải
/// hay tạo lại, không mất gì của người dùng.
const AT_TOP: &[&str] = &[
    "claude-code",
    "claude-code-vm",
    "vm_bundles",
    "Crashpad",
    "logs",
    "blob_storage",
];

/// Quá giới hạn cỡ thì chỉ giữ chừng này: đủ để khôi phục đăng nhập, cộng khoá giải mã và cấu hình Chromium.
const MINIMAL: &[&str] = &["Local State", "Preferences"];

/// Danh sách file không chép, để người dùng biết bản sao lưu thiếu gì.
pub(super) const SKIPPED_LIST: &str = "hive-skipped.txt";

enum Kind {
    Dir,
    File(u64),
    Link,
}

struct Entry {
    /// Đường dẫn tương đối, phân cách bằng `/`.
    rel: String,
    kind: Kind,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Report {
    pub(super) files: u64,
    pub(super) bytes: u64,
    pub(super) skipped: Vec<String>,
    /// Hồ sơ quá lớn: chỉ sao lưu phần đăng nhập và cấu hình.
    pub(super) minimal: bool,
}

fn skip(rel: &str, name: &str) -> bool {
    CACHES.contains(&name) || (rel.is_empty() && AT_TOP.contains(&name))
}

fn timed_out(ctl: &Ctl) -> String {
    format!(
        "Sao lưu hồ sơ Claude Desktop quá {} phút; chưa đổi gì. Bấm \"Chép thông tin chẩn đoán\" và gửi cho người hỗ trợ.",
        ctl.limits.backup_wait.as_secs().div_ceil(60)
    )
}

fn scan(
    from: &Path,
    rel: &str,
    out: &mut Vec<Entry>,
    report: &mut Report,
    ctl: &Ctl,
    until: Instant,
) -> Result<(), String> {
    let dir = if rel.is_empty() {
        from.to_path_buf()
    } else {
        at(from, rel)
    };
    let entries =
        std::fs::read_dir(&dir).map_err(|e| format!("Không đọc được {}: {e}", dir.display()))?;
    for entry in entries {
        ctl.check()?;
        if Instant::now() >= until {
            return Err(timed_out(ctl));
        }
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if skip(rel, &name) {
            continue;
        }
        let child = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            report.skipped.push(child);
            continue;
        };
        // Junction của Windows cũng là symlink ở đây: không đi theo ra ngoài hồ sơ.
        if meta.file_type().is_symlink() {
            if cfg!(unix) {
                out.push(Entry {
                    rel: child,
                    kind: Kind::Link,
                });
            } else {
                report.skipped.push(child);
            }
        } else if meta.is_dir() {
            out.push(Entry {
                rel: child.clone(),
                kind: Kind::Dir,
            });
            scan(from, &child, out, report, ctl, until)?;
        } else if meta.is_file() {
            if meta.len() > ctl.limits.file_max {
                report
                    .skipped
                    .push(format!("{child} ({} MB)", meta.len() >> 20));
            } else {
                out.push(Entry {
                    rel: child,
                    kind: Kind::File(meta.len()),
                });
            }
        }
    }
    Ok(())
}

/// Chép hồ sơ `from` sang `to` (chưa có), bỏ cache, báo phần trăm theo số byte. File lặt vặt không chép được (đang bị
/// khoá, quá lớn) ghi vào `hive-skipped.txt`; file cần để khôi phục đăng nhập mà không chép được thì báo lỗi.
pub(super) fn copy(
    from: &Path,
    to: &Path,
    auth_files: &[&str],
    ctl: &Ctl,
) -> Result<Report, String> {
    let until = Instant::now() + ctl.limits.backup_wait;
    let essential = |rel: &str| rel == CONFIG || rel == DESKTOP_CONFIG || auth_files.contains(&rel);
    ctl.percent(Step::BackingUp, 0);
    let mut report = Report::default();
    let mut entries = vec![];
    scan(from, "", &mut entries, &mut report, ctl, until)?;
    let total: u64 = entries
        .iter()
        .map(|e| match e.kind {
            Kind::File(n) => n,
            _ => 0,
        })
        .sum();
    if total > ctl.limits.total_max {
        report.minimal = true;
        report.skipped.push(format!(
            "(hồ sơ {} MB, quá {} MB: chỉ sao lưu đăng nhập và cấu hình)",
            total >> 20,
            ctl.limits.total_max >> 20
        ));
        entries.retain(|e| match e.kind {
            Kind::File(_) => essential(&e.rel) || MINIMAL.contains(&e.rel.as_str()),
            _ => false,
        });
    }
    let total: u64 = entries
        .iter()
        .map(|e| match e.kind {
            Kind::File(n) => n,
            _ => 0,
        })
        .sum();
    create_private_dir(to).map_err(|e| format!("Không tạo được thư mục sao lưu: {e}"))?;
    let mut shown = 0;
    for e in &entries {
        ctl.check()?;
        if Instant::now() >= until {
            return Err(timed_out(ctl));
        }
        let dest = at(to, &e.rel);
        let done = match e.kind {
            Kind::Dir => create_private_dir(&dest),
            Kind::File(n) => dest
                .parent()
                .map_or(Ok(()), create_private_dir)
                .and_then(|_| retry_locked(|| std::fs::copy(at(from, &e.rel), &dest)))
                .map(|_| {
                    report.files += 1;
                    report.bytes += n;
                }),
            Kind::Link => link(&at(from, &e.rel), &dest),
        };
        match done {
            Err(err) if essential(&e.rel) => {
                return Err(format!("Không sao lưu được {}: {err}", e.rel));
            }
            Err(_) => report.skipped.push(e.rel.clone()),
            Ok(()) => {}
        }
        let percent = (report.bytes * 100)
            .checked_div(total)
            .map_or(100, |p| p.min(100) as u8);
        if percent != shown {
            shown = percent;
            ctl.percent(Step::BackingUp, percent);
        }
    }
    if !report.skipped.is_empty() {
        let text = format!(
            "Hive bỏ qua khi sao lưu (cache Chromium luôn bỏ qua):\n{}\n",
            report.skipped.join("\n")
        );
        let _ = std::fs::write(to.join(SKIPPED_LIST), text);
    }
    Ok(report)
}

#[cfg(unix)]
fn link(from: &Path, to: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(std::fs::read_link(from)?, to)
}

#[cfg(not(unix))]
fn link(_: &Path, _: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Lỗi của lần sao lưu là do người dùng bấm Huỷ.
pub(super) fn cancelled(e: &str) -> bool {
    e == CANCELLED
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use super::super::job::Limits;
    use super::super::tests::{put, temp_home};
    use super::*;

    const AUTH: &[&str] = &["Network/Cookies", "Cookies"];

    fn big(path: &Path, size: u64) {
        put(path, "");
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_len(size)
            .unwrap();
    }

    fn profile(home: &Path) -> std::path::PathBuf {
        let real = home.join("Claude");
        put(&real.join("config.json"), "{}");
        put(&real.join("Network/Cookies"), "cookies");
        put(&real.join("Local State"), "{}");
        put(&real.join("IndexedDB/https_claude.ai_0/000003.log"), "idb");
        big(&real.join("Cache/Cache_Data/data_1"), 4 << 20);
        big(&real.join("Service Worker/CacheStorage/abc/1"), 1 << 20);
        put(&real.join("Service Worker/Database/CURRENT"), "sw");
        big(&real.join("Partitions/p/Code Cache/js/x"), 1 << 20);
        put(&real.join("Partitions/p/Local Storage/leveldb/LOG"), "ls");
        big(&real.join("claude-code/2.1/claude.exe"), 2 << 20);
        big(&real.join("vm_bundles/claudevm.bundle/rootfs.img"), 8 << 20);
        put(&real.join("Crashpad/reports/r.dmp"), "dmp");
        put(&real.join("logs/main.log"), "log");
        put(&real.join("blob_storage/x/1"), "blob");
        put(
            &real.join("sessions/logs/keep.json"),
            "logs không ở gốc thì giữ",
        );
        real
    }

    fn ctl_with<'a>(
        cancel: &'a AtomicBool,
        report: &'a dyn Fn(Step, Option<u8>),
        limits: Limits,
    ) -> Ctl<'a> {
        let mut ctl = Ctl::new(cancel, report);
        ctl.limits = limits;
        ctl
    }

    #[test]
    fn large_profile_is_backed_up_without_caches_and_with_progress() {
        let home = temp_home("backup-big");
        let real = profile(&home);
        big(&real.join("huge.bin"), 3 << 20);
        let never = AtomicBool::new(false);
        let seen = std::sync::Mutex::new(vec![]);
        let report = |_: Step, p: Option<u8>| seen.lock().unwrap().extend(p);
        let limits = Limits {
            file_max: 2 << 20,
            total_max: 1 << 30,
            backup_wait: Duration::from_secs(60),
        };
        let to = home.join("backup");
        let r = copy(&real, &to, AUTH, &ctl_with(&never, &report, limits)).unwrap();
        for kept in [
            "config.json",
            "Network/Cookies",
            "Local State",
            "IndexedDB/https_claude.ai_0/000003.log",
            "Service Worker/Database/CURRENT",
            "Partitions/p/Local Storage/leveldb/LOG",
            "sessions/logs/keep.json",
        ] {
            assert!(at(&to, kept).is_file(), "{kept}");
        }
        for gone in [
            "Cache",
            "Service Worker/CacheStorage",
            "Partitions/p/Code Cache",
            "claude-code",
            "vm_bundles",
            "Crashpad",
            "logs",
            "blob_storage",
            "huge.bin",
        ] {
            assert!(!at(&to, gone).exists(), "{gone}");
        }
        assert!(!r.minimal);
        assert_eq!(r.skipped, ["huge.bin (3 MB)"]);
        assert!(
            std::fs::read_to_string(to.join(SKIPPED_LIST))
                .unwrap()
                .contains("huge.bin")
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.first(), Some(&0));
        assert_eq!(seen.last(), Some(&100));
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "{seen:?}");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn profile_over_the_size_limit_keeps_only_login_and_config() {
        let home = temp_home("backup-minimal");
        let real = profile(&home);
        let never = AtomicBool::new(false);
        let limits = Limits {
            file_max: 1 << 30,
            total_max: 10,
            backup_wait: Duration::from_secs(60),
        };
        let to = home.join("backup");
        let r = copy(&real, &to, AUTH, &ctl_with(&never, &|_, _| {}, limits)).unwrap();
        assert!(r.minimal);
        for kept in ["config.json", "Network/Cookies", "Local State"] {
            assert!(at(&to, kept).is_file(), "{kept}");
        }
        assert!(!to.join("IndexedDB").exists());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn backup_stops_on_cancel_and_on_timeout() {
        let home = temp_home("backup-cancel");
        let real = profile(&home);
        for i in 0..50 {
            put(&real.join(format!("Local Storage/leveldb/{i:03}.ldb")), "x");
        }
        let cancel = AtomicBool::new(false);
        let copied = std::sync::atomic::AtomicU32::new(0);
        let report = |_: Step, p: Option<u8>| {
            if p.is_some_and(|p| p > 0) && copied.fetch_add(1, Ordering::SeqCst) == 3 {
                cancel.store(true, Ordering::SeqCst);
            }
        };
        let to = home.join("backup-1");
        let err = copy(
            &real,
            &to,
            AUTH,
            &ctl_with(&cancel, &report, super::super::job::LIMITS),
        )
        .unwrap_err();
        assert!(cancelled(&err), "{err}");

        let never = AtomicBool::new(false);
        let limits = Limits {
            backup_wait: Duration::ZERO,
            ..super::super::job::LIMITS
        };
        let err = copy(
            &real,
            &home.join("backup-2"),
            AUTH,
            &ctl_with(&never, &|_, _| {}, limits),
        )
        .unwrap_err();
        assert!(err.contains("quá 0 phút"), "{err}");
        std::fs::remove_dir_all(&home).unwrap();
    }
}
