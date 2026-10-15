//! Bộ đệm artifact của app và giao thức `hive-artifact` (specs/012-artifacts T040, plan.md D17, FR-091, FR-092).
//!
//! Phiên bản người dùng đã mở được ghi ra `<app_data>/artifacts/<hồ sơ>/<tổ chức>/<id>/<phiên bản>.json` để đọc lại khi
//! mất mạng. Hồ sơ là dấu của địa chỉ hub, tổ chức lấy từ token cá nhân trong keychain: giao diện không chọn được phạm vi,
//! nên không đọc được bản đệm của tổ chức khác. Bộ đệm bị xoá khi gỡ liên kết hoặc đổi token (account.rs), vì token mới
//! có thể là người khác hay tổ chức khác.
//!
//! Khung cách ly nạp `hive-artifact://localhost/frame/<id>/<phiên bản>` (Windows: `http://hive-artifact.localhost/…`):
//! tài liệu khung do hub dựng sẵn (`artifacts.frameDocument`, kể cả bản biên dịch `react`), thư viện từ resource đóng gói
//! trong app. CSP giống hệt khung trên hub; chỉ khác nguồn thư viện.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::http::{Request, Response, StatusCode, header};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, UriSchemeContext, UriSchemeResponder, Wry};

pub const SCHEME: &str = "hive-artifact";
/// FR-091: trần dung lượng của cả bộ đệm trên máy.
pub const LIMIT_BYTES: u64 = 200 * 1024 * 1024;
/// Thư mục resource chứa `artifacts-runtime/dist/lib` (tauri.conf.json `bundle.resources`).
const LIB_RESOURCE: &str = "artifacts-lib";
/// Nguồn thư viện hub ghi vào tài liệu khung cho app (`APP_LIB_BASE` trong hub `artifacts/frame-routes.ts`).
const HUB_APP_LIB_BASE: &str = "hive-artifact://localhost/lib/";
/// WebView2 không nhận giao thức riêng; Tauri phục vụ nó dưới `http://<tên>.localhost`.
const WINDOWS_LIB_BASE: &str = "http://hive-artifact.localhost/lib/";

/// Ghi và dọn bộ đệm lần lượt: hai lần ghi cùng lúc có thể cùng dọn và xoá quá tay.
static WRITE: Mutex<()> = Mutex::new(());

fn lib_base() -> &'static str {
    if cfg!(windows) {
        WINDOWS_LIB_BASE
    } else {
        HUB_APP_LIB_BASE
    }
}

/// Cùng chỉ thị với `buildCsp` của `@xdev-hive/artifacts-runtime`; `APP_FRAME_CSP` trong `src/lib/artifact-cache.ts`
/// được test bên TypeScript so với `buildCsp`, test ở đây so chuỗi này với file đó.
pub fn frame_csp(lib: &str) -> String {
    [
        "default-src 'none'".to_string(),
        format!("script-src 'unsafe-inline' {lib}"),
        format!("style-src 'unsafe-inline' {lib}"),
        "img-src data: blob:".into(),
        "connect-src 'none'".into(),
        "form-action 'none'".into(),
        "frame-src 'none'".into(),
        "base-uri 'none'".into(),
        "sandbox allow-scripts".into(),
    ]
    .join("; ")
}

// ---- Phạm vi -------------------------------------------------------------------------------------------------------

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Hồ sơ (hub) và tổ chức của bộ đệm. Chỉ dựng từ hub đã đăng ký và token trong keychain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    profile: String,
    org: String,
}

impl Scope {
    pub fn new(hub: &str, org: &str) -> Option<Scope> {
        if !is_uuid(org) {
            return None;
        }
        // Băm địa chỉ hub: tên thư mục không lộ địa chỉ và không mang ký tự lạ của URL.
        let normalized = hub.trim().trim_end_matches('/').to_ascii_lowercase();
        let digest = Sha256::digest(normalized.as_bytes());
        let profile = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
        Some(Scope {
            profile,
            org: org.to_ascii_lowercase(),
        })
    }

    pub fn of_token(hub: &str, token: &str) -> Option<Scope> {
        Scope::new(hub, crate::hub::org_of_pat(token)?)
    }
}

