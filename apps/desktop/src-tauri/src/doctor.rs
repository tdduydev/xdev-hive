//! Màn Môi trường (AppSetup): dò công cụ trên máy và yêu cầu của thư mục dự án, gợi ý lệnh cài.
//!
//! Giao diện chỉ gửi id của mục; lệnh chạy luôn do Rust sinh lại từ bảng của nó, không bao giờ nhận chuỗi lệnh từ
//! giao diện, để một lỗi chèn script ở cửa sổ cũng không chạy được lệnh tuỳ ý. Lệnh cần quyền quản trị hoặc cần shell
//! (nvm, &&) chỉ để chép.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const OUTPUT_TAIL: usize = 4000;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Cli,
    Runtime,
    Tool,
    Dependency,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Ok,
    Outdated,
    /// Máy có bản mới hơn yêu cầu khớp tiền tố (.nvmrc `24`, máy có Node 26): không phải cũ mà là khác bản.
    Mismatch,
    Missing,
    /// Không bắt buộc và máy chưa có.
    Optional,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    /// Lệnh hiển thị để chép.
    pub command: String,
    /// App chạy được lệnh này (không cần shell, không cần quyền quản trị).
    pub runnable: bool,
    pub admin: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CheckItem {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub required: bool,
    pub need: Option<String>,
    pub have: Option<String>,
    pub status: Status,
    /// File của dự án đặt ra yêu cầu (go.mod, package.json…); rỗng là yêu cầu chung của máy.
    pub source: String,
    pub install: Option<Install>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub ok: bool,
    pub code: Option<i32>,
    pub output: String,
}

/// Lệnh cài nội bộ: `argv` None là chỉ để chép.
struct Spec {
    display: String,
    argv: Option<Vec<String>>,
    admin: bool,
}

impl Spec {
    fn run(cmd: &str) -> Self {
        Spec {
            display: cmd.to_string(),
            argv: Some(cmd.split_whitespace().map(String::from).collect()),
            admin: false,
        }
    }
    fn copy(cmd: &str) -> Self {
        Spec {
            display: cmd.to_string(),
            argv: None,
            admin: false,
        }
    }
    fn admin(cmd: &str) -> Self {
        Spec {
            display: cmd.to_string(),
            argv: None,
            admin: true,
        }
    }
}

/// Ràng buộc phiên bản đọc được từ file dự án.
#[derive(Debug, Clone, PartialEq)]
enum Need {
    /// go.mod `go 1.27`, engines `>=24`: tối thiểu.
    AtLeast(Vec<u64>),
    /// packageManager `pnpm@12.1.0`, engines `^24`: cùng major và không thấp hơn.
    Caret(Vec<u64>),
    /// .nvmrc `24`, engines `24.x`: khớp tiền tố.
    Prefix(Vec<u64>),
}

impl Need {
    fn label(&self) -> String {
        let v = |p: &Vec<u64>| p.iter().map(u64::to_string).collect::<Vec<_>>().join(".");
        match self {
            Need::AtLeast(p) => format!("≥ {}", v(p)),
            Need::Caret(p) => format!("^{}", v(p)),
            Need::Prefix(p) => format!("{}.x", v(p)),
        }
    }

    /// Bản máy có cao hơn yêu cầu (dùng để phân biệt "khác bản" với "cũ").
    fn newer_than(&self, have: &[u64]) -> bool {
        let want = match self {
            Need::AtLeast(p) | Need::Caret(p) | Need::Prefix(p) => p,
        };
        for (i, w) in want.iter().enumerate() {
            let h = have.get(i).copied().unwrap_or(0);
            if h != *w {
                return h > *w;
            }
        }
        false
    }

    fn satisfied_by(&self, have: &[u64]) -> bool {
        let cmp = |want: &[u64]| {
            for (i, w) in want.iter().enumerate() {
                let h = have.get(i).copied().unwrap_or(0);
                if h != *w {
                    return h.cmp(w);
                }
            }
            std::cmp::Ordering::Equal
        };
        match self {
            Need::AtLeast(p) => cmp(p).is_ge(),
            Need::Caret(p) => have.first() == p.first() && cmp(p).is_ge(),
            Need::Prefix(p) => p.iter().enumerate().all(|(i, w)| have.get(i) == Some(w)),
        }
    }
}

