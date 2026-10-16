//! Chỉ giữ credential trong bộ nhớ của lần gọi: helper có thể xoay token giữa hai thao tác.

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use url::Url;

use crate::no_window::NoWindow;

const TIMEOUT: Duration = Duration::from_secs(15);

pub fn server(kind: &str, raw: &str) -> Result<Url, String> {
    let default = match kind {
        "gitlab" => "https://gitlab.com",
        "github" => "https://github.com",
        _ => return Err("Chọn GitLab hoặc GitHub.".into()),
    };
    let raw = raw.trim();
    let raw = if raw.is_empty() {
        default.to_string()
    } else if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let url = Url::parse(&raw).map_err(|_| "Địa chỉ máy chủ không hợp lệ.")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || raw.chars().any(char::is_control)
    {
        return Err(
            "Đăng nhập Git có sẵn cần địa chỉ HTTPS không chứa thông tin đăng nhập.".into(),
        );
    }
    Ok(url)
}

fn command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env_remove("GIT_ASKPASS")
        .env_remove("SSH_ASKPASS")
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .no_window();
    cmd
}

async fn fill_with(mut cmd: Command, url: &Url, timeout: Duration) -> Result<String, String> {
    // Không truyền path: credential dùng chung cho HTTPS host, kể cả GCM, gh, glab và osxkeychain.
    let host = &url[url::Position::BeforeHost..url::Position::AfterPort];
    let input = format!("protocol=https\nhost={host}\n\n");
    cmd.args(["-c", "core.askPass=", "credential", "fill"])
        .stdin(Stdio::piped());
    let run = async {
        let mut child = cmd.spawn().map_err(|_| "Không chạy được Git của máy.")?;
        child
            .stdin
            .take()
            .ok_or("Không gửi được yêu cầu tới Git.")?
            .write_all(input.as_bytes())
            .await
            .map_err(|_| "Không gửi được yêu cầu tới Git.")?;
        let output = child
            .wait_with_output()
            .await
            .map_err(|_| "Không đọc được đăng nhập Git.")?;
        if !output.status.success() || output.stdout.len() > 64 * 1024 {
            return Err("Không tìm thấy đăng nhập Git cho máy chủ này. Hãy đăng nhập bằng Git hoặc nhập PAT.".to_string());
        }
        parse_password(&output.stdout)
    };
    tokio::time::timeout(timeout, run).await.map_err(|_| {
        "Đọc đăng nhập Git quá thời gian chờ; kiểm tra credential helper của máy.".to_string()
    })?
}

fn parse_password(bytes: &[u8]) -> Result<String, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Đăng nhập Git không hợp lệ.")?;
    let password = text
        .lines()
        .find_map(|line| line.strip_prefix("password="))
        .filter(|s| !s.is_empty() && !s.chars().any(char::is_control));
    password
        .map(String::from)
        .ok_or_else(|| "Credential helper không trả mật khẩu hoặc token. Hãy nhập PAT.".into())
}

pub async fn credential(kind: &str, raw: &str) -> Result<String, String> {
    let url = server(kind, raw)?;
    let (key, path) = tauri::async_runtime::spawn_blocking(crate::sidecar_path)
        .await
        .map_err(|_| "Không tìm được Git của máy.")?;
    let mut cmd = command("git");
    cmd.env(key, path);
    fill_with(cmd, &url, TIMEOUT).await
}

