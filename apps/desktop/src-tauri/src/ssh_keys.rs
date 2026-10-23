//! Máy chủ SSH của máy này (specs/023-desktop-ssh-keys): chuyển đăng nhập từ mật khẩu sang khoá qua `hive-worker ssh`.
//! Chạy được khi chưa đăng nhập Hive.
//!
//! Mật khẩu chỉ đi qua stdin của sidecar: không nằm trong tham số, biến môi trường, file hay log. Sidecar gửi nó tới máy
//! chủ có khoá đúng dấu vân tay người dùng đã xác nhận, đúng một lần, rồi thoát.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

use crate::profiles::{Launch, open_terminal};
use crate::sidecar_json;

/// Sidecar tự dừng sau 55 giây; app chờ thêm chút để nhận lỗi của nó trước khi giết tiến trình.
const SETUP_TIMEOUT: Duration = Duration::from_secs(60);

/// Mỗi lúc chỉ một lần cài khoá (FR-043): hai lần cùng lúc có thể cùng tạo khoá hay cùng ghi ~/.ssh/config.
#[derive(Default)]
pub struct SetupLock(AtomicBool);

fn arg(key: &str, value: impl std::fmt::Display) -> String {
    // `--key=value` để giá trị bắt đầu bằng `-` không bị đọc thành cờ.
    format!("--{key}={value}")
}

fn base(action: &str) -> Vec<String> {
    vec!["ssh".into(), action.into(), "--json".into()]
}

pub fn host_arg(host: &str) -> Result<String, String> {
    let h = host.trim();
    let ok = !h.is_empty()
        && h.len() <= 253
        && !h.starts_with('-')
        && h.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'));
    if !ok {
        return Err("Địa chỉ máy chủ không hợp lệ: chỉ tên miền, IPv4 hoặc IPv6.".into());
    }
    Ok(arg("host", h))
}

pub fn port_arg(port: u32) -> Result<String, String> {
    if !(1..=65535).contains(&port) {
        return Err("Cổng phải từ 1 đến 65535.".into());
    }
    Ok(arg("port", port))
}

fn name_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn user_arg(user: &str) -> Result<String, String> {
    if !name_ok(user.trim()) {
        return Err("Tên đăng nhập không hợp lệ.".into());
    }
    Ok(arg("user", user.trim()))
}

pub fn alias_arg(alias: &str) -> Result<String, String> {
    if !name_ok(alias.trim()) {
        return Err(
            "Tên gợi nhớ chỉ gồm chữ, số, dấu chấm, gạch dưới, gạch ngang, tối đa 64 ký tự.".into(),
        );
    }
    Ok(arg("alias", alias.trim()))
}

pub fn fingerprint_arg(fingerprint: &str) -> Result<String, String> {
    let ok = fingerprint.strip_prefix("SHA256:").is_some_and(|b64| {
        b64.len() == 43
            && b64
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/')
    });
    if !ok {
        return Err("Dấu vân tay khoá máy chủ không hợp lệ.".into());
    }
    Ok(arg("fingerprint", fingerprint))
}

pub fn setup_args(
    host: &str,
    port: u32,
    user: &str,
    alias: &str,
    fingerprint: &str,
) -> Result<Vec<String>, String> {
    let mut v = base("setup");
    v.push(host_arg(host)?);
    v.push(port_arg(port)?);
    v.push(user_arg(user)?);
    v.push(alias_arg(alias)?);
    v.push(fingerprint_arg(fingerprint)?);
    Ok(v)
}

/// Ghi đè bằng 0 trước khi trả bộ nhớ. Chỉ là cố gắng tốt nhất: chuỗi đã đi qua webview và IPC.
fn wipe_bytes(bytes: &mut [u8]) {
    bytes.fill(0);
    std::hint::black_box(&*bytes);
}

fn wipe(secret: String) {
    let mut bytes = secret.into_bytes();
    wipe_bytes(&mut bytes);
}

/// Dòng báo ở đầu cửa sổ terminal; chữ cố định vì cmd của Windows hiểu `&`, `%` trong echo.
const OPEN_NOTE: &str = "xDev Hive: phiên SSH tới máy chủ. Gõ exit để đóng.";

