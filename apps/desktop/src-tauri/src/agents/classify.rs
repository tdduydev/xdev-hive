//! Nhận ra tiến trình agent CLI (Claude Code, Codex, Antigravity) trong danh sách tiến trình của máy, gộp shim, cộng
//! CPU và RAM theo cây, và đoán ai mở. Hàm thuần trên `Proc` để test không cần hệ điều hành; `agents.rs` đọc tiến trình
//! thật bằng sysinfo.

use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// Một tiến trình của máy, đã đọc xong. Môi trường không nằm ở đây: `agents.rs` lọc ngay khi đọc.
#[derive(Debug, Clone, Default)]
pub(crate) struct Proc {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: String,
    /// None khi không hỏi được đường dẫn (tiến trình của người dùng khác, quyền cao hơn).
    pub exe: Option<String>,
    pub cmd: Vec<String>,
    pub cwd: Option<String>,
    /// Giây kể từ epoch.
    pub start: u64,
    /// Phần trăm của một nhân, như sysinfo trả.
    pub cpu: f32,
    pub memory: u64,
    /// Cùng người dùng hệ điều hành với app.
    pub own: bool,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Cli {
    Claude,
    Codex,
    Antigravity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Match {
    pub cli: Cli,
    /// `node` chạy gói npm của CLI: con cùng CLI của nó là cùng một phiên.
    pub shim: bool,
    /// Chạy một lượt rồi thoát (`claude -p`, `codex exec`).
    pub background: bool,
    pub bypass: bool,
}

/// Ai mở agent.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Source {
    Run {
        run_id: String,
    },
    Hive {
        session_id: Option<String>,
        hub_id: Option<String>,
    },
    App,
    ClaudeDesktop,
    OtherApp {
        name: String,
    },
    Terminal,
}

/// Một dòng của `hive ls --json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HiveSession {
    pub id: String,
    pub pid: u32,
    pub hub_id: Option<String>,
}

pub(crate) struct Context<'a> {
    pub app_pid: u32,
    pub hive: &'a [HiveSession],
}

/// Một agent trên màn: tiến trình ngoài cùng của phiên, kèm con đã gộp.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Row {
    pub pid: u32,
    /// pid của dòng rồi tới con cùng CLI đã gộp (shim → binary).
    pub pids: Vec<u32>,
    pub m: Match,
    pub start: u64,
    pub cpu: f32,
    pub memory: u64,
    pub own: bool,
    pub cwd: Option<String>,
    pub source: Source,
    /// Agent khác chạy bên dưới dòng này (dừng dòng này thì dừng cả chúng).
    pub children: usize,
    /// Có tổ tiên `hive-worker` mà không phải Hive run: cần `hive ls` để biết phiên nào.
    pub under_worker: bool,
}

/// Giới hạn bước đi lên cây: Windows dùng lại pid nên cha có thể trỏ vòng.
const MAX_DEPTH: usize = 64;

/// Tên file chạy, chữ thường, bỏ `.exe`; không có đường dẫn thì dùng tên tiến trình.
fn stem(exe_or_name: &str) -> String {
    let file = exe_or_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(exe_or_name);
    let lower = file.to_lowercase();
    lower
        .strip_suffix(".exe")
        .map(str::to_string)
        .unwrap_or(lower)
}

fn path_of(p: &Proc) -> &str {
    p.exe.as_deref().unwrap_or(&p.name)
}

/// Claude Desktop cũng tên `claude.exe` trên Windows và `Claude` trên macOS, nên phải xét đường dẫn: thư mục cài
/// (WindowsApps, AnthropicClaude) hay gói `Claude.app`. Claude Code mà Claude Desktop tải về nằm ở thư mục dữ liệu
/// (`%APPDATA%\Claude\claude-code`) nên không bị loại. Cùng luật với `claude_desktop/win.rs`.
pub(crate) fn is_claude_desktop_exe(path: &str) -> bool {
    let p = path.to_lowercase().replace('\\', "/");
    if p.contains("/claude.app/contents/") {
        return true;
    }
    if !p.ends_with("/claude.exe") {
        return false;
    }
    if p.contains("/anthropicclaude/") {
        return true;
    }
    p.split("/windowsapps/")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .is_some_and(|package| {
            let name = package.split('_').next().unwrap_or("");
            package.contains('_') && (name == "claude" || name.ends_with(".claude"))
        })
}

