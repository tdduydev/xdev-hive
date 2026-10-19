//! Thông báo hệ thống có đích bấm vào. Màn việc của đội (duyệt, câu hỏi, Leader) chỉ còn trên web, nên thông báo về
//! chúng mở đúng trang web của hub; run trên máy thì mở màn trong app. Giao diện dò hộp thư của hub và run của máy rồi
//! gọi `show_notification`; Rust giữ đích theo id thông báo vì plugin chỉ trả lại id khi người dùng bấm.
//! Windows chỉ báo lượt bấm khi thông báo còn trên màn hình, không báo khi bấm trong Action Center.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI32, Ordering};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::{Action, ActionType, NotificationExt};

/// Loại thông báo có nút mở trang web của hub.
const WEB_TYPE: &str = "hive-web";
/// Loại thông báo có nút mở một màn của app.
const APP_TYPE: &str = "hive-app";
const OPEN: &str = "open";
/// Plugin báo bấm vào thân thông báo bằng id này.
const TAP: &str = "tap";
/// Sự kiện báo cửa sổ app chuyển màn (`#/<màn>`).
pub const NAVIGATE_EVENT: &str = "app-navigate";
/// Chỉ giữ đích của chừng này thông báo gần nhất: thông báo cũ đã rời màn hình thì Windows không báo bấm nữa.
const KEEP: usize = 50;

#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    /// Đường dẫn trên hub, đã qua `safe_hub_path`.
    Web(String),
    /// Mã màn của app (`runs`, `home`…).
    Screen(String),
}

#[derive(Default)]
pub struct Notices {
    next: AtomicI32,
    targets: Mutex<BTreeMap<i32, Target>>,
}

impl Notices {
    fn remember(&self, target: Target) -> i32 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        if let Ok(mut map) = self.targets.lock() {
            map.insert(id, target);
            while map.len() > KEEP {
                map.pop_first();
            }
        }
        id
    }

    fn take(&self, id: i32) -> Option<Target> {
        self.targets.lock().ok()?.remove(&id)
    }
}

/// Mã màn của app chỉ gồm chữ thường và gạch nối, để sự kiện chuyển màn không mang gì khác vào `location.hash`.
fn safe_screen(screen: &str) -> bool {
    !screen.is_empty()
        && screen.len() <= 32
        && screen.chars().all(|c| c.is_ascii_lowercase() || c == '-')
}

fn target_of(web: Option<String>, screen: Option<String>) -> Result<Target, String> {
    match (web, screen) {
        (Some(path), None) if crate::safe_hub_path(&path) => Ok(Target::Web(path)),
        (None, Some(screen)) if safe_screen(&screen) => Ok(Target::Screen(screen)),
        _ => Err("Đích của thông báo không hợp lệ.".into()),
    }
}

/// Chữ trên nút theo ngôn ngữ của app; gọi lại khi đổi ngôn ngữ để nút đổi theo.
pub fn register_actions(app: &AppHandle, en: bool) {
    let (web, open) = if en {
        ("Open on the web", "Open")
    } else {
        ("Mở trên web", "Mở")
    };
    let types = vec![
        ActionType::builder(WEB_TYPE)
            .actions(vec![Action::builder(OPEN, web).build()])
            .build(),
        ActionType::builder(APP_TYPE)
            .actions(vec![Action::builder(OPEN, open).build()])
            .build(),
    ];
    if let Err(e) = app.notification().register_action_types(types) {
        eprintln!("Không đăng ký được nút của thông báo: {e}");
    }
}

/// Nghe lượt bấm một lần lúc khởi động. Thông báo không có đích (worker, cập nhật) thì bấm vào là mở app.
pub fn listen(app: &AppHandle) {
    let handle = app.clone();
    let heard = app.notification().on_action(move |performed| {
        if performed.action_id() != TAP && performed.action_id() != OPEN {
            return;
        }
        let target = performed
            .notification()
            .and_then(|n| handle.state::<Notices>().take(n.id()));
        match target {
            Some(Target::Web(path)) => {
                if let Err(e) = crate::open_hub_page(handle.clone(), path) {
                    eprintln!("{e}");
                }
            }
            Some(Target::Screen(screen)) => {
                crate::show_app(&handle);
                let _ = handle.emit(NAVIGATE_EVENT, screen);
            }
            None => crate::show_app(&handle),
        }
    });
    if let Err(e) = heard {
        eprintln!("Không nghe được lượt bấm thông báo: {e}");
    }
}

/// Hiện thông báo có đích: `web` là đường dẫn trên hub, `screen` là màn của app; đúng một trong hai.
#[tauri::command]
pub fn show_notification(
    app: AppHandle,
    title: String,
    body: String,
    web: Option<String>,
    screen: Option<String>,
) -> Result<(), String> {
    let target = target_of(web, screen)?;
    let kind = match target {
        Target::Web(_) => WEB_TYPE,
        Target::Screen(_) => APP_TYPE,
    };
    let id = app.state::<Notices>().remember(target);
    let clip = |s: &str, n: usize| s.chars().take(n).collect::<String>();
    app.notification()
        .builder()
        .id(id)
        .title(clip(&title, 120))
        .body(clip(&body, 300))
        .action_type_id(kind)
        .show()
        .map_err(|e| format!("Không hiện được thông báo: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_hub_paths_and_app_screens() {
        assert_eq!(
            target_of(Some("/knowledge/reviews?id=ab".into()), None),
            Ok(Target::Web("/knowledge/reviews?id=ab".into()))
        );
        assert_eq!(
            target_of(None, Some("runs".into())),
            Ok(Target::Screen("runs".into()))
        );
        assert!(target_of(Some("https://evil.example".into()), None).is_err());
        assert!(target_of(Some("//evil.example/x".into()), None).is_err());
        assert!(target_of(None, Some("runs/../x".into())).is_err());
        assert!(target_of(None, Some("Runs".into())).is_err());
        assert!(target_of(None, None).is_err());
        assert!(target_of(Some("/runs".into()), Some("runs".into())).is_err());
    }

    #[test]
    fn keeps_recent_targets_once() {
        let n = Notices::default();
        let first = n.remember(Target::Screen("runs".into()));
        let ids: Vec<i32> = (0..KEEP)
            .map(|_| n.remember(Target::Web("/runs".into())))
            .collect();
        assert_eq!(n.take(first), None, "đích cũ nhất đã bỏ");
        let last = *ids.last().unwrap();
        assert_eq!(n.take(last), Some(Target::Web("/runs".into())));
        assert_eq!(n.take(last), None, "bấm hai lần chỉ mở một lần");
    }
}
