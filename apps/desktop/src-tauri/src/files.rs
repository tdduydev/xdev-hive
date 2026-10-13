//! File trong thư mục dự án cho màn "Tài liệu từ code": mở thư mục con của cây, xem file code, sửa và lưu file tài
//! liệu. Cửa sổ chỉ gửi thư mục dự án và đường dẫn tương đối; Rust giải đường dẫn thật (kể cả symlink) và từ chối mọi
//! thứ nằm ngoài thư mục dự án, nên một lỗi chèn script ở cửa sổ cũng không đọc được ~/.ssh hay ghi đè file hệ thống.

use crate::cli::{TreeEntry, project_folder, walk};
use serde::Serialize;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Đủ cho file code và tài liệu người viết; file lớn hơn thường là dữ liệu hay file sinh ra, mở ở đây chỉ làm treo.
pub const MAX_FILE: u64 = 2 * 1024 * 1024;
/// Chỉ lưu được file tài liệu: trình soạn của màn là trình soạn Markdown, không phải trình soạn code.
const WRITABLE: &[&str] = &["md", "mdx", "markdown", "txt"];

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Đường dẫn tương đối hợp lệ: không rỗng, không tuyệt đối, không có `..`.
fn relative_parts(rel: &str) -> Result<&Path, String> {
    let rel = rel.trim();
    let path = Path::new(rel);
    if rel.is_empty()
        || rel.len() > 1024
        || rel.contains('\0')
        || !path
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!("Đường dẫn không hợp lệ: {rel}"));
    }
    Ok(path)
}

/// Đường dẫn thật của một mục có sẵn trong thư mục dự án. `root` đã canonicalize (project_folder); so sau khi giải
/// symlink nên symlink trỏ ra ngoài bị từ chối.
pub fn resolve_existing(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let path = relative_parts(rel)?;
    let real = root
        .join(path)
        .canonicalize()
        .map_err(|_| format!("Không tìm thấy {rel}."))?;
    if !real.starts_with(root) {
        return Err(format!("{rel} nằm ngoài thư mục dự án."));
    }
    Ok(real)
}

/// Một tầng của thư mục con (bấm mở thư mục trong cây). Độ sâu tính từ gốc như `folder_tree`.
pub fn list_dir(root: &Path, rel: &str) -> Result<Vec<TreeEntry>, String> {
    let dir = resolve_existing(root, rel)?;
    if !dir.is_dir() {
        return Err(format!("{rel} không phải thư mục."));
    }
    let depth = relative_parts(rel)?
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count();
    let depth = u8::try_from(depth).unwrap_or(u8::MAX);
    let mut out = Vec::new();
    walk(root, &dir, depth, depth, &mut out);
    Ok(out)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub content: String,
    pub size: u64,
    /// Thời điểm sửa (ms) để màn biết file đã đổi trên đĩa (agent sửa) khi tải lại.
    pub modified_ms: u64,
    /// File tài liệu lưu được từ màn.
    pub writable: bool,
}

pub fn writable(path: &Path) -> bool {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|e| WRITABLE.contains(&e.as_str()))
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

pub fn read_text(root: &Path, rel: &str) -> Result<FileText, String> {
    let real = resolve_existing(root, rel)?;
    let meta = std::fs::metadata(&real).map_err(|e| format!("Không đọc được {rel}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{rel} không phải file."));
    }
    if meta.len() > MAX_FILE {
        return Err(format!(
            "{rel} lớn quá ({} KB), app chỉ mở file đến {} KB.",
            meta.len() / 1024,
            MAX_FILE / 1024
        ));
    }
    let bytes = std::fs::read(&real).map_err(|e| format!("Không đọc được {rel}: {e}"))?;
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Err(format!("{rel} là file nhị phân, không mở được ở đây."));
    }
    // Không đổi lossy: lưu lại bản đã thay ký tự lỗi sẽ làm hỏng file.
    let content =
        String::from_utf8(bytes).map_err(|_| format!("{rel} không phải văn bản UTF-8."))?;
    Ok(FileText {
        size: meta.len(),
        modified_ms: modified_ms(&meta),
        writable: writable(&real),
        content,
    })
}

/// Ghi file tài liệu có sẵn hoặc tạo mới trong thư mục đã có. Trả thời điểm sửa mới.
pub fn write_text(root: &Path, rel: &str, content: &str) -> Result<u64, String> {
    if content.len() as u64 > MAX_FILE {
        return Err(format!(
            "Nội dung lớn quá, app chỉ lưu file đến {} KB.",
            MAX_FILE / 1024
        ));
    }
    let path = relative_parts(rel)?;
    // Có mục ở đường dẫn (kể cả symlink hỏng hay trỏ ra ngoài) thì phải giải được vào trong thư mục; chỉ tạo mới khi
    // chưa có gì.
    let target = match root.join(path).symlink_metadata() {
        Ok(_) => resolve_existing(root, rel)?,
        Err(_) => {
            let name = path
                .file_name()
                .ok_or_else(|| format!("Đường dẫn không hợp lệ: {rel}"))?;
            let parent = path.parent().map(|p| p.to_string_lossy().into_owned());
            let dir = match parent.as_deref().filter(|p| !p.is_empty()) {
                Some(p) => resolve_existing(root, p)?,
                None => root.to_path_buf(),
            };
            dir.join(name)
        }
    };
    if !target.starts_with(root) {
        return Err(format!("{rel} nằm ngoài thư mục dự án."));
    }
    if !writable(&target) {
        return Err("Chỉ lưu được file tài liệu (.md, .mdx, .markdown, .txt).".into());
    }
    if target.is_dir() {
        return Err(format!("{rel} là thư mục."));
    }
    let fail = |e: std::io::Error| format!("Không lưu được {rel}: {e}");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Đường dẫn đã giải symlink; nếu ai đó đổi file thành symlink ngay sau bước kiểm thì không ghi theo nó.
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&target).map_err(fail)?;
    file.write_all(content.as_bytes()).map_err(fail)?;
    file.flush().map_err(fail)?;
    drop(file);
    let meta = std::fs::metadata(&target).map_err(fail)?;
    Ok(modified_ms(&meta))
}