/// Phạm vi hiện tại của app; None khi chưa đăng ký máy hoặc chưa liên kết tài khoản.
fn current_scope(app: &AppHandle) -> Option<Scope> {
    let hub = crate::hub_of(app)?;
    let token = crate::account::stored_token(&hub)?;
    Scope::of_token(&hub, &token)
}

// ---- Bộ đệm --------------------------------------------------------------------------------------------------------

/// Một phiên bản đã đệm. `detail` là `ArtifactDetail` của hub, giữ nguyên để giao diện đọc như khi có mạng.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub version: u32,
    pub detail: Value,
    /// Tài liệu khung theo giao diện sáng/tối, cho loại chạy trong khung.
    #[serde(default)]
    pub frames: BTreeMap<String, String>,
    /// Lúc ghi (ms), cho nhãn "Bản đã tải lúc …".
    pub saved_at: u64,
}

/// Một dòng của danh sách bản đã tải, không có nội dung.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub version: u32,
    /// `ArtifactSummary` của hub lúc tải.
    pub artifact: Value,
    pub themes: Vec<String>,
    pub saved_at: u64,
    pub size_bytes: u64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FrameInput {
    pub theme: String,
    pub html: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PutInput {
    pub detail: Value,
    #[serde(default)]
    pub frame: Option<FrameInput>,
}

fn millis(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn version_file(name: &str) -> Option<u32> {
    name.strip_suffix(".json")?.parse().ok().filter(|v| *v > 0)
}

fn summary_of(entry: &Entry, size: u64) -> Summary {
    Summary {
        id: entry.id.clone(),
        version: entry.version,
        artifact: entry.detail["artifact"].clone(),
        themes: entry.frames.keys().cloned().collect(),
        saved_at: entry.saved_at,
        size_bytes: size,
    }
}

/// Bộ đệm trên đĩa. Lần dùng gần nhất là mtime của file: đọc thì chạm lại, đầy thì bỏ file cũ nhất (LRU).
pub struct Cache {
    root: PathBuf,
    limit: u64,
}

impl Cache {
    pub fn new(root: PathBuf, limit: u64) -> Cache {
        Cache { root, limit }
    }

    fn scope_dir(&self, scope: &Scope) -> PathBuf {
        self.root.join(&scope.profile).join(&scope.org)
    }

    fn entry_path(&self, scope: &Scope, id: &str, version: u32) -> PathBuf {
        self.scope_dir(scope)
            .join(id.to_ascii_lowercase())
            .join(format!("{version}.json"))
    }

    pub fn put(&self, scope: &Scope, input: PutInput, now: SystemTime) -> Result<Summary, String> {
        let id = input.detail["artifact"]["id"]
            .as_str()
            .filter(|id| is_uuid(id))
            .ok_or("Artifact không có id hợp lệ.")?
            .to_ascii_lowercase();
        let version = input.detail["version"]["version"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v > 0)
            .ok_or("Phiên bản artifact không hợp lệ.")?;
        let _guard = WRITE.lock().map_err(|e| e.to_string())?;
        let path = self.entry_path(scope, &id, version);
        // Cùng phiên bản mở ở giao diện kia: giữ tài liệu khung đã có, chỉ thêm hoặc thay giao diện vừa tải.
        let mut frames = read_entry(&path).map(|e| e.frames).unwrap_or_default();
        if let Some(frame) = input.frame {
            if frame.theme != "light" && frame.theme != "dark" {
                return Err("Giao diện của khung không hợp lệ.".into());
            }
            frames.insert(frame.theme, frame.html);
        }
        let entry = Entry {
            id,
            version,
            detail: input.detail,
            frames,
            saved_at: millis(now),
        };
        let body = serde_json::to_vec(&entry).map_err(|e| e.to_string())?;
        if body.len() as u64 > self.limit {
            return Err("Artifact quá lớn để lưu vào bộ đệm của app.".into());
        }
        let dir = path.parent().ok_or("Đường dẫn bộ đệm không hợp lệ.")?;
        fs::create_dir_all(dir).map_err(|e| format!("Không tạo được thư mục bộ đệm: {e}"))?;
        // Ghi file tạm rồi đổi tên: khung đang đọc không bao giờ thấy file ghi dở.
        let tmp = path.with_extension("json.tmp");
        let mut file = fs::File::create(&tmp).map_err(|e| format!("Không ghi được bộ đệm: {e}"))?;
        file.write_all(&body)
            .and_then(|_| file.set_modified(now))
            .map_err(|e| format!("Không ghi được bộ đệm: {e}"))?;
        drop(file);
        fs::rename(&tmp, &path).map_err(|e| format!("Không ghi được bộ đệm: {e}"))?;
        self.evict(&path)?;
        Ok(summary_of(&entry, body.len() as u64))
    }

    /// Một phiên bản; không nêu phiên bản thì bản mới nhất đã tải của artifact.
    pub fn get(
        &self,
        scope: &Scope,
        id: &str,
        version: Option<u32>,
        now: SystemTime,
    ) -> Option<Entry> {
        if !is_uuid(id) {
            return None;
        }
        let version = match version {
            Some(v) => v,
            None => fs::read_dir(self.scope_dir(scope).join(id.to_ascii_lowercase()))
                .ok()?
                .filter_map(|e| version_file(&e.ok()?.file_name().to_string_lossy()))
                .max()?,
        };
        let path = self.entry_path(scope, id, version);
        let entry = read_entry(&path)?;
        touch(&path, now);
        Some(entry)
    }

    pub fn list(&self, scope: &Scope) -> Vec<Summary> {
        let mut out: Vec<Summary> = files_under(&self.scope_dir(scope), 2)
            .into_iter()
            .filter_map(|(path, size, _)| Some(summary_of(&read_entry(&path)?, size)))
            .collect();
        out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at).then(b.version.cmp(&a.version)));
        out
    }

    /// Xoá bản đệm của các artifact nêu tên (mất quyền), hoặc cả phạm vi khi không nêu.
    pub fn clear(&self, scope: &Scope, ids: Option<&[String]>) -> Result<(), String> {
        let _guard = WRITE.lock().map_err(|e| e.to_string())?;
        let dir = self.scope_dir(scope);
        let targets: Vec<PathBuf> = match ids {
            Some(ids) => ids
                .iter()
                .filter(|id| is_uuid(id))
                .map(|id| dir.join(id.to_ascii_lowercase()))
                .collect(),
            None => vec![dir],
        };
        for target in targets {
            match fs::remove_dir_all(&target) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Không xoá được bộ đệm artifact: {e}")),
            }
        }
        // Hồ sơ không còn tổ chức nào thì bỏ luôn thư mục hồ sơ.
        let _ = fs::remove_dir(self.root.join(&scope.profile));
        Ok(())
    }

    /// Tài liệu khung cho giao thức; thiếu giao diện được hỏi thì dùng giao diện đã có.
    pub fn frame(
        &self,
        scope: &Scope,
        id: &str,
        version: u32,
        theme: Option<&str>,
        now: SystemTime,
    ) -> Option<String> {
        let mut entry = self.get(scope, id, Some(version), now)?;
        theme
            .and_then(|t| entry.frames.remove(t))
            .or_else(|| entry.frames.into_values().next())
    }

    /// Tổng dung lượng các bản đã đệm (mọi hồ sơ, tổ chức).
    #[cfg(test)]
    pub fn size(&self) -> u64 {
        files_under(&self.root, 4).iter().map(|(_, s, _)| s).sum()
    }

    fn evict(&self, keep: &Path) -> Result<(), String> {
        let mut files = files_under(&self.root, 4);
        let mut total: u64 = files.iter().map(|(_, s, _)| s).sum();
        if total <= self.limit {
            return Ok(());
        }
        files.sort_by_key(|(_, _, used)| *used);
        for (path, size, _) in files {
            if total <= self.limit {
                break;
            }
            if path == keep {
                continue;
            }
            if fs::remove_file(&path).is_ok() {
                total -= size;
                if let Some(dir) = path.parent() {
                    // Thư mục artifact rỗng sau khi bỏ bản cuối; còn file thì remove_dir lỗi và giữ nguyên.
                    let _ = fs::remove_dir(dir);
                }
            }
        }
        Ok(())
    }
}

