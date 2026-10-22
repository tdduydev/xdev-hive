//! Nút "Tối ưu" (spec 029): `hive-worker optimize all` dựng kế hoạch, chạy và hoàn tác. Worker lo phần ghi file; ở đây
//! chỉ chặn bước lạ trước khi kế hoạch thành file tạm của sidecar, và chạy bước `tool.*` (cài công cụ) vì worker không
//! cài phần mềm. Bước nào cũng đi theo id trong danh sách đóng: giao diện không gửi được lệnh hay đường dẫn.

use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{Map, Value};
use tauri::AppHandle;

use crate::doctor::{run_with_timeout, user_path};
use crate::setup_extra::in_path;
use crate::sidecar_command;

/// Cùng danh sách đóng với `StepIDs()` của worker (worker/internal/optimizeall/plan.go); worker kiểm lại lần nữa.
const STEP_IDS: &[&str] = &[
    "optimizer.enable",
    "fix.optimizer.balanced",
    "fix.optimizer.rtk",
    "fix.optimizer.aggressive",
    "fix.codegraph.mcp",
    "fix.codegraph.init",
    "tool.rtk",
    "tool.codegraph",
    "context.sync",
    "score.recompute",
];
/// Kế hoạch thật chỉ vài chục bước; trần rộng để chặn dữ liệu bất thường chứ không để giới hạn người dùng.
const MAX_STEPS: usize = 200;
/// Chính sách và kế hoạch đều là JSON nhỏ; trần chặn file khổng lồ trước khi ghi ra đĩa.
const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Chỉ giữ phần cuối đầu ra của lệnh cài: lỗi nằm ở cuối, và lý do này hiện trên giao diện.
const ERROR_TAIL: usize = 400;

static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

fn arg(key: &str, value: impl std::fmt::Display) -> String {
    // `--key=value` để giá trị bắt đầu bằng `-` không bị đọc thành cờ.
    format!("--{key}={value}")
}

fn base(flag: &str) -> Vec<String> {
    vec!["optimize".into(), "all".into(), flag.into(), "--json".into()]
}

fn preview_args(policy_file: Option<&str>) -> Vec<String> {
    let mut args = base("--preview");
    if let Some(file) = policy_file {
        args.push(arg("policy-file", file));
    }
    args
}

fn apply_args(plan_file: &str) -> Vec<String> {
    let mut args = base("--apply");
    args.push(arg("plan-file", plan_file));
    args
}

/// Id lần chạy do worker sinh (ULID); chỉ nhận chữ và số, gạch ngang, gạch dưới.
fn undo_args(run_id: &str) -> Result<Vec<String>, String> {
    let run_id = run_id.trim();
    let valid = !run_id.is_empty()
        && run_id.len() <= 64
        && run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err("Id lần tối ưu không hợp lệ.".into());
    }
    let mut args = base("--undo");
    args.push(arg("run", run_id));
    Ok(args)
}

/// Kiểm kế hoạch từ giao diện trước khi đưa cho sidecar. Chỉ nhận id trong danh sách đóng và cờ `selected`; trạng thái
/// bước cài công cụ do Rust ghi, nên xoá `status`, `error` giao diện gửi lên để không giả kết quả.
fn validate_plan(plan: Value) -> Result<Map<String, Value>, String> {
    let Value::Object(mut plan) = plan else {
        return Err("Kế hoạch tối ưu không đúng dạng.".into());
    };
    let Some(Value::Array(steps)) = plan.get_mut("steps") else {
        return Err("Kế hoạch tối ưu thiếu danh sách bước.".into());
    };
    if steps.is_empty() {
        return Err("Kế hoạch tối ưu không có bước nào.".into());
    }
    if steps.len() > MAX_STEPS {
        return Err("Kế hoạch tối ưu có quá nhiều bước.".into());
    }
    for step in steps.iter_mut() {
        let Some(step) = step.as_object_mut() else {
            return Err("Bước tối ưu không đúng dạng.".into());
        };
        let id = step.get("id").and_then(Value::as_str).unwrap_or_default();
        if !STEP_IDS.contains(&id) {
            return Err(format!("Bước {id:?} không có trong danh sách được phép."));
        }
        if !step.get("selected").is_some_and(Value::is_boolean) {
            return Err("Bước tối ưu thiếu cờ chọn.".into());
        }
        step.remove("status");
        step.remove("error");
    }
    Ok(plan)
}