/// `ssh <alias>` chứ không ghép user@host:port: ssh tự áp khối của alias trong ~/.ssh/config (khoá, cổng, ProxyJump),
/// giống hệt lúc người dùng gõ tay. Alias đi vào script sh hay cmd nên chỉ nhận ký tự an toàn của `name_ok`.
pub fn open_launch(alias: &str) -> Result<Launch, String> {
    alias_arg(alias)?;
    Ok(Launch::plain(vec!["ssh".into(), alias.trim().into()], OPEN_NOTE))
}

/// Nút "Mở remote" của màn SSH: mở terminal của máy (cmd/Windows Terminal, Terminal.app, x-terminal-emulator…) chạy
/// ssh tới một alias. Không dùng điều khiển từ xa của remote.rs: tính năng đó cho thiết bị khác điều khiển máy này,
/// còn đây là đi ra máy chủ khác.
#[tauri::command]
pub async fn ssh_open_terminal(alias: String) -> Result<(), String> {
    let job = open_launch(&alias)?;
    tauri::async_runtime::spawn_blocking(move || open_terminal(&job))
        .await
        .map_err(|e| e.to_string())?
}

/// Khoá của máy và các khối Host trong ~/.ssh/config, kèm đường dẫn ssh của máy (rỗng: chưa có OpenSSH client).
#[tauri::command]
pub async fn ssh_list(app: AppHandle) -> Result<Value, String> {
    sidecar_json(&app, base("list"), vec![]).await
}

/// Đăng nhập thử bằng khoá, không mật khẩu, không hỏi gì.
#[tauri::command]
pub async fn ssh_check(app: AppHandle, alias: String) -> Result<Value, String> {
    let mut args = base("check");
    args.push(alias_arg(&alias)?);
    sidecar_json(&app, args, vec![]).await
}

/// Đọc khoá máy chủ để người dùng đối chiếu dấu vân tay; chưa xác thực gì.
#[tauri::command]
pub async fn ssh_scan(app: AppHandle, host: String, port: u32) -> Result<Value, String> {
    let mut args = base("scan");
    args.push(host_arg(&host)?);
    args.push(port_arg(port)?);
    sidecar_json(&app, args, vec![]).await
}

/// Gỡ khối do app tạo khỏi ~/.ssh/config (có sao lưu); khối viết tay bị sidecar từ chối.
#[tauri::command]
pub async fn ssh_remove(app: AppHandle, alias: String) -> Result<Value, String> {
    let mut args = base("remove");
    args.push(alias_arg(&alias)?);
    sidecar_json(&app, args, vec![]).await
}

/// Cài khoá công khai lên máy chủ bằng mật khẩu gõ một lần, rồi ghi known_hosts, ~/.ssh/config và kiểm tra bằng khoá.
#[tauri::command]
pub async fn ssh_setup(
    app: AppHandle,
    host: String,
    port: u32,
    user: String,
    alias: String,
    fingerprint: String,
    password: String,
) -> Result<Value, String> {
    let args = match setup_args(&host, port, &user, &alias, &fingerprint) {
        Ok(args) => args,
        Err(e) => {
            wipe(password);
            return Err(e);
        }
    };
    if password.is_empty() || password.contains(['\n', '\r']) {
        wipe(password);
        return Err("Nhập mật khẩu của máy chủ (một dòng).".into());
    }
    let lock = app.state::<SetupLock>();
    if lock.0.swap(true, Ordering::SeqCst) {
        wipe(password);
        return Err("Đang cài khoá cho một máy chủ khác, chờ xong rồi thử lại.".into());
    }
    let result = run_setup(&app, args, password).await;
    lock.0.store(false, Ordering::SeqCst);
    result
}