fn read_entry(path: &Path) -> Option<Entry> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn touch(path: &Path, now: SystemTime) {
    if let Ok(file) = fs::File::options().write(true).open(path) {
        let _ = file.set_modified(now);
    }
}

/// File `<phiên bản>.json` nằm đúng `depth` tầng thư mục dưới `dir`: (đường dẫn, cỡ, lần dùng gần nhất).
fn files_under(dir: &Path, depth: usize) -> Vec<(PathBuf, u64, SystemTime)> {
    let Ok(read) = fs::read_dir(dir) else {
        return vec![];
    };
    let mut out = vec![];
    for entry in read.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if depth > 1 {
            if kind.is_dir() {
                out.extend(files_under(&path, depth - 1));
            }
        } else if kind.is_file()
            && version_file(&entry.file_name().to_string_lossy()).is_some()
            && let Ok(meta) = entry.metadata()
        {
            out.push((path, meta.len(), meta.modified().unwrap_or(UNIX_EPOCH)));
        }
    }
    out
}

fn cache_of(app: &AppHandle) -> Result<Cache, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Không tìm thấy thư mục dữ liệu của app: {e}"))?;
    Ok(Cache::new(dir.join("artifacts"), LIMIT_BYTES))
}

/// Xoá bộ đệm của token cũ (gỡ liên kết, đổi tài khoản hay tổ chức). Lỗi chỉ ghi log: không chặn việc đăng xuất.
pub fn forget(app: &AppHandle, hub: &str, token: &str) {
    let Some(scope) = Scope::of_token(hub, token) else {
        return;
    };
    match cache_of(app).and_then(|c| c.clear(&scope, None)) {
        Ok(()) => {}
        Err(e) => eprintln!("{e}"),
    }
}

