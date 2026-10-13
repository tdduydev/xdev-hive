//! Cài skill từ hub vào CLI trên máy (AppSkills, specs/008-desktop-v2 T014, DESK-06).
//!
//! Hai nơi cài: thư mục dự án (`.claude/skills`, `.agents/skills`) hoặc tài khoản trên máy (`~/.claude/skills`,
//! `~/.codex/skills`). App ghi sổ (phiên bản, sha256 của file đã cài) trong thư mục dữ liệu của app, không thêm file lạ
//! vào repo của người dùng. File trên máy khác sha256 đã ghi là người dùng đã sửa tay: không ghi đè, không xoá, trừ khi
//! người dùng chọn ghi đè.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Target {
    Project,
    User,
}

/// Lệnh Tauri chạy song song: khoá để hai lần cài cùng lúc không ghi đè sổ của nhau.
static LEDGER_LOCK: Mutex<()> = Mutex::new(());
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Entry {
    version: u32,
    sha256: String,
}

/// Sổ cài đặt: theo gốc (thư mục dự án hoặc thư mục nhà) → tên skill → bản và sha256 đã ghi.
type Ledger = BTreeMap<String, BTreeMap<String, Entry>>;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub name: String,
    /// Bản đã cài từ hub; None là skill trong thư mục mà app không cài (người dùng tự thêm).
    pub version: Option<u32>,
    /// File trên máy khác bản app đã ghi: người dùng đã sửa tay.
    pub modified: bool,
    /// Thư mục CLI có skill này (vd. `.claude/skills`).
    pub dirs: Vec<String>,
    /// SKILL.md ở thư mục CLI đầu tiên có skill: giao diện so với bản trên hub để hiện thay đổi.
    pub text: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    pub name: String,
    pub version: u32,
    /// Nội dung SKILL.md đầy đủ (frontmatter và nội dung), giao diện dựng từ skill của hub.
    pub text: String,
    /// File kèm theo SKILL.md (skill mặc định của Hive: scripts, references, data). Giao diện cũ không gửi trường này.
    #[serde(default)]
    pub extra: Vec<ExtraFile>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtraFile {
    /// Đường dẫn tương đối kiểu POSIX trong thư mục skill, vd. `references/rules.md`.
    pub path: String,
    pub text: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub done: Vec<String>,
    /// Skill đã sửa tay trên máy, bỏ qua vì không chọn ghi đè.
    pub conflicts: Vec<String>,
}

fn dirs_for(target: Target) -> [&'static str; 2] {
    match target {
        Target::Project => [".claude/skills", ".agents/skills"],
        Target::User => [".claude/skills", ".codex/skills"],
    }
}

/// Tên skill đi thẳng vào đường dẫn: chỉ cho chữ, số, `.`, `-`, `_`, không cho `..` để không ghi ra ngoài thư mục.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// Đường dẫn file kèm theo do hub gửi: chỉ cho đi xuống trong thư mục skill, không tuyệt đối, không `..`.
pub fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 300
        && path != "SKILL.md"
        && path
            .split('/')
            .all(|c| !c.is_empty() && c != "." && c != ".." && !c.contains(['\\', ':', '\0']))
}

pub fn sha256(text: &str) -> String {
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn base_dir(target: Target, folder: Option<&str>) -> Result<PathBuf, String> {
    match target {
        Target::Project => {
            let f = folder
                .map(str::trim)
                .filter(|f| !f.is_empty())
                .ok_or("Chưa chọn thư mục dự án.")?;
            let p = PathBuf::from(f);
            if p.is_dir() {
                Ok(p)
            } else {
                Err(format!("Không tìm thấy thư mục {f}."))
            }
        }
        Target::User => std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .ok_or_else(|| "Không biết thư mục nhà của tài khoản.".into()),
    }
}

fn ledger_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("installed-skills.json"))
}

fn read_ledger(path: &Path) -> Ledger {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("Đường dẫn không hợp lệ.")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Không tạo được {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(
        ".hive-{}-{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, text).map_err(|e| format!("Không ghi được {}: {e}", path.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Không ghi được {}: {e}", path.display()))
}

