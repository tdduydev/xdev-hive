//! "Chép thông tin chẩn đoán" của mục Claude Desktop: khi chuyển hỏng trên máy người dùng (Windows, chưa thử hết các
//! cách cài), người hỗ trợ cần biết app cài kiểu gì, hồ sơ nào đang được chọn, cỡ của nó và tiến trình nào đang chạy.
//! Chỉ liệt kê tên, cỡ, giờ sửa; không đọc nội dung file đăng nhập, không in dòng lệnh của tiến trình.

use std::fmt::Write;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

use super::{CURRENT, Os, Paths, job, mac, profiles_root, read_state, utc_stamp, win};

/// Cả bản chẩn đoán không được chạy lâu: hồ sơ vài GB trên ổ chậm thì đếm dở và ghi rõ là chưa đủ.
const SIZE_BUDGET: Duration = Duration::from_secs(8);

struct Size {
    bytes: u64,
    files: u64,
    /// Hết thời gian giữa chừng.
    partial: bool,
}

fn size_of(dir: &Path, until: Instant) -> Size {
    let mut s = Size {
        bytes: 0,
        files: 0,
        partial: false,
    };
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.filter_map(Result::ok) {
            if Instant::now() >= until {
                s.partial = true;
                return s;
            }
            let Ok(m) = std::fs::symlink_metadata(e.path()) else {
                continue;
            };
            if m.is_dir() {
                stack.push(e.path());
            } else if m.is_file() {
                s.bytes += m.len();
                s.files += 1;
            }
        }
    }
    s
}

fn shown(s: &Size) -> String {
    format!(
        "{} MB, {} file{}",
        s.bytes >> 20,
        s.files,
        if s.partial {
            " (đếm chưa hết)"
        } else {
            ""
        }
    )
}

fn when(t: Option<SystemTime>) -> String {
    t.map_or_else(|| "không có".into(), |t| format!("{} UTC", utc_stamp(t)))
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Mục cấp đầu của hồ sơ, lớn trước: thấy ngay thứ gì làm sao lưu chậm.
fn top_entries(dir: &Path, until: Instant, out: &mut String) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut rows: Vec<(String, Size)> = entries
        .filter_map(Result::ok)
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let size = match std::fs::symlink_metadata(e.path()) {
                Ok(m) if m.is_dir() => size_of(&e.path(), until),
                Ok(m) => Size {
                    bytes: m.len(),
                    files: 1,
                    partial: false,
                },
                Err(_) => Size {
                    bytes: 0,
                    files: 0,
                    partial: true,
                },
            };
            (name, size)
        })
        .collect();
    rows.sort_by(|a, b| b.1.bytes.cmp(&a.1.bytes).then(a.0.cmp(&b.0)));
    for (name, size) in rows.iter().take(25) {
        let _ = writeln!(out, "    {name}: {}", shown(size));
    }
    if rows.len() > 25 {
        let _ = writeln!(out, "    … và {} mục nữa", rows.len() - 25);
    }
}

fn profile_block(paths: &Paths, dir: &Path, until: Instant, out: &mut String) {
    if !dir.is_dir() {
        let _ = writeln!(out, "  {}: không có", dir.display());
        return;
    }
    let _ = writeln!(out, "  {}: {}", dir.display(), shown(&size_of(dir, until)));
    for m in win::MARKERS {
        let p = super::at(dir, m);
        if p.exists() {
            let _ = writeln!(out, "    {m}: sửa {}", when(modified(&p)));
        }
    }
    let _ = writeln!(
        out,
        "    có cookie đăng nhập: {}",
        if paths.has_login(dir) {
            "có"
        } else {
            "không"
        }
    );
}

/// File đăng nhập có trong một bộ: chỉ tên và cỡ.
fn bundle_files(paths: &Paths, dir: &Path) -> String {
    let mut names: Vec<String> = paths
        .auth_files()
        .iter()
        .chain(&[super::CONFIG, super::BUNDLE_PREFS])
        .filter_map(|f| {
            let m = std::fs::symlink_metadata(super::at(dir, f)).ok()?;
            Some(format!("{f} ({} B)", m.len()))
        })
        .collect();
    if names.is_empty() {
        names.push("trống".into());
    }
    names.join(", ")
}

pub(super) fn report(home: &Path) -> String {
    report_in(home, CURRENT, &win::Dirs::from_env(home))
}