// ---- Lệnh IPC ------------------------------------------------------------------------------------------------------

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Ghi phiên bản vừa mở (và tài liệu khung nếu có) vào bộ đệm của tài khoản đang liên kết.
#[tauri::command]
pub async fn artifact_cache_put(app: AppHandle, entry: PutInput) -> Result<Summary, String> {
    let scope =
        current_scope(&app).ok_or("Chưa liên kết tài khoản nên chưa lưu được bản đọc offline.")?;
    let cache = cache_of(&app)?;
    blocking(move || cache.put(&scope, entry, SystemTime::now())).await
}

#[tauri::command]
pub async fn artifact_cache_get(
    app: AppHandle,
    id: String,
    version: Option<u32>,
) -> Result<Option<Entry>, String> {
    let Some(scope) = current_scope(&app) else {
        return Ok(None);
    };
    let cache = cache_of(&app)?;
    blocking(move || Ok(cache.get(&scope, &id, version, SystemTime::now()))).await
}

#[tauri::command]
pub async fn artifact_cache_list(app: AppHandle) -> Result<Vec<Summary>, String> {
    let Some(scope) = current_scope(&app) else {
        return Ok(vec![]);
    };
    let cache = cache_of(&app)?;
    blocking(move || Ok(cache.list(&scope))).await
}

/// `ids`: bỏ bản đệm của artifact đã mất quyền hoặc bị xoá trên hub; không có thì xoá cả bộ đệm của tài khoản.
#[tauri::command]
pub async fn artifact_cache_clear(app: AppHandle, ids: Option<Vec<String>>) -> Result<(), String> {
    let Some(scope) = current_scope(&app) else {
        return Ok(());
    };
    let cache = cache_of(&app)?;
    blocking(move || cache.clear(&scope, ids.as_deref())).await
}

// ---- Giao thức hive-artifact ---------------------------------------------------------------------------------------

fn lib_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("css") => "text/css; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn plain(status: StatusCode, text: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        // Trang lỗi cũng có thể bị mở trực tiếp; không có lý do cho nó chạy gì.
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .body(text.as_bytes().to_vec())
        .unwrap_or_default()
}

/// File trong thư mục thư viện; chỉ nhận đoạn đường dẫn thường để không thoát ra ngoài resource.
fn lib_file(dir: &Path, rest: &str) -> Option<PathBuf> {
    let rel = Path::new(rest);
    if rest.is_empty()
        || rest.contains('\\')
        || !rel.components().all(|c| matches!(c, Component::Normal(_)))
    {
        return None;
    }
    let file = dir.join(rel);
    file.is_file().then_some(file)
}

/// Theme trong query `?theme=dark`.
fn theme_of(query: Option<&str>) -> Option<&str> {
    query?
        .split('&')
        .find_map(|kv| kv.strip_prefix("theme="))
        .filter(|t| *t == "light" || *t == "dark")
}