/// Skill đang có ở hai thư mục CLI của gốc, kèm bản đã cài và có bị sửa tay không.
pub fn list_at(base: &Path, target: Target, ledger: &BTreeMap<String, Entry>) -> Vec<Installed> {
    let mut by_name: BTreeMap<String, Installed> = BTreeMap::new();
    for dir in dirs_for(target) {
        let Ok(entries) = std::fs::read_dir(base.join(dir)) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(text) = std::fs::read_to_string(e.path().join("SKILL.md")) else {
                continue;
            };
            let recorded = ledger.get(&name);
            let item = by_name.entry(name.clone()).or_insert_with(|| Installed {
                name: name.clone(),
                version: recorded.map(|r| r.version),
                modified: false,
                dirs: vec![],
                text: text.clone(),
            });
            item.dirs.push(dir.to_string());
            if recorded.is_some_and(|r| r.sha256 != sha256(&text)) {
                item.modified = true;
            }
        }
    }
    by_name.into_values().collect()
}

/// Ghi skill vào cả hai thư mục CLI. Skill đã sửa tay thì bỏ qua (trừ khi `force`).
pub fn install_at(
    base: &Path,
    target: Target,
    ledger: &mut BTreeMap<String, Entry>,
    files: &[SkillFile],
    force: bool,
) -> Result<ApplyResult, String> {
    let current = list_at(base, target, ledger);
    let mut result = ApplyResult {
        done: vec![],
        conflicts: vec![],
    };
    for f in files {
        if !valid_name(&f.name) {
            return Err(format!("Tên skill không hợp lệ: {}", f.name));
        }
        // Sửa tay sau khi app cài, hoặc người dùng tự đặt skill cùng tên (không có trong sổ): đều không ghi đè.
        if !force
            && current
                .iter()
                .any(|i| i.name == f.name && (i.modified || i.version.is_none()))
        {
            result.conflicts.push(f.name.clone());
            continue;
        }
        if let Some(bad) = f.extra.iter().find(|e| !valid_path(&e.path)) {
            return Err(format!(
                "Đường dẫn file không hợp lệ trong skill {}: {}",
                f.name, bad.path
            ));
        }
        for dir in dirs_for(target) {
            let root = base.join(dir).join(&f.name);
            // Skill có file kèm theo được thay cả thư mục, để file bản cũ đã bỏ không còn sót lại cho agent đọc nhầm.
            if !f.extra.is_empty() && root.is_dir() {
                std::fs::remove_dir_all(&root)
                    .map_err(|e| format!("Không xoá được {}: {e}", root.display()))?;
            }
            write_atomic(&root.join("SKILL.md"), &f.text)?;
            for e in &f.extra {
                write_atomic(&root.join(&e.path), &e.text)?;
            }
        }
        ledger.insert(
            f.name.clone(),
            Entry {
                version: f.version,
                sha256: sha256(&f.text),
            },
        );
        result.done.push(f.name.clone());
    }
    Ok(result)
}

/// Gỡ skill app đã cài ("Tắt với tôi"). Skill người dùng tự thêm (không có trong sổ) không bao giờ bị xoá.
pub fn remove_at(
    base: &Path,
    target: Target,
    ledger: &mut BTreeMap<String, Entry>,
    names: &[String],
    force: bool,
) -> Result<ApplyResult, String> {
    let current = list_at(base, target, ledger);
    let mut result = ApplyResult {
        done: vec![],
        conflicts: vec![],
    };
    for name in names {
        if !valid_name(name) || !ledger.contains_key(name) {
            result.conflicts.push(name.clone());
            continue;
        }
        if !force && current.iter().any(|i| &i.name == name && i.modified) {
            result.conflicts.push(name.clone());
            continue;
        }
        for dir in dirs_for(target) {
            let path = base.join(dir).join(name);
            if path.is_dir() {
                std::fs::remove_dir_all(&path)
                    .map_err(|e| format!("Không xoá được {}: {e}", path.display()))?;
            }
        }
        ledger.remove(name);
        result.done.push(name.clone());
    }
    Ok(result)
}

fn with_ledger<T>(
    app: &AppHandle,
    base: &Path,
    f: impl FnOnce(&mut BTreeMap<String, Entry>) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = LEDGER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = ledger_path(app)?;
    let mut all = read_ledger(&path);
    let key = base.to_string_lossy().into_owned();
    let mut mine = all.remove(&key).unwrap_or_default();
    let out = f(&mut mine)?;
    if !mine.is_empty() {
        all.insert(key, mine);
    }
    write_atomic(
        &path,
        &serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?,
    )?;
    Ok(out)
}

#[tauri::command]
pub fn installed_skills(
    app: AppHandle,
    target: Target,
    folder: Option<String>,
) -> Result<Vec<Installed>, String> {
    let base = base_dir(target, folder.as_deref())?;
    let all = read_ledger(&ledger_path(&app)?);
    let mine = all
        .get(base.to_string_lossy().as_ref())
        .cloned()
        .unwrap_or_default();
    Ok(list_at(&base, target, &mine))
}

