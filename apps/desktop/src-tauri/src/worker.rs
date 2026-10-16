//! Máy trạng thái của worker chạy làm sidecar. Không đụng Tauri hay tiến trình: nhận sự kiện (dòng trạng thái JSON của
//! `hive-worker run --status-json`, tiến trình thoát, nhịp đồng hồ) và trả việc cần làm, để test được không cần app.

use serde::Deserialize;

/// Mất kết nối quá chừng này giây thì báo người dùng.
pub const NOTIFY_AFTER_SECS: u64 = 60;
/// Mã thoát của `hive-worker run` khi hub từ chối máy (token thu hồi, máy bị xoá): chạy lại cũng vô ích.
pub const EXIT_REJECTED: i32 = 3;
/// Worker khác đang giữ khoá của người dùng; tự chạy lại sẽ chỉ gây vòng lặp báo lỗi.
pub const EXIT_ALREADY_RUNNING: i32 = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Stopped,
    Starting,
    /// Đang nối lần đầu; `since` để báo khi mãi không nối được.
    Connecting {
        since: u64,
    },
    Online,
    /// Đã mất kết nối, worker đang tự nối lại; `since` là lúc mất, không đổi qua các lần thử.
    Disconnected {
        since: u64,
        error: String,
    },
    Stopping,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// Người dùng bật worker (hoặc app khởi động với máy đã đăng ký).
    Start,
    /// Người dùng tắt worker hoặc thoát app.
    Stop,
    /// Một dòng stdout của sidecar.
    Line(String),
    /// Tiến trình sidecar thoát với mã này (None khi bị giết bằng tín hiệu).
    Exited(Option<i32>),
    /// Hết thời gian chờ sau lần thoát bất thường.
    Retry,
    Tick,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Spawn,
    /// Dừng êm: gửi "stop" qua stdin, quá hạn thì giết.
    Stop,
    Notify(String),
    /// Báo mất kết nối quá 1 phút; tách riêng vì người dùng tắt được loại báo này ở màn Cài đặt.
    NotifyOffline(String),
    /// Gửi Event::Retry sau chừng này giây.
    RetryIn(u64),
    /// Mở cửa sổ đăng ký: token của máy không còn dùng được.
    AskRegister,
}

#[derive(Deserialize)]
struct Line {
    status: String,
    #[serde(default)]
    error: String,
}

#[derive(Debug)]
pub struct Worker {
    status: Status,
    wanted: bool,
    notified: bool,
    failures: u32,
}

impl Default for Worker {
    fn default() -> Self {
        Self {
            status: Status::Stopped,
            wanted: false,
            notified: false,
            failures: 0,
        }
    }
}

impl Worker {
    #[cfg(test)]
    pub fn status(&self) -> &Status {
        &self.status
    }

    pub fn wanted(&self) -> bool {
        self.wanted
    }