/// Trả lời một yêu cầu tới `hive-artifact`. Tách khỏi Tauri để test: bộ đệm, phạm vi và thư mục thư viện truyền vào.
pub fn serve(
    method: &str,
    path: &str,
    query: Option<&str>,
    frames: Option<(&Cache, &Scope)>,
    lib_dir: Option<&Path>,
    lib: &str,
    now: SystemTime,
) -> Response<Vec<u8>> {
    if method != "GET" {
        return plain(StatusCode::METHOD_NOT_ALLOWED, "Không hỗ trợ.");
    }
    if let Some(rest) = path.strip_prefix("/frame/") {
        let mut parts = rest.split('/');
        let (Some(id), Some(Ok(version)), None) = (
            parts.next(),
            parts.next().map(str::parse::<u32>),
            parts.next(),
        ) else {
            return plain(StatusCode::NOT_FOUND, "Không tìm thấy.");
        };
        let Some(html) =
            frames.and_then(|(cache, scope)| cache.frame(scope, id, version, theme_of(query), now))
        else {
            return plain(
                StatusCode::NOT_FOUND,
                "Phiên bản này chưa được tải về máy. Cần kết nối hub để mở.",
            );
        };
        // Hub dựng tài liệu với nguồn thư viện của macOS/Linux; Windows phục vụ giao thức dưới host khác.
        let html = if lib == HUB_APP_LIB_BASE {
            html
        } else {
            html.replace(HUB_APP_LIB_BASE, lib)
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_SECURITY_POLICY, frame_csp(lib))
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .header(header::REFERRER_POLICY, "no-referrer")
            .header(header::CACHE_CONTROL, "no-store")
            .body(html.into_bytes())
            .unwrap_or_default();
    }
    if let Some(rest) = path.strip_prefix("/lib/") {
        let Some(file) = lib_dir.and_then(|dir| lib_file(dir, rest)) else {
            return plain(StatusCode::NOT_FOUND, "Không tìm thấy.");
        };
        let Ok(body) = fs::read(&file) else {
            return plain(StatusCode::NOT_FOUND, "Không tìm thấy.");
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, lib_type(&file))
            // Khung là origin mờ (`Origin: null`) nên nạp module là yêu cầu CORS; thư viện là mã công khai.
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .body(body)
            .unwrap_or_default();
    }
    plain(StatusCode::NOT_FOUND, "Không tìm thấy.")
}

