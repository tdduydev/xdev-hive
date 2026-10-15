//! Kiểm thật Nhóm Git với một group trên máy chủ thật, chỉ đọc. Không chạy trên CI (`#[ignore]`), chạy tay:
//!
//! ```sh
//! HIVE_E2E_GIT_URL=https://gitlab.example.vn HIVE_E2E_GIT_GROUP=acme HIVE_E2E_GIT_ROOT=$HOME/xdev-hive-test \
//!   cargo test --lib git_groups::e2e -- --ignored --nocapture
//! ```
//!
//! Dùng đăng nhập Git có sẵn của máy (HOME thật, helper như glab/GCM) như chế độ "đăng nhập có sẵn" của app, nhưng
//! cấu hình worker, projects.json và thư mục gốc đều là thư mục tạm: không đụng cấu hình thật của app. Worker được build
//! từ `worker/` (hoặc lấy ở HIVE_E2E_WORKER) và gọi bằng đúng tham số các lệnh Tauri dựng.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::*;

/// Giới hạn song song mặc định của worker (gitgroups.DefaultConcurrency); app không truyền --concurrency.
const DEFAULT_CONCURRENCY: usize = 4;

/// git giả đứng trước git thật trong PATH, đếm số clone/fetch đang chạy cùng lúc để kiểm giới hạn song song. Chỉ dùng
/// cho lượt không huỷ: sh không chuyển Interrupt cho git con.
const SHIM: &str = r#"#!/bin/sh
case " $* " in
  *" clone "*) op=clone ;;
  *" fetch "*) op=fetch ;;
  *) exec "$HIVE_E2E_REAL_GIT" "$@" ;;
esac
touch "$HIVE_E2E_GIT_LOG/active.$$"
echo "$op $(ls "$HIVE_E2E_GIT_LOG" | grep -c '^active\.')" >> "$HIVE_E2E_GIT_LOG/ops"
"$HIVE_E2E_REAL_GIT" "$@"
rc=$?
rm -f "$HIVE_E2E_GIT_LOG/active.$$"
exit $rc
"#;

struct Worker {
    bin: PathBuf,
    config: PathBuf,
    path: String,
    shim_path: String,
    log: PathBuf,
    real_git: String,
}

struct Run {
    events: Vec<Value>,
    elapsed: Duration,
    /// Từ lúc gửi "cancel" tới sự kiện "done".
    cancel_latency: Option<Duration>,
    /// Giờ xong của từng repo, tính từ lúc bắt đầu.
    at: BTreeMap<String, Duration>,
}

impl Run {
    fn repos(&self) -> BTreeMap<String, (String, String)> {
        self.events
            .iter()
            .filter(|e| e["type"] == "repo")
            .map(|e| {
                (
                    e["path"].as_str().unwrap_or("").to_string(),
                    (
                        e["result"].as_str().unwrap_or("").to_string(),
                        e["message"].as_str().unwrap_or("").to_string(),
                    ),
                )
            })
            .collect()
    }

    fn summary(&self) -> Value {
        let done = self.events.iter().find(|e| e["type"] == "done");
        done.expect("sidecar không gửi sự kiện done")["summary"].clone()
    }
}

impl Worker {
    fn command(&self, args: &[String], shim: bool) -> Command {
        let mut cmd = Command::new(&self.bin);
        cmd.args(args)
            .env("HIVE_WORKER_CONFIG", &self.config)
            .env("PATH", if shim { &self.shim_path } else { &self.path })
            .env("HIVE_E2E_GIT_LOG", &self.log)
            .env("HIVE_E2E_REAL_GIT", &self.real_git)
            .env_remove(TOKEN_ENV)
            .env_remove(TOKENS_ENV);
        cmd
    }

    fn json(&self, args: Vec<String>, env: &[(&str, String)]) -> Value {
        let mut cmd = self.command(&args, false);
        for (k, v) in env {
            cmd.env(k, v);
        }
        let out = cmd.output().expect("chạy worker");
        assert!(
            out.status.success(),
            "{} lỗi: {}",
            args[1],
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).expect("JSON của worker")
    }

    fn status(&self, id: &str) -> BTreeMap<String, Value> {
        let mut args = base("status");
        args.push(id_arg("id", id).unwrap());
        self.json(args, &[])["status"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| (s["path"].as_str().unwrap().to_string(), s.clone()))
            .collect()
    }

