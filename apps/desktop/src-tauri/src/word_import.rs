//! Nhập Word từ app desktop (spec 019): chọn file hay thư mục bằng hộp thoại của hệ điều hành, gửi lên hub theo luồng
//! (multipart) bằng token cá nhân trong keychain, và tải ảnh xem trước, file gốc, đính kèm về dạng byte. Giao diện
//! không bao giờ thấy token, cũng không chỉ được Rust đọc một file bất kỳ trên máy.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const PROGRESS: &str = "word-import:progress";
const EXTENSIONS: [&str; 3] = ["docx", "odt", "doc"];
// Cùng `WORD_IMPORT_DEFAULT_LIMITS` và câu của `WORD_IMPORT_ERRORS` (packages/contracts). Hub kiểm lại theo cấu hình của
// nó; chặn ở đây để khỏi đẩy hàng trăm MB lên rồi mới bị từ chối.
const FILE_BYTES: u64 = 50 * 1024 * 1024;
const BATCH_FILES: usize = 100;
const BATCH_BYTES: u64 = 500 * 1024 * 1024;
const FILE_TOO_LARGE: &str =
    "File Word vượt giới hạn dung lượng. Nén ảnh trong Word hoặc tách thành nhiều file.";
const BATCH_TOO_LARGE: &str =
    "Lượt nhập vượt giới hạn số file hoặc dung lượng. Chia thành nhiều lượt nhỏ hơn.";
// Chọn nhầm thư mục gốc ổ đĩa thì dừng sớm thay vì liệt kê hàng chục nghìn file.
const MAX_LISTED: usize = 1000;
const MAX_DEPTH: usize = 32;
const KEEP_PICKS: usize = 8;
const CHUNK: usize = 64 * 1024;
const REPORT_EVERY: u64 = 512 * 1024;
// Lượt 500 MB qua mạng chậm vẫn phải xong; lỗi mạng thật thì reqwest báo sớm hơn nhiều.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
const FETCH_MAX: usize = 60 * 1024 * 1024;
const NOT_LINKED: &str =
    "Chưa liên kết tài khoản. Đăng nhập bằng trình duyệt hoặc dán token cá nhân ở mục Tài khoản.";
const BAD_TOKEN: &str = "Token đã lưu không đúng dạng; liên kết lại tài khoản.";

#[derive(Clone, Debug)]
struct Picked {
    path: PathBuf,
    name: String,
    relative_dir: String,
    size: u64,
    last_modified: Option<u64>,
}

