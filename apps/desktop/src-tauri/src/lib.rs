//! App desktop: khay hệ thống, worker Go chạy làm sidecar, giao diện cục bộ gọi hub qua Rust.

mod account;
mod agents;
mod browser_login;
#[cfg(test)]
mod capabilities_audit;
mod claude_desktop;
mod cli;
mod context_sync;
mod doctor;
mod files;
mod git_branches;
mod git_credentials;
mod git_groups;
mod hive_cli;
mod hub;
mod hub_ca;
mod hub_switch;
mod local_projects;
mod memory_store;
mod no_window;
mod notices;
mod optimize_all;
mod optimizer;
mod outbox;
mod profiles;
mod register;
mod remote;
mod run_logs;
mod secret_clipboard;
mod secrets;
mod settings;
mod setup_extra;
mod skills;
mod ssh_keys;
mod tls;
mod token_score;
mod tray_icon;
mod updates;
mod usage;
mod word_import;
mod worker;
mod workspace;

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

use register::RegisterArgs;
use worker::{Action, Event, Worker};

const SIDECAR: &str = "hive-worker";
const REGISTER: &str = "register";
/// Cửa sổ app cục bộ (AppNav và các màn trên máy). Chỉ nạp file trong dist của app, không nạp trang từ xa.
const APP: &str = "app";
const TRAY: &str = "tray";
/// Worker chờ run đang chạy ghi xong kết quả tối đa 30 giây (StopTimeout của kênh); chờ thêm chút rồi mới giết.
const STOP_GRACE: Duration = Duration::from_secs(35);
const TICK: Duration = Duration::from_secs(10);

#[derive(Default)]
struct State {
    worker: Mutex<Worker>,
    child: Mutex<Option<CommandChild>>,
    hub: Mutex<Option<String>>,
    /// Tên (hoặc id) máy đã đăng ký với hub: màn Lượt chạy lọc run theo máy này.
    machine: Mutex<Option<String>>,
    quitting: AtomicBool,
    /// Ngôn ngữ của app (vi/en) cho chữ trên khay; giao diện báo qua lệnh set_lang.
    lang: Mutex<String>,
    /// Bản cập nhật đã tải xong, chờ người dùng mở lại (updates.rs).
    pending_update: Mutex<Option<updates::Pending>>,
    update_gate: Mutex<updates::Gate>,
}

struct Tray {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    /// "Tắt điều khiển từ xa ngay": chỉ bấm được khi điều khiển từ xa đang bật.
    remote_off: MenuItem<Wry>,
    open: MenuItem<Wry>,
    open_app: MenuItem<Wry>,
    quit: MenuItem<Wry>,
    /// "Đăng xuất khỏi Hive": gỡ token cá nhân, không gỡ đăng ký máy (account::sign_out).
    sign_out: MenuItem<Wry>,
    update_check: MenuItem<Wry>,
    /// Chỉ nằm trong menu khi có bản đã tải xong.
    update_restart: MenuItem<Wry>,
    /// "Chuyển Claude Desktop sang…": mỗi gói Claude một mục. Chỉ có trên macOS và Windows (claude_desktop.rs).
    claude: Option<Submenu<Wry>>,
    menu: Menu<Wry>,
    restart_shown: Mutex<bool>,
    /// Ảnh gốc của biểu tượng khay (RGBA) để vẽ chấm trạng thái lên.
    icon: Option<(Vec<u8>, u32, u32)>,
    /// Trạng thái đang vẽ, để không dựng lại ảnh khi trạng thái không đổi.
    drawn: Mutex<String>,
}

/// Trạng thái worker cho cửa sổ app (thẻ worker ở AppNav), cùng nội dung với dòng trạng thái trên khay.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorkerView {
    kind: &'static str,
    label: String,
    detail: Option<String>,
    wanted: bool,
    hub: Option<String>,
    /// Giây Unix lúc bắt đầu mất kết nối với hub; None khi không đang chờ nối.
    offline_since: Option<u64>,
}

fn lang_of(app: &AppHandle) -> String {
    app.state::<State>()
        .lang
        .lock()
        .map(|l| {
            if l.as_str() == "en" {
                "en".to_string()
            } else {
                "vi".to_string()
            }
        })
        .unwrap_or_else(|_| "vi".into())
}

fn worker_view(app: &AppHandle) -> Option<WorkerView> {
    let lang = lang_of(app);
    let state = app.state::<State>();
    let w = state.worker.lock().ok()?;
    Some(WorkerView {
        kind: w.kind(),
        label: w.label_in(&lang),
        detail: w.detail().map(str::to_string),
        wanted: w.wanted(),
        hub: hub_of(app),
        offline_since: w.offline_since(),
    })
}

/// Cập nhật chữ, tooltip, chấm màu của khay theo trạng thái và ngôn ngữ, rồi báo cửa sổ app.
fn refresh_tray(app: &AppHandle) {
    let Some(view) = worker_view(app) else {
        return;
    };
    let en = lang_of(app) == "en";
    if let Some(tray) = app.try_state::<Tray>() {
        let _ = tray.status.set_text(&view.label);
        let _ = tray.toggle.set_text(match (view.wanted, en) {
            (true, false) => "Tắt worker",
            (true, true) => "Stop worker",
            (false, false) => "Bật worker",
            (false, true) => "Start worker",
        });
        let _ = tray.open.set_text(if en {
            "Open xDev Hive"
        } else {
            "Mở xDev Hive"
        });
        let _ = tray.open_app.set_text(if en {
            "Open the desktop app"
        } else {
            "Mở app trên máy"
        });
        let _ = tray.quit.set_text(if en { "Quit" } else { "Thoát" });
        let _ = tray.sign_out.set_text(if en {
            "Sign out of Hive"
        } else {
            "Đăng xuất khỏi Hive"
        });
        if let Some(claude) = &tray.claude {
            let _ = claude.set_text(claude_menu_text(en));
        }
        let _ = tray.remote_off.set_text(if en {
            "Turn off remote control now"
        } else {
            "Tắt điều khiển từ xa ngay"
        });
        let remote = app.state::<remote::Remote>();
        let _ = tray.remote_off.set_enabled(remote.enabled());
        let _ = tray.update_check.set_text(if en {
            "Check for updates"
        } else {
            "Kiểm tra bản mới"
        });
        sync_restart_item(app, &tray, en);
        if let (Some((rgba, w, h)), Some(icon)) = (&tray.icon, app.tray_by_id(TRAY)) {
            let mut drawn = tray.drawn.lock().ok();
            // Khoá vẽ gồm cả chấm điều khiển từ xa: đổi một trong hai là vẽ lại.
            let key = format!("{}|{}", view.kind, remote.active());
            if drawn.as_deref().map(String::as_str) != Some(key.as_str()) {
                let dotted = tray_icon::with_dots(
                    rgba,
                    *w,
                    *h,
                    tray_icon::dot_color(view.kind),
                    remote.active(),
                );
                let _ = icon.set_icon(Some(tauri::image::Image::new_owned(dotted, *w, *h)));
                if let Some(d) = drawn.as_mut() {
                    **d = key;
                }
            }
        }
    }
    if let Some(icon) = app.tray_by_id(TRAY) {
        let tip = match &view.detail {
            Some(d) => format!("xDev Hive · {}\n{d}", view.label),
            None => format!("xDev Hive · {}", view.label),
        };
        let _ = icon.set_tooltip(Some(tip));
    }
    let _ = app.emit("worker-state", view);
}

