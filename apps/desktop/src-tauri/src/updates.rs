//! Cập nhật app: kiểm bản mới theo thứ tự hub của máy rồi GitHub, tải sẵn vào bộ nhớ, cài khi người dùng chọn "Mở lại
//! để cập nhật" hoặc khi thoát app. Không tự thoát giữa chừng: máy có thể đang có run chạy.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::State;

/// Manifest của bản phát hành mới nhất trên GitHub (release.yml ghép `latest.json`). Fork ghi đè bằng biến môi trường
/// lúc chạy hoặc lúc build, cùng tên.
const GITHUB_ENDPOINT: &str =
    "https://github.com/tdduydev/xdev-hive/releases/latest/download/latest.json";
const ENDPOINT_ENV: &str = "HIVE_UPDATE_ENDPOINT";
/// Kiểm định kỳ; cửa sổ app được focus thì kiểm thêm nhưng cách lần trước ít nhất FOCUS_MIN_GAP.
const CHECK_EVERY: Duration = Duration::from_secs(30 * 60);
const FOCUS_MIN_GAP: Duration = Duration::from_secs(5 * 60);
/// Chỉ hỏi manifest: không có hạn này thì GitHub treo sẽ giữ cờ "đang kiểm" mãi.
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Gói cài dài hơn manifest nhiều: mạng chậm vẫn tải xong.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Bản đã tải xong, chờ cài. Gói nằm trong bộ nhớ: Windows thoát app ngay khi chạy trình cài, nên việc cài phải đợi
/// người dùng chọn mở lại (hoặc thoát app).
pub struct Pending {
    update: Update,
    bytes: Vec<u8>,
}

/// Chống kiểm chồng nhau và kiểm dồn dập mỗi lần cửa sổ được focus.
#[derive(Default)]
pub struct Gate {
    last: Option<Instant>,
    busy: bool,
}

impl Gate {
    fn begin(&mut self, now: Instant) -> bool {
        if self.busy {
            return false;
        }
        self.busy = true;
        self.last = Some(now);
        true
    }

    fn begin_on_focus(&mut self, now: Instant) -> bool {
        let recent = self
            .last
            .is_some_and(|last| now.saturating_duration_since(last) < FOCUS_MIN_GAP);
        !recent && self.begin(now)
    }

    fn finish(&mut self) {
        self.busy = false;
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReadyView {
    version: String,
    notes: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    current: String,
    ready: Option<ReadyView>,
}

fn http(url: &url::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// Địa chỉ hub trả bản cập nhật cho app (route /api/v1/desktop/updates của hub, DESK-10).
fn hub_endpoint(hub: &str, os: &str, arch: &str, version: &str) -> Option<url::Url> {
    url::Url::parse(&format!(
        "{}/api/v1/desktop/updates/{os}/{arch}/{version}",
        hub.trim_end_matches('/')
    ))
    .ok()
    .filter(http)
}

/// Biến lúc chạy thắng biến lúc build, rồi tới hằng số của repo gốc.
fn github_endpoint_from(runtime: Option<&str>, build: Option<&str>) -> String {
    [runtime, build]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|v| !v.is_empty())
        .unwrap_or(GITHUB_ENDPOINT)
        .to_string()
}

fn github_endpoint() -> String {
    github_endpoint_from(
        std::env::var(ENDPOINT_ENV).ok().as_deref(),
        option_env!("HIVE_UPDATE_ENDPOINT"),
    )
}

/// Thứ tự hỏi: hub của máy (nếu đã đăng ký), rồi GitHub. Máy chưa đăng ký chỉ có GitHub.
fn endpoints(
    hub: Option<&str>,
    github: &str,
    os: &str,
    arch: &str,
    version: &str,
) -> Vec<url::Url> {
    let mut out: Vec<url::Url> = hub
        .and_then(|h| hub_endpoint(h, os, arch, version))
        .into_iter()
        .collect();
    if let Some(url) = url::Url::parse(github).ok().filter(http)
        && !out.contains(&url)
    {
        out.push(url);
    }
    out
}

fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim_start_matches('v').split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let triple = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(triple)
}

/// Hub có thể còn giữ manifest cũ vài phút: không để nó đè bản đã tải bằng bản thấp hơn.
fn is_newer(candidate: &str, than: &str) -> bool {
    match (parse_version(candidate), parse_version(than)) {
        (Some(a), Some(b)) => a > b,
        _ => candidate != than,
    }
}

fn has_signing_key(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.is_empty())
}

