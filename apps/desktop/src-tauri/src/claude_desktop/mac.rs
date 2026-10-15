//! Phần riêng macOS của việc chuyển Claude Desktop: tìm Claude.app, dò tiến trình bằng `ps`, thoát bằng AppleScript.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use super::{App, QUIT_WAIT, Running, profiles_root, valid_id, wait_gone};

const BUNDLE_ID: &str = "com.anthropic.claudefordesktop";

pub(super) const NOT_INSTALLED: &str = "Chưa thấy Claude Desktop trong /Applications hay ~/Applications. Cài Claude Desktop rồi thử lại.";

/// Hồ sơ của chính Claude Desktop, dùng chung cho mọi gói.
pub(super) fn profile(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("Claude")
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

pub(super) fn find_app(home: &Path) -> Option<App> {
    find_app_in(&app_candidates(home)).map(App::Mac)
}

/// Tiến trình chính của Claude.app từ `ps -axo pid=,command=`, chia theo hồ sơ: dùng hồ sơ thật (không có
/// `--user-data-dir`) hay hồ sơ riêng kiểu cũ của Hive (id gói). Tiến trình phụ của Electron (`--type=renderer`…) bỏ qua.
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

pub(super) fn running(home: &Path) -> Running {
    let Ok(out) = Command::new("ps").args(["-axo", "pid=,command="]).output() else {
        return Running::default();
    };
    running_in(&String::from_utf8_lossy(&out.stdout), &profiles_root(home))
}

/// Thoát Claude Desktop bằng lệnh Quit của AppleScript như Cmd+Q, để app tự lưu và đóng file. `force` (người dùng đã
/// đồng ý) thì quá hạn sẽ gửi SIGTERM rồi SIGKILL. Trả false khi app vẫn chạy.
pub(super) fn quit(home: &Path, force: bool) -> Result<bool, String> {
    let now = running(home);
    if let Some(id) = now.legacy.keys().next() {
        return Err(format!(
            "Claude Desktop đang mở bằng hồ sơ riêng (bản cũ) của gói {id}. Thoát cửa sổ đó (Cmd+Q) rồi thử lại."
        ));
    }
    if now.real.is_empty() {
        return Ok(true);
    }
    let gone_within = |d| wait_gone(|| running(home).real, d);
    // osascript chờ app trả lời; app hỏi lại trước khi thoát thì lệnh treo, nên không chờ nó mà dò tiến trình.
    let mut script = Command::new("osascript")
        .args([
            "-e",
            &format!("tell application id \"{BUNDLE_ID}\" to quit"),
        ])
        .spawn()
        .map_err(|e| format!("Không gửi được lệnh thoát cho Claude Desktop: {e}"))?;
    let gone = gone_within(QUIT_WAIT);
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
        if gone_within(Duration::from_secs(5)) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn launch(bundle: &Path) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    #[test]
    fn finds_app_in_applications_or_home() {
        let home = super::super::tests::temp_home("find");
        let user_app = home.join("Applications").join("Claude.app");
        let missing = home.join("nowhere").join("Claude.app");
        assert_eq!(find_app_in(&[missing.clone(), user_app.clone()]), None);
        super::super::tests::put(&app_binary(&user_app), "x");
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
}