/// Vị trí của mục "Mở lại để cập nhật" trong menu khay: ngay trên "Kiểm tra bản mới" (sau mục "Tắt điều khiển từ xa").
const RESTART_ITEM_AT: usize = 7;

fn sync_restart_item(app: &AppHandle, tray: &Tray, en: bool) {
    let ready = updates::ready_version(app);
    let Ok(mut shown) = tray.restart_shown.lock() else {
        return;
    };
    if let Some(version) = &ready {
        let _ = tray.update_restart.set_text(if en {
            format!("Restart to update ({version})")
        } else {
            format!("Mở lại để cập nhật ({version})")
        });
    }
    match (ready.is_some(), *shown) {
        (true, false) => {
            *shown = tray
                .menu
                .insert(&tray.update_restart, RESTART_ITEM_AT)
                .is_ok()
        }
        (false, true) => *shown = tray.menu.remove(&tray.update_restart).is_err(),
        _ => {}
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

pub(crate) fn hub_of(app: &AppHandle) -> Option<String> {
    app.state::<State>().hub.lock().ok().and_then(|h| h.clone())
}

/// Đưa sự kiện vào máy trạng thái rồi làm việc nó trả về. Không giữ khoá khi cập nhật khay: menu chạy trên main thread,
/// mà sự kiện của menu cũng gọi vào đây từ main thread.
fn dispatch(app: &AppHandle, event: Event) {
    let actions = {
        let state = app.state::<State>();
        let Ok(mut w) = state.worker.lock() else {
            return;
        };
        w.handle(event, now())
    };
    refresh_tray(app);
    for action in actions {
        perform(app, action);
    }
}

fn perform(app: &AppHandle, action: Action) {
    match action {
        Action::Spawn => {
            if let Err(e) = spawn_worker(app) {
                eprintln!("Không chạy được worker: {e}");
                dispatch(app, Event::Exited(None));
            }
        }
        Action::Stop => stop_worker(app),
        Action::Notify(body) => notify(app, &body),
        Action::NotifyOffline(body) => {
            if settings::get(app).notify_offline {
                notify(app, &body);
            }
        }
        Action::AskRegister => show_register(app),
        Action::RetryIn(secs) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(secs)).await;
                dispatch(&app, Event::Retry);
            });
        }
    }
}

fn notify(app: &AppHandle, body: &str) {
    if let Err(e) = app
        .notification()
        .builder()
        .title("xDev Hive")
        .body(body)
        .show()
    {
        eprintln!("Không hiện được thông báo: {e}");
    }
}

/// Tham số chạy worker làm sidecar. `--stdin-control` cũng tắt tự cập nhật của worker: app cập nhật cả gói (kèm
/// sidecar) qua updater, worker không được tự thay binary nằm trong gói đã ký.
/// `--owner desktop` để client khác đọc `worker.status` biết worker này của app, không tự chạy worker thứ hai.
const SIDECAR_RUN_ARGS: [&str; 5] = [
    "run",
    "--status-json",
    "--stdin-control",
    "--owner",
    "desktop",
];

/// PATH của shell đăng nhập cho worker: app mở từ Finder chỉ có /usr/bin:/bin…, nên worker không thấy claude/codex cài
/// qua nvm, Homebrew hay ~/.local/bin, báo "Chưa có CLI trên máy" và không chạy được run.
fn sidecar_path() -> (&'static str, String) {
    ("PATH", doctor::user_path().to_string())
}

fn spawn_worker(app: &AppHandle) -> Result<(), String> {
    let (key, path) = sidecar_path();
    let (mut rx, child) = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|e| e.to_string())?
        .args(SIDECAR_RUN_ARGS)
        .env(key, path)
        .spawn()
        .map_err(|e| e.to_string())?;
    let pid = child.pid();
    if let Ok(mut slot) = app.state::<State>().child.lock() {
        *slot = Some(child);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    for line in String::from_utf8_lossy(&bytes).lines() {
                        dispatch(&app, Event::Line(line.to_string()));
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprint!("[hive-worker] {}", String::from_utf8_lossy(&bytes))
                }
                CommandEvent::Error(e) => eprintln!("[hive-worker] {e}"),
                CommandEvent::Terminated(payload) => {
                    if let Ok(mut slot) = app.state::<State>().child.lock()
                        && slot.as_ref().map(CommandChild::pid) == Some(pid)
                    {
                        slot.take();
                    }
                    dispatch(&app, Event::Exited(payload.code));
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

/// Dừng êm qua stdin (cùng cách trên mọi hệ điều hành; Windows không có SIGTERM), quá hạn thì giết.
fn stop_worker(app: &AppHandle) {
    let pid = {
        let state = app.state::<State>();
        let Ok(mut slot) = state.child.lock() else {
            return;
        };
        let Some(child) = slot.as_mut() else { return };
        if let Err(e) = child.write(b"stop\n") {
            eprintln!("Không gửi được lệnh dừng cho worker: {e}");
        }
        child.pid()
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STOP_GRACE).await;
        let state = app.state::<State>();
        let Ok(mut slot) = state.child.lock() else {
            return;
        };
        if slot.as_ref().map(CommandChild::pid) == Some(pid)
            && let Some(child) = slot.take()
        {
            let _ = child.kill();
        }
    });
}