/// Các lần chọn gần nhất. Giao diện chỉ gửi lại mã lần chọn và số thứ tự file, nên không thể bảo Rust đọc rồi gửi một
/// file khác lên hub.
#[derive(Default)]
pub struct Picks(Mutex<VecDeque<(String, Vec<Picked>)>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordFile {
    pub index: usize,
    pub name: String,
    /// Thư mục con dưới thư mục đã chọn, nối bằng `/`; rỗng là nằm thẳng trong đó. Hub nhận đúng dạng này.
    pub relative_dir: String,
    pub relative_path: String,
    pub size: u64,
    pub last_modified: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordPick {
    pub pick_id: String,
    /// Thư mục đã chọn; chọn file lẻ thì không có.
    pub root: Option<String>,
    pub files: Vec<WordFile>,
    /// Thư mục có quá nhiều file Word, danh sách đã dừng ở `MAX_LISTED`.
    pub truncated: bool,
}

fn is_word(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

fn modified_ms(meta: &std::fs::Metadata) -> Option<u64> {
    let since = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(since.as_millis()).ok()
}

fn picked(path: PathBuf, relative_dir: String) -> Option<Picked> {
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let name = path.file_name()?.to_string_lossy().into_owned();
    Some(Picked {
        size: meta.len(),
        last_modified: modified_ms(&meta),
        name,
        relative_dir,
        path,
    })
}

/// File Word trong thư mục, gồm thư mục con. Không theo symlink (kể cả junction trên Windows): một liên kết tới `~` hay
/// vòng lặp sẽ kéo cả ổ đĩa vào lượt nhập. Bỏ mục ẩn và file khoá `~$…` Word tạo khi đang mở tài liệu.
fn walk(root: &Path) -> (Vec<Picked>, bool) {
    let mut found = Vec::new();
    let mut truncated = false;
    let mut stack = vec![(root.to_path_buf(), Vec::<String>::new())];
    'walk: while let Some((dir, parts)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_symlink() || name.starts_with('.') || name.starts_with("~$") {
                continue;
            }
            if kind.is_dir() {
                if parts.len() < MAX_DEPTH {
                    let mut sub = parts.clone();
                    sub.push(name);
                    stack.push((entry.path(), sub));
                }
            } else if kind.is_file() && is_word(&entry.path()) {
                if found.len() >= MAX_LISTED {
                    truncated = true;
                    break 'walk;
                }
                if let Some(file) = picked(entry.path(), parts.join("/")) {
                    found.push(file);
                }
            }
        }
    }
    found.sort_by(|a, b| (&a.relative_dir, &a.name).cmp(&(&b.relative_dir, &b.name)));
    (found, truncated)
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| format!("Không tạo được số ngẫu nhiên: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Hộp thoại chọn file Word (`folder = false`) hoặc thư mục (`true`). Người dùng bấm Huỷ thì trả `None`.
#[tauri::command]
pub async fn pick_word_files(app: AppHandle, folder: bool) -> Result<Option<WordPick>, String> {
    let dialog = app.clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        if folder {
            let root = dialog
                .dialog()
                .file()
                .set_title("Chọn thư mục chứa file Word")
                .blocking_pick_folder()?
                .into_path()
                .ok()?;
            let (files, truncated) = walk(&root);
            Some((Some(root.display().to_string()), files, truncated))
        } else {
            let files = dialog
                .dialog()
                .file()
                .set_title("Chọn file Word")
                .add_filter("Word", &EXTENSIONS)
                .blocking_pick_files()?
                .into_iter()
                .filter_map(|p| p.into_path().ok())
                .filter(|p| is_word(p))
                .filter_map(|p| picked(p, String::new()))
                .collect();
            Some((None, files, false))
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some((root, files, truncated)) = chosen else {
        return Ok(None);
    };
    let pick_id = random_hex(16)?;
    let listed = files
        .iter()
        .enumerate()
        .map(|(index, f)| WordFile {
            index,
            name: f.name.clone(),
            relative_dir: f.relative_dir.clone(),
            relative_path: if f.relative_dir.is_empty() {
                f.name.clone()
            } else {
                format!("{}/{}", f.relative_dir, f.name)
            },
            size: f.size,
            last_modified: f.last_modified,
        })
        .collect();
    {
        let picks = app.state::<Picks>();
        let mut kept = picks.0.lock().map_err(|e| e.to_string())?;
        kept.push_back((pick_id.clone(), files));
        while kept.len() > KEEP_PICKS {
            kept.pop_front();
        }
    }
    Ok(Some(WordPick {
        pick_id,
        root,
        files: listed,
        truncated,
    }))
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UploadInput {
    pub home_id: String,
    pub target_dir: Option<String>,
    pub mode: Option<String>,
    pub doc_key: Option<String>,
    pub confidential: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadReply {
    pub import_id: String,
}

/// Lỗi cùng dạng với lỗi oRPC của hub (`{ status, code, message, data }`) để giao diện báo như các màn khác: 401 là token
/// hỏng, `data.code` là mã lỗi nhập Word. `status` 0 là không tới được hub.
#[derive(Serialize, Debug)]
pub struct UploadError {
    pub status: u16,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl UploadError {
    fn bad(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            code: "BAD_REQUEST".into(),
            message: message.into(),
            data: None,
        }
    }

    fn limit(code: &str, message: String, limit: u64) -> Self {
        Self {
            data: Some(json!({ "code": code, "limit": limit })),
            ..Self::bad(message)
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: 401,
            code: "UNAUTHORIZED".into(),
            message: message.into(),
            data: None,
        }
    }

    fn network(message: impl Into<String>) -> Self {
        Self {
            status: 0,
            code: "NETWORK_ERROR".into(),
            message: message.into(),
            data: None,
        }
    }
}

fn batch_too_large() -> UploadError {
    UploadError::limit(
        "WORD_IMPORT_BATCH_TOO_LARGE",
        BATCH_TOO_LARGE.into(),
        BATCH_BYTES,
    )
}

/// Hub, token và tổ chức của lời gọi. Tách khỏi `AppHandle` để test gọi thẳng vào máy chủ giả.
#[derive(Clone, Copy)]
struct Hub<'a> {
    url: &'a str,
    token: &'a str,
    org: &'a str,
}

fn form_fields(input: &UploadInput) -> Result<Vec<(&'static str, String)>, UploadError> {
    let mode = input.mode.as_deref().unwrap_or("create");
    if !["create", "update", "link"].contains(&mode) {
        return Err(UploadError::bad("Cách nhập Word không hợp lệ."));
    }
    let mut fields = vec![("homeId", input.home_id.clone()), ("mode", mode.to_string())];
    if let Some(dir) = &input.target_dir {
        fields.push(("targetDir", dir.clone()));
    }
    if let Some(key) = &input.doc_key {
        fields.push(("docKey", key.clone()));
    }
    if let Some(flag) = input.confidential {
        fields.push(("confidential", flag.to_string()));
    }
    // Giá trị nằm giữa các dòng của multipart: xuống dòng trong đó sẽ mở ra một phần mới.
    if fields
        .iter()
        .any(|(_, v)| v.contains(|c: char| c == '\r' || c == '\n'))
    {
        return Err(UploadError::bad("Dữ liệu nhập Word không hợp lệ."));
    }
    Ok(fields)
}

fn chosen_files(
    picks: &Picks,
    pick_id: &str,
    indexes: &[usize],
) -> Result<Vec<(usize, Picked)>, UploadError> {
    let kept = picks
        .0
        .lock()
        .map_err(|_| UploadError::bad("Không đọc được danh sách file đã chọn."))?;
    let (_, files) = kept
        .iter()
        .find(|(id, _)| id == pick_id)
        .ok_or_else(|| UploadError::bad("Danh sách file đã cũ. Chọn lại file Word."))?;
    indexes
        .iter()
        .map(|&i| {
            files
                .get(i)
                .map(|f| (i, f.clone()))
                .ok_or_else(|| UploadError::bad("File đã chọn không còn trong danh sách."))
        })
        .collect()
}

/// Đọc lại kích thước ngay trước khi gửi (file có thể đã đổi sau lúc chọn) rồi chặn lượt vượt giới hạn trước khi đẩy byte
/// nào lên hub.
fn check_batch(files: &mut [(usize, Picked)]) -> Result<(), UploadError> {
    if files.is_empty() {
        return Err(UploadError::bad("Chưa chọn file Word nào."));
    }
    if files.len() > BATCH_FILES {
        return Err(batch_too_large());
    }
    let mut total = 0u64;
    for (_, file) in files.iter_mut() {
        if !is_word(&file.path) {
            return Err(UploadError::bad(format!(
                "{}: Chỉ nhận file .docx, .odt, .doc.",
                file.name
            )));
        }
        let meta = std::fs::metadata(&file.path)
            .ok()
            .filter(|m| m.is_file())
            .ok_or_else(|| UploadError::bad(format!("{}: Không đọc được file.", file.name)))?;
        file.size = meta.len();
        file.last_modified = modified_ms(&meta);
        if file.size > FILE_BYTES {
            return Err(UploadError::limit(
                "WORD_IMPORT_FILE_TOO_LARGE",
                format!("{}: {FILE_TOO_LARGE}", file.name),
                FILE_BYTES,
            ));
        }
        total += file.size;
    }
    if total > BATCH_BYTES {
        return Err(batch_too_large());
    }
    Ok(())
}

fn content_type_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("odt") => "application/vnd.oasis.opendocument.text",
        Some("doc") => "application/msword",
        _ => "application/octet-stream",
    }
}

/// Tên file trong `filename="…"` thoát như trình duyệt (RFC 7578); hub đọc lại đúng cách này (multipart.ts).
fn quoted(name: &str) -> String {
    name.replace('"', "%22")
        .replace('\r', "%0D")
        .replace('\n', "%0A")
}

enum Part {
    Bytes(Vec<u8>),
    File { index: usize, file: Picked },
}

fn field(boundary: &str, name: &str, value: &str) -> String {
    format!("--{boundary}\r\ncontent-disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
}

/// Thân multipart: trường chữ trước, file sau, như form của web. Độ dài tính trước để gửi `content-length`: hub từ chối
/// lượt quá lớn ngay từ header thay vì nhận hết rồi mới đếm.
fn multipart(
    boundary: &str,
    fields: &[(&str, String)],
    files: &[(usize, Picked)],
) -> (VecDeque<Part>, u64) {
    let mut parts = VecDeque::new();
    let mut head = String::new();
    for (name, value) in fields {
        head.push_str(&field(boundary, name, value));
    }
    for (_, file) in files {
        head.push_str(&field(boundary, "relativePaths", &file.relative_dir));
    }
    // Hub cần đủ một giá trị cho mỗi file hoặc không có giá trị nào.
    if files.iter().all(|(_, f)| f.last_modified.is_some()) {
        for (_, file) in files {
            let ms = file.last_modified.unwrap_or_default().to_string();
            head.push_str(&field(boundary, "lastModified", &ms));
        }
    }
    for (index, file) in files {
        head.push_str(&format!(
            "--{boundary}\r\ncontent-disposition: form-data; name=\"files\"; filename=\"{}\"\r\ncontent-type: {}\r\n\r\n",
            quoted(&file.name),
            content_type_of(&file.path)
        ));
        parts.push_back(Part::Bytes(std::mem::take(&mut head).into_bytes()));
        parts.push_back(Part::File {
            index: *index,
            file: file.clone(),
        });
        head.push_str("\r\n");
    }
    head.push_str(&format!("--{boundary}--\r\n"));
    parts.push_back(Part::Bytes(head.into_bytes()));
    let length: u64 = parts
        .iter()
        .map(|p| match p {
            Part::Bytes(b) => b.len() as u64,
            Part::File { file, .. } => file.size,
        })
        .sum();
    (parts, length)
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub upload_id: String,
    /// Số thứ tự file trong lần chọn (`WordFile.index`).
    pub index: usize,
    pub name: String,
    pub sent: u64,
    pub size: u64,
}

type Reporter = Arc<dyn Fn(Progress) + Send + Sync>;

struct Open {
    index: usize,
    file: Picked,
    handle: tokio::fs::File,
    sent: u64,
    reported: u64,
}

struct Sending {
    upload_id: String,
    parts: VecDeque<Part>,
    open: Option<Open>,
    report: Reporter,
    /// Câu lỗi tiếng Việt khi file đổi giữa chừng: reqwest chỉ trả lỗi chung của body.
    failure: Arc<Mutex<Option<String>>>,
}

impl Sending {
    fn progress(&self, open: &Open) {
        (self.report)(Progress {
            upload_id: self.upload_id.clone(),
            index: open.index,
            name: open.file.name.clone(),
            sent: open.sent,
            size: open.file.size,
        });
    }

    fn fail(&self, name: &str) -> std::io::Error {
        let message = format!("{name}: File đã thay đổi trong lúc gửi. Chọn lại file rồi gửi lại.");
        if let Ok(mut failure) = self.failure.lock() {
            *failure = Some(message.clone());
        }
        std::io::Error::other(message)
    }
}

/// Đọc từng đoạn 64 KiB từ đĩa nên lượt 500 MB không nằm trọn trong bộ nhớ. Báo tiến độ khi bắt đầu mỗi file, mỗi
/// `REPORT_EVERY` byte và khi gửi xong file.
fn body_stream(
    sending: Sending,
) -> impl futures_util::stream::Stream<Item = Result<Vec<u8>, std::io::Error>> + Send + 'static {
    futures_util::stream::try_unfold(sending, |mut s| async move {
        use tokio::io::AsyncReadExt;
        loop {
            if let Some(mut open) = s.open.take() {
                let left = open.file.size - open.sent;
                if left == 0 {
                    continue;
                }
                let mut buf = vec![0u8; usize::try_from(left).unwrap_or(CHUNK).min(CHUNK)];
                let read = match open.handle.read(&mut buf).await {
                    Ok(0) | Err(_) => return Err(s.fail(&open.file.name)),
                    Ok(n) => n,
                };
                buf.truncate(read);
                open.sent += read as u64;
                if open.sent == open.file.size || open.sent - open.reported >= REPORT_EVERY {
                    open.reported = open.sent;
                    s.progress(&open);
                }
                s.open = Some(open);
                return Ok(Some((buf, s)));
            }
            match s.parts.pop_front() {
                None => return Ok(None),
                Some(Part::Bytes(bytes)) => return Ok(Some((bytes, s))),
                Some(Part::File { index, file }) => {
                    let handle = match tokio::fs::File::open(&file.path).await {
                        Ok(h) => h,
                        Err(_) => return Err(s.fail(&file.name)),
                    };
                    // Độ dài đã nằm trong `content-length`: file to ra hay nhỏ đi sau lúc kiểm thì dừng, không gửi lệch.
                    match handle.metadata().await {
                        Ok(meta) if meta.len() == file.size => {}
                        _ => return Err(s.fail(&file.name)),
                    }
                    let open = Open {
                        index,
                        file,
                        handle,
                        sent: 0,
                        reported: 0,
                    };
                    s.progress(&open);
                    s.open = Some(open);
                }
            }
        }
    })
}

/// Lỗi hub trả về giữ nguyên mã và câu tiếng Việt; 401 vẫn là `UNAUTHORIZED` như các màn gọi qua `hub_rpc`.
fn hub_error(status: u16, text: &str) -> UploadError {
    let body: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let code = body["code"].as_str().map(str::to_string).unwrap_or_else(|| {
        if status == 401 {
            "UNAUTHORIZED".into()
        } else {
            "HUB_ERROR".into()
        }
    });
    let message = body["message"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| format!("Hub trả mã {status}."));
    UploadError {
        status,
        code,
        message,
        data: body.get("data").cloned(),
    }
}

/// Không để token lọt ra giao diện, kể cả khi hub hay máy chủ ở giữa lặp lại header trong câu lỗi.
fn scrub(mut error: UploadError, token: &str) -> UploadError {
    if token.is_empty() {
        return error;
    }
    error.message = error.message.replace(token, "…");
    error.data = error.data.map(|data| {
        let text = data.to_string();
        if text.contains(token) {
            serde_json::from_str(&text.replace(token, "…")).unwrap_or(Value::Null)
        } else {
            data
        }
    });
    error
}

async fn upload_files(
    client: &reqwest::Client,
    hub: Hub<'_>,
    upload_id: &str,
    fields: &[(&'static str, String)],
    files: Vec<(usize, Picked)>,
    report: Reporter,
) -> Result<String, UploadError> {
    send_files(client, hub, upload_id, fields, files, report)
        .await
        .map_err(|e| scrub(e, hub.token))
}

async fn send_files(
    client: &reqwest::Client,
    hub: Hub<'_>,
    upload_id: &str,
    fields: &[(&'static str, String)],
    mut files: Vec<(usize, Picked)>,
    report: Reporter,
) -> Result<String, UploadError> {
    check_batch(&mut files)?;
    let boundary = format!("xdev-hive-{}", random_hex(16).map_err(UploadError::bad)?);
    let (parts, length) = multipart(&boundary, fields, &files);
    let failure = Arc::new(Mutex::new(None));
    let body = reqwest::Body::wrap_stream(body_stream(Sending {
        upload_id: upload_id.to_string(),
        parts,
        open: None,
        report,
        failure: failure.clone(),
    }));
    let url = format!("{}/api/v1/docs/word-imports", hub.url.trim_end_matches('/'));
    let sent = client
        .post(&url)
        .timeout(UPLOAD_TIMEOUT)
        .header("authorization", format!("Bearer {}", hub.token))
        .header("x-hive-org", hub.org)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .header("content-length", length.to_string())
        .body(body)
        .send()
        .await;
    let response = match sent {
        Ok(response) => response,
        Err(e) => {
            let changed = failure.lock().ok().and_then(|f| f.clone());
            return Err(match changed {
                Some(message) => UploadError::bad(message),
                None => UploadError::network(format!(
                    "Không gửi được file lên hub: {}",
                    e.without_url()
                )),
            });
        }
    };
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(hub_error(status, &text));
    }
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v["importId"].as_str().map(str::to_string))
        .ok_or_else(|| UploadError {
            status,
            code: "HUB_ERROR".into(),
            message: "Hub trả dữ liệu không đọc được.".into(),
            data: None,
        })
}

/// Gửi các file của một lần chọn lên `POST /api/v1/docs/word-imports`. Tiến độ phát qua sự kiện `word-import:progress`
/// kèm `uploadId` của giao diện để phân biệt hai lượt gửi cùng lúc.
#[tauri::command]
pub async fn hub_upload_word(
    app: AppHandle,
    upload_id: String,
    pick_id: String,
    indexes: Vec<usize>,
    input: UploadInput,
) -> Result<UploadReply, UploadError> {
    let fields = form_fields(&input)?;
    let files = chosen_files(&app.state::<Picks>(), &pick_id, &indexes)?;
    let hub = crate::hub_of(&app).ok_or_else(|| UploadError::bad("Máy chưa đăng ký với hub nào."))?;
    let token =
        crate::account::stored_token(&hub).ok_or_else(|| UploadError::unauthorized(NOT_LINKED))?;
    let org = crate::hub::org_of_pat(&token)
        .ok_or_else(|| UploadError::unauthorized(BAD_TOKEN))?
        .to_string();
    let client = crate::tls::client().map_err(UploadError::network)?;
    let emitter = app.clone();
    let report: Reporter = Arc::new(move |progress: Progress| {
        let _ = emitter.emit_to(crate::APP, PROGRESS, progress);
    });
    let target = Hub {
        url: &hub,
        token: &token,
        org: &org,
    };
    let import_id = upload_files(&client, target, &upload_id, &fields, files, report).await?;
    Ok(UploadReply { import_id })
}

fn is_id(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Đường dẫn giao diện được tải về dạng byte: ảnh xem trước và file gốc của lượt nhập Word, đính kèm của tài liệu. Kiểm
/// như `safe_rpc_path`: không thoát khỏi hub, không mở ra route nào khác.
pub fn safe_bytes_path(path: &str) -> bool {
    if path.contains("..")
        || path.contains("//")
        || !path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/_-.?=&%+".contains(c))
    {
        return false;
    }
    if let Some(rest) = path.strip_prefix("/api/v1/docs/word-imports/") {
        let parts: Vec<&str> = rest.split('/').collect();
        return match parts.as_slice() {
            [import, "files", file, "media", name] => {
                is_id(import) && is_id(file) && !name.is_empty() && !name.contains('?')
            }
            [import, "files", file, "original"] => is_id(import) && is_id(file),
            _ => false,
        };
    }
    match path.strip_prefix("/api/v1/docs/assets") {
        Some(rest) if rest.starts_with('?') => true,
        Some(rest) => rest
            .strip_prefix('/')
            .is_some_and(|r| is_id(r.split('?').next().unwrap_or_default())),
        None => false,
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BytesReply {
    pub status: u16,
    pub content_type: String,
    pub base64: String,
}

async fn fetch_bytes(
    client: &reqwest::Client,
    hub: Hub<'_>,
    path: &str,
) -> Result<BytesReply, String> {
    let url = format!("{}{}", hub.url.trim_end_matches('/'), path);
    let mut response = client
        .get(&url)
        .timeout(FETCH_TIMEOUT)
        .header("authorization", format!("Bearer {}", hub.token))
        .header("x-hive-org", hub.org)
        .send()
        .await
        .map_err(|e| format!("Không gọi được hub: {}", e.without_url()))?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let too_large = || "File quá lớn để mở trong app.".to_string();
    if response.content_length().is_some_and(|n| n > FETCH_MAX as u64) {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Không đọc được trả lời của hub: {}", e.without_url()))?
    {
        if bytes.len() + chunk.len() > FETCH_MAX {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    use base64::Engine;
    Ok(BytesReply {
        status,
        content_type,
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

/// `GET` một đường dẫn của hub bằng token cá nhân, trả byte (base64) và `content-type`. Mã lỗi của hub trả nguyên như
/// `hub_rpc` để giao diện tự báo.
#[tauri::command]
pub async fn hub_fetch_bytes(app: AppHandle, path: String) -> Result<BytesReply, String> {
    if !safe_bytes_path(&path) {
        return Err("Đường dẫn không hợp lệ.".into());
    }
    let hub = crate::hub_of(&app).ok_or("Máy chưa đăng ký với hub nào.")?;
    let token = crate::account::stored_token(&hub).ok_or(NOT_LINKED)?;
    let org = crate::hub::org_of_pat(&token).ok_or(BAD_TOKEN)?;
    let client = crate::tls::client()?;
    let target = Hub {
        url: &hub,
        token: &token,
        org,
    };
    fetch_bytes(&client, target, &path)
        .await
        .map_err(|e| e.replace(token.as_str(), "…"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    const ORG: &str = "0a0a0a0a-0000-4000-8000-00000000000a";

    fn token() -> String {
        format!("hive_pat_{ORG}_{}", "s".repeat(43))
    }

    struct Seen {
        head: String,
        body: Vec<u8>,
    }

    /// Máy chủ HTTP giả trong tiến trình: đọc header, đọc đủ `content-length` byte của body, ghi lại rồi trả `reply`.
    fn serve(status: u16, content_type: &str, reply: Vec<u8>) -> (String, Arc<Mutex<Vec<Seen>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let content_type = content_type.to_string();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    head.push_str(&line);
                }
                let length = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                    })
                    .unwrap_or(0);
                let mut body = vec![0u8; length];
                let _ = reader.read_exact(&mut body);
                log.lock().unwrap().push(Seen { head, body });
                let mut stream = stream;
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    reply.len()
                );
                let _ = stream.write_all(&reply);
            }
        });
        (base, seen)
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hive-word-{name}-{}-{}",
            std::process::id(),
            random_hex(4).unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    fn recorder() -> (Reporter, Arc<Mutex<Vec<Progress>>>) {
        let events: Arc<Mutex<Vec<Progress>>> = Arc::new(Mutex::new(Vec::new()));
        let log = events.clone();
        let report: Reporter = Arc::new(move |p: Progress| log.lock().unwrap().push(p));
        (report, events)
    }

    #[test]
    fn streams_multipart_with_token_and_progress_in_order() {
        let dir = scratch("upload");
        let big: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(dir.join("a.docx"), &big).unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("b.odt"), b"odt").unwrap();
        let (found, truncated) = walk(&dir);
        assert!(!truncated);
        let files: Vec<(usize, Picked)> = found.into_iter().enumerate().collect();
        let (base, seen) = serve(201, "application/json", br#"{"importId":"imp-1"}"#.to_vec());
        let (report, events) = recorder();
        let fields = form_fields(&UploadInput {
            home_id: "home-1".into(),
            target_dir: Some("docs".into()),
            ..Default::default()
        })
        .unwrap();
        let token = token();
        let hub = Hub {
            url: &base,
            token: &token,
            org: ORG,
        };
        let client = crate::tls::client().unwrap();
        let result = tauri::async_runtime::block_on(upload_files(
            &client, hub, "u1", &fields, files, report,
        ));
        assert_eq!(result.unwrap(), "imp-1");

        let seen = seen.lock().unwrap();
        let request = &seen[0];
        let head = request.head.to_ascii_lowercase();
        assert!(head.starts_with("post /api/v1/docs/word-imports "));
        assert!(head.contains(&format!("authorization: bearer {}", token.to_ascii_lowercase())));
        assert!(head.contains(&format!("x-hive-org: {ORG}")));
        assert!(head.contains(&format!("content-length: {}\r\n", request.body.len())));
        assert!(head.contains("content-type: multipart/form-data; boundary=xdev-hive-"));
        assert!(!head.contains("transfer-encoding"));
        let body = &request.body;
        for text in [
            "name=\"homeId\"\r\n\r\nhome-1\r\n",
            "name=\"mode\"\r\n\r\ncreate\r\n",
            "name=\"targetDir\"\r\n\r\ndocs\r\n",
            "name=\"relativePaths\"\r\n\r\n\r\n",
            "name=\"relativePaths\"\r\n\r\nsub\r\n",
            "name=\"lastModified\"\r\n\r\n",
            "name=\"files\"; filename=\"b.odt\"\r\ncontent-type: application/vnd.oasis.opendocument.text\r\n\r\nodt\r\n",
        ] {
            assert!(find(body, text.as_bytes()).is_some(), "thiếu {text:?}");
        }
        let header = find(body, b"filename=\"a.docx\"").unwrap();
        let start = header + find(&body[header..], b"\r\n\r\n").unwrap() + 4;
        assert_eq!(&body[start..start + big.len()], &big[..]);
        assert!(body.ends_with(b"--\r\n"));

        let events: Vec<(usize, u64, u64)> = events
            .lock()
            .unwrap()
            .iter()
            .map(|p| {
                assert_eq!(p.upload_id, "u1");
                (p.index, p.sent, p.size)
            })
            .collect();
        assert_eq!(
            events,
            vec![(0, 0, 300_000), (0, 300_000, 300_000), (1, 0, 3), (1, 3, 3)]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn large_files_report_progress_in_steps() {
        let dir = scratch("steps");
        let size = 2 * REPORT_EVERY + 10;
        std::fs::write(dir.join("big.docx"), vec![7u8; size as usize]).unwrap();
        let files: Vec<(usize, Picked)> = walk(&dir).0.into_iter().map(|f| (4, f)).collect();
        let (base, _) = serve(201, "application/json", br#"{"importId":"imp-2"}"#.to_vec());
        let (report, events) = recorder();
        let fields = form_fields(&UploadInput {
            home_id: "home-1".into(),
            target_dir: Some(String::new()),
            ..Default::default()
        })
        .unwrap();
        let token = token();
        let hub = Hub {
            url: &base,
            token: &token,
            org: ORG,
        };
        let client = crate::tls::client().unwrap();
        tauri::async_runtime::block_on(upload_files(&client, hub, "u2", &fields, files, report))
            .unwrap();
        let sent: Vec<u64> = events.lock().unwrap().iter().map(|p| p.sent).collect();
        assert_eq!(sent.first(), Some(&0));
        assert_eq!(sent.last(), Some(&size));
        assert!(sent.windows(2).all(|w| w[0] < w[1]), "{sent:?}");
        assert!(sent.len() >= 4, "{sent:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn errors_never_carry_the_token() {
        let token = token();
        let dir = scratch("errors");
        std::fs::write(dir.join("a.docx"), b"docx").unwrap();
        let files = || -> Vec<(usize, Picked)> { walk(&dir).0.into_iter().enumerate().collect() };
        let fields = form_fields(&UploadInput {
            home_id: "home-1".into(),
            target_dir: Some(String::new()),
            ..Default::default()
        })
        .unwrap();
        let client = crate::tls::client().unwrap();

        let echo = json!({
            "defined": false, "code": "UNAUTHORIZED", "status": 401,
            "message": format!("Chưa đăng nhập. Bearer {token}"),
            "data": { "header": format!("Bearer {token}") },
        });
        let (base, _) = serve(401, "application/json", echo.to_string().into_bytes());
        let hub = Hub {
            url: &base,
            token: &token,
            org: ORG,
        };
        let (report, _) = recorder();
        let error = tauri::async_runtime::block_on(upload_files(
            &client, hub, "u3", &fields, files(), report,
        ))
        .unwrap_err();
        assert_eq!((error.status, error.code.as_str()), (401, "UNAUTHORIZED"));
        assert!(error.message.starts_with("Chưa đăng nhập."));
        assert!(!serde_json::to_string(&error).unwrap().contains(&token));

        // Không tới được hub: lỗi mạng cũng không mang token hay header.
        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", closed.local_addr().unwrap());
        drop(closed);
        let hub = Hub {
            url: &base,
            token: &token,
            org: ORG,
        };
        let (report, _) = recorder();
        let error = tauri::async_runtime::block_on(upload_files(
            &client, hub, "u4", &fields, files(), report,
        ))
        .unwrap_err();
        assert_eq!((error.status, error.code.as_str()), (0, "NETWORK_ERROR"));
        assert!(!serde_json::to_string(&error).unwrap().contains(&token));
        let error = tauri::async_runtime::block_on(fetch_bytes(
            &client,
            hub,
            "/api/v1/docs/assets/a1",
        ))
        .unwrap_err();
        assert!(!error.contains(&token));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn over_limit_batches_stop_before_sending() {
        let dir = scratch("limits");
        let huge = dir.join("huge.docx");
        std::fs::File::create(&huge)
            .unwrap()
            .set_len(FILE_BYTES + 1)
            .unwrap();
        std::fs::write(dir.join("small.docx"), b"docx").unwrap();
        let (base, seen) = serve(201, "application/json", br#"{"importId":"x"}"#.to_vec());
        let token = token();
        let hub = Hub {
            url: &base,
            token: &token,
            org: ORG,
        };
        let fields = form_fields(&UploadInput {
            home_id: "home-1".into(),
            target_dir: Some(String::new()),
            ..Default::default()
        })
        .unwrap();
        let client = crate::tls::client().unwrap();
        let all = walk(&dir).0;
        let small = all.iter().find(|f| f.name == "small.docx").unwrap().clone();

        let (report, events) = recorder();
        let error = tauri::async_runtime::block_on(upload_files(
            &client,
            hub,
            "u5",
            &fields,
            all.into_iter().enumerate().collect(),
            report,
        ))
        .unwrap_err();
        assert_eq!(error.data.as_ref().unwrap()["code"], "WORD_IMPORT_FILE_TOO_LARGE");
        assert!(error.message.starts_with("huge.docx: File Word vượt giới hạn"));

        let many: Vec<(usize, Picked)> = (0..=BATCH_FILES).map(|i| (i, small.clone())).collect();
        let (report, _) = recorder();
        let error = tauri::async_runtime::block_on(upload_files(
            &client, hub, "u6", &fields, many, report,
        ))
        .unwrap_err();
        assert_eq!(error.data.as_ref().unwrap()["code"], "WORD_IMPORT_BATCH_TOO_LARGE");

        assert!(events.lock().unwrap().is_empty());
        assert!(seen.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn form_fields_refuse_line_breaks_and_unknown_modes() {
        let input = |mode: &str, home: &str| UploadInput {
            home_id: home.into(),
            mode: Some(mode.into()),
            doc_key: Some("doc-1".into()),
            ..Default::default()
        };
        assert!(form_fields(&input("update", "home-1")).is_ok());
        assert!(form_fields(&input("delete", "home-1")).is_err());
        assert!(form_fields(&input("link", "home-1\r\n--x")).is_err());
        let fields = form_fields(&UploadInput {
            home_id: "h".into(),
            confidential: Some(true),
            ..Default::default()
        })
        .unwrap();
        assert!(fields.contains(&("confidential", "true".into())));
        assert!(fields.contains(&("mode", "create".into())));
        assert_eq!(quoted("a\"b\r\n.docx"), "a%22b%0D%0A.docx");
    }

    #[test]
    fn walk_keeps_subfolders_and_skips_other_files() {
        let dir = scratch("walk");
        std::fs::create_dir_all(dir.join("a").join("b")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        for file in [
            "top.DOCX",
            "a/mid.odt",
            "a/b/deep.doc",
            "a/notes.txt",
            "~$top.docx",
            ".hidden.docx",
            ".git/x.docx",
        ] {
            std::fs::write(dir.join(file), b"x").unwrap();
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&dir, dir.join("a").join("loop")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("top.DOCX"), dir.join("link.docx")).unwrap();
        let (found, truncated) = walk(&dir);
        assert!(!truncated);
        let listed: Vec<(&str, &str)> = found
            .iter()
            .map(|f| (f.relative_dir.as_str(), f.name.as_str()))
            .collect();
        assert_eq!(
            listed,
            vec![("", "top.DOCX"), ("a", "mid.odt"), ("a/b", "deep.doc")]
        );
        assert!(found.iter().all(|f| f.size == 1 && f.last_modified.is_some()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fetches_bytes_with_token_and_content_type() {
        let png = vec![0x89, b'P', b'N', b'G', 0, 1, 2];
        let (base, seen) = serve(200, "image/png", png.clone());
        let token = token();
        let hub = Hub {
            url: &base,
            token: &token,
            org: ORG,
        };
        let client = crate::tls::client().unwrap();
        let path = "/api/v1/docs/word-imports/i-1/files/f-1/media/image1.png";
        let reply = tauri::async_runtime::block_on(fetch_bytes(&client, hub, path)).unwrap();
        assert_eq!((reply.status, reply.content_type.as_str()), (200, "image/png"));
        use base64::Engine;
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&reply.base64)
                .unwrap(),
            png
        );
        let head = seen.lock().unwrap()[0].head.to_ascii_lowercase();
        assert!(head.starts_with(&format!("get {path} ")));
        assert!(head.contains(&format!("x-hive-org: {ORG}")));
    }

    #[test]
    fn only_word_import_and_asset_paths_are_fetched() {
        let id = "0a0a0a0a-0000-4000-8000-00000000000a";
        assert!(safe_bytes_path(&format!(
            "/api/v1/docs/word-imports/{id}/files/{id}/media/image1.png"
        )));
        assert!(safe_bytes_path(&format!(
            "/api/v1/docs/word-imports/{id}/files/{id}/media/%E1%BA%A3nh%201.jpeg"
        )));
        assert!(safe_bytes_path(&format!(
            "/api/v1/docs/word-imports/{id}/files/{id}/original"
        )));
        assert!(safe_bytes_path(&format!("/api/v1/docs/assets/{id}")));
        assert!(safe_bytes_path(&format!("/api/v1/docs/assets/{id}?org={id}&doc=k1")));
        assert!(safe_bytes_path("/api/v1/docs/assets?doc=k1&path=img%2Fa.png"));

        for path in [
            format!("/api/v1/docs/word-imports/{id}/files/{id}/media/../../original"),
            format!("/api/v1/docs/word-imports/{id}/files/{id}/media/a/b.png"),
            format!("/api/v1/docs/word-imports/{id}/files/{id}/media/a.png?x=1"),
            format!("/api/v1/docs/word-imports/{id}/files/{id}/original#x"),
            format!("/api/v1/docs/word-imports/{id}/files/{id}/delete"),
            format!("/api/v1/docs/word-imports/{id}"),
            format!("/api/v1/docs/word-imports//files/{id}/original"),
            format!("/api/v1/docs/assets/{id}/../../../api/auth/sign-out"),
            format!("/api/v1/docs/assets/{id}/x"),
            "//evil.example/api/v1/docs/assets/a1".into(),
            "/api/v1/docs/assets/".into(),
            "/api/v1/docs/assetsx".into(),
            "/api/v1/docs/assets#x".into(),
            "/api/auth/get-session".into(),
            "/rpc/teams/list".into(),
            "https://evil.example/api/v1/docs/assets/a1".into(),
            "/api/v1/docs/assets/a 1".into(),
        ] {
            assert!(!safe_bytes_path(&path), "{path}");
        }
    }
}
