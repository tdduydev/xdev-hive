//! Cài đặt của app trên máy (màn Cài đặt). Rust đọc chúng lúc khởi động, trước khi có cửa sổ nào (bật worker) và khi
//! không có cửa sổ (đóng cửa sổ, báo mất kết nối), nên lưu ở file của app chứ không ở localStorage của giao diện.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE: &str = "settings.json";

/// Mặc định giữ đúng cách app chạy trước khi có màn Cài đặt: mọi mục đều bật. Thiếu khoá (file của bản cũ) thì lấy
/// mặc định của khoá đó, không bỏ cả file.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Máy đã đăng ký thì bật worker ngay khi app mở.
    pub start_worker: bool,
    /// Đóng cửa sổ app chỉ ẩn xuống khay; tắt thì đóng cửa sổ là thoát app (worker dừng êm trước).
    pub hide_on_close: bool,
    /// Run trên máy xong hoặc lỗi.
    pub notify_runs: bool,
    /// Kế hoạch, PR hoặc tài liệu chờ người dùng duyệt.
    pub notify_approvals: bool,
    /// Agent hoặc Leader hỏi người dùng.
    pub notify_questions: bool,
    /// Worker mất kết nối với hub quá 1 phút.
    pub notify_offline: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            start_worker: true,
            hide_on_close: true,
            notify_runs: true,
            notify_approvals: true,
            notify_questions: true,
            notify_offline: true,
        }
    }
}

impl Settings {
    /// Đổi một mục theo khoá camelCase của giao diện; khoá lạ thì báo lỗi thay vì lặng lẽ bỏ qua.
    pub fn set(&mut self, key: &str, value: bool) -> Result<(), String> {
        let slot = match key {
            "startWorker" => &mut self.start_worker,
            "hideOnClose" => &mut self.hide_on_close,
            "notifyRuns" => &mut self.notify_runs,
            "notifyApprovals" => &mut self.notify_approvals,
            "notifyQuestions" => &mut self.notify_questions,
            "notifyOffline" => &mut self.notify_offline,
            _ => return Err(format!("Không có cài đặt {key}.")),
        };
        *slot = value;
        Ok(())
    }
}

/// Bản đã đọc, để mỗi lần đóng cửa sổ hay báo mất kết nối không phải đọc lại file.
#[derive(Default)]
pub struct Store(Mutex<Option<Settings>>);

fn path_of(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Không tìm thấy thư mục cấu hình của app: {e}"))?;
    Ok(dir.join(FILE))
}

/// File hỏng hay chưa có thì dùng mặc định: app vẫn chạy như trước khi có màn Cài đặt.
pub fn read_at(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Ghi file tạm rồi đổi tên, để app tắt giữa chừng không để lại file cụt.
pub fn write_at(path: &Path, settings: &Settings) -> Result<(), String> {
    let dir = path.parent().ok_or("Đường dẫn cài đặt không hợp lệ.")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Không tạo được {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".{FILE}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| format!("Không ghi được {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Không ghi được {}: {e}", path.display()))
}

pub fn get(app: &AppHandle) -> Settings {
    let store = app.state::<Store>();
    let Ok(mut slot) = store.0.lock() else {
        return Settings::default();
    };
    slot.get_or_insert_with(|| path_of(app).map(|p| read_at(&p)).unwrap_or_default())
        .clone()
}

#[tauri::command]
pub fn app_settings(app: AppHandle) -> Settings {
    get(&app)
}

#[tauri::command]
pub fn set_app_setting(app: AppHandle, key: String, value: bool) -> Result<Settings, String> {
    let mut next = get(&app);
    next.set(&key, value)?;
    write_at(&path_of(&app)?, &next)?;
    if let Ok(mut slot) = app.state::<Store>().0.lock() {
        *slot = Some(next.clone());
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_broken_file_keeps_old_behaviour() {
        let dir = std::env::temp_dir().join(format!("hive-settings-{}", std::process::id()));
        let path = dir.join(FILE);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(read_at(&path), Settings::default());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "{ không phải json").unwrap();
        assert_eq!(read_at(&path), Settings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn old_file_without_a_key_takes_its_default() {
        let s: Settings = serde_json::from_str(r#"{"startWorker":false}"#).unwrap();
        assert!(!s.start_worker);
        assert!(s.hide_on_close && s.notify_runs && s.notify_offline);
    }

    #[test]
    fn writes_then_reads_back() {
        let dir = std::env::temp_dir().join(format!("hive-settings-rw-{}", std::process::id()));
        let path = dir.join(FILE);
        let mut s = Settings::default();
        s.set("hideOnClose", false).unwrap();
        s.set("notifyQuestions", false).unwrap();
        write_at(&path, &s).unwrap();
        assert_eq!(read_at(&path), s);
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            raw.contains("\"hideOnClose\": false"),
            "khoá camelCase như giao diện: {raw}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_key_is_an_error() {
        let mut s = Settings::default();
        assert!(s.set("autostart", true).is_err());
        assert_eq!(s, Settings::default());
    }
}