fn open_hub_url(app: &AppHandle, url: &str) -> Result<(), String> {
    // Webview có kho CA riêng: trang web đầy đủ mở ở trình duyệt hệ thống, dữ liệu trong app đi qua Rust.
    #[allow(deprecated)]
    app.shell()
        .open(url, None)
        .map_err(|e| format!("Không mở được trình duyệt: {e}"))
}

fn show_app(app: &AppHandle) {
    show_app_at(app, "index.html");
}

fn show_app_at(app: &AppHandle, path: &str) {
    if let Some(window) = app.get_webview_window(APP) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, APP, WebviewUrl::App(path.into()))
        .title("xDev Hive")
        .inner_size(1100.0, 720.0)
        .min_inner_size(640.0, 480.0)
        .build();
    if let Err(e) = built {
        eprintln!("Không mở được cửa sổ app: {e}");
    }
}

fn show_register(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(REGISTER) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn open_hub(app: &AppHandle) {
    match hub_of(app) {
        Some(hub) => {
            if let Err(e) = open_hub_url(app, &hub) {
                eprintln!("{e}");
            }
        }
        // Chưa có hub để mở web: vào app, nơi người dùng kết nối Hive ở thẻ tài khoản.
        None => show_app(app),
    }
}

fn toggle(app: &AppHandle) {
    let wanted = app
        .state::<State>()
        .worker
        .lock()
        .map(|w| w.wanted())
        .unwrap_or(false);
    set_wanted(app, !wanted);
}

/// Bật hay tắt worker. Máy chưa đăng ký thì chưa có hub để nối: mở cửa sổ đăng ký thay vì bật.
fn set_wanted(app: &AppHandle, on: bool) {
    if !on {
        dispatch(app, Event::Stop);
    } else if hub_of(app).is_some() {
        dispatch(app, Event::Start);
    } else {
        show_register(app);
    }
}

/// Dừng worker rồi chờ nó thoát hẳn, để run đang chạy kịp báo kết quả thay vì bị giết giữa chừng.
async fn stop_worker_and_wait(app: &AppHandle) {
    dispatch(app, Event::Stop);
    let deadline = Instant::now() + STOP_GRACE + Duration::from_secs(2);
    while Instant::now() < deadline
        && app
            .state::<State>()
            .child
            .lock()
            .map(|c| c.is_some())
            .unwrap_or(false)
    {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Thoát app sau khi worker dừng hẳn. Có bản cập nhật đã tải thì cài luôn: người dùng thoát thay vì bấm "Mở lại" vẫn
/// được bản mới ở lần mở sau.
fn quit(app: &AppHandle) {
    if app.state::<State>().quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        stop_worker_and_wait(&app).await;
        if let Err(e) = updates::install_pending(&app) {
            eprintln!("{e}");
        }
        app.exit(0);
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerConfig {
    registered: bool,
    hub_url: Option<String>,
    #[serde(default)]
    machine_id: Option<String>,
    /// Worker cũ không trả; khi đó app không tự đổi địa chỉ hub được.
    #[serde(default)]
    config_path: Option<String>,
}

async fn sidecar_json<T: serde::de::DeserializeOwned>(
    app: &AppHandle,
    args: Vec<String>,
    env: Vec<(&str, String)>,
) -> Result<T, String> {
    // Lần đầu dò PATH đăng nhập có thể mất một chút (chạy shell); không giữ luồng async trong lúc đó.
    let (key, path) = tauri::async_runtime::spawn_blocking(sidecar_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut cmd = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|e| e.to_string())?
        .args(args)
        .env(key, path);
    for (k, v) in env {
        cmd = cmd.env(k, v);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Không chạy được worker: {e}"))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if msg.is_empty() {
            "Worker báo lỗi mà không có chi tiết.".into()
        } else {
            msg
        });
    }
    serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("Không đọc được kết quả của worker: {e}"))
}

/// Sidecar dạng `std::process::Command` (plugin shell đã đặt đường dẫn, ẩn cửa sổ trên Windows), cho lệnh cần ghi
/// stdin rồi đóng hay giữ stdin để gửi tiếp.
async fn sidecar_command(
    app: &AppHandle,
    args: Vec<String>,
    env: Vec<(&str, String)>,
) -> Result<std::process::Command, String> {
    let (key, path) = tauri::async_runtime::spawn_blocking(sidecar_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut cmd = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|e| e.to_string())?
        .args(args)
        .env(key, path);
    for (k, v) in env {
        cmd = cmd.env(k, v);
    }
    Ok(cmd.into())
}

/// Như `sidecar_json` nhưng ghi `input` làm dòng đầu stdin và giết sidecar nếu không trả lời trong `wait`.
async fn sidecar_json_stdin<T: serde::de::DeserializeOwned + Send + 'static>(
    app: &AppHandle,
    args: Vec<String>,
    env: Vec<(&str, String)>,
    input: serde_json::Value,
    wait: std::time::Duration,
) -> Result<T, String> {
    let cmd = sidecar_command(app, args, env).await?;
    let v = tauri::async_runtime::spawn_blocking(move || git_branches::run_json(cmd, &input, wait))
        .await
        .map_err(|e| e.to_string())??;
    serde_json::from_value(v).map_err(|e| format!("Không đọc được kết quả của worker: {e}"))
}

/// Trạng thái worker hiện tại; sau đó cửa sổ app nghe sự kiện "worker-state".
#[tauri::command]
fn worker_state(app: AppHandle) -> Option<WorkerView> {
    worker_view(&app)
}

/// Bật hay tắt worker từ màn Máy này, như mục Tắt/Bật worker của khay. Trả trạng thái ngay sau khi đổi; các bước
/// sau (đang nối, đang nhận việc) đến qua sự kiện "worker-state".
#[tauri::command]
fn set_worker(app: AppHandle, on: bool) -> Option<WorkerView> {
    set_wanted(&app, on);
    worker_view(&app)
}