/// File chạy chính của một app macOS (`X.app/Contents/MacOS/X`): app có giao diện, không phải CLI.
fn mac_app_main(path: &str) -> bool {
    path.replace('\\', "/").contains(".app/Contents/MacOS/")
}

/// Binary Codex của gói npm mang đuôi bộ ba nền tảng (`codex-x86_64-pc-windows-msvc`); helper khác của Codex
/// (`codex-computer-use-swift`) thì không.
fn codex_binary(stem: &str) -> bool {
    stem == "codex"
        || stem.strip_prefix("codex-").is_some_and(|rest| {
            ["-pc-windows-", "-apple-darwin", "-unknown-linux-"]
                .iter()
                .any(|t| rest.contains(t))
        })
}

/// Gói npm của CLI trong tham số của `node`.
fn npm_cli(args: &[String]) -> Option<Cli> {
    args.iter().find_map(|a| {
        let a = a.replace('\\', "/");
        if a.contains("@anthropic-ai/claude-code") {
            Some(Cli::Claude)
        } else if a.contains("@openai/codex") {
            Some(Cli::Codex)
        } else {
            None
        }
    })
}

pub(crate) fn match_cli(p: &Proc) -> Option<Match> {
    let args = p.cmd.get(1..).unwrap_or_default();
    let path = path_of(p);
    let cli_stem = |s: &str| s == "claude" || s == "agy" || codex_binary(s);
    let file = stem(path);
    // Trình cài native của Claude Code để `~/.local/bin/claude` trỏ tới `…/claude/versions/<bản>`, và macOS, Linux trả
    // đường dẫn thật của file chạy. File chạy mang tên khác thì xét tên lệnh người dùng gõ (argv[0]).
    let file = if path
        .replace('\\', "/")
        .to_lowercase()
        .contains("/claude/versions/")
    {
        "claude".to_string()
    } else if cli_stem(&file) || file == "node" || file == "bun" {
        file
    } else {
        p.cmd
            .first()
            .map(|a| stem(a))
            .filter(|a| cli_stem(a))
            .unwrap_or(file)
    };
    let (cli, shim) = match file.as_str() {
        "node" | "bun" => (npm_cli(args)?, true),
        _ if mac_app_main(path) => return None,
        // Không đọc được đường dẫn thì không phân biệt được Claude Desktop với Claude Code.
        "claude" if p.exe.is_none() || is_claude_desktop_exe(path) => return None,
        "claude" => (Cli::Claude, false),
        "agy" => (Cli::Antigravity, false),
        s if codex_binary(s) => (Cli::Codex, false),
        _ => return None,
    };
    let has = |flag: &str| args.iter().any(|a| a == flag);
    let background = match cli {
        Cli::Codex => has("exec"),
        Cli::Claude | Cli::Antigravity => has("-p") || has("--print"),
    };
    let bypass = has("--dangerously-skip-permissions")
        || has("--dangerously-bypass-approvals-and-sandbox")
        || has("--yolo")
        || has("--permission-mode=bypassPermissions")
        || args
            .windows(2)
            .any(|w| w[0] == "--permission-mode" && w[1] == "bypassPermissions");
    Some(Match {
        cli,
        shim,
        background,
        bypass,
    })
}