/// `report` với hệ điều hành và thư mục AppData truyền vào: test trên Windows không được đọc hồ sơ thật của máy CI.
fn report_in(home: &Path, os: Option<Os>, dirs: &win::Dirs) -> String {
    let until = Instant::now() + SIZE_BUDGET;
    let mut out = String::new();
    let _ = writeln!(
        out,
        "xDev Hive {} · {} {} · lúc {} UTC",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        utc_stamp(SystemTime::now())
    );
    let Some(os) = os else {
        let _ = writeln!(out, "{}", super::UNSUPPORTED);
        return out;
    };
    let (paths, app) = match os {
        Os::Mac => (Paths::mac(home), mac::find_app(home)),
        Os::Windows => (Paths::windows(home, dirs), win::find_app(dirs)),
    };
    let _ = writeln!(
        out,
        "Claude Desktop: {}",
        app.map_or_else(|| "chưa thấy".into(), |a| format!("{a:?}"))
    );
    let _ = writeln!(out, "Hồ sơ đang chọn: {}", paths.real.display());
    let _ = writeln!(out, "Các hồ sơ có thể dùng:");
    match os {
        Os::Windows => {
            for dir in win::candidates(dirs) {
                profile_block(&paths, &dir, until, &mut out);
            }
        }
        Os::Mac => profile_block(&paths, &paths.real, until, &mut out),
    }
    let _ = writeln!(out, "  Mục trong hồ sơ đang chọn:");
    top_entries(&paths.real, until, &mut out);

    let root = profiles_root(home);
    let _ = writeln!(
        out,
        "Thư mục của Hive: {} ({})",
        root.display(),
        if root.is_dir() {
            shown(&size_of(&root, until))
        } else {
            "chưa có".into()
        }
    );
    let state = read_state(&paths);
    let _ = writeln!(
        out,
        "  Gói đang dùng: {} · bản sao lưu: {} · báo đăng nhập lạ: {}",
        state.active.as_deref().unwrap_or("không"),
        state.backup.as_deref().map_or("chưa có".into(), |b| {
            let p = root.join(b);
            let skipped = if p.join(super::backup::SKIPPED_LIST).exists() {
                ", có file bỏ qua"
            } else {
                ""
            };
            format!("{b} ({}{skipped})", if p.is_dir() { "còn" } else { "mất" })
        }),
        if state.mismatch.is_some() {
            "có"
        } else {
            "không"
        }
    );
    if let Ok(entries) = std::fs::read_dir(&root) {
        let mut ids: Vec<String> = entries
            .filter_map(Result::ok)
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|id| super::valid_id(id) || id == ".previous")
            .collect();
        ids.sort();
        for id in ids {
            let auth = root.join(&id).join("auth");
            let _ = writeln!(out, "  {id}: {}", bundle_files(&paths, &auth));
        }
    }

    let _ = writeln!(out, "Tiến trình:");
    match os {
        Os::Windows => match win::processes() {
            None => {
                let _ = writeln!(out, "  không dò được (PowerShell không trả lời)");
            }
            Some(procs) if procs.is_empty() => {
                let _ = writeln!(out, "  không có claude.exe nào");
            }
            Some(procs) => {
                for p in procs {
                    let _ = writeln!(
                        out,
                        "  {} {} [{}] {}",
                        p.pid,
                        if p.desktop() {
                            "Claude Desktop"
                        } else {
                            "khác (Claude Code CLI?)"
                        },
                        p.kind.as_deref().unwrap_or("chính"),
                        p.exe
                    );
                }
            }
        },
        Os::Mac => match mac::running(home) {
            None => {
                let _ = writeln!(out, "  không dò được (ps không trả lời)");
            }
            Some(r) => {
                let _ = writeln!(
                    out,
                    "  tiến trình chính: {:?}, hồ sơ riêng kiểu cũ: {:?}",
                    r.real, r.legacy
                );
            }
        },
    }

    match job::progress() {
        Some(p) => {
            let _ = writeln!(out, "Lần chuyển đang chạy: {p:?}");
        }
        None => {
            let _ = writeln!(out, "Lần chuyển đang chạy: không");
        }
    }
    match job::last_error() {
        Some((t, e)) => {
            let _ = writeln!(out, "Lỗi gần nhất ({}): {e}", when(Some(t)));
        }
        None => {
            let _ = writeln!(out, "Lỗi gần nhất: không");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::tests::{put, temp_home};
    use super::*;

    /// Có cỡ và tên file, không có nội dung token hay cookie. Bố cục Windows có gói MSIX: liệt kê cả hồ sơ chuyển hướng
    /// lẫn `%APPDATA%\Claude`.
    #[test]
    fn report_lists_sizes_but_never_secrets() {
        let home = temp_home("diagnose");
        let dirs = win::Dirs {
            roaming: home.join("AppData").join("Roaming"),
            local: home.join("AppData").join("Local"),
        };
        let msix = dirs
            .local
            .join("Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude");
        for (os, real) in [
            (Os::Mac, Paths::mac(&home)),
            (Os::Windows, {
                put(&msix.join("config.json"), "{}");
                Paths::windows(&home, &dirs)
            }),
        ] {
            put(
                &real.real.join("config.json"),
                r#"{"oauth:tokenCache":"SECRET-TOKEN"}"#,
            );
            put(
                &super::super::at(&real.real, real.auth_files()[0]),
                "SECRET-COOKIE",
            );
            put(&real.real.join("Cache/Cache_Data/big"), "cache");
            put(
                &real.root.join("claude-2/auth/config.json"),
                r#"{"oauth:tokenCache":"SECRET-2"}"#,
            );
            let text = report_in(&home, Some(os), &dirs);
            assert!(!text.contains("SECRET"), "{text}");
            assert!(text.contains(&real.real.display().to_string()), "{text}");
            assert!(text.contains("claude-2: config.json"), "{text}");
            assert!(text.contains("    Cache: "), "{text}");
            assert!(text.contains("Lỗi gần nhất"), "{text}");
            if os == Os::Windows {
                assert_eq!(real.real, msix);
                assert!(
                    text.contains(&dirs.roaming.join("Claude").display().to_string()),
                    "{text}"
                );
            }
        }
        assert!(report_in(&home, None, &dirs).contains("Chưa hỗ trợ"));
        std::fs::remove_dir_all(&home).unwrap();
    }
}
