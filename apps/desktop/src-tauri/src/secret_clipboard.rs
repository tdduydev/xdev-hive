//! Clipboard cho nút Sao chép của màn Bí mật (specs/031 T037): ghi giá trị, rồi sau 30 giây xoá nếu người dùng chưa chép
//! thứ khác.
//!
//! Dùng công cụ clipboard của hệ điều hành thay vì thêm crate: giá trị chỉ đi qua stdin của công cụ, không qua tham số
//! hay biến môi trường. Muốn đổi sang `tauri-plugin-clipboard-manager` thì chỉ sửa file này.

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::no_window::NoWindow;

/// Thời gian giữ giá trị trong clipboard (FR-052).
pub(crate) const CLEAR_AFTER: Duration = Duration::from_secs(30);

type Tool = (&'static str, &'static [&'static str]);

// Windows PowerShell 5.1 có sẵn trên mọi máy Windows 10+. Mã hoá UTF-8 đặt tường minh vì mặc định là trang mã OEM.
#[cfg(windows)]
const PS_WRITE: &str = "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())";
#[cfg(windows)]
const PS_READ: &str = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $c=Get-Clipboard -Raw; if ($null -ne $c) { [Console]::Out.Write($c) }";
#[cfg(windows)]
const PS_CLEAR: &str = "Set-Clipboard -Value ''";

#[cfg(windows)]
const WRITE: &[Tool] = &[("powershell", &["-NoProfile", "-NonInteractive", "-Command", PS_WRITE])];
#[cfg(windows)]
const READ: &[Tool] = &[("powershell", &["-NoProfile", "-NonInteractive", "-Command", PS_READ])];
#[cfg(windows)]
const CLEAR: &[Tool] = &[("powershell", &["-NoProfile", "-NonInteractive", "-Command", PS_CLEAR])];

#[cfg(target_os = "macos")]
const WRITE: &[Tool] = &[("pbcopy", &[])];
#[cfg(target_os = "macos")]
const READ: &[Tool] = &[("pbpaste", &[])];
#[cfg(target_os = "macos")]
const CLEAR: &[Tool] = &[("pbcopy", &[])];

#[cfg(all(unix, not(target_os = "macos")))]
const WRITE: &[Tool] = &[
    ("wl-copy", &[]),
    ("xclip", &["-selection", "clipboard"]),
    ("xsel", &["--clipboard", "--input"]),
];
#[cfg(all(unix, not(target_os = "macos")))]
const READ: &[Tool] = &[
    ("wl-paste", &["--no-newline"]),
    ("xclip", &["-selection", "clipboard", "-o"]),
    ("xsel", &["--clipboard", "--output"]),
];
#[cfg(all(unix, not(target_os = "macos")))]
const CLEAR: &[Tool] = &[
    ("wl-copy", &["--clear"]),
    ("xclip", &["-selection", "clipboard"]),
    ("xsel", &["--clipboard", "--clear"]),
];

pub(crate) trait Clipboard {
    fn read(&self) -> Option<String>;
    fn clear(&self) -> Result<(), String>;
}

pub(crate) struct System;

fn command(tool: &Tool) -> Command {
    let mut cmd = Command::new(tool.0);
    // pbcopy đọc theo LANG; app mở từ Finder không có LANG nên tiếng Việt thành rác.
    cmd.args(tool.1).env("LC_ALL", "en_US.UTF-8").no_window();
    cmd
}

fn pipe_in(tool: &Tool, input: &[u8]) -> bool {
    let mut cmd = command(tool);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let Ok(mut child) = cmd.spawn() else {
        return false;
    };
    if let Some(mut stdin) = child.stdin.take() {
        // Công cụ thoát sớm vì lỗi thì ghi hỏng; trạng thái thoát bên dưới cho biết kết quả.
        let _ = stdin.write_all(input);
    }
    child.wait().is_ok_and(|s| s.success())
}

fn pipe_out(tool: &Tool) -> Option<String> {
    let mut cmd = command(tool);
    cmd.stdin(Stdio::null()).stderr(Stdio::null());
    let out = cmd.output().ok().filter(|o| o.status.success())?;
    String::from_utf8(out.stdout).ok()
}

impl System {
    pub(crate) fn write(&self, text: &str) -> Result<(), String> {
        if WRITE.iter().any(|tool| pipe_in(tool, text.as_bytes())) {
            return Ok(());
        }
        Err(no_clipboard())
    }
}

impl Clipboard for System {
    fn read(&self) -> Option<String> {
        READ.iter().find_map(pipe_out)
    }

    fn clear(&self) -> Result<(), String> {
        if CLEAR.iter().any(|tool| pipe_in(tool, b"")) {
            return Ok(());
        }
        Err(no_clipboard())
    }
}

fn no_clipboard() -> String {
    if cfg!(all(unix, not(target_os = "macos"))) {
        "Không dùng được clipboard. Cài wl-clipboard (Wayland) hoặc xclip (X11) rồi thử lại.".into()
    } else {
        "Không dùng được clipboard của máy.".into()
    }
}

fn same(a: &str, b: &str) -> bool {
    let trim = |s: &str| s.replace("\r\n", "\n").trim_end_matches('\n').to_string();
    trim(a) == trim(b)
}

/// Xoá clipboard nếu nó vẫn là giá trị vừa chép; người dùng đã chép thứ khác thì không đụng tới. Trả true khi đã xoá.
pub(crate) fn clear_if_unchanged(clip: &dyn Clipboard, copied: &str) -> bool {
    let unchanged = clip.read().is_some_and(|now| same(&now, copied));
    unchanged && clip.clear().is_ok()
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use super::*;

    struct Fake {
        content: RefCell<Option<String>>,
        cleared: Cell<u32>,
    }

    impl Fake {
        fn holding(text: Option<&str>) -> Self {
            Fake {
                content: RefCell::new(text.map(String::from)),
                cleared: Cell::new(0),
            }
        }
    }

    impl Clipboard for Fake {
        fn read(&self) -> Option<String> {
            self.content.borrow().clone()
        }

        fn clear(&self) -> Result<(), String> {
            self.cleared.set(self.cleared.get() + 1);
            *self.content.borrow_mut() = Some(String::new());
            Ok(())
        }
    }

    #[test]
    fn clears_only_what_it_copied() {
        let kept = Fake::holding(Some("giá trị giả 12345678"));
        assert!(clear_if_unchanged(&kept, "giá trị giả 12345678"));
        assert_eq!(kept.cleared.get(), 1);
        assert_eq!(kept.read().as_deref(), Some(""));

        let replaced = Fake::holding(Some("người dùng chép thứ khác"));
        assert!(!clear_if_unchanged(&replaced, "giá trị giả 12345678"));
        assert_eq!(replaced.cleared.get(), 0);

        let unreadable = Fake::holding(None);
        assert!(!clear_if_unchanged(&unreadable, "giá trị giả 12345678"));
        assert_eq!(unreadable.cleared.get(), 0);
    }

    #[test]
    fn line_endings_do_not_hide_the_copy() {
        let clip = Fake::holding(Some("dòng một\r\ndòng hai\r\n"));
        assert!(clear_if_unchanged(&clip, "dòng một\ndòng hai"));
    }

    #[test]
    fn near_misses_are_left_alone() {
        let clip = Fake::holding(Some("giá trị giả 1234567"));
        assert!(!clear_if_unchanged(&clip, "giá trị giả 12345678"));
        assert_eq!(clip.cleared.get(), 0);
    }
}