    /// Mã trạng thái cho giao diện và màu chấm trên biểu tượng khay.
    pub fn kind(&self) -> &'static str {
        match &self.status {
            Status::Stopped => "stopped",
            Status::Starting => "starting",
            Status::Connecting { .. } => "connecting",
            Status::Online => "online",
            Status::Disconnected { .. } => "disconnected",
            Status::Stopping => "stopping",
            Status::Failed(_) => "failed",
        }
    }

    /// Nhãn trạng thái theo ngôn ngữ của app (AppTray.dc.html); `label()` là bản tiếng Việt.
    pub fn label_in(&self, lang: &str) -> String {
        if lang != "en" {
            return self.label();
        }
        match &self.status {
            Status::Stopped => "Worker: off",
            Status::Starting => "Worker: starting",
            Status::Connecting { .. } => "Worker: connecting",
            Status::Online => "Worker: taking tasks",
            Status::Disconnected { .. } => "Worker: disconnected, retrying",
            Status::Stopping => "Worker: stopping",
            Status::Failed(_) => "Worker: error",
        }
        .into()
    }

    /// Nhãn trạng thái trên khay hệ thống.
    pub fn label(&self) -> String {
        match &self.status {
            Status::Stopped => "Worker: đã tắt".into(),
            Status::Starting => "Worker: đang khởi động".into(),
            Status::Connecting { .. } => "Worker: đang kết nối".into(),
            Status::Online => "Worker: đang nhận việc".into(),
            Status::Disconnected { .. } => "Worker: mất kết nối, đang thử lại".into(),
            Status::Stopping => "Worker: đang dừng".into(),
            Status::Failed(_) => "Worker: lỗi".into(),
        }
    }

    /// Lúc bắt đầu mất kết nối (hoặc bắt đầu nối mà chưa được), giây Unix; None khi không đang chờ nối. Màn Máy này
    /// dùng để chỉ báo khi đã mất quá 1 phút, cùng ngưỡng với thông báo.
    pub fn offline_since(&self) -> Option<u64> {
        match self.status {
            Status::Connecting { since } | Status::Disconnected { since, .. } => Some(since),
            _ => None,
        }
    }

    /// Chi tiết lỗi cho tooltip, nếu có.
    pub fn detail(&self) -> Option<&str> {
        match &self.status {
            Status::Disconnected { error, .. } if !error.is_empty() => Some(error),
            Status::Failed(msg) => Some(msg),
            _ => None,
        }
    }

    pub fn handle(&mut self, event: Event, now: u64) -> Vec<Action> {
        match event {
            Event::Start => {
                self.wanted = true;
                self.failures = 0;
                if matches!(self.status, Status::Stopped | Status::Failed(_)) {
                    self.status = Status::Starting;
                    return vec![Action::Spawn];
                }
                vec![]
            }
            Event::Stop => {
                self.wanted = false;
                match self.status {
                    Status::Starting
                    | Status::Connecting { .. }
                    | Status::Online
                    | Status::Disconnected { .. } => {
                        self.status = Status::Stopping;
                        vec![Action::Stop]
                    }
                    Status::Failed(_) => {
                        self.status = Status::Stopped;
                        vec![]
                    }
                    Status::Stopped | Status::Stopping => vec![],
                }
            }
            Event::Retry => {
                if self.wanted && matches!(self.status, Status::Failed(_)) {
                    self.status = Status::Starting;
                    return vec![Action::Spawn];
                }
                vec![]
            }
            Event::Line(line) => {
                self.on_line(&line, now);
                vec![]
            }
            Event::Exited(code) => self.on_exit(code),
            Event::Tick => self.on_tick(now),
        }
    }

    fn on_line(&mut self, raw: &str, now: u64) {
        // Dòng không phải JSON trạng thái (sidecar cũ, log lạc vào stdout) thì bỏ qua.
        let Ok(line) = serde_json::from_str::<Line>(raw.trim()) else {
            return;
        };
        if matches!(self.status, Status::Stopping | Status::Stopped) {
            return;
        }
        match line.status.as_str() {
            "connecting" => {
                // Worker báo "connecting" trước mỗi lần thử: giữ mốc mất kết nối để đếm đủ 1 phút qua nhiều lần thử.
                if !matches!(
                    self.status,
                    Status::Connecting { .. } | Status::Disconnected { .. }
                ) {
                    self.status = Status::Connecting { since: now };
                }
            }
            "online" => {
                self.status = Status::Online;
                self.notified = false;
                self.failures = 0;
            }
            "disconnected" => {
                let since = match self.status {
                    Status::Connecting { since } | Status::Disconnected { since, .. } => since,
                    _ => now,
                };
                self.status = Status::Disconnected {
                    since,
                    error: line.error,
                };
            }
            _ => {}
        }
    }

    fn on_exit(&mut self, code: Option<i32>) -> Vec<Action> {
        if !self.wanted {
            self.status = Status::Stopped;
            return vec![];
        }
        if code == Some(EXIT_ALREADY_RUNNING) {
            self.wanted = false;
            let msg = "Đã có worker đang chạy. Hãy tắt worker ở bản app hoặc dịch vụ khác trước khi bật tại đây.".to_string();
            self.status = Status::Failed(msg.clone());
            return vec![Action::Notify(msg)];
        }
        if code == Some(EXIT_REJECTED) {
            self.wanted = false;
            let msg = "Hub từ chối máy này (token đã bị thu hồi hoặc máy đã bị xoá). Hãy đăng ký lại máy.".to_string();
            self.status = Status::Failed(msg.clone());
            return vec![Action::Notify(msg), Action::AskRegister];
        }
        // Thoát bất thường (crash, hub yêu cầu drain): chạy lại, chờ lâu dần để không quay vòng khi lỗi lặp lại.
        self.failures += 1;
        let wait = (5u64 << (self.failures - 1).min(6)).min(300);
        let code = code.map_or_else(|| "bị dừng".to_string(), |c| format!("mã {c}"));
        self.status = Status::Failed(format!("Worker thoát ({code}), chạy lại sau {wait} giây."));
        vec![Action::RetryIn(wait)]
    }

    fn on_tick(&mut self, now: u64) -> Vec<Action> {
        let since = match self.status {
            Status::Connecting { since } | Status::Disconnected { since, .. } => since,
            _ => return vec![],
        };
        if self.notified || now.saturating_sub(since) < NOTIFY_AFTER_SECS {
            return vec![];
        }
        self.notified = true;
        vec![Action::NotifyOffline(
            "Worker mất kết nối với hub hơn 1 phút. Máy này tạm không nhận việc.".into(),
        )]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(s: &str) -> Event {
        Event::Line(s.into())
    }

    #[test]
    fn connects_online_then_stops() {
        let mut w = Worker::default();
        assert_eq!(w.handle(Event::Start, 0), vec![Action::Spawn]);
        assert_eq!(w.status(), &Status::Starting);
        // Bật lần nữa khi đang chạy không sinh thêm tiến trình.
        assert_eq!(w.handle(Event::Start, 0), vec![]);
        w.handle(line(r#"{"status":"connecting"}"#), 1);
        assert_eq!(w.status(), &Status::Connecting { since: 1 });
        w.handle(line(r#"{"status":"online"}"#), 2);
        assert_eq!(w.status(), &Status::Online);
        assert_eq!(w.label(), "Worker: đang nhận việc");
        assert_eq!(w.kind(), "online");
        assert_eq!(w.label_in("en"), "Worker: taking tasks");
        assert_eq!(w.label_in("vi"), "Worker: đang nhận việc");
        assert_eq!(w.handle(Event::Stop, 3), vec![Action::Stop]);
        assert_eq!(w.status(), &Status::Stopping);
        // Dòng đến muộn lúc đang dừng không đổi trạng thái.
        w.handle(line(r#"{"status":"online"}"#), 3);
        assert_eq!(w.handle(Event::Exited(Some(0)), 4), vec![]);
        assert_eq!(w.status(), &Status::Stopped);
    }

    #[test]
    fn reports_once_when_disconnected_over_a_minute() {
        let mut w = Worker::default();
        w.handle(Event::Start, 0);
        w.handle(line(r#"{"status":"online"}"#), 0);
        w.handle(line(r#"{"status":"disconnected","error":"EOF"}"#), 100);
        // Các lần thử lại không đặt lại mốc mất kết nối.
        w.handle(line(r#"{"status":"connecting"}"#), 130);
        w.handle(
            line(r#"{"status":"disconnected","error":"connection refused"}"#),
            140,
        );
        assert_eq!(
            w.status(),
            &Status::Disconnected {
                since: 100,
                error: "connection refused".into()
            }
        );
        assert_eq!(w.detail(), Some("connection refused"));
        assert_eq!(w.handle(Event::Tick, 159), vec![]);
        assert!(matches!(
            w.handle(Event::Tick, 160).as_slice(),
            [Action::NotifyOffline(_)]
        ));
        assert_eq!(w.handle(Event::Tick, 200), vec![], "chỉ báo một lần");
        // Nối lại rồi mất lần nữa thì được báo lại.
        w.handle(line(r#"{"status":"online"}"#), 210);
        assert_eq!(w.offline_since(), None);
        w.handle(line(r#"{"status":"disconnected"}"#), 220);
        assert_eq!(w.offline_since(), Some(220));
        assert!(matches!(
            w.handle(Event::Tick, 281).as_slice(),
            [Action::NotifyOffline(_)]
        ));
    }

    #[test]
    fn reports_when_never_connected() {
        let mut w = Worker::default();
        w.handle(Event::Start, 0);
        w.handle(line(r#"{"status":"connecting"}"#), 10);
        w.handle(line(r#"{"status":"disconnected","error":"dial"}"#), 11);
        assert_eq!(
            w.status(),
            &Status::Disconnected {
                since: 10,
                error: "dial".into()
            }
        );
        assert!(matches!(
            w.handle(Event::Tick, 70).as_slice(),
            [Action::NotifyOffline(_)]
        ));
    }

    #[test]
    fn no_restart_when_hub_rejects_machine() {
        let mut w = Worker::default();
        w.handle(Event::Start, 0);
        let actions = w.handle(Event::Exited(Some(EXIT_REJECTED)), 1);
        assert!(
            matches!(actions.as_slice(), [Action::Notify(m), Action::AskRegister] if m.contains("đăng ký lại"))
        );
        assert!(!w.wanted());
        assert_eq!(w.handle(Event::Retry, 2), vec![]);
        assert_eq!(w.label(), "Worker: lỗi");
    }

    #[test]
    fn restarts_with_growing_delay_on_abnormal_exit() {
        let mut w = Worker::default();
        w.handle(Event::Start, 0);
        let mut waits = vec![];
        for _ in 0..8 {
            match w.handle(Event::Exited(Some(1)), 0).as_slice() {
                [Action::RetryIn(s)] => waits.push(*s),
                other => panic!("cần RetryIn, có {other:?}"),
            }
            assert_eq!(w.handle(Event::Retry, 0), vec![Action::Spawn]);
        }
        assert_eq!(waits, vec![5, 10, 20, 40, 80, 160, 300, 300]);
        // Nối được thì đếm lại từ đầu.
        w.handle(line(r#"{"status":"online"}"#), 0);
        assert_eq!(w.handle(Event::Exited(None), 0), vec![Action::RetryIn(5)]);
        // Người dùng tắt trong lúc chờ chạy lại: không chạy lại nữa.
        assert_eq!(w.handle(Event::Stop, 0), vec![]);
        assert_eq!(w.status(), &Status::Stopped);
        assert_eq!(w.handle(Event::Retry, 0), vec![]);
    }

    #[test]
    fn ignores_non_status_lines() {
        let mut w = Worker::default();
        w.handle(Event::Start, 0);
        w.handle(line("time=... level=INFO msg=hello"), 1);
        w.handle(line(r#"{"status":"la"}"#), 1);
        assert_eq!(w.status(), &Status::Starting);
    }
}