/// Giao diện đổi ngôn ngữ thì khay và nút trên thông báo đổi theo.
#[tauri::command]
fn set_lang(app: AppHandle, lang: String) {
    if let Ok(mut l) = app.state::<State>().lang.lock() {
        *l = if lang == "en" {
            "en".into()
        } else {
            "vi".into()
        };
    }
    notices::register_actions(&app, lang == "en");
    refresh_tray(&app);
}

#[tauri::command]
fn parse_registration(input: String) -> Result<RegisterArgs, String> {
    register::parse_register_command(&input)
}

/// Đăng ký máy bằng sidecar rồi bật worker và mở web của hub. Token đi qua biến môi trường, không qua tham số dòng
/// lệnh, để người dùng khác trên máy không đọc được nó trong danh sách tiến trình.
#[tauri::command]
async fn register_worker(
    app: AppHandle,
    hub: String,
    token: String,
    machine: Option<String>,
) -> Result<String, String> {
    let args = register::validate(&hub, &token, machine.as_deref())?;
    register_and_start(&app, args).await
}

async fn register_and_start(app: &AppHandle, args: RegisterArgs) -> Result<String, String> {
    let (cli, env) = register::sidecar_invocation(&args);
    let reg: WorkerConfig = sidecar_json(app, cli, env).await?;
    let hub = reg
        .hub_url
        .filter(|_| reg.registered)
        .ok_or("Worker không trả địa chỉ hub sau khi đăng ký.")?;
    if let Ok(mut slot) = app.state::<State>().hub.lock() {
        *slot = Some(hub);
    }
    if let Ok(mut slot) = app.state::<State>().machine.lock() {
        *slot = reg.machine_id.clone();
    }
    // Đăng ký lại (đổi hub) khi worker đang chạy: tiến trình cũ vẫn giữ token và hub cũ trong bộ nhớ, phải khởi động
    // lại mới đọc cấu hình mới.
    if worker_running(app) {
        stop_worker_and_wait(app).await;
    }
    dispatch(app, Event::Start);
    if let Some(window) = app.get_webview_window(REGISTER) {
        let _ = window.hide();
    }
    // Spec 008 US1: đăng ký xong vào AppNav của app (cửa sổ cục bộ), không mở web của hub. Web chỉ mở khi người dùng
    // chọn (khay: Mở xDev Hive, hoặc liên kết tới một trang của hub).
    show_app(app);
    Ok(reg.machine_id.unwrap_or_default())
}

fn worker_running(app: &AppHandle) -> bool {
    app.state::<State>()
        .child
        .lock()
        .map(|c| c.is_some())
        .unwrap_or(false)
}

/// Mở trang đồng ý của hub trong trình duyệt và chờ đổi mã (browser_login.rs).
async fn browser_exchange(
    app: &AppHandle,
    hub: &str,
    purpose: browser_login::Purpose,
) -> Result<browser_login::Exchange, String> {
    let machine = app
        .state::<State>()
        .machine
        .lock()
        .ok()
        .and_then(|m| m.clone())
        .unwrap_or_else(|| browser_login::machine_from_hostname(&browser_login::hostname()));
    let pkce = browser_login::new_pkce()?;
    let (listener, port) = browser_login::listen()?;
    let url = browser_login::connect_url(hub, port, &pkce, &machine, purpose)?;
    #[allow(deprecated)]
    app.shell()
        .open(url, None)
        .map_err(|e| format!("Không mở được trình duyệt: {e}"))?;
    let state = pkce.state.clone();
    let code = tauri::async_runtime::spawn_blocking(move || {
        browser_login::wait_for_code(listener, &state)
    })
    .await
    .map_err(|e| e.to_string())??;
    browser_login::exchange(hub, &code, &pkce.verifier).await
}

/// Đăng nhập bằng trình duyệt (browser_login.rs): một lần đăng nhập trên web, app tự đăng ký máy và liên kết tài
/// khoản, không phải dán mã đăng ký hay token cá nhân.
#[tauri::command]
async fn browser_login(app: AppHandle, hub: String) -> Result<String, String> {
    let hub = register::normalize_hub(&hub)?;
    let ex = browser_exchange(&app, &hub, browser_login::Purpose::Register).await?;
    let token = ex
        .registration_token
        .as_deref()
        .ok_or("Hub không trả mã đăng ký máy. Thử lại.")?;
    let args = register::validate(&hub, token, Some(&ex.machine))?;
    let machine_id = register_and_start(&app, args).await?;
    // Máy đã đăng ký và worker đã chạy; token cá nhân lỗi thì người dùng vẫn liên kết tay được ở màn Tài khoản.
    if let Err(e) = account::save_checked(&app, &hub, &ex.personal_token).await {
        eprintln!("Không liên kết được tài khoản sau khi đăng nhập: {e}");
    }
    Ok(machine_id)
}

/// Máy đã đăng ký đăng nhập lại bằng trình duyệt, như `hive login`: chỉ lấy token cá nhân, không đăng ký lại máy, không
/// phải chọn đội. Đăng xuất rồi đăng nhập lại không còn phải tạo token MCP ở web rồi dán vào.
#[tauri::command]
async fn account_browser_login(app: AppHandle) -> Result<account::AccountStatus, String> {
    let hub = hub_of(&app).ok_or("Máy chưa đăng ký với hub nào. Đăng ký máy trước.")?;
    let ex = browser_exchange(&app, &hub, browser_login::Purpose::SignIn).await?;
    account::save_checked(&app, &hub, &ex.personal_token).await?;
    let _ = app.emit(account::CHANGED_EVENT, ());
    Ok(account::status_for(Some(hub)).await)
}

/// Kiểm địa chỉ hub người dùng nhập (hub_switch.rs). Trả địa chỉ đã chuẩn hoá để giao diện dùng tiếp.
#[tauri::command]
async fn hub_check(hub: String) -> Result<String, String> {
    hub_switch::check(&hub).await
}

#[tauri::command]
async fn hub_ca_inspect(hub: String) -> Result<hub_ca::Candidate, String> {
    hub_ca::discover(&hub).await
}