/// Mã run của Hive từ thư mục worktree của worker: `…/xdev-hive/worker/runs/<runId>-<lần thử>` (worker
/// `runner.go`). Thư mục `.trash-…` là worktree đang chờ xoá.
pub(crate) fn run_of(cwd: &str) -> Option<String> {
    let parts: Vec<&str> = cwd.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    let at = parts.windows(3).position(|w| {
        w[0].eq_ignore_ascii_case("xdev-hive")
            && w[1].eq_ignore_ascii_case("worker")
            && w[2].eq_ignore_ascii_case("runs")
    })?;
    let name = parts.get(at + 3)?;
    if name.starts_with('.') {
        return None;
    }
    let (id, attempt) = name.rsplit_once('-')?;
    (!id.is_empty() && !attempt.is_empty() && attempt.chars().all(|c| c.is_ascii_digit()))
        .then(|| id.to_string())
}

/// App đã biết mở agent trong terminal riêng của nó.
pub(crate) fn other_app(exe_or_name: &str) -> Option<&'static str> {
    let path = exe_or_name.replace('\\', "/").to_lowercase();
    if let Some(bundle) = path.split('/').find(|c| c.ends_with(".app")) {
        return match bundle {
            "codex.app" => Some("Codex Desktop"),
            "visual studio code.app" | "code.app" => Some("VS Code"),
            "cursor.app" => Some("Cursor"),
            "antigravity.app" => Some("Antigravity IDE"),
            b if ["intellij idea", "webstorm", "pycharm", "goland", "rider"]
                .iter()
                .any(|n| b.starts_with(n)) =>
            {
                Some("JetBrains")
            }
            _ => None,
        };
    }
    match stem(&path).as_str() {
        // App Codex trên Windows là ChatGPT.exe trong gói OpenAI.Codex.
        "chatgpt" => Some("Codex Desktop"),
        "code" | "code - insiders" => Some("VS Code"),
        "cursor" => Some("Cursor"),
        "antigravity" => Some("Antigravity IDE"),
        "idea" | "idea64" | "webstorm64" | "pycharm64" | "goland64" | "rider64" => {
            Some("JetBrains")
        }
        _ => None,
    }
}

/// Cha thật của tiến trình. Windows dùng lại pid và không xoá pid cha đã chết khỏi tiến trình con: một tiến trình chạy
/// trước mà ghi cha là pid nay thuộc agent thì không phải con của agent. Không có giờ bắt đầu thì tin pid cha.
fn parent_of<'a>(p: &Proc, get: impl Fn(u32) -> Option<&'a Proc>) -> Option<u32> {
    let parent = p.parent.filter(|x| *x != p.pid)?;
    match get(parent) {
        Some(up) if up.start != 0 && p.start != 0 && up.start > p.start => None,
        _ => Some(parent),
    }
}

struct Tree<'a> {
    by_pid: HashMap<u32, &'a Proc>,
}

impl<'a> Tree<'a> {
    fn new(procs: &'a [Proc]) -> Self {
        Self {
            by_pid: procs.iter().map(|p| (p.pid, p)).collect(),
        }
    }

    /// Tổ tiên, gần nhất trước, không gồm chính nó; dừng khi gặp vòng hay đủ sâu.
    fn ancestors(&self, pid: u32) -> Vec<u32> {
        let mut seen = HashSet::from([pid]);
        let mut out = Vec::new();
        let mut cur = pid;
        while let Some(parent) = self
            .by_pid
            .get(&cur)
            .and_then(|p| parent_of(p, |x| self.by_pid.get(&x).copied()))
        {
            if out.len() >= MAX_DEPTH || !seen.insert(parent) {
                break;
            }
            out.push(parent);
            cur = parent;
        }
        out
    }

    fn get(&self, pid: u32) -> Option<&'a Proc> {
        self.by_pid.get(&pid).copied()
    }
}