fn root_of(folder: &str) -> Result<PathBuf, String> {
    project_folder(folder, home().as_deref())
}

#[tauri::command]
pub async fn folder_list(folder: String, path: String) -> Result<Vec<TreeEntry>, String> {
    let root = root_of(&folder)?;
    tauri::async_runtime::spawn_blocking(move || list_dir(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_local_file(folder: String, path: String) -> Result<FileText, String> {
    let root = root_of(&folder)?;
    tauri::async_runtime::spawn_blocking(move || read_text(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// "Lưu vào file" của trình soạn tài liệu.
#[tauri::command]
pub async fn write_local_file(
    folder: String,
    path: String,
    content: String,
) -> Result<u64, String> {
    let root = root_of(&folder)?;
    tauri::async_runtime::spawn_blocking(move || write_text(&root, &path, &content))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "hive-files-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn put(root: &Path, rel: &str, body: &[u8]) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    #[test]
    fn lists_one_level_of_a_subfolder() {
        let root = temp("list");
        put(&root, "internal/channel/ws.go", b"package channel");
        put(&root, "internal/main.go", b"package main");
        put(&root, "internal/node_modules/x.js", b"x");
        let entries = list_dir(&root, "internal").unwrap();
        assert_eq!(
            entries,
            [
                TreeEntry {
                    path: "internal/channel".into(),
                    dir: true,
                    depth: 1
                },
                TreeEntry {
                    path: "internal/main.go".into(),
                    dir: false,
                    depth: 1
                },
            ]
        );
        assert_eq!(list_dir(&root, "internal/channel").unwrap()[0].depth, 2);
        assert!(list_dir(&root, "internal/main.go").is_err());
        assert!(list_dir(&root, "..").is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reads_text_files_only_inside_the_folder() {
        let root = temp("read");
        put(&root, "README.md", "# Xin chào".as_bytes());
        put(&root, "go.mod", b"module x");
        put(&root, "logo.png", b"\x89PNG\0\0");
        put(&root, "latin1.txt", b"caf\xe9");
        let readme = read_text(&root, "README.md").unwrap();
        assert_eq!(readme.content, "# Xin chào");
        assert!(readme.writable);
        assert!(!read_text(&root, "go.mod").unwrap().writable);
        assert!(
            read_text(&root, "logo.png")
                .unwrap_err()
                .contains("nhị phân")
        );
        assert!(
            read_text(&root, "latin1.txt")
                .unwrap_err()
                .contains("UTF-8")
        );
        assert!(read_text(&root, "khong-co.md").is_err());
        let outside = temp("outside");
        put(&outside, "secret.md", b"secret");
        let rel = format!(
            "../{}/secret.md",
            outside.file_name().unwrap().to_string_lossy()
        );
        assert!(read_text(&root, &rel).is_err());
        assert!(read_text(&root, &outside.join("secret.md").to_string_lossy()).is_err());
        let big = vec![b'a'; MAX_FILE as usize + 1];
        put(&root, "big.txt", &big);
        assert!(read_text(&root, "big.txt").unwrap_err().contains("lớn quá"));
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn writes_docs_but_not_outside_or_code() {
        let root = temp("write");
        put(&root, "docs/guide.md", b"cu");
        put(&root, "main.go", b"package main");
        write_text(&root, "docs/guide.md", "# Mới\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("docs/guide.md")).unwrap(),
            "# Mới\n"
        );
        write_text(&root, "docs/new.md", "x").unwrap();
        assert!(root.join("docs/new.md").is_file());
        assert!(
            write_text(&root, "main.go", "x")
                .unwrap_err()
                .contains("tài liệu")
        );
        assert!(write_text(&root, "../evil.md", "x").is_err());
        assert!(write_text(&root, "/tmp/evil.md", "x").is_err());
        assert!(write_text(&root, "khong/co/thu-muc.md", "x").is_err());
        let big = "a".repeat(MAX_FILE as usize + 1);
        assert!(write_text(&root, "docs/guide.md", &big).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_out_of_the_folder_are_refused() {
        let root = temp("link");
        let outside = temp("link-out");
        put(&outside, "notes.md", b"ngoai");
        std::os::unix::fs::symlink(outside.join("notes.md"), root.join("notes.md")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("ext")).unwrap();
        assert!(read_text(&root, "notes.md").is_err());
        assert!(write_text(&root, "notes.md", "x").is_err());
        assert!(write_text(&root, "ext/new.md", "x").is_err());
        assert!(list_dir(&root, "ext").is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("notes.md")).unwrap(),
            "ngoai"
        );
        assert!(!outside.join("new.md").exists());
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }
}