/// Số phiên bản đầu tiên trong chuỗi: "go version go1.25.4 darwin" → 1.25.4, "v26.10.0" → 26.10.0.
pub fn extract_version(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() && (i == 0 || !bytes[i - 1].is_ascii_digit()) {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            let found = text[start..i].trim_end_matches('.');
            if found.contains('.') {
                return Some(found.to_string());
            }
        } else {
            i += 1;
        }
    }
    None
}

fn parts(version: &str) -> Vec<u64> {
    version
        .split('.')
        .map_while(|p| p.parse::<u64>().ok())
        .collect()
}

/// Ràng buộc semver thường gặp trong package.json; dạng khác (khoảng, ||) thì chỉ kiểm có hay không.
fn parse_range(range: &str) -> Option<Need> {
    let r = range.trim().trim_start_matches('v');
    if r.contains(' ') || r.contains('|') {
        return None;
    }
    if let Some(rest) = r.strip_prefix(">=") {
        return Some(Need::AtLeast(parts(rest.trim().trim_start_matches('v'))));
    }
    if let Some(rest) = r.strip_prefix('^') {
        return Some(Need::Caret(parts(rest)));
    }
    if let Some(rest) = r.strip_prefix('~') {
        let p = parts(rest);
        return Some(Need::Prefix(p.into_iter().take(2).collect()));
    }
    if r.contains('<') || r.contains('>') {
        return None;
    }
    let p: Vec<u64> = r
        .split('.')
        .take_while(|s| *s != "x" && *s != "*")
        .map_while(|s| s.parse::<u64>().ok())
        .collect();
    (!p.is_empty()).then_some(Need::Prefix(p))
}

/// Yêu cầu của thư mục dự án, theo từng công cụ.
#[derive(Default, Debug)]
struct ProjectNeeds {
    go: Option<(Need, &'static str)>,
    node: Option<(Need, &'static str)>,
    pnpm: Option<(Need, &'static str)>,
    /// Có package.json và lockfile pnpm nhưng chưa có node_modules.
    pnpm_install_missing: Option<bool>,
}

fn read_project(folder: &Path) -> ProjectNeeds {
    let mut needs = ProjectNeeds::default();
    if let Ok(go_mod) = std::fs::read_to_string(folder.join("go.mod")) {
        needs.go = go_mod
            .lines()
            .find_map(|l| l.trim().strip_prefix("go "))
            .map(|v| (Need::AtLeast(parts(v.trim())), "go.mod"));
    }
    if let Ok(nvmrc) = std::fs::read_to_string(folder.join(".nvmrc")) {
        needs.node = parse_range(nvmrc.trim()).map(|n| (n, ".nvmrc"));
    }
    if let Ok(text) = std::fs::read_to_string(folder.join("package.json")) {
        if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&text) {
            if needs.node.is_none() {
                needs.node = pkg["engines"]["node"]
                    .as_str()
                    .and_then(parse_range)
                    .map(|n| (n, "package.json"));
            }
            needs.pnpm = pkg["packageManager"]
                .as_str()
                .and_then(|pm| pm.strip_prefix("pnpm@"))
                .map(|v| {
                    (
                        Need::Caret(parts(v.split('+').next().unwrap_or(v))),
                        "package.json",
                    )
                });
        }
        if folder.join("pnpm-lock.yaml").exists() {
            needs.pnpm_install_missing = Some(!folder.join("node_modules").exists());
        }
    }
    needs
}

/// PATH của shell đăng nhập. App mở từ Finder chỉ có PATH tối thiểu (/usr/bin:/bin…), không thấy công cụ cài bằng
/// Homebrew, nvm hay npm -g; hỏi shell của người dùng một lần, lỗi thì thêm các thư mục hay gặp.
pub(crate) fn user_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let current = std::env::var("PATH").unwrap_or_default();
        #[cfg(unix)]
        {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
            let mut cmd = Command::new(shell);
            cmd.args(["-ilc", "printf '__HIVE_PATH__%s__HIVE_PATH__' \"$PATH\""]);
            if let Some(out) = run_with_timeout(cmd, Duration::from_secs(5)) {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(path) = text.split("__HIVE_PATH__").nth(1).filter(|p| !p.is_empty()) {
                    return path.to_string();
                }
            }
            let home = std::env::var("HOME").unwrap_or_default();
            let extra = [
                "/opt/homebrew/bin".to_string(),
                "/usr/local/bin".to_string(),
                format!("{home}/.local/bin"),
                format!("{home}/.cargo/bin"),
            ];
            format!("{current}:{}", extra.join(":"))
        }
        #[cfg(not(unix))]
        current
    })
}