#[tauri::command]
async fn hub_ca_trust(hub: String, fingerprint: String) -> Result<(), String> {
    hub_ca::trust(&hub, &fingerprint).await
}

#[tauri::command]
fn hub_ca_forget() -> Result<(), String> {
    hub_ca::forget()
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct HubChange {
    hub: String,
    /// Đã ghi địa chỉ mới vào cấu hình worker.
    changed: bool,
    /// Hub mới không nhận đăng ký cũ của máy (hoặc máy chưa đăng ký): phải đăng ký lại. Giao diện hỏi trước.
    needs_register: bool,
}

/// Chuyển máy đã đăng ký sang địa chỉ hub mới mà không đăng ký lại: hub mới nhận token máy cũ (cùng hub, đổi http sang
/// https hay bỏ cổng) thì chỉ sửa `hubUrl` trong cấu hình worker và chuyển token cá nhân sang. Gói agent, dự án, tài
/// khoản CLI trên máy không đụng tới.
#[tauri::command]
async fn hub_change(app: AppHandle, hub: String) -> Result<HubChange, String> {
    let hub = hub_switch::check(&hub).await?;
    let config: WorkerConfig =
        sidecar_json(&app, vec!["config".into(), "--json".into()], vec![]).await?;
    let Some(current) = config.hub_url.filter(|_| config.registered) else {
        return Ok(HubChange {
            hub,
            changed: false,
            needs_register: true,
        });
    };
    if hub_switch::same_hub(&current, &hub) {
        return Ok(HubChange {
            hub: current,
            changed: false,
            needs_register: false,
        });
    }
    let path = std::path::PathBuf::from(
        config
            .config_path
            .ok_or("Worker này không cho biết file cấu hình. Cập nhật app rồi thử lại.")?,
    );
    let token = hub_switch::machine_token(&path)?;
    if !hub_switch::machine_token_accepted(&hub, &token).await? {
        return Ok(HubChange {
            hub,
            changed: false,
            needs_register: true,
        });
    }
    let wanted = app
        .state::<State>()
        .worker
        .lock()
        .map(|w| w.wanted())
        .unwrap_or(false);
    if worker_running(&app) {
        stop_worker_and_wait(&app).await;
    }
    hub_switch::set_worker_hub(&path, &hub)?;
    if let Ok(mut slot) = app.state::<State>().hub.lock() {
        *slot = Some(hub.clone());
    }
    account::carry_over(&app, &current, &hub).await;
    if wanted {
        dispatch(&app, Event::Start);
    } else {
        refresh_tray(&app);
    }
    let _ = app.emit(account::CHANGED_EVENT, ());
    Ok(HubChange {
        hub,
        changed: true,
        needs_register: false,
    })
}

/// Mở một trang của hub trong trình duyệt hệ thống. Chỉ nhận đường dẫn tương đối an toàn để không mở URL tuỳ ý.
#[tauri::command]
fn open_hub_page(app: AppHandle, path: String) -> Result<(), String> {
    let hub = hub_of(&app).ok_or("Máy chưa đăng ký với hub nào.")?;
    if !safe_hub_path(&path) {
        return Err("Đường dẫn không hợp lệ.".into());
    }
    let url = url::Url::parse(&hub)
        .and_then(|u| u.join(&path))
        .map_err(|e| e.to_string())?;
    open_hub_url(&app, url.as_str())
}

fn safe_hub_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && path.len() <= 300
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/-_?=&.".contains(c))
}

/// Máy này trên hub (tên hay id đã đăng ký); None khi chưa đăng ký.
#[tauri::command]
fn this_machine(app: AppHandle) -> Option<String> {
    app.state::<State>()
        .machine
        .lock()
        .ok()
        .and_then(|m| m.clone())
}

/// Tiền tố id mục khay chuyển Claude Desktop sang một gói; phần sau là id gói.
const CLAUDE_ITEM: &str = "claude-desktop:";

fn claude_menu_text(en: bool) -> &'static str {
    if en {
        "Switch Claude Desktop to…"
    } else {
        "Chuyển Claude Desktop sang…"
    }
}

/// Đổ lại danh sách gói Claude vào mục "Chuyển Claude Desktop sang…" của khay.
pub(crate) fn set_claude_tray(app: &AppHandle, view: &claude_desktop::ProfilesView) {
    let Some(tray) = app.try_state::<Tray>() else {
        return;
    };
    let Some(sub) = &tray.claude else {
        return;
    };
    let en = lang_of(app) == "en";
    if let Ok(items) = sub.items() {
        for item in items {
            let _ = sub.remove(&item);
        }
    }
    if view.profiles.is_empty() {
        let empty = if en {
            "No Claude plan yet"
        } else {
            "Chưa có gói Claude"
        };
        if let Ok(item) = MenuItem::new(app, empty, false, None::<&str>) {
            let _ = sub.append(&item);
        }
        return;
    }
    for p in &view.profiles {
        let text = claude_desktop::tray_label(p, en);
        let id = format!("{CLAUDE_ITEM}{}", p.id);
        if let Ok(item) = MenuItem::with_id(app, id, text, view.app.is_some(), None::<&str>) {
            let _ = sub.append(&item);
        }
    }
}

fn switch_claude_from_tray(app: &AppHandle, plan: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let en = lang_of(&app) == "en";
        notify(
            &app,
            if en {
                "Restarting Claude Desktop…"
            } else {
                "Đang khởi động lại Claude Desktop…"
            },
        );
        // Khay không hỏi được "buộc thoát?": app không chịu thoát thì báo, người dùng tự thoát hoặc dùng cửa sổ Hive.
        let text = match claude_desktop::switch(&app, &plan, false).await {
            Ok(s) => match s.status {
                claude_desktop::SwitchStatus::StillRunning => {
                    claude_desktop::still_running_text(en).to_string()
                }
                claude_desktop::SwitchStatus::Already if en => {
                    format!("Claude Desktop is already on {plan}.")
                }
                claude_desktop::SwitchStatus::Already => {
                    format!("Claude Desktop đang dùng gói {plan}.")
                }
                _ if s.needs_login && en => {
                    format!("Claude Desktop is now on {plan}: sign in with this plan's account.")
                }
                _ if s.needs_login => {
                    format!(
                        "Đã chuyển Claude Desktop sang {plan}: đăng nhập bằng tài khoản của gói này."
                    )
                }
                _ if en => format!("Claude Desktop is now on {plan}."),
                _ => format!("Đã chuyển Claude Desktop sang {plan}."),
            },
            Err(e) => e,
        };
        notify(&app, &text);
    });
}