/// Nguồn của một agent và cờ "có worker phía trên mà chưa biết phiên nào".
fn source(tree: &Tree, p: &Proc, ctx: &Context) -> (Source, bool) {
    if let Some(run_id) = p.cwd.as_deref().and_then(run_of) {
        return (Source::Run { run_id }, false);
    }
    let up = tree.ancestors(p.pid);
    let chain: Vec<u32> = std::iter::once(p.pid).chain(up.iter().copied()).collect();
    if let Some(s) = chain
        .iter()
        .find_map(|pid| ctx.hive.iter().find(|s| s.pid == *pid))
    {
        let session = Source::Hive {
            session_id: Some(s.id.clone()),
            hub_id: s.hub_id.clone(),
        };
        return (session, false);
    }
    let procs_up = || up.iter().filter_map(|pid| tree.get(*pid));
    // Worker là con của app: xét trước app để run và phiên hive không thành "terminal trong app".
    if procs_up().any(|a| stem(path_of(a)).starts_with("hive-worker")) {
        let unknown = Source::Hive {
            session_id: None,
            hub_id: None,
        };
        return (unknown, true);
    }
    if up.contains(&ctx.app_pid) {
        return (Source::App, false);
    }
    if procs_up().any(|a| a.exe.as_deref().is_some_and(is_claude_desktop_exe)) {
        return (Source::ClaudeDesktop, false);
    }
    if let Some(name) = procs_up().find_map(|a| other_app(path_of(a))) {
        return (Source::OtherApp { name: name.into() }, false);
    }
    (Source::Terminal, false)
}

pub(crate) fn rows(procs: &[Proc], ctx: &Context) -> Vec<Row> {
    let tree = Tree::new(procs);
    let matched: HashMap<u32, Match> = procs
        .iter()
        .filter_map(|p| match_cli(p).map(|m| (p.pid, m)))
        .collect();
    // Con cùng CLI của shim là cùng một phiên: gắn vào agent gần nhất phía trên khi đó là shim.
    let merged_into: HashMap<u32, u32> = matched
        .iter()
        .filter_map(|(pid, m)| {
            let near = tree
                .ancestors(*pid)
                .into_iter()
                .find(|a| matched.contains_key(a))?;
            let parent = matched[&near];
            (parent.shim && parent.cli == m.cli).then_some((*pid, near))
        })
        .collect();
    let root_of = |pid: u32| {
        let mut cur = pid;
        for _ in 0..MAX_DEPTH {
            match merged_into.get(&cur) {
                Some(up) if *up != pid => cur = *up,
                _ => break,
            }
        }
        cur
    };
    let roots: Vec<u32> = matched
        .keys()
        .copied()
        .filter(|pid| !merged_into.contains_key(pid))
        .collect();
    let mut out: Vec<Row> = roots
        .iter()
        .filter_map(|pid| tree.get(*pid))
        .map(|p| {
            let mut pids = vec![p.pid];
            let mut extra: Vec<u32> = merged_into
                .keys()
                .copied()
                .filter(|c| root_of(*c) == p.pid)
                .collect();
            extra.sort_unstable();
            pids.extend(extra);
            let mut m = matched[&p.pid];
            for c in &pids[1..] {
                m.background |= matched[c].background;
                m.bypass |= matched[c].bypass;
            }
            let cwd = pids
                .iter()
                .find_map(|c| tree.get(*c).and_then(|x| x.cwd.clone()));
            let (source, under_worker) = source(&tree, p, ctx);
            Row {
                pid: p.pid,
                pids,
                m,
                start: p.start,
                cpu: 0.0,
                memory: 0,
                own: p.own,
                cwd,
                source,
                children: 0,
                under_worker,
            }
        })
        .collect();
    let index: HashMap<u32, usize> = out.iter().enumerate().map(|(i, r)| (r.pid, i)).collect();
    // Mỗi tiến trình tính cho dòng gần nhất phía trên nó, kể cả chính nó: rg, MCP server thuộc agent đã mở chúng.
    for p in procs {
        let owner = std::iter::once(p.pid)
            .chain(tree.ancestors(p.pid))
            .find_map(|a| index.get(&a).copied());
        if let Some(i) = owner {
            out[i].cpu += p.cpu;
            out[i].memory += p.memory;
        }
    }
    for pid in &roots {
        for a in tree.ancestors(*pid) {
            if let Some(i) = index.get(&a) {
                out[*i].children += 1;
            }
        }
    }
    out.sort_by_key(|r| (r.start, r.pid));
    out
}