fn ready_view(app: &AppHandle) -> Option<ReadyView> {
    let state = app.state::<State>();
    let pending = state.pending_update.lock().ok()?;
    pending.as_ref().map(|p| ReadyView {
        version: p.update.version.clone(),
        notes: p.update.body.clone().filter(|n| !n.trim().is_empty()),
    })
}

pub fn ready_version(app: &AppHandle) -> Option<String> {
    ready_view(app).map(|r| r.version)
}

fn view(app: &AppHandle) -> UpdateView {
    UpdateView {
        current: app.package_info().version.to_string(),
        ready: ready_view(app),
    }
}

/// Hỏi lần lượt từng địa chỉ; địa chỉ đầu tiên có bản mới thắng. Không dùng danh sách địa chỉ của updater vì nó dừng
/// ngay khi một địa chỉ đáp "không có bản mới" (hub 204), không bao giờ hỏi tới GitHub.
async fn find(app: &AppHandle, urls: Vec<url::Url>) -> Result<Option<Update>, String> {
    let mut answered = false;
    let mut last_error = None;
    for url in urls {
        let host = url.host_str().unwrap_or_default().to_string();
        let updater = match app
            .updater_builder()
            .timeout(MANIFEST_TIMEOUT)
            .endpoints(vec![url])
            .and_then(|b| b.build())
        {
            Ok(u) => u,
            Err(e) => {
                eprintln!("Không dựng được updater cho {host}: {e}");
                last_error = Some(e.to_string());
                continue;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => return Ok(Some(update)),
            Ok(None) => answered = true,
            Err(e) => {
                eprintln!("Không kiểm được bản cập nhật ở {host}: {e}");
                last_error = Some(e.to_string());
            }
        }
    }
    match (answered, last_error) {
        (false, Some(e)) => Err(format!("Không kiểm được bản mới: {e}")),
        (false, None) => Err("Không có địa chỉ cập nhật nào dùng được.".into()),
        _ => Ok(None),
    }
}

async fn run(app: &AppHandle) -> Result<UpdateView, String> {
    // Chưa có khoá ký trong tauri.conf.json thì bỏ qua: updater chỉ nhận bản ký đúng khoá đó (apps/desktop/README.md).
    if !has_signing_key(app) {
        return Err("Bản dựng này chưa có khoá ký cập nhật.".into());
    }
    let current = app.package_info().version.to_string();
    let hub = crate::hub_of(app);
    let urls = endpoints(
        hub.as_deref(),
        &github_endpoint(),
        std::env::consts::OS,
        std::env::consts::ARCH,
        &current,
    );
    let Some(mut update) = find(app, urls).await? else {
        return Ok(view(app));
    };
    if ready_version(app).is_some_and(|have| !is_newer(&update.version, &have)) {
        return Ok(view(app));
    }
    crate::notify(app, &format!("Có bản mới {}. Đang tải.", update.version));
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Không tải được bản {}: {e}", update.version))?;
    let version = update.version.clone();
    if let Ok(mut slot) = app.state::<State>().pending_update.lock() {
        *slot = Some(Pending { update, bytes });
    }
    crate::notify(
        app,
        &format!("Đã tải bản {version}. Mở lại app để cập nhật."),
    );
    crate::refresh_tray(app);
    if let Some(ready) = ready_view(app) {
        let _ = app.emit("update-ready", ready);
    }
    Ok(view(app))
}

enum Trigger {
    Periodic,
    Focus,
    Manual,
}

/// Chạy một lượt kiểm nếu cổng cho phép; None khi đang có lượt khác hoặc (với focus) mới kiểm cách đây chưa lâu.
async fn guarded(app: &AppHandle, trigger: Trigger) -> Option<Result<UpdateView, String>> {
    let now = Instant::now();
    let allowed = {
        let state = app.state::<State>();
        let mut gate = state.update_gate.lock().ok()?;
        match trigger {
            Trigger::Focus => gate.begin_on_focus(now),
            Trigger::Periodic | Trigger::Manual => gate.begin(now),
        }
    };
    if !allowed {
        return None;
    }
    let result = run(app).await;
    if let Ok(mut gate) = app.state::<State>().update_gate.lock() {
        gate.finish();
    }
    Some(result)
}

/// Kiểm lúc mở app rồi 30 phút một lần, kể cả máy chưa đăng ký (khi đó chỉ hỏi GitHub). Gọi sau khi đã đọc cấu hình
/// worker để biết địa chỉ hub.
pub async fn run_periodic(app: &AppHandle) {
    loop {
        if let Some(Err(e)) = guarded(app, Trigger::Periodic).await {
            eprintln!("{e}");
        }
        tokio::time::sleep(CHECK_EVERY).await;
    }
}

/// Cửa sổ app được focus: kiểm lại nếu lần trước đã lâu, để người mở app sau nhiều giờ thấy bản mới ngay.
pub fn check_on_focus(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(Err(e)) = guarded(&app, Trigger::Focus).await {
            eprintln!("{e}");
        }
    });
}

