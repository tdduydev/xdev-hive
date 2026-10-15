//! Lần chuyển Claude Desktop đang chạy: bước hiện tại để cửa sổ hiện tiến độ, cờ Huỷ, lỗi gần nhất cho chẩn đoán, và
//! chạy lệnh có thời hạn. Bản 0.2.16 giữ khoá chuyển bằng một `Mutex` quanh cả lần chuyển: một lệnh treo trên Windows
//! (PowerShell/WMI không trả lời, sao lưu hồ sơ vài GB) giữ khoá tới khi thoát app và mọi lần bấm sau đều bị từ chối.
//! Giờ mọi bước có thời hạn, khoá nhả cả khi lỗi hay panic, và người dùng huỷ được.

use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError, mpsc};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Step {
    Preparing,
    /// Chờ Claude Desktop thoát êm.
    Quitting,
    /// Người dùng đã đồng ý buộc thoát.
    ForceQuitting,
    /// Sao lưu hồ sơ lần đầu (có phần trăm).
    BackingUp,
    Swapping,
    Launching,
}

impl Step {
    fn text(self) -> &'static str {
        match self {
            Step::Preparing => "đang chuẩn bị",
            Step::Quitting => "đang chờ Claude Desktop thoát",
            Step::ForceQuitting => "đang buộc Claude Desktop thoát",
            Step::BackingUp => "đang sao lưu hồ sơ",
            Step::Swapping => "đang đổi đăng nhập",
            Step::Launching => "đang mở lại Claude Desktop",
        }
    }
}

/// Tiến độ của lần chuyển đang chạy, cho cửa sổ.
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    step: Step,
    /// Gói đang chuyển sang; None khi khôi phục bản ban đầu.
    target: Option<String>,
    /// Phần trăm của bước sao lưu.
    percent: Option<u8>,
    /// Giây từ lúc bắt đầu.
    elapsed: u64,
    /// Đã bấm Huỷ, đang dừng.
    cancelling: bool,
    /// Lúc mở lại app thì đã đổi xong, không còn gì để huỷ.
    cancellable: bool,
}

struct Job {
    target: Option<String>,
    step: Step,
    percent: Option<u8>,
    started: Instant,
}

static JOB: Mutex<Option<Job>> = Mutex::new(None);
static CANCEL: AtomicBool = AtomicBool::new(false);
static LAST_ERROR: Mutex<Option<(SystemTime, String)>> = Mutex::new(None);

pub(super) const CANCELLED: &str = "Đã huỷ chuyển Claude Desktop; đăng nhập giữ như trước.";

/// Khoá bị đầu độc (một lần chuyển panic giữa chừng) vẫn dùng tiếp: nội dung chỉ là trạng thái hiển thị.
pub(super) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Lần chuyển đang chạy; bỏ đi (kể cả khi lỗi hay panic) là nhả cho lần sau.
pub(super) struct Busy(());

impl Drop for Busy {
    fn drop(&mut self) {
        *lock(&JOB) = None;
        CANCEL.store(false, Ordering::SeqCst);
    }
}

pub(super) fn begin(target: Option<&str>) -> Result<Busy, String> {
    let mut job = lock(&JOB);
    if let Some(j) = job.as_ref() {
        return Err(format!(
            "Đang chuyển Claude Desktop ({}, {} giây); chờ xong hay bấm Huỷ.",
            j.step.text(),
            j.started.elapsed().as_secs()
        ));
    }
    CANCEL.store(false, Ordering::SeqCst);
    *job = Some(Job {
        target: target.map(str::to_string),
        step: Step::Preparing,
        percent: None,
        started: Instant::now(),
    });
    Ok(Busy(()))
}

pub(crate) fn progress() -> Option<Progress> {
    lock(&JOB).as_ref().map(|j| Progress {
        step: j.step,
        target: j.target.clone(),
        percent: j.percent,
        elapsed: j.started.elapsed().as_secs(),
        cancelling: CANCEL.load(Ordering::SeqCst),
        cancellable: j.step != Step::Launching,
    })
}

/// Bấm Huỷ: false khi không có lần chuyển nào hay đã tới bước mở lại app.
pub(crate) fn cancel() -> bool {
    match lock(&JOB).as_ref() {
        Some(j) if j.step != Step::Launching => {
            CANCEL.store(true, Ordering::SeqCst);
            true
        }
        _ => false,
    }
}

pub(super) fn record_error(e: &str) {
    *lock(&LAST_ERROR) = Some((SystemTime::now(), e.to_string()));
}

pub(super) fn last_error() -> Option<(SystemTime, String)> {
    lock(&LAST_ERROR).clone()
}

fn report_job(step: Step, percent: Option<u8>) {
    if let Some(j) = lock(&JOB).as_mut() {
        j.step = step;
        j.percent = percent;
    }
}

#[cfg(test)]
fn report_none(_: Step, _: Option<u8>) {}

#[cfg(test)]
static NEVER: AtomicBool = AtomicBool::new(false);