/// Lệnh cài theo hệ điều hành, không qua shell. Trả None khi hệ điều hành này không có cách cài chạy được.
/// [Unverified] tên gói rtk (winget, brew) và codegraph (npm) lấy từ tài liệu hai công cụ, chưa chạy thật.
fn install_argv(tool: &str, os: &str) -> Option<Vec<&'static str>> {
    Some(match (tool, os) {
        ("rtk", "windows") => vec!["winget", "install", "--id", "rtk-ai.rtk", "-e"],
        ("rtk", "macos") => vec!["brew", "install", "rtk"],
        // npm trên Windows là npm.cmd, Command không tự chạy được file .cmd nên đi qua cmd /c.
        ("codegraph", "windows") => vec![
            "cmd",
            "/c",
            "npm",
            "install",
            "-g",
            "@colbymchenry/codegraph",
        ],
        ("codegraph", _) => vec!["npm", "install", "-g", "@colbymchenry/codegraph"],
        _ => return None,
    })
}

/// Tên chương trình để biết công cụ đã có trong PATH chưa.
fn program_of(tool: &str) -> &'static str {
    if tool == "rtk" { "rtk" } else { "codegraph" }
}

fn tail(text: &str) -> String {
    let text = text.trim();
    let start = text
        .char_indices()
        .rev()
        .nth(ERROR_TAIL)
        .map_or(0, |(i, _)| i);
    text[start..].to_string()
}

/// Cài một công cụ; trả trạng thái và lý do lỗi như worker ghi vào nhật ký (`ok` hay `failed`).
fn install_tool(tool: &str) -> (&'static str, Option<String>) {
    let path = user_path();
    // Đã có thì không cài lại: tránh `brew install` báo lỗi khi gói đã có.
    if in_path(program_of(tool), path) {
        return ("ok", None);
    }
    let Some(argv) = install_argv(tool, std::env::consts::OS) else {
        return (
            "failed",
            Some(format!("Chưa có cách tự cài {tool} trên hệ điều hành này.")),
        );
    };
    let Some((program, args)) = argv.split_first() else {
        return ("failed", Some("Lệnh cài rỗng.".into()));
    };
    let mut cmd = Command::new(program);
    cmd.args(args).env("PATH", path);
    let Some(out) = run_with_timeout(cmd, INSTALL_TIMEOUT) else {
        return (
            "failed",
            Some("Không chạy được lệnh cài hoặc lệnh chạy quá 15 phút.".into()),
        );
    };
    if out.code == Some(0) {
        return ("ok", None);
    }
    let mut output = String::from_utf8_lossy(&out.stderr).into_owned();
    if output.trim().is_empty() {
        output = String::from_utf8_lossy(&out.stdout).into_owned();
    }
    let code = out.code.map_or("không rõ".to_string(), |c| c.to_string());
    (
        "failed",
        Some(format!("Lệnh cài thoát với mã {code}: {}", tail(&output))),
    )
}

/// Chạy các bước `tool.*` đã chọn và ghi kết quả vào kế hoạch; worker không cài phần mềm nên đọc kết quả từ đây.
/// Bước không chọn để nguyên, worker sẽ ghi là bỏ qua.
fn run_tools(mut plan: Map<String, Value>) -> Map<String, Value> {
    let Some(Value::Array(steps)) = plan.get_mut("steps") else {
        return plan;
    };
    for step in steps.iter_mut() {
        let Some(step) = step.as_object_mut() else {
            continue;
        };
        let Some(tool) = step
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| id.strip_prefix("tool."))
            .map(str::to_owned)
        else {
            continue;
        };
        if step.get("selected") != Some(&Value::Bool(true)) {
            continue;
        }
        let (status, error) = install_tool(&tool);
        step.insert("status".into(), status.into());
        step.insert("error".into(), error.map_or(Value::Null, Value::String));
    }
    plan
}