/// Mục "Kiểm tra bản mới" của khay: kết quả báo bằng thông báo hệ thống vì khay không có chỗ hiện chữ.
pub fn check_from_tray(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match guarded(&app, Trigger::Manual).await {
            Some(Ok(v)) if v.ready.is_none() => {
                crate::notify(&app, &format!("Đang dùng bản mới nhất ({}).", v.current))
            }
            Some(Ok(_)) | None => {}
            Some(Err(e)) => crate::notify(&app, &e),
        }
    });
}

/// Cài bản đã tải. Windows thoát app ngay khi chạy trình cài; macOS và Linux thay file rồi trả về để gọi restart.
pub fn install_pending(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<State>();
    let mut slot = state.pending_update.lock().map_err(|e| e.to_string())?;
    if let Some(p) = slot.as_ref() {
        p.update
            .install(&p.bytes)
            .map_err(|e| format!("Không cài được bản {}: {e}", p.update.version))?;
        slot.take();
    }
    Ok(())
}

/// Phiên bản đang chạy và bản đã tải xong (nếu có) cùng ghi chú của nó.
#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateView {
    view(&app)
}

/// Kiểm ngay (bỏ qua giới hạn tần suất của focus). Lỗi mạng hay thiếu khoá ký trả về chữ tiếng Việt cho UI.
#[tauri::command]
pub async fn check_updates_now(app: AppHandle) -> Result<UpdateView, String> {
    guarded(&app, Trigger::Manual)
        .await
        .unwrap_or_else(|| Err("Đang kiểm bản mới, thử lại sau ít giây.".into()))
}

