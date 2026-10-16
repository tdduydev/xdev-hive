//! App là tiến trình GUI không có console: Windows cấp cho mỗi lệnh console con (git, claude, powershell, taskkill…)
//! một cửa sổ đen mới nếu không đặt CREATE_NO_WINDOW. Lệnh cố ý mở cửa sổ cho người dùng (`cmd /C start`) vẫn đặt cờ
//! cho cmd đứng giữa; PTY đi qua ConPTY nên không cần.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}