/// File tạm chứa chính sách hay kế hoạch. Xoá khi bị thả, nên mọi đường thoát (cả lỗi) đều dọn.
struct TempFile {
    path: PathBuf,
}

impl TempFile {
    fn json(label: &str, value: &Value) -> Result<Self, String> {
        let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_JSON_BYTES {
            return Err("Dữ liệu gửi cho worker quá lớn.".into());
        }
        let name = format!(
            "hive-optimize-{}-{}-{label}.tmp",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(name);
        // create_new: không ghi đè hay đi theo liên kết sẵn có ở đường dẫn đoán được.
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("Không tạo được file tạm: {e}"))?;
        // Bọc ngay sau khi tạo để ghi lỗi cũng xoá file.
        let temp = Self { path };
        file.write_all(&bytes)
            .map_err(|e| format!("Không ghi được file tạm: {e}"))?;
        Ok(temp)
    }

    fn arg(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Kết quả của sidecar. Với `--json` lỗi nằm ở stdout dạng `{"error":{"code","message"}}` (stderr trống), nên đọc
/// message từ đó trước, rồi mới đến stderr. `--last` khi chưa có lần nào in `null`, là kết quả hợp lệ.
fn parse_output(success: bool, stdout: &[u8], stderr: &[u8]) -> Result<Value, String> {
    let parsed: Option<Value> = serde_json::from_slice(stdout).ok();
    if let Some(message) = parsed
        .as_ref()
        .and_then(|v| v.get("error"))
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
    {
        return Err(message.to_string());
    }
    if !success {
        let msg = String::from_utf8_lossy(stderr).trim().to_string();
        return Err(if msg.is_empty() {
            "Worker báo lỗi mà không có chi tiết.".into()
        } else {
            msg
        });
    }
    parsed.ok_or_else(|| "Không đọc được kết quả của worker.".to_string())
}

/// Chạy `hive-worker optimize all …`; `temps` sống đến khi sidecar thoát rồi mới bị xoá.
async fn run(app: &AppHandle, args: Vec<String>, temps: Vec<TempFile>) -> Result<Value, String> {
    let mut cmd = sidecar_command(app, args, vec![]).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = cmd.output();
        drop(temps);
        let out = out.map_err(|e| format!("Không chạy được worker: {e}"))?;
        parse_output(out.status.success(), &out.stdout, &out.stderr)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Xem trước: dựng kế hoạch, không ghi gì. `policy` là `{ [projectId]: DevOptimizerPolicy }` hoặc null.
#[tauri::command]
pub async fn optimize_all_preview(
    app: AppHandle,
    policy: Option<Value>,
) -> Result<Value, String> {
    let mut temps = Vec::new();
    let mut policy_file = None;
    if let Some(policy) = policy.filter(|v| !v.is_null()) {
        if !policy.is_object() {
            return Err("Chính sách tối ưu không đúng dạng.".into());
        }
        let file = TempFile::json("policy", &policy)?;
        policy_file = Some(file.arg());
        temps.push(file);
    }
    run(&app, preview_args(policy_file.as_deref()), temps).await
}

/// Áp dụng kế hoạch người dùng đã chọn: cài công cụ trước, ghi kết quả vào kế hoạch, rồi để sidecar chạy phần còn lại.
#[tauri::command]
pub async fn optimize_all_apply(app: AppHandle, plan: Value) -> Result<Value, String> {
    let plan = validate_plan(plan)?;
    // Cài đặt chạy tới 15 phút mỗi công cụ: không giữ luồng async.
    let plan = tauri::async_runtime::spawn_blocking(move || run_tools(plan))
        .await
        .map_err(|e| e.to_string())?;
    let file = TempFile::json("plan", &Value::Object(plan))?;
    let args = apply_args(&file.arg());
    run(&app, args, vec![file]).await
}

#[tauri::command]
pub async fn optimize_all_undo(app: AppHandle, run_id: String) -> Result<Value, String> {
    run(&app, undo_args(&run_id)?, vec![]).await
}

/// Lần tối ưu gần nhất, hoặc null khi chưa có.
#[tauri::command]
pub async fn optimize_all_last(app: AppHandle) -> Result<Value, String> {
    run(&app, base("--last"), vec![]).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plan_with(id: &str) -> Value {
        json!({ "createdAt": "2026-10-22T09:00:01Z", "steps": [{ "id": id, "selected": true }] })
    }

    #[test]
    fn rejects_unknown_step_ids() {
        for id in ["tool.evil", "tool.", "fix.codegraph.rm", "", "run.shell", "Tool.rtk"] {
            assert!(validate_plan(plan_with(id)).is_err(), "{id}");
        }
        for id in STEP_IDS {
            assert!(validate_plan(plan_with(id)).is_ok(), "{id}");
        }
    }

    #[test]
    fn one_unknown_step_rejects_the_whole_plan() {
        let plan = json!({ "steps": [
            { "id": "optimizer.enable", "selected": true },
            { "id": "rm -rf", "selected": true },
        ] });
        assert!(validate_plan(plan).is_err());
    }

    #[test]
    fn rejects_malformed_plans() {
        for plan in [
            Value::Null,
            json!([]),
            json!("plan"),
            json!({}),
            json!({ "steps": "x" }),
            json!({ "steps": [] }),
            json!({ "steps": ["optimizer.enable"] }),
            json!({ "steps": [{ "selected": true }] }),
            json!({ "steps": [{ "id": 7, "selected": true }] }),
            json!({ "steps": [{ "id": "context.sync" }] }),
            json!({ "steps": [{ "id": "context.sync", "selected": "yes" }] }),
        ] {
            assert!(validate_plan(plan.clone()).is_err(), "{plan}");
        }
        let many: Vec<Value> = (0..=MAX_STEPS)
            .map(|_| json!({ "id": "context.sync", "selected": true }))
            .collect();
        assert!(validate_plan(json!({ "steps": many })).is_err());
    }

    #[test]
    fn keeps_the_fields_the_sidecar_needs() {
        let plan = json!({
            "createdAt": "2026-10-22T09:00:01Z",
            "scoreBefore": 48,
            "steps": [{
                "id": "optimizer.enable", "group": "cli", "target": "claude-2", "selected": false,
                "profile": "claude-2", "level": "aggressive", "autoCompactWindow": 150000
            }]
        });
        let out = validate_plan(plan.clone()).unwrap();
        assert_eq!(Value::Object(out), plan);
    }

    #[test]
    fn forged_status_from_the_ui_is_dropped() {
        let plan = json!({ "steps": [
            { "id": "tool.rtk", "selected": true, "status": "ok", "error": null },
            { "id": "context.sync", "selected": true, "status": "ok", "error": "x" },
        ] });
        let out = validate_plan(plan).unwrap();
        for step in out["steps"].as_array().unwrap() {
            assert!(step.get("status").is_none());
            assert!(step.get("error").is_none());
        }
    }

    #[test]
    fn unselected_tool_steps_are_not_run() {
        let plan = json!({ "steps": [
            { "id": "tool.rtk", "selected": false },
            { "id": "tool.codegraph", "selected": false },
            { "id": "context.sync", "selected": true },
        ] });
        let validated = validate_plan(plan.clone()).unwrap();
        // Không có bước tool nào được chọn nên không lệnh cài nào chạy và kế hoạch giữ nguyên.
        assert_eq!(Value::Object(run_tools(validated)), plan);
    }

    #[test]
    fn install_commands_come_from_the_table() {
        assert_eq!(
            install_argv("rtk", "macos").unwrap(),
            ["brew", "install", "rtk"]
        );
        assert_eq!(install_argv("codegraph", "linux").unwrap()[0], "npm");
        assert_eq!(
            install_argv("codegraph", "windows").unwrap()[..3],
            ["cmd", "/c", "npm"]
        );
        assert!(install_argv("rtk", "linux").is_none());
        assert!(install_argv("evil", "macos").is_none());
        assert!(install_argv("evil", "windows").is_none());
    }

    #[test]
    fn every_tool_step_has_an_install_entry() {
        for id in STEP_IDS {
            if let Some(tool) = id.strip_prefix("tool.") {
                assert!(install_argv(tool, "macos").is_some() || install_argv(tool, "windows").is_some());
                assert!(!program_of(tool).is_empty());
            }
        }
    }

    #[test]
    fn sidecar_args_are_explicit() {
        assert_eq!(
            preview_args(None),
            ["optimize", "all", "--preview", "--json"]
        );
        assert_eq!(
            preview_args(Some("/t/policy.tmp")),
            [
                "optimize",
                "all",
                "--preview",
                "--json",
                "--policy-file=/t/policy.tmp"
            ]
        );
        assert_eq!(
            apply_args("/t/plan.tmp"),
            [
                "optimize",
                "all",
                "--apply",
                "--json",
                "--plan-file=/t/plan.tmp"
            ]
        );
        assert_eq!(base("--last"), ["optimize", "all", "--last", "--json"]);
        assert_eq!(
            undo_args(" 01JBRUNID0000000000000000 ").unwrap(),
            [
                "optimize",
                "all",
                "--undo",
                "--json",
                "--run=01JBRUNID0000000000000000"
            ]
        );
    }

    #[test]
    fn run_id_cannot_become_a_flag_or_path() {
        for id in ["", "  ", "a b", "../x", "a/b", "x\n--apply", "id\0", &"a".repeat(65)] {
            assert!(undo_args(id).is_err(), "{id:?}");
        }
    }

    #[test]
    fn parses_sidecar_output() {
        assert_eq!(parse_output(true, b"null\n", b"").unwrap(), Value::Null);
        assert_eq!(
            parse_output(true, br#"{"id":"r1"}"#, b"").unwrap()["id"],
            "r1"
        );
        let locked = br#"{"error":{"code":"OPTIMIZE_LOCKED","message":"Đang tối ưu ở cửa sổ khác."}}"#;
        assert_eq!(
            parse_output(false, locked, b"").unwrap_err(),
            "Đang tối ưu ở cửa sổ khác."
        );
        assert_eq!(parse_output(false, b"", b"hỏng\n").unwrap_err(), "hỏng");
        assert!(parse_output(false, b"", b"").is_err());
        assert!(parse_output(true, b"khong phai json", b"").is_err());
    }

    #[test]
    fn tail_keeps_the_end_on_a_char_boundary() {
        let text = format!("{}lỗi cuối", "ầ".repeat(1000));
        let out = tail(&text);
        assert!(out.ends_with("lỗi cuối"));
        assert!(out.chars().count() <= ERROR_TAIL + 1);
        assert_eq!(tail("  ngắn \n"), "ngắn");
    }

    #[test]
    fn temp_file_is_removed_when_dropped() {
        let file = TempFile::json("test", &json!({ "steps": [] })).unwrap();
        let path = file.path.clone();
        assert_eq!(std::fs::read(&path).unwrap(), br#"{"steps":[]}"#);
        drop(file);
        assert!(!path.exists());
        let big = Value::String("x".repeat(MAX_JSON_BYTES + 1));
        assert!(TempFile::json("big", &big).is_err());
    }
}