    /// Như `git_group_sync`: tiến độ mỗi dòng một JSON, huỷ bằng "cancel" qua stdin.
    fn sync(&self, id: &str, action: &str, cancel_after: Option<usize>, shim: bool) -> Run {
        let _ = std::fs::remove_file(self.log.join("ops"));
        let started = Instant::now();
        let mut child = self
            .command(&sync_args(id, action).unwrap(), shim)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("chạy sidecar");
        let mut stdin = child.stdin.take();
        let mut run = Run {
            events: vec![],
            elapsed: Duration::ZERO,
            cancel_latency: None,
            at: BTreeMap::new(),
        };
        let mut cancelled_at = None;
        let mut repos = 0;
        for line in BufReader::new(child.stdout.take().unwrap()).lines() {
            let event: Value = serde_json::from_str(&line.unwrap()).expect("dòng JSON");
            if event["type"] == "repo" {
                repos += 1;
                run.at.insert(
                    event["path"].as_str().unwrap().to_string(),
                    started.elapsed(),
                );
                if cancel_after == Some(repos) {
                    stdin
                        .as_mut()
                        .unwrap()
                        .write_all(b"cancel\n")
                        .expect("gửi cancel");
                    cancelled_at = Some(Instant::now());
                }
            }
            if event["type"] == "done" {
                run.cancel_latency = cancelled_at.map(|t| t.elapsed());
            }
            run.events.push(event);
        }
        drop(stdin);
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "sync {action} lỗi: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        run.elapsed = started.elapsed();
        run
    }

    /// Số clone/fetch đã chạy và số lớn nhất chạy cùng lúc trong lượt có git giả.
    fn ops(&self, op: &str) -> (usize, usize) {
        let text = std::fs::read_to_string(self.log.join("ops")).unwrap_or_default();
        let counts: Vec<usize> = text
            .lines()
            .filter_map(|l| l.strip_prefix(op)?.trim().parse().ok())
            .collect();
        (counts.len(), counts.into_iter().max().unwrap_or(0))
    }
}

/// Xoá thư mục gốc và cấu hình tạm cả khi test hỏng giữa chừng; HIVE_E2E_KEEP=1 để giữ lại mà xem.
struct Cleanup(Vec<PathBuf>);