#[tauri::command]
pub fn install_skills(
    app: AppHandle,
    target: Target,
    folder: Option<String>,
    files: Vec<SkillFile>,
    force: bool,
) -> Result<ApplyResult, String> {
    let base = base_dir(target, folder.as_deref())?;
    with_ledger(&app, &base, |l| install_at(&base, target, l, &files, force))
}

#[tauri::command]
pub fn remove_skills(
    app: AppHandle,
    target: Target,
    folder: Option<String>,
    names: Vec<String>,
    force: bool,
) -> Result<ApplyResult, String> {
    let base = base_dir(target, folder.as_deref())?;
    with_ledger(&app, &base, |l| remove_at(&base, target, l, &names, force))
}

/// "Đề xuất sửa": gửi SKILL.md người dùng đã sửa trên máy lên hub thành đề xuất. Lệnh riêng thay vì mở `hub_tool` cho
/// tool ghi, để cửa sổ app chỉ ghi được đúng một việc này.
#[tauri::command]
pub async fn propose_skill(
    app: AppHandle,
    name: String,
    project: Option<String>,
    base_version: u32,
    text: String,
    note: String,
) -> Result<serde_json::Value, String> {
    if !valid_name(&name) {
        return Err(format!("Tên skill không hợp lệ: {name}"));
    }
    let hub = crate::hub_of(&app).ok_or("Máy chưa đăng ký với hub nào.")?;
    let token = crate::account::stored_token(&hub)
        .ok_or("Chưa liên kết tài khoản: mở thẻ người dùng ở góc dưới để dán token MCP.")?;
    let mut args = serde_json::json!({ "name": name, "baseVersion": base_version, "content": text, "note": note });
    if let Some(p) = project.filter(|p| !p.is_empty()) {
        args["project"] = p.into();
    }
    crate::hub::call_tool(&hub, &token, "skill_propose", args)
        .await
        .map_err(|e| e.text())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test chạy song song; đồng hồ macOS chỉ tới micro giây nên đánh số để hai test không dùng chung thư mục.
    fn temp() -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "hive-skills-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn file(name: &str, version: u32, body: &str) -> SkillFile {
        SkillFile {
            name: name.into(),
            version,
            text: format!("---\nname: {name}\n---\n{body}\n"),
            extra: vec![],
        }
    }
    fn extra(path: &str, text: &str) -> ExtraFile {
        ExtraFile {
            path: path.into(),
            text: text.into(),
        }
    }

    #[test]
    fn installs_extra_files_and_drops_stale_ones_on_update() {
        let base = temp();
        let mut ledger = BTreeMap::new();
        let mut v1 = file("ui-ux-pro-max", 1, "Thiết kế");
        v1.extra = vec![
            extra("data/styles.csv", "a,b\n"),
            extra("scripts/old.py", "print(1)\n"),
        ];
        install_at(&base, Target::Project, &mut ledger, &[v1], false).unwrap();
        for dir in [".claude/skills", ".agents/skills"] {
            let root = base.join(dir).join("ui-ux-pro-max");
            assert_eq!(
                std::fs::read_to_string(root.join("data/styles.csv")).unwrap(),
                "a,b\n"
            );
            assert!(root.join("scripts/old.py").is_file());
        }
        let mut v2 = file("ui-ux-pro-max", 2, "Thiết kế v2");
        v2.extra = vec![extra("data/styles.csv", "a,b,c\n")];
        let r = install_at(&base, Target::Project, &mut ledger, &[v2], false).unwrap();
        assert_eq!(r.done, vec!["ui-ux-pro-max".to_string()]);
        let root = base.join(".claude/skills/ui-ux-pro-max");
        assert_eq!(
            std::fs::read_to_string(root.join("data/styles.csv")).unwrap(),
            "a,b,c\n"
        );
        assert!(!root.join("scripts/old.py").exists());
        assert_eq!(ledger["ui-ux-pro-max"].version, 2);
    }

    #[test]
    fn rejects_extra_paths_that_escape_the_skill_folder() {
        let base = temp();
        let mut ledger = BTreeMap::new();
        for bad in ["../x.md", "/etc/x", "a/../../x", "a\\b", "SKILL.md", ""] {
            let mut f = file("hive", 1, "x");
            f.extra = vec![extra(bad, "x")];
            assert!(
                install_at(&base, Target::Project, &mut ledger, &[f], false).is_err(),
                "{bad}"
            );
        }
        assert!(!base.join(".claude/skills/hive").exists());
        assert!(valid_path("references/rules.md"));
    }

    #[test]
    fn installs_into_both_cli_folders_and_lists_them() {
        let base = temp();
        let mut ledger = BTreeMap::new();
        let r = install_at(
            &base,
            Target::Project,
            &mut ledger,
            &[file("review", 3, "Đọc diff")],
            false,
        )
        .unwrap();
        assert_eq!(r.done, vec!["review"]);
        assert!(base.join(".claude/skills/review/SKILL.md").is_file());
        assert!(base.join(".agents/skills/review/SKILL.md").is_file());
        let list = list_at(&base, Target::Project, &ledger);
        assert_eq!(
            list,
            vec![Installed {
                name: "review".into(),
                version: Some(3),
                modified: false,
                dirs: vec![".claude/skills".into(), ".agents/skills".into()],
                text: file("review", 3, "Đọc diff").text,
            }]
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn hand_edits_are_never_overwritten_or_removed_without_force() {
        let base = temp();
        let mut ledger = BTreeMap::new();
        install_at(
            &base,
            Target::Project,
            &mut ledger,
            &[file("review", 3, "A")],
            false,
        )
        .unwrap();
        std::fs::write(base.join(".claude/skills/review/SKILL.md"), "sửa tay").unwrap();
        assert!(list_at(&base, Target::Project, &ledger)[0].modified);
        let r = install_at(
            &base,
            Target::Project,
            &mut ledger,
            &[file("review", 4, "B")],
            false,
        )
        .unwrap();
        assert_eq!(r.conflicts, vec!["review"]);
        assert_eq!(
            std::fs::read_to_string(base.join(".claude/skills/review/SKILL.md")).unwrap(),
            "sửa tay"
        );
        let r = remove_at(
            &base,
            Target::Project,
            &mut ledger,
            &["review".into()],
            false,
        )
        .unwrap();
        assert_eq!(r.conflicts, vec!["review"]);
        let r = install_at(
            &base,
            Target::Project,
            &mut ledger,
            &[file("review", 4, "B")],
            true,
        )
        .unwrap();
        assert_eq!(r.done, vec!["review"]);
        assert_eq!(ledger["review"].version, 4);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn removes_only_skills_the_app_installed() {
        let base = temp();
        let mut ledger = BTreeMap::new();
        install_at(
            &base,
            Target::User,
            &mut ledger,
            &[file("deploy", 1, "x")],
            false,
        )
        .unwrap();
        std::fs::create_dir_all(base.join(".claude/skills/mine")).unwrap();
        std::fs::write(base.join(".claude/skills/mine/SKILL.md"), "của tôi").unwrap();
        let r = remove_at(
            &base,
            Target::User,
            &mut ledger,
            &["deploy".into(), "mine".into()],
            false,
        )
        .unwrap();
        assert_eq!(r.done, vec!["deploy"]);
        assert_eq!(r.conflicts, vec!["mine"]);
        assert!(!base.join(".codex/skills/deploy").exists());
        assert!(base.join(".claude/skills/mine/SKILL.md").is_file());
        let list = list_at(&base, Target::User, &ledger);
        assert_eq!(
            list[0],
            Installed {
                name: "mine".into(),
                version: None,
                modified: false,
                dirs: vec![".claude/skills".into()],
                text: "của tôi".into(),
            }
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn never_overwrites_a_skill_the_user_placed_by_hand() {
        let base = temp();
        std::fs::create_dir_all(base.join(".agents/skills/review")).unwrap();
        std::fs::write(base.join(".agents/skills/review/SKILL.md"), "của tôi").unwrap();
        let mut ledger = BTreeMap::new();
        let r = install_at(
            &base,
            Target::Project,
            &mut ledger,
            &[file("review", 1, "x")],
            false,
        )
        .unwrap();
        assert_eq!(r.conflicts, vec!["review"]);
        assert!(!base.join(".claude/skills/review").exists());
        assert!(ledger.is_empty());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn rejects_names_that_escape_the_folder() {
        assert!(valid_name("code-review_2.0"));
        assert!(!valid_name(".."));
        assert!(!valid_name("../x"));
        assert!(!valid_name("a/b"));
        assert!(!valid_name(""));
        let base = temp();
        let err = install_at(
            &base,
            Target::Project,
            &mut BTreeMap::new(),
            &[file("../../evil", 1, "x")],
            true,
        );
        assert!(err.is_err());
        std::fs::remove_dir_all(base).unwrap();
    }
}