pub(crate) struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Chạy lệnh không qua shell, đóng stdin, quá hạn thì giết. Trả None khi không chạy được hoặc quá hạn.
pub(crate) fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<Output> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    // Đọc ở luồng riêng để tiến trình in nhiều không bị nghẽn ống trong lúc chờ.
    let out = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    Some(Output {
        code: status.code(),
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

fn probe(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args).env("PATH", user_path());
    let out = run_with_timeout(cmd, PROBE_TIMEOUT)?;
    if out.code != Some(0) {
        return None;
    }
    let text = format!(
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    extract_version(&text)
}

struct Tool {
    id: &'static str,
    name: &'static str,
    kind: Kind,
    program: &'static str,
    args: &'static [&'static str],
    /// Máy nào cũng cần, kể cả khi dự án không nói gì (worker cần git để làm việc với repo).
    always_required: bool,
}

const TOOLS: &[Tool] = &[
    Tool {
        id: "git",
        name: "Git",
        kind: Kind::Tool,
        program: "git",
        args: &["--version"],
        always_required: true,
    },
    Tool {
        id: "claude",
        name: "Claude Code",
        kind: Kind::Cli,
        program: "claude",
        args: &["--version"],
        always_required: false,
    },
    Tool {
        id: "codex",
        name: "Codex CLI",
        kind: Kind::Cli,
        program: "codex",
        args: &["--version"],
        always_required: false,
    },
    Tool {
        id: "gemini",
        name: "Gemini CLI",
        kind: Kind::Cli,
        program: "gemini",
        args: &["--version"],
        always_required: false,
    },
    Tool {
        id: "go",
        name: "Go",
        kind: Kind::Runtime,
        program: "go",
        args: &["version"],
        always_required: false,
    },
    Tool {
        id: "node",
        name: "Node.js",
        kind: Kind::Runtime,
        program: "node",
        args: &["--version"],
        always_required: false,
    },
    Tool {
        id: "pnpm",
        name: "pnpm",
        kind: Kind::Tool,
        program: "pnpm",
        args: &["--version"],
        always_required: false,
    },
    Tool {
        id: "docker",
        name: "Docker",
        kind: Kind::Tool,
        program: "docker",
        args: &["--version"],
        always_required: false,
    },
];

/// Lệnh cài theo hệ điều hành. `outdated` cho CLI có lệnh tự cập nhật.
fn install_spec(id: &str, outdated: bool, need: Option<&Need>) -> Option<Spec> {
    let mac = cfg!(target_os = "macos");
    let win = cfg!(target_os = "windows");
    let node_major = need
        .and_then(|n| match n {
            Need::AtLeast(p) | Need::Caret(p) | Need::Prefix(p) => p.first().copied(),
        })
        .map(|m| m.to_string())
        .unwrap_or_else(|| "--lts".into());
    Some(match id {
        "git" if mac => Spec::run("xcode-select --install"),
        "git" if win => Spec::run("winget install --id Git.Git -e"),
        "git" => Spec::admin("sudo apt-get install -y git"),
        "claude" if outdated => Spec::run("claude update"),
        "claude" => Spec::run("npm install -g @anthropic-ai/claude-code"),
        "codex" => Spec::run("npm install -g @openai/codex"),
        "gemini" => Spec::run("npm install -g @google/gemini-cli"),
        "go" if mac => Spec::run("brew install go"),
        "go" if win => Spec::run("winget install --id GoLang.Go -e"),
        "go" => Spec::admin("sudo snap install go --classic"),
        // nvm là hàm của shell, không phải chương trình: chỉ chép được.
        "node" if win => Spec::run("winget install --id OpenJS.NodeJS.LTS -e"),
        "node" => Spec::copy(&format!("nvm install {node_major}")),
        "pnpm" => Spec::run("corepack enable pnpm"),
        "docker" if mac => Spec::copy("brew install colima docker && colima start"),
        "docker" if win => Spec::run("winget install --id Docker.DockerDesktop -e"),
        "docker" => Spec::admin("sudo apt-get install -y docker.io"),
        "pnpm-install" => Spec::run("pnpm install --frozen-lockfile"),
        _ => return None,
    })
}

fn public(spec: Spec) -> Install {
    Install {
        command: spec.display,
        runnable: spec.argv.is_some() && !spec.admin,
        admin: spec.admin,
    }
}

/// Thư mục dự án người dùng nhập: phải là thư mục có thật.
fn project_dir(folder: Option<&str>) -> Result<Option<PathBuf>, String> {
    match folder.map(str::trim).filter(|f| !f.is_empty()) {
        None => Ok(None),
        Some(f) => {
            let path = PathBuf::from(f);
            if path.is_dir() {
                Ok(Some(path))
            } else {
                Err(format!("Không tìm thấy thư mục {f}."))
            }
        }
    }
}

/// Đánh giá một công cụ theo phiên bản máy có và yêu cầu (nếu có).
fn evaluate(tool: &Tool, have: Option<String>, need: Option<&(Need, &'static str)>) -> CheckItem {
    let required = tool.always_required || need.is_some();
    let status = match (&have, need) {
        (None, _) if required => Status::Missing,
        (None, _) => Status::Optional,
        (Some(v), Some((n, _))) if !n.satisfied_by(&parts(v)) && n.newer_than(&parts(v)) => {
            Status::Mismatch
        }
        (Some(v), Some((n, _))) if !n.satisfied_by(&parts(v)) => Status::Outdated,
        _ => Status::Ok,
    };
    let install = (status != Status::Ok)
        .then(|| install_spec(tool.id, status == Status::Outdated, need.map(|(n, _)| n)))
        .flatten()
        .map(public);
    CheckItem {
        id: tool.id.into(),
        name: tool.name.into(),
        kind: tool.kind,
        required,
        need: need.map(|(n, _)| n.label()),
        have,
        status,
        source: need.map(|(_, s)| (*s).to_string()).unwrap_or_default(),
        install,
    }
}

fn scan(folder: Option<&Path>) -> Vec<CheckItem> {
    let needs = folder.map(read_project).unwrap_or_default();
    let probes: Vec<_> = TOOLS
        .iter()
        .map(|tool| std::thread::spawn(move || probe(tool.program, tool.args)))
        .collect();
    let mut items: Vec<CheckItem> = TOOLS
        .iter()
        .zip(probes)
        .map(|(tool, handle)| {
            let have = handle.join().ok().flatten();
            let need = match tool.id {
                "go" => needs.go.as_ref(),
                "node" => needs.node.as_ref(),
                "pnpm" => needs.pnpm.as_ref(),
                _ => None,
            };
            evaluate(tool, have, need)
        })
        .collect();
    if let Some(missing) = needs.pnpm_install_missing {
        items.push(CheckItem {
            id: "pnpm-install".into(),
            name: "pnpm install".into(),
            kind: Kind::Dependency,
            required: true,
            need: None,
            have: None,
            status: if missing { Status::Missing } else { Status::Ok },
            source: "pnpm-lock.yaml".into(),
            install: missing
                .then(|| install_spec("pnpm-install", false, None))
                .flatten()
                .map(public),
        });
    }
    items
}

#[tauri::command]
pub async fn scan_environment(folder: Option<String>) -> Result<Vec<CheckItem>, String> {
    let dir = project_dir(folder.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || scan(dir.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

/// Chạy lệnh cài của một mục sau khi người dùng xác nhận. Quét lại để lấy đúng lệnh hiện tại của mục đó.
#[tauri::command]
pub async fn run_install(id: String, folder: Option<String>) -> Result<InstallResult, String> {
    let dir = project_dir(folder.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let item = scan(dir.as_deref())
            .into_iter()
            .find(|i| i.id == id)
            .ok_or("Không có mục này.")?;
        let need = match (item.id.as_str(), dir.as_deref().map(read_project)) {
            ("node", Some(n)) => n.node.map(|(n, _)| n),
            _ => None,
        };
        let spec = install_spec(&item.id, item.status == Status::Outdated, need.as_ref())
            .ok_or("Mục này không có lệnh cài.")?;
        if item.status == Status::Ok {
            return Err("Mục này đã đủ, không cần cài.".to_string());
        }
        let argv =
            match (&spec.argv, spec.admin) {
                (Some(argv), false) => argv.clone(),
                _ => return Err(
                    "Lệnh này cần quyền quản trị hoặc cần shell: hãy chép và chạy trong terminal."
                        .into(),
                ),
            };
        let (program, args) = argv.split_first().ok_or("Lệnh rỗng.")?;
        let mut cmd = Command::new(program);
        cmd.args(args).env("PATH", user_path());
        if item.kind == Kind::Dependency {
            cmd.current_dir(dir.as_deref().ok_or("Cần thư mục dự án.")?);
        }
        let out = run_with_timeout(cmd, INSTALL_TIMEOUT)
            .ok_or("Không chạy được lệnh hoặc lệnh chạy quá 15 phút.")?;
        let mut output = String::from_utf8_lossy(&out.stdout).into_owned();
        output.push_str(&String::from_utf8_lossy(&out.stderr));
        let tail = output
            .char_indices()
            .rev()
            .nth(OUTPUT_TAIL)
            .map(|(i, _)| output[i..].to_string())
            .unwrap_or(output);
        Ok(InstallResult {
            ok: out.code == Some(0),
            code: out.code,
            output: tail,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_versions_from_real_outputs() {
        assert_eq!(
            extract_version("go version go1.25.4 darwin/arm64").as_deref(),
            Some("1.25.4")
        );
        assert_eq!(extract_version("v26.10.0\n").as_deref(), Some("26.10.0"));
        assert_eq!(
            extract_version("2.1.296 (Claude Code)").as_deref(),
            Some("2.1.296")
        );
        assert_eq!(
            extract_version("codex-cli 0.162.1").as_deref(),
            Some("0.162.1")
        );
        assert_eq!(
            extract_version("Docker version 28.1.1, build 4eba377").as_deref(),
            Some("28.1.1")
        );
        assert_eq!(
            extract_version("git version 2.50.1 (Apple Git-155)").as_deref(),
            Some("2.50.1")
        );
        assert_eq!(extract_version("no digits here"), None);
    }

    #[test]
    fn compares_versions_by_constraint() {
        assert!(Need::AtLeast(vec![1, 27]).satisfied_by(&[1, 27, 0]));
        assert!(!Need::AtLeast(vec![1, 27]).satisfied_by(&[1, 25, 4]));
        assert!(Need::AtLeast(vec![1, 27]).satisfied_by(&[2, 0]));
        assert!(Need::Caret(vec![12, 1]).satisfied_by(&[12, 11, 2]));
        assert!(!Need::Caret(vec![12, 1]).satisfied_by(&[13, 0]));
        assert!(!Need::Caret(vec![12, 1]).satisfied_by(&[12, 0, 9]));
        assert!(Need::Prefix(vec![24]).satisfied_by(&[24, 21, 0]));
        assert!(!Need::Prefix(vec![24]).satisfied_by(&[26, 10, 0]));
    }

    #[test]
    fn parses_common_ranges() {
        assert_eq!(parse_range(">=24"), Some(Need::AtLeast(vec![24])));
        assert_eq!(parse_range("^10.4.0"), Some(Need::Caret(vec![10, 4, 0])));
        assert_eq!(parse_range("26.x"), Some(Need::Prefix(vec![26])));
        assert_eq!(parse_range("v24.21.0"), Some(Need::Prefix(vec![24, 21, 0])));
        assert_eq!(parse_range("~1.2.3"), Some(Need::Prefix(vec![1, 2])));
        assert_eq!(parse_range(">=18 <20"), None);
        assert_eq!(parse_range("18 || 20"), None);
    }

    #[test]
    fn reads_project_requirements() {
        let dir = std::env::temp_dir().join(format!("hive-doctor-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("go.mod"),
            "module x\n\ngo 1.27\n\ntoolchain go1.27.1\n",
        )
        .unwrap();
        std::fs::write(dir.join(".nvmrc"), "24\n").unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"packageManager":"pnpm@12.11.2+sha512.abc","engines":{"node":">=20"}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        let needs = read_project(&dir);
        assert_eq!(needs.go, Some((Need::AtLeast(vec![1, 27]), "go.mod")));
        // .nvmrc thắng engines: đó là bản dự án thật sự dùng.
        assert_eq!(needs.node, Some((Need::Prefix(vec![24]), ".nvmrc")));
        assert_eq!(
            needs.pnpm,
            Some((Need::Caret(vec![12, 11, 2]), "package.json"))
        );
        assert_eq!(needs.pnpm_install_missing, Some(true));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn statuses_follow_requirements() {
        let go = &TOOLS[4];
        let need = (Need::AtLeast(vec![1, 27]), "go.mod");
        let old = evaluate(go, Some("1.25.4".into()), Some(&need));
        assert_eq!(old.status, Status::Outdated);
        assert!(old.required);
        assert_eq!(old.need.as_deref(), Some("≥ 1.27"));
        assert_eq!(old.source, "go.mod");
        assert!(old.install.is_some());
        let missing_optional = evaluate(&TOOLS[3], None, None);
        assert_eq!(missing_optional.status, Status::Optional);
        assert!(!missing_optional.required);
        let git = evaluate(&TOOLS[0], None, None);
        assert_eq!(git.status, Status::Missing);
        assert!(git.required);
        let node = &TOOLS[5];
        let nvmrc = (Need::Prefix(vec![24]), ".nvmrc");
        assert_eq!(
            evaluate(node, Some("26.10.0".into()), Some(&nvmrc)).status,
            Status::Mismatch
        );
        assert_eq!(
            evaluate(node, Some("22.1.0".into()), Some(&nvmrc)).status,
            Status::Outdated
        );
        let ok = evaluate(go, Some("1.27.1".into()), Some(&need));
        assert_eq!(ok.status, Status::Ok);
        assert!(ok.install.is_none());
    }

    #[test]
    fn shell_or_admin_commands_are_copy_only() {
        let nvm = public(install_spec("node", false, Some(&Need::Prefix(vec![24]))).unwrap());
        if !cfg!(target_os = "windows") {
            assert_eq!(nvm.command, "nvm install 24");
            assert!(!nvm.runnable);
        }
        let pnpm = public(install_spec("pnpm", false, None).unwrap());
        assert!(pnpm.runnable);
        assert!(install_spec("rm -rf /", false, None).is_none());
    }

    #[test]
    fn rejects_missing_folder() {
        assert!(project_dir(Some("/khong/co/thu/muc/nay")).is_err());
        assert_eq!(project_dir(Some("  ")).unwrap(), None);
    }

    #[test]
    fn kills_commands_past_the_deadline() {
        #[cfg(unix)]
        {
            let mut cmd = Command::new("sleep");
            cmd.arg("5");
            let started = Instant::now();
            assert!(run_with_timeout(cmd, Duration::from_millis(200)).is_none());
            assert!(started.elapsed() < Duration::from_secs(2));
        }
    }
}