impl Drop for Cleanup {
    fn drop(&mut self) {
        if std::env::var_os("HIVE_E2E_KEEP").is_none() {
            for p in &self.0 {
                let _ = std::fs::remove_dir_all(p);
            }
        }
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?} trong {dir:?}");
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn worker_bin(tmp: &Path, path: &str) -> PathBuf {
    if let Ok(bin) = std::env::var("HIVE_E2E_WORKER") {
        return bin.into();
    }
    let bin = tmp.join("hive-worker");
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../worker");
    let ok = Command::new("go")
        .args(["build", "-o"])
        .arg(&bin)
        .arg("./cmd/hive-worker")
        .current_dir(src)
        .env("PATH", path)
        .status()
        .expect("chạy go build")
        .success();
    assert!(ok, "build hive-worker lỗi");
    bin
}

#[test]
#[ignore = "gọi máy chủ Git thật bằng đăng nhập của máy; chạy tay"]
fn real_group_clone_status_pull_cancel() {
    let (Ok(url), Ok(group), Ok(root)) = (
        std::env::var("HIVE_E2E_GIT_URL"),
        std::env::var("HIVE_E2E_GIT_GROUP"),
        std::env::var("HIVE_E2E_GIT_ROOT"),
    ) else {
        panic!("đặt HIVE_E2E_GIT_URL, HIVE_E2E_GIT_GROUP, HIVE_E2E_GIT_ROOT");
    };
    let root = PathBuf::from(root);
    // Bước huỷ xoá lại các repo đã clone: chỉ làm trong thư mục do chính test tạo.
    assert!(
        root.is_absolute() && !root.exists(),
        "HIVE_E2E_GIT_ROOT phải là đường dẫn tuyệt đối chưa có"
    );

    let tmp = std::env::temp_dir().join(format!("hive-gitgroups-e2e-{}", std::process::id()));
    let _cleanup = Cleanup(vec![root.clone(), tmp.clone()]);
    let log = tmp.join("log");
    let bin_dir = tmp.join("bin");
    std::fs::create_dir_all(&log).unwrap();
    std::fs::create_dir_all(&bin_dir).unwrap();
    let path = crate::sidecar_path().1;
    let real_git = String::from_utf8(
        Command::new("sh")
            .args(["-c", "command -v git"])
            .env("PATH", &path)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();
    let shim = bin_dir.join("git");
    std::fs::write(&shim, SHIM).unwrap();
    std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
    let w = Worker {
        bin: worker_bin(&tmp, &path),
        config: tmp.join("worker.json"),
        shim_path: format!("{}:{path}", bin_dir.display()),
        path,
        log,
        real_git,
    };
    // Ghi từng dòng ngay: test hỏng giữa chừng vẫn còn kết quả các bước trước.
    let mut report = std::env::var("HIVE_E2E_REPORT")
        .ok()
        .map(|p| std::fs::File::create(p).expect("tạo file báo cáo"));
    let mut note = |line: String| {
        eprintln!("{line}");
        if let Some(f) = report.as_mut() {
            let _ = writeln!(f, "{line}");
        }
    };

    // 1. Kết nối "đăng nhập có sẵn": như git_host_add với auth_mode = "git".
    let t = Instant::now();
    let (token, username) =
        tauri::async_runtime::block_on(crate::git_credentials::verified_credential("gitlab", &url))
            .expect("đọc và kiểm đăng nhập Git của máy");
    note(format!("probe: tài khoản {username} ({:?})", t.elapsed()));
    let mut args = host_add_args("gitlab", &url, "E2E").unwrap();
    args.push(arg("auth-mode", "git"));
    let view = w.json(args, &[(TOKEN_ENV, token.clone())]);
    let host = view["host"]["id"].as_str().unwrap().to_string();
    assert_eq!(view["host"]["authMode"], "git");
    let saved = std::fs::read_to_string(tmp.join("gitgroups.json")).unwrap();
    assert!(!saved.contains(&token), "gitgroups.json chứa token");

    // 2. Liệt kê group gồm subgroup: như git_group_add (token của helper chỉ đi qua môi trường).
    let t = Instant::now();
    let tokens = serde_json::json!({ host.clone(): token }).to_string();
    let view = w.json(
        group_add_args(&host, &group, &root.to_string_lossy(), "https", "", false).unwrap(),
        &[(TOKENS_ENV, tokens)],
    );
    let g = &view["group"];
    let id = g["id"].as_str().unwrap().to_string();
    let all = g["repos"].as_array().unwrap();
    let repos: BTreeSet<String> = all
        .iter()
        .filter(|r| r["archived"] != true)
        .map(|r| r["path"].as_str().unwrap().to_string())
        .collect();
    let subgroups: BTreeSet<&str> = repos
        .iter()
        .filter_map(|p| p.split('/').nth(1).filter(|_| p.matches('/').count() > 1))
        .collect();
    note(format!(
        "group {group}: {} repo ({} archived), subgroup {subgroups:?} ({:?})",
        repos.len(),
        all.len() - repos.len(),
        t.elapsed()
    ));
    if let Ok(n) = std::env::var("HIVE_E2E_GIT_REPOS") {
        assert_eq!(repos.len(), n.parse::<usize>().unwrap(), "số repo");
    }
    assert!(!repos.is_empty());
    assert!(repos.iter().all(|p| p.starts_with(&format!("{group}/"))));

    // 3. Clone đủ, song song tối đa 4.
    let run = w.sync(&id, "clone", None, true);
    let (clones, peak) = w.ops("clone");
    note(format!(
        "clone: {:?}, {clones} lần git clone, cùng lúc tối đa {peak}, {}",
        run.elapsed,
        run.summary()
    ));
    note("| Repo | Kết quả clone | Xong sau |".into());
    note("|---|---|---|".into());
    for (p, (result, msg)) in run.repos() {
        note(format!(
            "| {p} | {result}{} | {:.1}s |",
            if msg.is_empty() {
                String::new()
            } else {
                format!(" ({msg})")
            },
            run.at[&p].as_secs_f64()
        ));
    }
    assert_eq!(run.repos().keys().cloned().collect::<BTreeSet<_>>(), repos);
    assert!(run.repos().values().all(|(r, _)| r == "done"));
    assert_eq!(clones, repos.len());
    assert!(peak <= DEFAULT_CONCURRENCY, "chạy {peak} clone cùng lúc");
    for p in &repos {
        let dir = root.join(p);
        assert!(dir.join(".git").is_dir(), "{dir:?} không phải repo");
    }
    let listed = std::fs::read_to_string(tmp.join("projects.json")).unwrap();
    let listed: Value = serde_json::from_str(&listed).unwrap();
    assert_eq!(listed["projects"].as_array().unwrap().len(), repos.len());

    // 4. Trạng thái sau clone: sạch.
    let t = Instant::now();
    let status = w.status(&id);
    note(format!("status: {:?}", t.elapsed()));
    for (p, s) in &status {
        assert_eq!(s["state"], "clean", "{p}: {s}");
    }

    // 5. Clone lần hai: không clone trùng.
    let run = w.sync(&id, "clone", None, true);
    assert_eq!(w.ops("clone").0, 0);
    assert!(run.repos().values().all(|(r, _)| r == "unchanged"));
    note(format!("clone lần 2: {:?}, {}", run.elapsed, run.summary()));

    // 6. Sửa một file (không commit) rồi pull tất cả: repo đó bị bỏ qua có lý do, repo khác pull bình thường.
    let dirty = repos.iter().next().unwrap().clone();
    let dir = root.join(&dirty);
    let file = git(&dir, &["ls-files"])
        .lines()
        .next()
        .expect("repo có file")
        .to_string();
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(dir.join(&file))
        .unwrap();
    writeln!(f, "e2e").unwrap();
    drop(f);
    let run = w.sync(&id, "pull", None, true);
    let (fetches, peak) = w.ops("fetch");
    note(format!(
        "pull: {:?}, {fetches} lần git fetch, cùng lúc tối đa {peak}, {}",
        run.elapsed,
        run.summary()
    ));
    for (p, (result, msg)) in run.repos() {
        if p == dirty {
            note(format!("pull {p}: {result} ({msg})"));
            assert_eq!(result, "skipped");
            assert!(!msg.is_empty(), "bỏ qua mà không có lý do");
        } else {
            assert!(
                result == "unchanged" || result == "done",
                "{p}: {result} {msg}"
            );
        }
    }
    assert!(peak <= DEFAULT_CONCURRENCY);
    assert_eq!(w.status(&id)[&dirty]["state"], "dirty");
    git(&dir, &["checkout", "--", &file]);

    // 7. Fetch tất cả.
    let run = w.sync(&id, "fetch", None, false);
    note(format!("fetch: {:?}, {}", run.elapsed, run.summary()));
    assert!(run.repos().values().all(|(r, _)| r == "done"));

    // 8. Huỷ giữa chừng: xoá các repo rồi clone lại, huỷ sau repo đầu tiên. Repo dừng giữa chừng không để lại clone dở.
    std::fs::remove_dir_all(root.join(&group)).unwrap();
    let run = w.sync(&id, "clone", Some(1), false);
    let summary = run.summary();
    note(format!(
        "clone huỷ sau repo đầu: {:?}, dừng sau {:?} kể từ lúc huỷ, {summary}",
        run.elapsed,
        run.cancel_latency.unwrap()
    ));
    assert!(summary["cancelled"].as_u64().unwrap_or(0) > 0);
    assert!(run.cancel_latency.unwrap() < Duration::from_secs(15));
    let status = w.status(&id);
    let missing = status.values().filter(|s| s["state"] == "missing").count();
    for (p, s) in &status {
        assert!(
            s["state"] == "clean" || s["state"] == "missing",
            "sau huỷ {p}: {s}"
        );
        if s["state"] == "missing" {
            assert!(!root.join(p).exists(), "còn thư mục clone dở {p}");
        }
    }
    let run = w.sync(&id, "clone", None, false);
    note(format!(
        "clone tiếp sau huỷ: {:?}, {}",
        run.elapsed,
        run.summary()
    ));
    assert_eq!(
        run.summary()["done"].as_u64().unwrap_or(0) as usize,
        missing
    );
    assert!(w.status(&id).values().all(|s| s["state"] == "clean"));
}