async fn account(
    client: &reqwest::Client,
    endpoint: &str,
    kind: &str,
    token: &str,
) -> Result<String, String> {
    let mut request = client
        .get(endpoint)
        .header("User-Agent", "xdev-hive-desktop")
        .header("Accept", "application/json")
        .timeout(TIMEOUT);
    // Bearer nhận cả PAT và OAuth token do GCM trả về.
    request = request.bearer_auth(token);
    // Không đưa lỗi reqwest/body máy chủ vào UI: chúng có thể chứa thông tin xác thực.
    let response = request
        .send()
        .await
        .map_err(|_| "Không gọi được API để kiểm tra đăng nhập Git.")?;
    if !response.status().is_success() {
        if response.status().as_u16() != 401 && response.status().as_u16() != 403 {
            return Err(format!(
                "API máy chủ Git trả lỗi {}. Hãy thử lại sau.",
                response.status().as_u16()
            ));
        }
        return Err(match kind {
            "gitlab" => "Đăng nhập Git không được API chấp nhận; helper có thể trả mật khẩu thường hoặc token hết hạn/thiếu quyền. Hãy tạo PAT có read_api và read_repository.",
            _ => "Đăng nhập Git không được API chấp nhận; helper có thể trả mật khẩu thường hoặc token hết hạn/thiếu quyền. Hãy tạo PAT có quyền đọc repo.",
        }.into());
    }
    let body = response
        .text()
        .await
        .map_err(|_| "Không đọc được tài khoản Git.")?;
    let body: Value =
        serde_json::from_str(&body).map_err(|_| "API trả tài khoản Git không hợp lệ.")?;
    body[if kind == "gitlab" {
        "username"
    } else {
        "login"
    }]
    .as_str()
    .filter(|s| !s.is_empty())
    .map(String::from)
    .ok_or_else(|| "API không trả tên tài khoản Git.".into())
}

fn endpoint(kind: &str, url: &Url) -> String {
    let base = url.as_str().trim_end_matches('/');
    if kind == "gitlab" {
        format!("{base}/api/v4/user")
    } else if url.host_str() == Some("github.com") {
        "https://api.github.com/user".into()
    } else {
        format!("{base}/api/v3/user")
    }
}

pub async fn verified_credential(kind: &str, raw: &str) -> Result<(String, String), String> {
    let url = server(kind, raw)?;
    let token = credential(kind, raw).await?;
    let endpoint = endpoint(kind, &url);
    crate::tls::ensure();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Không tạo được kết nối API Git.")?;
    let username = account(&client, &endpoint, kind, &token).await?;
    Ok((token, username))
}

pub async fn probe(kind: &str, raw: &str) -> Result<String, String> {
    verified_credential(kind, raw)
        .await
        .map(|(_, username)| username)
}

#[derive(Serialize)]
pub struct Candidate {
    kind: String,
    url: String,
}

fn candidates(keys: &str, remotes: &[String]) -> Vec<Candidate> {
    let mut urls = Vec::new();
    for key in keys.lines() {
        if let Some(scope) = key
            .strip_prefix("credential.")
            .and_then(|s| s.rsplit_once('.').map(|x| x.0))
        {
            urls.push(scope.to_string());
        }
    }
    for remote in remotes {
        if let Ok(url) = Url::parse(remote) {
            if let Some(host) = url.host_str() {
                urls.push(format!(
                    "https://{host}{}",
                    url.port()
                        .filter(|_| url.scheme() == "https" || url.scheme() == "http")
                        .map(|p| format!(":{p}"))
                        .unwrap_or_default()
                ));
            }
        } else if let Some((_, host_path)) = remote.split_once('@') {
            if let Some((host, _)) = host_path.split_once(':') {
                urls.push(format!("https://{host}"));
            }
        }
    }
    let mut result = Vec::new();
    for raw in urls {
        if let Ok(url) = server("gitlab", &raw) {
            let kind = if url.host_str() == Some("github.com") {
                "github"
            } else {
                "gitlab"
            };
            let url = format!(
                "https://{}",
                &url[url::Position::BeforeHost..url::Position::AfterPort]
            );
            if !result.iter().any(|c: &Candidate| c.url == url) {
                result.push(Candidate {
                    kind: kind.into(),
                    url,
                });
            }
        }
    }
    result
}

