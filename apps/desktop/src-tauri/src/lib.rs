//! App desktop: khay hệ thống, worker Go chạy làm sidecar, cửa sổ web trỏ tới hub của máy, cửa sổ đăng ký cục bộ.

mod account;
mod browser_login;
mod cli;
mod doctor;
mod hub;
mod register;
mod setup_extra;
mod skills;
mod tls;
mod tray_icon;
mod usage;
mod worker;
mod workspace;

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
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
const MAIN: &str = "main";
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
}

struct Tray {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    open: MenuItem<Wry>,
    open_app: MenuItem<Wry>,
    quit: MenuItem<Wry>,
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
        if let (Some((rgba, w, h)), Some(icon)) = (&tray.icon, app.tray_by_id(TRAY)) {
            let mut drawn = tray.drawn.lock().ok();
            if drawn.as_deref().map(String::as_str) != Some(view.kind) {
                let dotted = tray_icon::with_dot(rgba, *w, *h, tray_icon::dot_color(view.kind));
                let _ = icon.set_icon(Some(tauri::image::Image::new_owned(dotted, *w, *h)));
                if let Some(d) = drawn.as_mut() {
                    **d = view.kind.to_string();
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

fn spawn_worker(app: &AppHandle) -> Result<(), String> {
    let (mut rx, child) = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|e| e.to_string())?
        .args(["run", "--status-json", "--stdin-control"])
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

fn show_main(app: &AppHandle, hub: &str) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    let url = url::Url::parse(hub).map_err(|e| format!("Địa chỉ hub không hợp lệ: {e}"))?;
    // Web của hub là trang từ xa: không có capability nào cấp cho cửa sổ này, nên nó không gọi được lệnh của app.
    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
        .title("xDev Hive")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn show_app(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(APP) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, APP, WebviewUrl::App("index.html".into()))
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
            if let Err(e) = show_main(app, &hub) {
                eprintln!("{e}");
            }
        }
        None => show_register(app),
    }
}

fn toggle(app: &AppHandle) {
    let wanted = app
        .state::<State>()
        .worker
        .lock()
        .map(|w| w.wanted())
        .unwrap_or(false);
    if wanted {
        dispatch(app, Event::Stop);
    } else if hub_of(app).is_some() {
        dispatch(app, Event::Start);
    } else {
        show_register(app);
    }
}

/// Thoát app sau khi worker dừng hẳn, để run đang chạy kịp báo kết quả thay vì bị giết giữa chừng.
fn quit(app: &AppHandle) {
    if app.state::<State>().quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    dispatch(app, Event::Stop);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
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
}

async fn sidecar_json(
    app: &AppHandle,
    args: Vec<String>,
    env: Vec<(&str, String)>,
) -> Result<WorkerConfig, String> {
    let mut cmd = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|e| e.to_string())?
        .args(args);
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

/// Trạng thái worker hiện tại; sau đó cửa sổ app nghe sự kiện "worker-state".
#[tauri::command]
fn worker_state(app: AppHandle) -> Option<WorkerView> {
    worker_view(&app)
}

/// Giao diện đổi ngôn ngữ thì khay đổi theo.
#[tauri::command]
fn set_lang(app: AppHandle, lang: String) {
    if let Ok(mut l) = app.state::<State>().lang.lock() {
        *l = if lang == "en" {
            "en".into()
        } else {
            "vi".into()
        };
    }
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
    let mut cli = vec![
        "register".to_string(),
        "--hub".into(),
        args.hub.clone(),
        "--json".into(),
    ];
    if let Some(m) = &args.machine {
        cli.extend(["--machine".into(), m.clone()]);
    }
    let reg = sidecar_json(app, cli, vec![("HIVE_REGISTRATION_TOKEN", args.token)]).await?;
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
    dispatch(app, Event::Start);
    if let Some(window) = app.get_webview_window(REGISTER) {
        let _ = window.hide();
    }
    // Spec 008 US1: đăng ký xong vào AppNav của app (cửa sổ cục bộ), không mở web của hub. Web chỉ mở khi người dùng
    // chọn (khay: Mở xDev Hive, hoặc liên kết tới một trang của hub).
    show_app(app);
    Ok(reg.machine_id.unwrap_or_default())
}

/// Đăng nhập bằng trình duyệt (browser_login.rs): một lần đăng nhập trên web, app tự đăng ký máy và liên kết tài
/// khoản, không phải dán mã đăng ký hay token cá nhân.
#[tauri::command]
async fn browser_login(app: AppHandle, hub: String) -> Result<String, String> {
    let hub = register::normalize_hub(&hub)?;
    let machine = browser_login::machine_from_hostname(&browser_login::hostname());
    let pkce = browser_login::new_pkce()?;
    let (listener, port) = browser_login::listen()?;
    let url = browser_login::connect_url(&hub, port, &pkce, &machine)?;
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
    let ex = browser_login::exchange(&hub, &code, &pkce.verifier).await?;
    let args = register::validate(&hub, &ex.registration_token, Some(&ex.machine))?;
    let machine_id = register_and_start(&app, args).await?;
    // Máy đã đăng ký và worker đã chạy; token cá nhân lỗi thì người dùng vẫn liên kết tay được ở màn Tài khoản.
    if let Err(e) = account::save_checked(&hub, &ex.personal_token).await {
        eprintln!("Không liên kết được tài khoản sau khi đăng nhập: {e}");
    }
    Ok(machine_id)
}

/// Mở một trang của hub (vd. `/runs/<id>`) trong cửa sổ web của hub. Chỉ nhận đường dẫn tương đối gồm ký tự an toàn,
/// để giao diện không dẫn cửa sổ đó sang trang ngoài hub.
#[tauri::command]
fn open_hub_page(app: AppHandle, path: String) -> Result<(), String> {
    let hub = hub_of(&app).ok_or("Máy chưa đăng ký với hub nào.")?;
    if !safe_hub_path(&path) {
        return Err("Đường dẫn không hợp lệ.".into());
    }
    let url = url::Url::parse(&hub)
        .and_then(|u| u.join(&path))
        .map_err(|e| e.to_string())?;
    show_main(&app, &hub)?;
    if let Some(window) = app.get_webview_window(MAIN) {
        window.navigate(url).map_err(|e| e.to_string())?;
    }
    Ok(())
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

/// Bản cập nhật lấy từ hub của máy. Chưa có khoá ký trong tauri.conf.json thì bỏ qua: updater chỉ nhận bản ký đúng
/// khoá đó (hướng dẫn trong apps/desktop/README.md). Trả true khi đã cài một bản, chờ người dùng mở lại app.
async fn check_updates(app: &AppHandle, hub: &str) -> bool {
    use tauri_plugin_updater::UpdaterExt;
    let has_key = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.is_empty());
    if !has_key {
        return false;
    }
    let endpoint = format!(
        "{hub}/api/v1/desktop/updates/{}/{}/{}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        app.package_info().version
    );
    let Ok(url) = url::Url::parse(&endpoint) else {
        return false;
    };
    let updater = match app
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|b| b.build())
    {
        Ok(u) => u,
        Err(e) => {
            eprintln!("Không dựng được updater: {e}");
            return false;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            notify(
                app,
                &format!("Có bản mới {}. Đang tải và cài.", update.version),
            );
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(()) => {
                    notify(
                        app,
                        &format!(
                            "Đã cài bản {}. Thoát rồi mở lại app để dùng.",
                            update.version
                        ),
                    );
                    true
                }
                Err(e) => {
                    eprintln!("Không cài được bản cập nhật: {e}");
                    false
                }
            }
        }
        Ok(None) => false,
        Err(e) => {
            eprintln!("Không kiểm được bản cập nhật: {e}");
            false
        }
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<Tray> {
    let status = MenuItem::with_id(app, "status", "Worker: đã tắt", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Mở xDev Hive", true, None::<&str>)?;
    let open_app = MenuItem::with_id(app, "app", "Mở app trên máy", true, None::<&str>)?;
    let toggle_item = MenuItem::with_id(app, "toggle", "Bật worker", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Thoát", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &open_app,
            &toggle_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;
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
        "quit" => quit(app),
        _ => {}
    })
    .build(app)?;
    Ok(Tray {
        status,
        toggle: toggle_item,
        open,
        open_app,
        quit: quit_item,
        icon: base,
        drawn: Mutex::new("stopped".into()),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tls::ensure();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(State::default())
        .manage(cli::Runs::default())
        .invoke_handler(tauri::generate_handler![
            parse_registration,
            register_worker,
            browser_login,
            hub::hub_rpc,
            doctor::scan_environment,
            doctor::run_install,
            usage::claude_context,
            usage::claude_usage,
            usage::session_stats,
            worker_state,
            set_lang,
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
            cli::folder_tree,
            cli::propose_doc
        ])
        .on_window_event(|window, event| {
            // Đóng cửa sổ chỉ ẩn vào khay: worker vẫn chạy nền.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let tray = build_tray(app)?;
            app.manage(tray);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match sidecar_json(&handle, vec!["config".into(), "--json".into()], vec![]).await {
                    Ok(WorkerConfig {
                        registered: true,
                        hub_url: Some(hub),
                        machine_id,
                    }) => {
                        if let Ok(mut slot) = handle.state::<State>().hub.lock() {
                            *slot = Some(hub.clone());
                        }
                        if let Ok(mut slot) = handle.state::<State>().machine.lock() {
                            *slot = machine_id;
                        }
                        dispatch(&handle, Event::Start);
                        show_app(&handle);
                        // App mở nhiều ngày liền vẫn nhận bản mới: kiểm lại sáu giờ một lần.
                        // Đã cài một bản thì thôi: kiểm tiếp sẽ tải lại đúng bản đó vì app chưa mở lại.
                        while !check_updates(&handle, &hub).await {
                            tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
                        }
                    }
                    Ok(_) => show_register(&handle),
                    Err(e) => {
                        eprintln!("Không đọc được cấu hình worker: {e}");
                        show_register(&handle);
                    }
                }
            });
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
}