/// Dùng chung hộp thoại để khay cũng hỏi về hộp thư đi và gán bí mật trước khi gỡ token.
fn sign_out_from_tray(app: &AppHandle) {
    if app.get_webview_window(APP).is_none() {
        // Cửa sổ mới chưa nghe sự kiện: mang yêu cầu trong URL để không mất thao tác của khay.
        show_app_at(app, "index.html?signOut=1");
        return;
    }
    show_app(app);
    let _ = app.emit("account-sign-out", ());
}

fn build_tray(app: &tauri::App) -> tauri::Result<Tray> {
    let status = MenuItem::with_id(app, "status", "Worker: đã tắt", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Mở xDev Hive", true, None::<&str>)?;
    let open_app = MenuItem::with_id(app, "app", "Mở app trên máy", true, None::<&str>)?;
    let toggle_item = MenuItem::with_id(app, "toggle", "Bật worker", true, None::<&str>)?;
    let update_check =
        MenuItem::with_id(app, "update_check", "Kiểm tra bản mới", true, None::<&str>)?;
    let update_restart = MenuItem::with_id(
        app,
        "update_restart",
        "Mở lại để cập nhật",
        true,
        None::<&str>,
    )?;
    let remote_off = MenuItem::with_id(
        app,
        "remote_off",
        "Tắt điều khiển từ xa ngay",
        false,
        None::<&str>,
    )?;
    let sign_out = MenuItem::with_id(app, "sign_out", "Đăng xuất khỏi Hive", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Thoát", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &open_app,
            &toggle_item,
            &remote_off,
            &PredefinedMenuItem::separator(app)?,
            &update_check,
            &PredefinedMenuItem::separator(app)?,
            &sign_out,
            &quit_item,
        ],
    )?;
    // Nằm trước "Đăng xuất khỏi Hive" để vị trí của mục "Mở lại để cập nhật" (RESTART_ITEM_AT) không đổi. Danh sách gói
    // đổ vào sau, khi worker trả danh sách (set_claude_tray).
    let claude = if claude_desktop::SUPPORTED {
        let sub = Submenu::with_items(
            app,
            claude_menu_text(false),
            true,
            &[&MenuItem::new(
                app,
                "Chưa có gói Claude",
                false,
                None::<&str>,
            )?],
        )?;
        let at = menu.items()?.len() - 2;
        menu.insert_items(&[&sub, &PredefinedMenuItem::separator(app)?], at)?;
        Some(sub)
    } else {
        None
    };
    let mut tray = TrayIconBuilder::with_id(TRAY)
        .tooltip("xDev Hive")
        .menu(&menu)
        .show_menu_on_left_click(true);
    // Chấm trạng thái cần ảnh màu: ảnh template của macOS bị tô một màu theo thanh menu, chấm sẽ mất màu. Vì vậy mọi hệ
    // điều hành dùng biểu tượng màu của app (ô navy, nhìn rõ trên thanh menu sáng lẫn tối).
    let base = app
        .default_window_icon()
        .map(|i| (i.rgba().to_vec(), i.width(), i.height()));
    if let Some((rgba, w, h)) = &base {
        let dotted = tray_icon::with_dot(rgba, *w, *h, tray_icon::dot_color("stopped"));
        tray = tray.icon(tauri::image::Image::new_owned(dotted, *w, *h));
    }
    tray.on_menu_event(|app, event| match event.id().as_ref() {
        "open" => open_hub(app),
        "app" => show_app(app),
        "toggle" => toggle(app),
        "remote_off" => remote::disable_from_tray(app),
        "update_check" => updates::check_from_tray(app),
        "update_restart" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = updates::relaunch_to_update(app.clone()).await {
                    notify(&app, &e);
                }
            });
        }
        "sign_out" => sign_out_from_tray(app),
        "quit" => quit(app),
        id => {
            if let Some(plan) = id.strip_prefix(CLAUDE_ITEM) {
                switch_claude_from_tray(app, plan.to_string());
            }
        }
    })
    .build(app)?;
    Ok(Tray {
        status,
        toggle: toggle_item,
        remote_off,
        open,
        open_app,
        quit: quit_item,
        sign_out,
        update_check,
        update_restart,
        claude,
        menu,
        restart_shown: Mutex::new(false),
        icon: base,
        drawn: Mutex::new("stopped|false".into()),
    })
}