/// Handler đăng ký với Tauri. Chỉ cửa sổ app cục bộ được nạp: cửa sổ web của hub là trang từ xa, không cần và không
/// được dò bộ đệm trên máy.
pub fn protocol(
    ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if ctx.webview_label() != crate::APP {
        responder.respond(plain(StatusCode::FORBIDDEN, "Không được phép."));
        return;
    }
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let scope = current_scope(&app);
        let cache = cache_of(&app).ok();
        let lib_dir = app
            .path()
            .resolve(LIB_RESOURCE, BaseDirectory::Resource)
            .ok();
        let method = request.method().as_str().to_string();
        let path = request.uri().path().to_string();
        let query = request.uri().query().map(str::to_string);
        let response = tauri::async_runtime::spawn_blocking(move || {
            let frames = cache.as_ref().zip(scope.as_ref());
            serve(
                &method,
                &path,
                query.as_deref(),
                frames,
                lib_dir.as_deref(),
                lib_base(),
                SystemTime::now(),
            )
        })
        .await
        .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "Lỗi bộ đệm artifact."));
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    const ORG: &str = "0a0a0a0a-0000-4000-8000-00000000000a";
    const OTHER_ORG: &str = "0b0b0b0b-0000-4000-8000-00000000000b";

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hive-artifacts-{tag}-{}-{}",
            std::process::id(),
            millis(SystemTime::now())
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn id(n: u8) -> String {
        format!("{n:08x}-0000-4000-8000-000000000000")
    }

    fn detail(id: &str, version: u32, content: &str) -> Value {
        json!({
            "artifact": { "id": id, "title": "Báo cáo", "type": "html", "latestVersion": version },
            "version": { "version": version, "content": content, "compileError": null },
            "access": { "write": true, "manage": true, "owner": true }
        })
    }

    fn put(cache: &Cache, scope: &Scope, id: &str, version: u32, html: &str, at: u64) -> Summary {
        cache
            .put(
                scope,
                PutInput {
                    detail: detail(id, version, "<p>x</p>"),
                    frame: Some(FrameInput {
                        theme: "light".into(),
                        html: html.into(),
                    }),
                },
                UNIX_EPOCH + Duration::from_secs(at),
            )
            .unwrap()
    }

    fn scope() -> Scope {
        Scope::new("https://hive.acme.vn/", ORG).unwrap()
    }

    #[test]
    fn scope_comes_from_hub_and_token_org() {
        let token = format!("hive_pat_{ORG}_{}", "s".repeat(43));
        let s = Scope::of_token("https://hive.acme.vn", &token).unwrap();
        assert_eq!(s, scope(), "dấu / cuối và chữ hoa không đổi hồ sơ");
        assert_eq!(s.org, ORG);
        assert_eq!(s.profile.len(), 16);
        assert!(
            !s.profile.contains("acme"),
            "tên thư mục không lộ địa chỉ hub"
        );
        assert_ne!(
            Scope::new("https://other.vn", ORG).unwrap().profile,
            s.profile
        );
        assert!(Scope::new("https://hive.acme.vn", "../etc").is_none());
        assert!(Scope::of_token("https://hive.acme.vn", "hwm_machine").is_none());
    }

    #[test]
    fn stores_and_reads_versions_per_scope() {
        let root = temp("scope");
        let cache = Cache::new(root.clone(), LIMIT_BYTES);
        let a = id(1);
        put(&cache, &scope(), &a, 1, "<html>v1</html>", 10);
        put(&cache, &scope(), &a, 2, "<html>v2</html>", 20);
        let got = cache.get(&scope(), &a, Some(1), SystemTime::now()).unwrap();
        assert_eq!(got.version, 1);
        assert_eq!(got.detail["version"]["content"], "<p>x</p>");
        assert_eq!(got.saved_at, 10_000);
        // Không nêu phiên bản: bản mới nhất đã tải (mở offline).
        assert_eq!(
            cache
                .get(&scope(), &a, None, SystemTime::now())
                .unwrap()
                .version,
            2
        );
        // Tổ chức khác trên cùng hub không thấy bản đệm này.
        let other = Scope::new("https://hive.acme.vn", OTHER_ORG).unwrap();
        assert!(cache.get(&other, &a, Some(1), SystemTime::now()).is_none());
        assert!(cache.list(&other).is_empty());
        let list = cache.list(&scope());
        assert_eq!(
            list.iter().map(|s| s.version).collect::<Vec<_>>(),
            vec![2, 1]
        );
        assert_eq!(list[0].artifact["title"], "Báo cáo");
        assert_eq!(list[0].themes, vec!["light".to_string()]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn keeps_both_themes_of_a_version() {
        let root = temp("themes");
        let cache = Cache::new(root.clone(), LIMIT_BYTES);
        let a = id(1);
        put(&cache, &scope(), &a, 1, "light-doc", 10);
        cache
            .put(
                &scope(),
                PutInput {
                    detail: detail(&a, 1, "<p>x</p>"),
                    frame: Some(FrameInput {
                        theme: "dark".into(),
                        html: "dark-doc".into(),
                    }),
                },
                SystemTime::now(),
            )
            .unwrap();
        let now = SystemTime::now();
        assert_eq!(
            cache.frame(&scope(), &a, 1, Some("dark"), now).as_deref(),
            Some("dark-doc")
        );
        assert_eq!(
            cache.frame(&scope(), &a, 1, Some("light"), now).as_deref(),
            Some("light-doc")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_bad_ids_and_themes() {
        let root = temp("bad");
        let cache = Cache::new(root.clone(), LIMIT_BYTES);
        let bad = |detail: Value, theme: &str| {
            cache
                .put(
                    &scope(),
                    PutInput {
                        detail,
                        frame: Some(FrameInput {
                            theme: theme.into(),
                            html: "x".into(),
                        }),
                    },
                    SystemTime::now(),
                )
                .is_err()
        };
        assert!(bad(detail("../../etc", 1, "x"), "light"));
        assert!(bad(detail(&id(1), 0, "x"), "light"));
        assert!(bad(detail(&id(1), 1, "x"), "neon"));
        assert!(
            cache
                .get(&scope(), "../x", None, SystemTime::now())
                .is_none()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn evicts_least_recently_used_when_full() {
        let root = temp("lru");
        let cache = Cache::new(root.clone(), 10_000);
        let big = "x".repeat(3_000);
        let (a, b, c, d) = (id(1), id(2), id(3), id(4));
        put(&cache, &scope(), &a, 1, &big, 10);
        put(&cache, &scope(), &b, 1, &big, 20);
        put(&cache, &scope(), &c, 1, &big, 30);
        // Mở lại A: A thành bản dùng gần nhất, B là bản cũ nhất.
        assert!(
            cache
                .get(&scope(), &a, Some(1), UNIX_EPOCH + Duration::from_secs(40))
                .is_some()
        );
        put(&cache, &scope(), &d, 1, &big, 50);
        let now = UNIX_EPOCH + Duration::from_secs(60);
        assert!(cache.get(&scope(), &b, Some(1), now).is_none(), "B bị bỏ");
        for kept in [&a, &c, &d] {
            assert!(cache.get(&scope(), kept, Some(1), now).is_some());
        }
        assert!(cache.size() <= 10_000);
        // Một bản lớn hơn cả trần thì từ chối, không xoá sạch bộ đệm để chứa nó.
        let huge = cache.put(
            &scope(),
            PutInput {
                detail: detail(&id(5), 1, &"y".repeat(20_000)),
                frame: None,
            },
            now,
        );
        assert!(huge.is_err());
        assert_eq!(cache.list(&scope()).len(), 3);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn clears_one_scope_or_some_artifacts() {
        let root = temp("clear");
        let cache = Cache::new(root.clone(), LIMIT_BYTES);
        let other = Scope::new("https://hive.acme.vn", OTHER_ORG).unwrap();
        let (a, b) = (id(1), id(2));
        put(&cache, &scope(), &a, 1, "a", 10);
        put(&cache, &scope(), &b, 1, "b", 10);
        put(&cache, &other, &a, 1, "a", 10);
        // Mất quyền với B: chỉ B đi.
        cache
            .clear(&scope(), Some(std::slice::from_ref(&b)))
            .unwrap();
        assert_eq!(cache.list(&scope()).len(), 1);
        // Đăng xuất (phạm vi này): tổ chức khác giữ nguyên.
        cache.clear(&scope(), None).unwrap();
        assert!(cache.list(&scope()).is_empty());
        assert_eq!(cache.list(&other).len(), 1);
        // Xoá lần nữa khi đã trống không lỗi.
        cache.clear(&scope(), None).unwrap();
        cache.clear(&other, None).unwrap();
        assert_eq!(cache.size(), 0);
        let _ = fs::remove_dir_all(root);
    }

    fn header(r: &Response<Vec<u8>>, name: header::HeaderName) -> &str {
        r.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    }

    #[test]
    fn serves_cached_frames_with_the_hub_csp() {
        let root = temp("serve");
        let cache = Cache::new(root.join("cache"), LIMIT_BYTES);
        let a = id(1);
        let doc = format!(
            r#"<script type="importmap">{{"react":"{HUB_APP_LIB_BASE}react@19/index.js"}}</script>"#
        );
        put(&cache, &scope(), &a, 1, &doc, 10);
        let now = SystemTime::now();
        let s = scope();
        let frames = Some((&cache, &s));
        let r = serve(
            "GET",
            &format!("/frame/{a}/1"),
            Some("theme=light"),
            frames,
            None,
            HUB_APP_LIB_BASE,
            now,
        );
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(String::from_utf8_lossy(r.body()), doc);
        assert_eq!(
            header(&r, header::CONTENT_SECURITY_POLICY),
            frame_csp(HUB_APP_LIB_BASE)
        );
        assert!(header(&r, header::CONTENT_SECURITY_POLICY).contains("connect-src 'none'"));
        assert!(header(&r, header::CONTENT_SECURITY_POLICY).ends_with("sandbox allow-scripts"));
        assert_eq!(header(&r, header::CONTENT_TYPE), "text/html; charset=utf-8");
        assert_eq!(header(&r, header::X_CONTENT_TYPE_OPTIONS), "nosniff");
        // Windows: thư viện và CSP cùng đổi sang host của WebView2.
        let w = serve(
            "GET",
            &format!("/frame/{a}/1"),
            None,
            frames,
            None,
            WINDOWS_LIB_BASE,
            now,
        );
        let body = String::from_utf8_lossy(w.body()).to_string();
        assert!(body.contains("http://hive-artifact.localhost/lib/react@19/index.js"));
        assert!(!body.contains(HUB_APP_LIB_BASE));
        assert_eq!(
            header(&w, header::CONTENT_SECURITY_POLICY),
            frame_csp(WINDOWS_LIB_BASE)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_frames_and_unknown_paths_are_404() {
        let root = temp("404");
        let cache = Cache::new(root.clone(), LIMIT_BYTES);
        let s = scope();
        let now = SystemTime::now();
        for path in [
            format!("/frame/{}/1", id(9)),
            format!("/frame/{}/x", id(9)),
            format!("/frame/{}/1/extra", id(9)),
            "/frame/../../etc/passwd".to_string(),
            "/other".to_string(),
        ] {
            let r = serve(
                "GET",
                &path,
                None,
                Some((&cache, &s)),
                None,
                HUB_APP_LIB_BASE,
                now,
            );
            assert_eq!(r.status(), StatusCode::NOT_FOUND, "{path}");
            assert_eq!(
                header(&r, header::CONTENT_SECURITY_POLICY),
                "default-src 'none'; sandbox"
            );
        }
        // Chưa liên kết tài khoản: không có phạm vi, khung nào cũng 404.
        let r = serve(
            "GET",
            &format!("/frame/{}/1", id(9)),
            None,
            None,
            None,
            HUB_APP_LIB_BASE,
            now,
        );
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        let r = serve("POST", "/lib/x.js", None, None, None, HUB_APP_LIB_BASE, now);
        assert_eq!(r.status(), StatusCode::METHOD_NOT_ALLOWED);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn serves_libs_with_cors_and_stays_inside_the_resource() {
        let root = temp("lib");
        let lib = root.join("lib");
        fs::create_dir_all(lib.join("react@19")).unwrap();
        fs::write(lib.join("react@19/index.js"), "export default 1;").unwrap();
        fs::write(root.join("secret.txt"), "no").unwrap();
        let now = SystemTime::now();
        let r = serve(
            "GET",
            "/lib/react@19/index.js",
            None,
            None,
            Some(&lib),
            HUB_APP_LIB_BASE,
            now,
        );
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.body(), b"export default 1;");
        assert_eq!(header(&r, header::ACCESS_CONTROL_ALLOW_ORIGIN), "*");
        assert_eq!(
            header(&r, header::CONTENT_TYPE),
            "text/javascript; charset=utf-8"
        );
        for path in [
            "/lib/../secret.txt",
            "/lib/react@19/../../secret.txt",
            "/lib/..\\secret.txt",
            "/lib/",
            "/lib/react@19",
            "/lib/missing.js",
        ] {
            let r = serve("GET", path, None, None, Some(&lib), HUB_APP_LIB_BASE, now);
            assert_eq!(r.status(), StatusCode::NOT_FOUND, "{path}");
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn csp_matches_the_one_checked_against_the_runtime() {
        // src/lib/artifact-cache.test.ts kiểm APP_FRAME_CSP bằng buildCsp của @xdev-hive/artifacts-runtime.
        let ts = include_str!("../../src/lib/artifact-cache.ts");
        assert!(
            ts.contains(&format!("\"{}\"", frame_csp(HUB_APP_LIB_BASE))),
            "APP_FRAME_CSP trong artifact-cache.ts lệch khỏi frame_csp"
        );
        assert!(ts.contains(HUB_APP_LIB_BASE) && ts.contains("http://hive-artifact.localhost/"));
    }

    #[test]
    fn app_csp_allows_only_the_artifact_frames() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        assert!(csp.contains("frame-src hive-artifact: http://hive-artifact.localhost"));
        assert!(csp.starts_with("default-src 'self'"));
        let resources = &conf["bundle"]["resources"];
        assert!(
            resources
                .as_object()
                .is_some_and(|m| m.values().any(|v| v == &json!(format!("{LIB_RESOURCE}/")))),
            "thư viện của khung phải nằm trong resource của app"
        );
    }
}