async fn run_setup(app: &AppHandle, args: Vec<String>, password: String) -> Result<Value, String> {
    // Chép sang buffer đủ chỗ cho dấu xuống dòng trước, để không có bản sao nào do cấp phát lại mà không được xoá.
    let mut line = Vec::with_capacity(password.len() + 1);
    line.extend_from_slice(password.as_bytes());
    line.push(b'\n');
    wipe(password);
    let spawned = async {
        let (key, path) = tauri::async_runtime::spawn_blocking(crate::sidecar_path)
            .await
            .map_err(|e| e.to_string())?;
        app.shell()
            .sidecar(crate::SIDECAR)
            .map_err(|e| e.to_string())?
            .args(args)
            .env(key, path)
            .spawn()
            .map_err(|e| format!("Không chạy được worker: {e}"))
    }
    .await;
    let (mut rx, mut child) = match spawned {
        Ok(pair) => pair,
        Err(e) => {
            wipe_bytes(&mut line);
            return Err(e);
        }
    };
    let written = child.write(&line);
    wipe_bytes(&mut line);
    if let Err(e) = written {
        let _ = child.kill();
        return Err(format!("Không gửi được mật khẩu cho worker: {e}"));
    }
    let collect = async {
        let (mut out, mut err, mut code) = (Vec::new(), Vec::new(), None);
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => out.extend_from_slice(&bytes),
                CommandEvent::Stderr(bytes) if err.len() < 4000 => err.extend_from_slice(&bytes),
                CommandEvent::Terminated(payload) => {
                    code = payload.code;
                    break;
                }
                _ => {}
            }
        }
        (out, err, code)
    };
    let Ok((out, err, code)) = tokio::time::timeout(SETUP_TIMEOUT, collect).await else {
        let _ = child.kill();
        return Err("Quá 60 giây mà máy chủ chưa xong; kiểm tra mạng rồi thử lại.".into());
    };
    if code != Some(0) {
        let msg = String::from_utf8_lossy(&err).trim().to_string();
        return Err(if msg.is_empty() {
            "Worker báo lỗi mà không có chi tiết.".into()
        } else {
            msg
        });
    }
    serde_json::from_slice(&out).map_err(|e| format!("Không đọc được kết quả của worker: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "SHA256:Uo7/F8GVJ/JOuiV7cChrx2WTkwvBw5jOn6DsFs+7uOw";

    #[test]
    fn hosts() {
        for ok in [
            "192.0.2.10",
            "srv.example.vn",
            "::1",
            "fe80::1",
            " hive-prod ",
        ] {
            assert!(host_arg(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "-v",
            "-oProxyJump",
            "-oProxyCommand=x",
            "a b",
            "h\nx",
            "h;rm",
            "h/x",
            &"a".repeat(254),
        ] {
            assert!(host_arg(bad).is_err(), "{bad}");
        }
        assert_eq!(host_arg(" 192.0.2.10 ").unwrap(), "--host=192.0.2.10");
    }

    #[test]
    fn ports() {
        assert_eq!(port_arg(22).unwrap(), "--port=22");
        assert!(port_arg(65535).is_ok());
        assert!(port_arg(0).is_err());
        assert!(port_arg(65536).is_err());
    }

    #[test]
    fn users_and_aliases() {
        assert_eq!(user_arg("deploy").unwrap(), "--user=deploy");
        assert_eq!(alias_arg("hive-prod").unwrap(), "--alias=hive-prod");
        assert!(alias_arg(&"a".repeat(64)).is_ok());
        for bad in ["", "-x", "a*", "a b", "a\nb", "dư", &"a".repeat(65)] {
            assert!(user_arg(bad).is_err(), "{bad}");
            assert!(alias_arg(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn fingerprints() {
        assert_eq!(fingerprint_arg(FP).unwrap(), format!("--fingerprint={FP}"));
        for bad in [
            "",
            "md5:aa:bb",
            &FP[..FP.len() - 1],
            &format!("{FP}="),
            &FP.replace('/', "-"),
            &FP.replace("SHA256:", "sha256:"),
        ] {
            assert!(fingerprint_arg(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn setup_args_never_carry_password() {
        assert_eq!(
            setup_args("192.0.2.10", 22, "deploy", "hive-prod", FP).unwrap(),
            [
                "ssh",
                "setup",
                "--json",
                "--host=192.0.2.10",
                "--port=22",
                "--user=deploy",
                "--alias=hive-prod",
                &format!("--fingerprint={FP}"),
            ]
        );
        assert!(setup_args("192.0.2.10", 22, "deploy", "a*", FP).is_err());
    }

    #[test]
    fn open_launch_runs_ssh_on_the_alias_only() {
        assert_eq!(open_launch(" hive-prod ").unwrap().argv, ["ssh", "hive-prod"]);
        for bad in ["", "-oProxyCommand=x", "a b", "a&calc", "a;rm", "a%PATH%", "a\nb"] {
            assert!(open_launch(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn wipe_zeroes_the_buffer() {
        let mut secret = b"mat-khau".to_vec();
        wipe_bytes(&mut secret);
        assert!(secret.iter().all(|&b| b == 0));
    }
}