/// Bản cũ đệm artifact đã mở vào `<app_data>/artifacts` và chỉ dọn khi đăng xuất. Màn Artifact đã chuyển sang web nên
/// không còn gì đọc hay dọn thư mục đó: xoá đi để tài liệu của tổ chức không nằm lại trên máy sau khi đăng xuất.
fn remove_old_artifact_cache(app_data: &std::path::Path) {
    match std::fs::remove_dir_all(app_data.join("artifacts")) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => eprintln!("Không xoá được bộ đệm artifact cũ: {e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tls::ensure();
    tauri::Builder::default()
        // Đăng ký đầu tiên: bản thứ hai phải thoát trước khi dựng tray hay bật worker thứ hai. App chưa có deep link
        // hay tham số dòng lệnh để chuyển giao, nên chỉ cần đưa cửa sổ bản đang chạy lên trước.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_app(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(State::default())
        .manage(cli::Runs::default())
        .manage(agents::Agents::default())
        .manage(remote::Remote::default())
        .manage(git_groups::Jobs::default())
        .manage(git_branches::BranchJobs::default())
        .manage(ssh_keys::SetupLock::default())
        .manage(settings::Store::default())
        .manage(notices::Notices::default())
        .manage(token_score::Last::default())
        .manage(word_import::Picks::default())
        .invoke_handler(tauri::generate_handler![
            parse_registration,
            register_worker,
            browser_login,
            account_browser_login,
            hub_check,
            hub_ca_inspect,
            hub_ca_trust,
            hub_ca_forget,
            hub_change,
            hub::hub_rpc,
            doctor::scan_environment,
            doctor::run_install,
            usage::claude_context,
            usage::claude_usage,
            usage::session_stats,
            worker_state,
            set_worker,
            set_lang,
            settings::app_settings,
            settings::set_app_setting,
            notices::show_notification,
            account::account_status,
            account::account_link,
            account::account_unlink,
            workspace::workspace_meta,
            workspace::hub_tool,
            usage::skill_uses,
            this_machine,
            open_hub_page,
            skills::installed_skills,
            skills::install_skills,
            skills::remove_skills,
            skills::propose_skill,
            cli::run_cli_stream,
            cli::cancel_cli_stream,
            cli::cli_accounts,
            profiles::cli_profiles,
            profiles::cli_profile_set,
            profiles::cli_profile_add,
            profiles::cli_profile_update,
            profiles::cli_profile_remove,
            profiles::cli_profile_logout,
            profiles::cli_profile_usage,
            profiles::cli_profile_resume,
            profiles::cli_profile_discover,
            profiles::cli_profile_discover_add,
            profiles::open_login_terminal,
            profiles::open_cli_terminal,
            profiles::open_agent_terminal,
            claude_desktop::claude_desktop_profiles,
            claude_desktop::switch_claude_desktop,
            claude_desktop::restore_claude_desktop,
            claude_desktop::adopt_claude_desktop,
            claude_desktop::dismiss_claude_desktop_mismatch,
            claude_desktop::forget_claude_desktop,
            claude_desktop::sign_out_claude_desktop,
            claude_desktop::migrate_claude_desktop_profiles,
            claude_desktop::claude_desktop_switch_progress,
            claude_desktop::cancel_claude_desktop_switch,
            claude_desktop::claude_desktop_diagnose,
            optimizer::optimizer_status,
            optimizer::optimizer_enable,
            optimizer::optimizer_disable,
            optimizer::optimizer_restore,
            optimizer::optimizer_report,
            token_score::token_score,
            token_score::token_score_history,
            token_score::token_score_last,
            token_score::token_score_report_status,
            token_score::token_score_report_set,
            token_score::token_score_fix_preview,
            token_score::token_score_fix,
            token_score::token_score_undo,
            memory_store::memory_scan,
            memory_store::memory_apply,
            memory_store::memory_compress,
            memory_store::memory_consolidate,
            context_sync::context_status,
            context_sync::context_enable,
            context_sync::context_disable,
            context_sync::context_save_source,
            context_sync::context_sync,
            context_sync::context_resolve,
            context_sync::context_migrate,
            optimize_all::optimize_all_preview,
            optimize_all::optimize_all_apply,
            optimize_all::optimize_all_undo,
            optimize_all::optimize_all_last,
            outbox::outbox_status,
            outbox::outbox_flush,
            outbox::outbox_submit,
            outbox::outbox_drop,
            outbox::outbox_retry,
            outbox::outbox_export,
            local_projects::local_projects,
            run_logs::read_run_log,
            local_projects::local_projects_import,
            local_projects::local_project_bind,
            local_projects::local_project_unbind,
            local_projects::local_project_set_full,
            git_groups::git_groups,
            git_groups::git_host_add,
            git_groups::git_host_probe,
            git_groups::git_host_discover,
            git_groups::git_host_remove,
            git_groups::git_group_suggest,
            git_groups::git_group_add,
            git_groups::git_group_update,
            git_groups::git_group_refresh,
            git_groups::git_group_remove,
            git_groups::git_group_status,
            git_groups::git_group_sync,
            git_groups::git_group_cancel,
            git_groups::open_folder,
            git_groups::open_folder_terminal,
            git_branches::git_branches_status,
            git_branches::git_branches_list,
            git_branches::git_branches_switch,
            git_branches::git_branches_create,
            git_branches::git_branches_fetch,
            git_branches::git_branches_pull,
            git_branches::git_branches_scan,
            git_branches::git_branches_clean,
            git_branches::git_branches_cancel,
            git_branches::git_branches_settings,
            git_branches::git_branches_settings_set,
            git_branches::git_branches_merge,
            git_branches::git_branches_rebase,
            git_branches::git_branches_continue,
            git_branches::git_branches_abort,
            ssh_keys::ssh_list,
            ssh_keys::ssh_check,
            ssh_keys::ssh_scan,
            ssh_keys::ssh_setup,
            ssh_keys::ssh_remove,
            ssh_keys::ssh_open_terminal,
            secrets::secrets_status,
            secrets::secrets_list,
            secrets::secret_save,
            secrets::secret_rename,
            secrets::secret_assign,
            secrets::secret_delete,
            secrets::secret_reveal,
            secrets::secret_copy,
            secrets::secrets_log,
            secrets::secrets_log_clear,
            secrets::secrets_purge,
            secrets::secret_approvals,
            secrets::secret_approve,
            secrets::delivery_creds_status,
            secrets::delivery_creds_list,
            secrets::delivery_cred_save,
            secrets::delivery_cred_delete,
            cli::folder_tree,
            cli::folder_docs,
            cli::propose_doc,
            files::folder_list,
            files::read_local_file,
            files::write_local_file,
            agents::machine_agents,
            agents::machine_agent_counts,
            agents::machine_agent_stop,
            agents::machine_agent_feed,
            agents::machine_agent_feed_older,
            updates::update_status,
            updates::check_updates_now,
            updates::relaunch_to_update,
            hive_cli::hive_cli_status,
            hive_cli::hive_cli_install,
            remote::remote_status,
            remote::remote_enable,
            remote::remote_disable,
            remote::remote_root_add,
            remote::remote_root_remove,
            remote::remote_device_remove,
            remote::remote_pair,
            remote::remote_set,
            remote::remote_pair_decide,
            remote::remote_totp_enroll,
            remote::remote_totp_confirm,
            remote::remote_totp_disable,
            remote::remote_totp_unlock,
            remote::remote_sessions,
            remote::remote_session_kill,
            word_import::pick_word_files,
            word_import::hub_upload_word,
            word_import::hub_fetch_bytes
        ])
        .on_window_event(|window, event| {
            // Đóng cửa sổ chỉ ẩn vào khay: worker vẫn chạy nền. Người dùng tắt "Đóng cửa sổ chỉ ẩn xuống khay" ở màn Cài
            // đặt thì đóng cửa sổ app là thoát hẳn, worker dừng êm trước như khi chọn Thoát ở khay.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                if window.label() == APP && !settings::get(window.app_handle()).hide_on_close {
                    quit(window.app_handle());
                    return;
                }
            }
            if let WindowEvent::Focused(true) = event
                && window.label() == APP
            {
                updates::check_on_focus(window.app_handle());
            }
        })
        .setup(|app| {
            doctor::warm_user_path();
            if let Ok(dir) = app.path().app_data_dir() {
                // Bộ đệm có thể tới 200 MiB: không giữ khởi động chờ xoá.
                tauri::async_runtime::spawn_blocking(move || remove_old_artifact_cache(&dir));
            }
            optimizer::link_on_start(app.handle());
            git_groups::start_auto_fetch(app.handle().clone());
            remote::start(app.handle());
            token_score::start_daily(app.handle().clone());
            let tray = build_tray(app)?;
            app.manage(tray);
            notices::register_actions(app.handle(), false);
            notices::listen(app.handle());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match sidecar_json::<WorkerConfig>(
                    &handle,
                    vec!["config".into(), "--json".into()],
                    vec![],
                )
                .await
                {
                    Ok(WorkerConfig {
                        registered: true,
                        hub_url: Some(hub),
                        machine_id,
                        ..
                    }) => {
                        if let Ok(mut slot) = handle.state::<State>().hub.lock() {
                            *slot = Some(hub.clone());
                        }
                        if let Ok(mut slot) = handle.state::<State>().machine.lock() {
                            *slot = machine_id;
                        }
                        // Lần đầu chạy app mới trên máy đã dùng app v1: mang tài khoản CLI sang trước khi worker
                        // khởi động, để worker nhận đủ số run cùng lúc ngay. Lỗi thì vẫn chạy bằng đăng nhập mặc định.
                        if let Err(e) = sidecar_json::<serde_json::Value>(
                            &handle,
                            vec!["accounts".into(), "import-legacy".into(), "--json".into()],
                            vec![],
                        )
                        .await
                        {
                            eprintln!("Không nhập được tài khoản CLI của app v1: {e}");
                        }
                        if settings::get(&handle).start_worker {
                            dispatch(&handle, Event::Start);
                        }
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("Không đọc được cấu hình worker: {e}"),
                }
                // Tính năng tại máy: không cần đăng ký với hub, chỉ cần danh sách gói của worker.
                if claude_desktop::SUPPORTED
                    && let Err(e) = claude_desktop::load(&handle).await
                {
                    eprintln!("Không đọc được gói Claude cho khay: {e}");
                }
                // App là client, không bắt đăng nhập: chưa đăng ký máy vẫn vào thẳng giao diện chính, các mục trên máy
                // dùng được ngay; kết nối Hive ở thẻ tài khoản khi người dùng cần.
                show_app(&handle);
                // Máy chưa đăng ký cũng kiểm (chỉ qua GitHub): app mới cài nhận được bản mới trước cả khi đăng ký.
                updates::run_periodic(&handle).await;
            });
            if claude_desktop::SUPPORTED {
                tauri::async_runtime::spawn(claude_desktop::watch(app.handle().clone()));
            }
            let ticker = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(TICK).await;
                    dispatch(&ticker, Event::Tick);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("không khởi động được xDev Hive desktop")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                remote::stop(app);
            }
            // Cmd+Q, đăng xuất hệ điều hành: dừng worker êm trước. app.exit() của quit() gửi lại sự kiện kèm mã, cho qua.
            if let RunEvent::ExitRequested {
                api, code: None, ..
            } = event
                && !app.state::<State>().quitting.load(Ordering::SeqCst)
            {
                api.prevent_exit();
                quit(app);
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn sidecar_gets_the_login_shell_path() {
        let (key, path) = super::sidecar_path();
        assert_eq!(key, "PATH");
        assert!(!path.is_empty());
        assert_eq!(
            path,
            super::doctor::user_path(),
            "worker và Terminal dùng cùng một PATH"
        );
    }

    #[test]
    fn sidecar_runs_under_app_control_without_self_update() {
        // Worker tắt tự cập nhật khi chạy với --stdin-control (worker/cmd/hive-worker TestSidecarDisablesSelfUpdate).
        assert_eq!(super::SIDECAR_RUN_ARGS[0], "run");
        assert!(super::SIDECAR_RUN_ARGS.contains(&"--stdin-control"));
        assert!(super::SIDECAR_RUN_ARGS.contains(&"--status-json"));
        let owner = super::SIDECAR_RUN_ARGS
            .iter()
            .position(|a| *a == "--owner")
            .unwrap();
        assert_eq!(super::SIDECAR_RUN_ARGS[owner + 1], "desktop");
    }

    use super::safe_hub_path;

    #[test]
    fn hub_pages_stay_on_the_hub() {
        assert!(safe_hub_path("/runs/3f0c-1"));
        assert!(safe_hub_path("/knowledge/reviews?id=ab"));
        assert!(!safe_hub_path("//evil.example/x"));
        assert!(!safe_hub_path("https://evil.example"));
        assert!(!safe_hub_path("/a b"));
        assert!(!safe_hub_path("/x#<script>"));
    }

    #[test]
    fn removes_only_the_old_artifact_cache() {
        let dir = std::env::temp_dir().join(format!("hive-app-data-{}", std::process::id()));
        let cached = dir.join("artifacts").join("a1b2").join("org").join("id");
        std::fs::create_dir_all(&cached).unwrap();
        std::fs::write(cached.join("1.json"), "{}").unwrap();
        std::fs::write(dir.join("installed-skills.json"), "{}").unwrap();
        super::remove_old_artifact_cache(&dir);
        assert!(!dir.join("artifacts").exists());
        assert!(dir.join("installed-skills.json").is_file());
        // Lần mở app sau không còn thư mục để xoá: không lỗi.
        super::remove_old_artifact_cache(&dir);
        let _ = std::fs::remove_dir_all(dir);
    }
}