/// Cả cây của `root`: con cháu trước, `root` sau cùng, để dừng từ lá lên.
pub(crate) fn subtree(procs: &[Proc], root: u32) -> Vec<u32> {
    let by_pid: HashMap<u32, &Proc> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut kids: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in procs {
        if let Some(parent) = parent_of(p, |x| by_pid.get(&x).copied()) {
            kids.entry(parent).or_default().push(p.pid);
        }
    }
    let mut out = Vec::new();
    let mut seen = HashSet::from([root]);
    // Duyệt sâu không đệ quy; cờ true là đã đẩy con, tới lượt thì ghi chính nó.
    let mut stack = vec![(root, false)];
    while let Some((pid, expanded)) = stack.pop() {
        if expanded {
            out.push(pid);
            continue;
        }
        stack.push((pid, true));
        for k in kids.get(&pid).into_iter().flatten() {
            if seen.insert(*k) {
                stack.push((*k, false));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, parent: u32, exe: &str, args: &[&str]) -> Proc {
        let name = exe.rsplit(['/', '\\']).next().unwrap_or(exe).to_string();
        Proc {
            pid,
            parent: (parent != 0).then_some(parent),
            name,
            exe: Some(exe.into()),
            cmd: std::iter::once(exe)
                .chain(args.iter().copied())
                .map(String::from)
                .collect(),
            cwd: Some("/home/ha/shop".into()),
            start: 1_000 + u64::from(pid),
            cpu: 10.0,
            memory: 100,
            own: true,
        }
    }

    fn cli(exe: &str, args: &[&str]) -> Option<Cli> {
        match_cli(&proc(1, 0, exe, args)).map(|m| m.cli)
    }

    const NONE: Context<'static> = Context {
        app_pid: 0,
        hive: &[],
    };

    #[test]
    fn matches_cli_binaries_and_skips_claude_desktop() {
        assert_eq!(
            cli(r"C:\Users\a\.local\bin\claude.exe", &[]),
            Some(Cli::Claude)
        );
        assert_eq!(
            cli(
                r"C:\Program Files\WindowsApps\Claude_2.42304.0.0_x64__pzs8sxrjxfjjc\app\claude.exe",
                &[]
            ),
            None
        );
        assert_eq!(
            cli(
                r"C:\Users\a\AppData\Local\AnthropicClaude\app-1.0\claude.exe",
                &[]
            ),
            None
        );
        assert_eq!(
            cli("/Applications/Claude.app/Contents/MacOS/Claude", &[]),
            None
        );
        // Phiên Code của Claude Desktop chạy Claude Code từ thư mục dữ liệu, không phải thư mục cài.
        assert_eq!(
            cli(
                r"C:\Users\a\AppData\Roaming\Claude\claude-code\2.1.299\f0584be0fbaf\claude.exe",
                &[]
            ),
            Some(Cli::Claude)
        );
        assert_eq!(cli("/usr/local/bin/codex", &[]), Some(Cli::Codex));
        assert_eq!(cli(r"C:\x\codex.exe", &[]), Some(Cli::Codex));
        assert_eq!(
            cli(r"C:\x\codex-x86_64-pc-windows-msvc.exe", &[]),
            Some(Cli::Codex)
        );
        assert_eq!(cli("/x/codex-aarch64-apple-darwin", &[]), Some(Cli::Codex));
        assert_eq!(cli(r"C:\x\codex-computer-use-swift.exe", &[]), None);
        // App Codex trên macOS cũng tên Codex nhưng là app có giao diện.
        assert_eq!(
            cli("/Applications/Codex.app/Contents/MacOS/Codex", &[]),
            None
        );
        assert_eq!(cli("/home/ha/.local/bin/agy", &[]), Some(Cli::Antigravity));
        let node_claude = match_cli(&proc(
            1,
            0,
            "/usr/bin/node",
            &["/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"],
        ))
        .unwrap();
        assert_eq!((node_claude.cli, node_claude.shim), (Cli::Claude, true));
        let node_codex = match_cli(&proc(
            1,
            0,
            r"C:\Program Files\nodejs\node.exe",
            &[r"C:\Users\a\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js"],
        ))
        .unwrap();
        assert_eq!((node_codex.cli, node_codex.shim), (Cli::Codex, true));
        assert_eq!(cli("/usr/bin/node", &["server.js"]), None);
        // Không đọc được đường dẫn thì không phân biệt được Claude Desktop với Claude Code: bỏ qua.
        let mut hidden = proc(1, 0, "claude.exe", &[]);
        hidden.exe = None;
        assert_eq!(match_cli(&hidden), None);
    }

    #[test]
    fn flags_background_and_bypass() {
        let m = |exe: &str, args: &[&str]| match_cli(&proc(1, 0, exe, args)).unwrap();
        assert!(m("/bin/claude", &["-p", "sửa lỗi"]).background);
        assert!(m("/bin/claude", &["--print"]).background);
        assert!(!m("/bin/claude", &[]).background);
        assert!(m("/bin/codex", &["exec", "--json", "x"]).background);
        assert!(!m("/bin/codex", &["app-server"]).background);
        assert!(m("/bin/claude", &["--dangerously-skip-permissions"]).bypass);
        assert!(m("/bin/claude", &["--permission-mode", "bypassPermissions"]).bypass);
        assert!(
            m(
                "/bin/codex",
                &["--dangerously-bypass-approvals-and-sandbox"]
            )
            .bypass
        );
        assert!(m("/bin/codex", &["--yolo"]).bypass);
        assert!(!m("/bin/codex", &[]).bypass);
    }

    #[test]
    fn reads_run_id_from_worker_folder() {
        assert_eq!(
            run_of("/home/a/.cache/xdev-hive/worker/runs/0b7c3e1a-5d2f-4c4e-9a7b-1f2e3d4c5b6a-2")
                .as_deref(),
            Some("0b7c3e1a-5d2f-4c4e-9a7b-1f2e3d4c5b6a")
        );
        assert_eq!(
            run_of(r"C:\Users\a\AppData\Local\xdev-hive\worker\runs\abc-1\sub").as_deref(),
            Some("abc")
        );
        assert_eq!(run_of("/home/a/code"), None);
        assert_eq!(
            run_of("/home/a/.cache/xdev-hive/worker/runs/.trash-abc-1-99"),
            None
        );
        assert_eq!(run_of("/home/a/.cache/xdev-hive/worker/runs"), None);
    }

    #[test]
    fn names_other_apps() {
        assert_eq!(
            other_app(
                r"C:\Program Files\WindowsApps\OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe"
            ),
            Some("Codex Desktop")
        );
        assert_eq!(
            other_app(r"C:\Users\a\AppData\Local\Programs\Microsoft VS Code\Code.exe"),
            Some("VS Code")
        );
        assert_eq!(
            other_app("/Applications/Visual Studio Code.app/Contents/MacOS/Electron"),
            Some("VS Code")
        );
        assert_eq!(
            other_app("/Applications/Cursor.app/Contents/MacOS/Cursor"),
            Some("Cursor")
        );
        assert_eq!(
            other_app("/Applications/Codex.app/Contents/MacOS/Codex"),
            Some("Codex Desktop")
        );
        assert_eq!(other_app("antigravity"), Some("Antigravity IDE"));
        assert_eq!(other_app(r"C:\JetBrains\bin\idea64.exe"), Some("JetBrains"));
        assert_eq!(
            other_app(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"),
            None
        );
        assert_eq!(other_app("/bin/zsh"), None);
    }

    #[test]
    fn merges_node_shim_but_keeps_nested_agents() {
        let procs = vec![
            proc(
                10,
                1,
                "/usr/bin/node",
                &["/usr/lib/node_modules/@openai/codex/bin/codex.js", "--yolo"],
            ),
            proc(
                11,
                10,
                "/usr/lib/node_modules/@openai/codex/vendor/codex-x86_64-unknown-linux-musl",
                &[],
            ),
            proc(12, 11, "/usr/bin/rg", &[]),
            proc(20, 1, "/home/ha/.local/bin/claude", &[]),
            proc(21, 20, "/home/ha/.local/bin/claude", &["-p", "việc con"]),
            proc(22, 21, "/usr/bin/node", &["mcp.js"]),
            proc(23, 20, "/usr/bin/node", &["mcp-server.js"]),
        ];
        let rows = rows(&procs, &NONE);
        assert_eq!(rows.len(), 3, "{rows:?}");
        let codex = rows.iter().find(|r| r.pid == 10).unwrap();
        assert_eq!(codex.pids, vec![10, 11]);
        assert_eq!(codex.m.cli, Cli::Codex);
        assert!(codex.m.bypass);
        assert_eq!((codex.cpu, codex.memory), (30.0, 300));
        let parent = rows.iter().find(|r| r.pid == 20).unwrap();
        let child = rows.iter().find(|r| r.pid == 21).unwrap();
        assert_eq!(parent.children, 1);
        assert_eq!(child.children, 0);
        assert!(child.m.background);
        // Cây của agent con tính cho agent con.
        assert_eq!((parent.cpu, parent.memory), (20.0, 200));
        assert_eq!((child.cpu, child.memory), (20.0, 200));
    }

    #[test]
    fn assigns_sources_in_order() {
        let mut run = proc(30, 3, "/bin/claude", &[]);
        run.cwd = Some("/home/ha/.cache/xdev-hive/worker/runs/r-77-1".into());
        let procs = vec![
            proc(1, 0, "/sbin/init", &[]),
            proc(2, 1, "/opt/xdev-hive/xdev-hive-desktop", &[]),
            proc(3, 2, "/opt/xdev-hive/hive-worker", &[]),
            run,
            proc(31, 3, "/bin/claude", &[]),
            proc(32, 3, "/bin/codex", &[]),
            proc(40, 2, "/bin/bash", &[]),
            proc(41, 40, "/bin/claude", &[]),
            proc(42, 2, "/bin/codex", &[]),
            proc(
                50,
                1,
                r"C:\Program Files\WindowsApps\Claude_2.42304.0.0_x64__pzs8sxrjxfjjc\app\claude.exe",
                &[],
            ),
            proc(
                51,
                50,
                r"C:\Users\a\AppData\Roaming\Claude\claude-code\2.1.299\x\claude.exe",
                &[],
            ),
            proc(
                60,
                1,
                r"C:\Apps\OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe",
                &[],
            ),
            proc(
                61,
                60,
                r"C:\Users\a\AppData\Local\OpenAI\Codex\bin\9614f1d9b40d9c4f\codex.exe",
                &["app-server"],
            ),
            proc(70, 1, "/usr/bin/zsh", &[]),
            proc(71, 70, "/bin/agy", &[]),
        ];
        let hive = [HiveSession {
            id: "s-1".into(),
            pid: 31,
            hub_id: Some("h-9".into()),
        }];
        let ctx = Context {
            app_pid: 2,
            hive: &hive,
        };
        let rows = rows(&procs, &ctx);
        let source = |pid: u32| rows.iter().find(|r| r.pid == pid).unwrap().source.clone();
        let under = |pid: u32| rows.iter().find(|r| r.pid == pid).unwrap().under_worker;
        assert_eq!(
            source(30),
            Source::Run {
                run_id: "r-77".into()
            }
        );
        assert!(!under(30));
        assert_eq!(
            source(31),
            Source::Hive {
                session_id: Some("s-1".into()),
                hub_id: Some("h-9".into())
            }
        );
        assert_eq!(
            source(32),
            Source::Hive {
                session_id: None,
                hub_id: None
            }
        );
        assert!(under(32));
        assert_eq!(source(41), Source::App);
        assert_eq!(source(42), Source::App);
        assert_eq!(source(51), Source::ClaudeDesktop);
        assert_eq!(
            source(61),
            Source::OtherApp {
                name: "Codex Desktop".into()
            }
        );
        assert_eq!(source(71), Source::Terminal);
    }

    #[test]
    fn survives_parent_loops() {
        // Windows dùng lại pid: cha của 1 là 2, cha của 2 là 1.
        let procs = vec![
            proc(1, 2, "/bin/claude", &[]),
            proc(2, 1, "/bin/claude", &[]),
        ];
        let started = std::time::Instant::now();
        let rows = rows(&procs, &NONE);
        assert_eq!(rows.len(), 2);
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(subtree(&procs, 1).last(), Some(&1));
    }

    #[test]
    fn subtree_lists_descendants_before_root() {
        let procs = vec![
            proc(1, 0, "/bin/claude", &[]),
            proc(2, 1, "/bin/sh", &[]),
            proc(3, 2, "/bin/rg", &[]),
            proc(4, 1, "/bin/node", &[]),
            proc(5, 0, "/bin/zsh", &[]),
        ];
        let all = subtree(&procs, 1);
        assert_eq!(all.len(), 4);
        assert_eq!(all.last(), Some(&1));
        let pos = |p: u32| all.iter().position(|x| *x == p).unwrap();
        assert!(pos(3) < pos(2));
        assert!(!all.contains(&5));
    }

    #[test]
    fn ignores_parent_links_to_a_reused_pid() {
        // Windows dùng lại pid: explorer (chạy trước) còn ghi cha là pid cũ của userinit, nay là pid của claude.
        let mut explorer = proc(20, 10, r"C:\Windows\explorer.exe", &[]);
        explorer.start = 100;
        let mut app = proc(21, 20, r"C:\Apps\notepad.exe", &[]);
        app.start = 200;
        let procs = vec![
            proc(10, 0, r"C:\Users\a\.local\bin\claude.exe", &[]),
            proc(11, 10, r"C:\x\rg.exe", &[]),
            explorer,
            app,
        ];
        assert_eq!(subtree(&procs, 10), vec![11, 10]);
        let rows = rows(&procs, &NONE);
        assert_eq!((rows[0].cpu, rows[0].memory), (20.0, 200));
    }

    #[test]
    fn matches_resolved_native_install_paths() {
        // Trình cài native của Claude Code để `~/.local/bin/claude` trỏ tới file theo phiên bản; macOS và Linux trả
        // đường dẫn thật của file chạy.
        let mut native = proc(1, 0, "/Users/ha/.local/share/claude/versions/2.1.300", &[]);
        native.name = "2.1.300".into();
        assert_eq!(match_cli(&native).map(|m| m.cli), Some(Cli::Claude));
        let mut argv0 = proc(1, 0, "/opt/tools/v/2.1.300", &[]);
        argv0.cmd[0] = "claude".into();
        assert_eq!(match_cli(&argv0).map(|m| m.cli), Some(Cli::Claude));
        // Tên lệnh không cứu được Claude Desktop: luật loại theo đường dẫn vẫn thắng.
        let mut desktop = proc(1, 0, "/Applications/Claude.app/Contents/MacOS/Claude", &[]);
        desktop.cmd[0] = "claude".into();
        assert_eq!(match_cli(&desktop), None);
    }
}