pub async fn discover(remotes: &[String]) -> Result<Vec<Candidate>, String> {
    let (key, path) = tauri::async_runtime::spawn_blocking(crate::sidecar_path)
        .await
        .map_err(|_| "Không tìm được Git của máy.")?;
    // Chỉ đọc tên khoá; giá trị helper có thể chứa secret của người dùng.
    let output = tokio::time::timeout(
        TIMEOUT,
        command("git")
            .env(key, path)
            .args(["config", "--name-only", "--get-regexp", "^credential\\."])
            .output(),
    )
    .await;
    let keys = output
        .ok()
        .and_then(Result::ok)
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    Ok(candidates(&keys, remotes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn validates_server_and_discovers_without_exposing_userinfo() {
        assert!(server("gitlab", "https://user:secret@git.test").is_err());
        assert!(server("gitlab", "http://git.test").is_err());
        assert!(server("gitlab", "git.test\nhost=evil").is_err());
        let c = candidates(
            "credential.https://git.test.helper\ncredential.helper\ncredential.https://git.test.username",
            &[
                "git@github.com:acme/repo.git".into(),
                "https://user:secret@git.test/a/b.git".into(),
            ],
        );
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].url, "https://git.test");
        assert_eq!(c[1].kind, "github");
        assert_eq!(
            endpoint("github", &server("github", "").unwrap()),
            "https://api.github.com/user"
        );
        assert!(parse_password(b"username=x\n").is_err());
        assert_eq!(
            parse_password(b"username=x\r\npassword=p=a\r\n").unwrap(),
            "p=a"
        );
    }

    #[test]
    fn verifies_gitlab_github_and_rejects_password_without_leaking_body() {
        tauri::async_runtime::block_on(async {
            for (kind, status, body) in [
                ("gitlab", "200 OK", r#"{"username":"duy"}"#),
                ("github", "200 OK", r#"{"login":"duy"}"#),
                ("gitlab", "401 Unauthorized", "secret-password"),
            ] {
                let listener = TcpListener::bind("127.0.0.1:0").unwrap();
                let endpoint = endpoint(
                    kind,
                    &Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap(),
                );
                let thread = std::thread::spawn(move || {
                    let (mut socket, _) = listener.accept().unwrap();
                    let mut bytes = [0; 4096];
                    let n = socket.read(&mut bytes).unwrap();
                    let request = String::from_utf8_lossy(&bytes[..n]).to_lowercase();
                    assert!(request.contains("authorization: bearer fake-token"));
                    assert!(request.starts_with(if kind == "gitlab" {
                        "get /api/v4/user "
                    } else {
                        "get /api/v3/user "
                    }));
                    write!(socket, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                });
                let result = account(&crate::tls::client().expect("tls client"), &endpoint, kind, "fake-token").await;
                thread.join().unwrap();
                if status.starts_with("200") {
                    assert_eq!(result.unwrap(), "duy");
                } else {
                    let e = result.unwrap_err();
                    assert!(e.contains("read_api"));
                    assert!(!e.contains("secret-password"));
                }
            }
        });
    }

    #[cfg(unix)]
    #[test]
    fn fake_git_fill_is_noninteractive_refreshes_and_times_out() {
        tauri::async_runtime::block_on(async {
            let url = server("gitlab", "https://git.test:8443").unwrap();
            // sh đóng vai git, không đọc cấu hình hay helper thật; test này chỉ chạy trên Unix.
            let mut cmd = command("sh");
            cmd.args(["-c", "[ \"$GIT_TERMINAL_PROMPT\" = 0 ] && [ \"$GCM_INTERACTIVE\" = never ] || exit 1; input=$(cat); [ \"$input\" = 'protocol=https\nhost=git.test:8443' ] || exit 2; printf 'username=test\npassword=fake-one\n'"]);
            assert_eq!(fill_with(cmd, &url, TIMEOUT).await.unwrap(), "fake-one");
            let mut cmd = command("sh");
            cmd.args([
                "-c",
                "cat >/dev/null; printf 'username=test\npassword=fake-two\n'",
            ]);
            assert_eq!(fill_with(cmd, &url, TIMEOUT).await.unwrap(), "fake-two");
            let mut cmd = command("sh");
            cmd.args(["-c", "cat >/dev/null; exec sleep 2"]);
            assert!(
                fill_with(cmd, &url, Duration::from_millis(30))
                    .await
                    .unwrap_err()
                    .contains("thời gian")
            );
        });
    }
}