/// Giới hạn của bản sao lưu lần đầu. File lớn hơn `file_max` trong hồ sơ Chromium là cache hay ảnh máy ảo app tự tải
/// lại; quá `total_max` thì chỉ sao lưu phần đăng nhập và cấu hình, để hồ sơ vài chục GB không chặn việc chuyển.
#[derive(Clone, Copy, Debug)]
pub(super) struct Limits {
    pub(super) file_max: u64,
    pub(super) total_max: u64,
    pub(super) backup_wait: Duration,
}

pub(super) const LIMITS: Limits = Limits {
    file_max: 256 << 20,
    total_max: 4 << 30,
    backup_wait: Duration::from_secs(600),
};

/// Báo tiến độ và hỏi cờ Huỷ. Truyền vào từng bước thay vì đọc biến toàn cục để test chạy song song không giẫm nhau.
pub(super) struct Ctl<'a> {
    cancel: &'a AtomicBool,
    report: &'a dyn Fn(Step, Option<u8>),
    pub(super) limits: Limits,
}

impl<'a> Ctl<'a> {
    pub(super) fn new(cancel: &'a AtomicBool, report: &'a dyn Fn(Step, Option<u8>)) -> Self {
        Self {
            cancel,
            report,
            limits: LIMITS,
        }
    }

    pub(super) fn step(&self, step: Step) {
        (self.report)(step, None);
    }

    pub(super) fn percent(&self, step: Step, percent: u8) {
        (self.report)(step, Some(percent));
    }

    pub(super) fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    pub(super) fn check(&self) -> Result<(), String> {
        if self.cancelled() {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }

    /// Ngủ từng quãng ngắn để nút Huỷ có tác dụng ngay.
    pub(super) fn sleep(&self, d: Duration) -> Result<(), String> {
        let until = Instant::now() + d;
        while Instant::now() < until {
            self.check()?;
            std::thread::sleep(Duration::from_millis(50).min(until - Instant::now()));
        }
        self.check()
    }
}

impl Ctl<'static> {
    /// Ctl của lần chuyển đang chạy (lệnh của cửa sổ, khay).
    pub(super) fn job() -> Self {
        Self::new(&CANCEL, &report_job)
    }

    /// Không báo đi đâu, không huỷ được.
    #[cfg(test)]
    pub(super) fn idle() -> Self {
        Self::new(&NEVER, &report_none)
    }
}

/// Chạy lệnh và lấy stdout, chờ tối đa `within`: quá hạn thì giết lệnh, trả None. Không chờ luồng đọc khi quá hạn vì
/// tiến trình con của lệnh có thể còn giữ pipe.
pub(super) fn output_within(cmd: &mut Command, within: Duration) -> Option<Output> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let until = Instant::now() + within;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let stdout = rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    Some(Output {
        status,
        stdout,
        stderr: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn hung_command_is_killed_at_the_deadline() {
        let started = Instant::now();
        assert!(
            output_within(Command::new("sleep").arg("30"), Duration::from_millis(300)).is_none()
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        let out = output_within(Command::new("echo").arg("hi"), Duration::from_secs(10)).unwrap();
        assert!(out.status.success());
        assert_eq!(out.stdout, b"hi\n");
        assert!(output_within(&mut Command::new("/no/such/bin"), Duration::from_secs(1)).is_none());
    }

    #[test]
    fn sleep_stops_as_soon_as_cancelled() {
        let flag = AtomicBool::new(true);
        let ctl = Ctl::new(&flag, &report_none);
        let started = Instant::now();
        assert_eq!(
            ctl.sleep(Duration::from_secs(30)),
            Err(CANCELLED.to_string())
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(Ctl::idle().sleep(Duration::from_millis(10)), Ok(()));
    }

    /// Lỗi hay panic giữa lần chuyển vẫn nhả cho lần sau (0.2.16: khoá giữ tới khi thoát app). Chạy chung một test vì
    /// dùng trạng thái toàn cục.
    #[test]
    fn busy_is_released_on_error_and_panic_and_cancel_follows_the_step() {
        let busy = begin(Some("claude-2")).unwrap();
        let p = progress().unwrap();
        assert_eq!(p.step, Step::Preparing);
        assert_eq!(p.target.as_deref(), Some("claude-2"));
        let again = begin(Some("claude-3")).err().unwrap();
        assert!(
            again.contains("Đang chuyển Claude Desktop (đang chuẩn bị"),
            "{again}"
        );
        Ctl::job().percent(Step::BackingUp, 40);
        assert_eq!(progress().unwrap().percent, Some(40));
        assert!(cancel());
        assert!(Ctl::job().cancelled());
        assert!(progress().unwrap().cancelling);
        drop(busy);
        assert_eq!(progress(), None);
        assert!(!cancel(), "không có lần chuyển nào để huỷ");

        let caught = std::thread::spawn(|| {
            let _busy = begin(None).unwrap();
            panic!("hỏng giữa chừng");
        })
        .join();
        assert!(caught.is_err());
        let busy = begin(None).expect("panic không được giữ khoá");
        assert!(!Ctl::job().cancelled(), "lần mới không mang cờ Huỷ cũ");
        Ctl::job().step(Step::Launching);
        assert!(!cancel(), "đang mở lại app: đã đổi xong");
        assert!(!progress().unwrap().cancellable);
        drop(busy);
    }
}