/// Dừng worker êm như khi thoát app (chờ run đang chạy ghi xong), cài bản đã tải rồi mở lại app.
#[tauri::command]
pub async fn relaunch_to_update(app: AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    if ready_version(&app).is_none() {
        return Err("Chưa có bản nào tải xong.".into());
    }
    if app.state::<State>().quitting.swap(true, Ordering::SeqCst) {
        return Err("App đang thoát.".into());
    }
    crate::stop_worker_and_wait(&app).await;
    if let Err(e) = install_pending(&app) {
        // Worker đã dừng mà app vẫn chạy: bật lại để máy không mất việc.
        app.state::<State>().quitting.store(false, Ordering::SeqCst);
        crate::dispatch(&app, crate::Event::Start);
        return Err(e);
    }
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    const GH: &str = "https://github.com/acme/hive/releases/latest/download/latest.json";

    fn strings(urls: Vec<url::Url>) -> Vec<String> {
        urls.into_iter().map(|u| u.to_string()).collect()
    }

    #[test]
    fn hub_endpoint_matches_hub_route() {
        assert_eq!(
            hub_endpoint("https://hive.acme.vn/", "macos", "aarch64", "0.2.4")
                .map(|u| u.to_string()),
            Some("https://hive.acme.vn/api/v1/desktop/updates/macos/aarch64/0.2.4".into())
        );
        assert_eq!(
            hub_endpoint("http://192.0.2.10:3000", "windows", "x86_64", "0.2.5")
                .map(|u| u.path().to_string()),
            Some("/api/v1/desktop/updates/windows/x86_64/0.2.5".into())
        );
        assert!(hub_endpoint("khong phai url", "macos", "aarch64", "1.0.0").is_none());
        assert!(hub_endpoint("file:///etc", "macos", "aarch64", "1.0.0").is_none());
    }

    #[test]
    fn hub_is_asked_before_github() {
        assert_eq!(
            strings(endpoints(
                Some("https://hive.acme.vn"),
                GH,
                "macos",
                "aarch64",
                "0.2.4"
            )),
            [
                "https://hive.acme.vn/api/v1/desktop/updates/macos/aarch64/0.2.4",
                GH
            ]
        );
    }

    #[test]
    fn unregistered_machine_still_checks_github() {
        assert_eq!(
            strings(endpoints(None, GH, "macos", "aarch64", "0.2.4")),
            [GH]
        );
        // Địa chỉ hub hỏng không làm mất đường GitHub.
        assert_eq!(
            strings(endpoints(
                Some("khong phai url"),
                GH,
                "macos",
                "aarch64",
                "0.2.4"
            )),
            [GH]
        );
    }

    #[test]
    fn github_default_and_overrides() {
        assert_eq!(github_endpoint_from(None, None), GITHUB_ENDPOINT);
        assert!(
            GITHUB_ENDPOINT
                .starts_with("https://github.com/tdduydev/xdev-hive/releases/latest/download/")
        );
        assert_eq!(github_endpoint_from(Some(""), Some(" ")), GITHUB_ENDPOINT);
        assert_eq!(
            github_endpoint_from(None, Some("https://a.example/l.json")),
            "https://a.example/l.json"
        );
        assert_eq!(
            github_endpoint_from(
                Some("https://run.example/l.json"),
                Some("https://a.example/l.json")
            ),
            "https://run.example/l.json"
        );
        // Địa chỉ ghi đè không phải http(s) thì bị bỏ, không rơi về địa chỉ khác.
        assert!(
            strings(endpoints(
                None,
                "file:///etc/passwd",
                "macos",
                "aarch64",
                "1.0.0"
            ))
            .is_empty()
        );
    }

    #[test]
    fn same_hub_and_github_url_is_asked_once() {
        let urls = endpoints(
            Some("https://hive.acme.vn"),
            "https://hive.acme.vn/api/v1/desktop/updates/macos/aarch64/1.0.0",
            "macos",
            "aarch64",
            "1.0.0",
        );
        assert_eq!(urls.len(), 1);
    }

    #[test]
    fn focus_checks_are_rate_limited() {
        let t0 = Instant::now();
        let mut gate = Gate::default();
        assert!(gate.begin_on_focus(t0), "lần đầu được kiểm");
        gate.finish();
        assert!(
            !gate.begin_on_focus(t0 + Duration::from_secs(60)),
            "chưa đủ 5 phút"
        );
        assert!(!gate.begin_on_focus(t0 + FOCUS_MIN_GAP - Duration::from_secs(1)));
        assert!(
            gate.begin_on_focus(t0 + FOCUS_MIN_GAP),
            "đủ 5 phút thì kiểm lại"
        );
    }

    #[test]
    fn manual_and_periodic_ignore_the_focus_gap_but_never_overlap() {
        let t0 = Instant::now();
        let mut gate = Gate::default();
        assert!(gate.begin(t0));
        assert!(!gate.begin(t0), "đang kiểm thì không kiểm chồng");
        assert!(!gate.begin_on_focus(t0 + FOCUS_MIN_GAP * 2));
        gate.finish();
        assert!(
            gate.begin(t0 + Duration::from_secs(1)),
            "kiểm tay không bị giới hạn 5 phút"
        );
        // Kiểm tay cũng tính là lần kiểm gần nhất cho focus.
        gate.finish();
        assert!(!gate.begin_on_focus(t0 + Duration::from_secs(2)));
    }

    #[test]
    fn stale_manifest_never_replaces_a_newer_download() {
        assert!(is_newer("0.3.0", "0.2.9"));
        assert!(is_newer("0.10.0", "0.9.0"));
        assert!(!is_newer("0.2.9", "0.3.0"));
        assert!(!is_newer("0.3.0", "0.3.0"));
        assert!(!is_newer("v0.3.0", "0.3.0"));
        assert!(is_newer("1.0.0", "0.9.9-rc1"));
    }
}
