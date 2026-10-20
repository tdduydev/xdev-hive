//! Đăng nhập app bằng trình duyệt (contracts/desktop-connect.ts): OAuth cho app cài trên máy theo RFC 8252, có PKCE
//! (RFC 7636). App mở một cổng tạm trên 127.0.0.1, mở trang `/desktop/connect` của hub trong trình duyệt mặc định,
//! chờ trình duyệt quay về với mã đổi, rồi đổi mã (kèm verifier chỉ app giữ) lấy mã đăng ký máy và token cá nhân.
//! Mật khẩu không bao giờ đi qua app, và đăng nhập GitHub hay SSO của hub dùng được như trên web.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use crate::no_window::NoWindow;

/// Bằng hạn của mã đổi trên hub: quá lâu thì mã cũng đã hết hạn.
const WAIT: Duration = Duration::from_secs(5 * 60);

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

fn random(n: usize) -> Result<String, String> {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).map_err(|e| format!("Không tạo được số ngẫu nhiên: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

pub fn challenge_of(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn new_pkce() -> Result<Pkce, String> {
    let verifier = random(32)?;
    Ok(Pkce {
        challenge: challenge_of(&verifier),
        verifier,
        state: random(24)?,
    })
}

/// Tên máy mặc định giống `hive-worker register` (defaultMachineID): chữ thường, số và `-`, tối đa 63 ký tự.
pub fn machine_from_hostname(hostname: &str) -> String {
    let lower = hostname.trim().to_lowercase();
    let lower = lower.strip_suffix(".local").unwrap_or(&lower);
    let mut name = String::new();
    let mut dash = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            name.push(c);
            dash = false;
        } else if !dash {
            name.push('-');
            dash = true;
        }
    }
    let mut name = name.trim_matches('-').to_string();
    if name.len() > 63 {
        name.truncate(63);
        name = name.trim_end_matches('-').to_string();
    }
    if name.is_empty() {
        "worker".into()
    } else {
        name
    }
}

pub fn hostname() -> String {
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        return name;
    }
    std::process::Command::new("hostname")
        .no_window()
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Việc của lần đăng nhập (contracts/desktop-connect.ts `connectPurpose`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Purpose {
    /// Đăng ký máy vào đội và lấy token cá nhân.
    Register,
    /// Máy đã đăng ký: chỉ lấy token cá nhân, như `hive login`. Không phải chọn đội và không đăng ký lại máy.
    SignIn,
}

pub fn connect_url(
    hub: &str,
    port: u16,
    pkce: &Pkce,
    machine: &str,
    purpose: Purpose,
) -> Result<String, String> {
    let mut url = url::Url::parse(hub)
        .and_then(|u| u.join("/desktop/connect"))
        .map_err(|e| format!("Địa chỉ hub không hợp lệ: {e}"))?;
    let mut q = url.query_pairs_mut();
    q.append_pair("port", &port.to_string())
        .append_pair("state", &pkce.state)
        .append_pair("challenge", &pkce.challenge)
        .append_pair("machine", machine);
    // Đăng ký không gửi `purpose` để hub cũ (trước `hive login`) vẫn nhận. `client` cho trang đồng ý nói "quay lại
    // app" thay vì "quay lại terminal".
    if purpose == Purpose::SignIn {
        q.append_pair("purpose", "cli")
            .append_pair("client", "desktop");
    }
    drop(q);
    Ok(url.into())
}

#[derive(Debug, PartialEq)]
pub enum Callback {
    Code(String),
    Denied,
}

/// Đọc dòng đầu của request trình duyệt gửi về: `GET /callback?code=…&state=… HTTP/1.1`. None khi không phải callback
/// (vd. trình duyệt xin /favicon.ico) để app chờ tiếp.
pub fn parse_callback(request_line: &str, state: &str) -> Option<Result<Callback, String>> {
    let target = request_line.split_whitespace().nth(1)?;
    let url = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != "/callback" {
        return None;
    }
    let get = |k: &str| {
        url.query_pairs()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.into_owned())
    };
    if get("state").as_deref() != Some(state) {
        // State khác là request lạ (trang khác gọi vào cổng này), không phải câu trả lời của hub.
        return Some(Err(
            "Phản hồi đăng nhập không khớp phiên này. Bấm đăng nhập lại.".into(),
        ));
    }
    if get("error").is_some() {
        return Some(Ok(Callback::Denied));
    }
    Some(
        get("code")
            .map(Callback::Code)
            .ok_or_else(|| "Hub không trả mã đăng nhập.".to_string()),
    )
}

const PAGE_OK: &str = "Đã kết nối app xDev Hive. Bạn có thể đóng tab này và quay lại app.";
const PAGE_DENIED: &str = "Đã từ chối. App xDev Hive không được kết nối.";
const PAGE_ERROR: &str = "Không kết nối được. Quay lại app xDev Hive để thử lại.";

fn respond(stream: &mut TcpStream, status: &str, text: &str) {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>xDev Hive</title><body style=\"font:16px system-ui;margin:20vh auto;max-width:28em;text-align:center\">{text}</body>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
}

fn read_request_line(stream: &mut TcpStream) -> Option<String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 16 * 1024 {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    String::from_utf8_lossy(&buf)
        .lines()
        .next()
        .map(String::from)
}

/// Mở cổng tạm trên 127.0.0.1 (không bao giờ 0.0.0.0, để máy khác trong mạng không gọi vào được).
pub fn listen() -> Result<(TcpListener, u16), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Không mở được cổng tạm để đăng nhập: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    Ok((listener, port))
}

/// Chờ trình duyệt quay về (chặn luồng; gọi trong spawn_blocking). Trả mã đổi, hoặc lỗi khi bị từ chối, hết giờ.
pub fn wait_for_code(listener: TcpListener, state: &str) -> Result<String, String> {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        let mut stream = match listener.accept() {
            Ok((s, _)) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
                continue;
            }
            Err(e) => return Err(format!("Cổng đăng nhập lỗi: {e}")),
        };
        let _ = stream.set_nonblocking(false);
        let Some(line) = read_request_line(&mut stream) else {
            continue;
        };
        match parse_callback(&line, state) {
            None => respond(&mut stream, "404 Not Found", ""),
            Some(Ok(Callback::Code(code))) => {
                respond(&mut stream, "200 OK", PAGE_OK);
                return Ok(code);
            }
            Some(Ok(Callback::Denied)) => {
                respond(&mut stream, "200 OK", PAGE_DENIED);
                return Err("Bạn đã từ chối kết nối trên trình duyệt.".into());
            }
            Some(Err(e)) => respond(
                &mut stream,
                "400 Bad Request",
                &format!("{PAGE_ERROR} ({e})"),
            ),
        }
    }
    Err("Quá 5 phút chưa đăng nhập xong trên trình duyệt. Bấm đăng nhập lại.".into())
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Exchange {
    pub machine: String,
    /// Chỉ có khi đăng ký máy; đăng nhập (`purpose=cli`) chỉ trả token cá nhân.
    #[serde(default)]
    pub registration_token: Option<String>,
    pub personal_token: String,
}

/// Đổi mã lấy mã đăng ký máy và token cá nhân. Câu lỗi của hub đã là tiếng Việt nên đưa nguyên cho người dùng.
pub async fn exchange(hub: &str, code: &str, verifier: &str) -> Result<Exchange, String> {
    let url = format!(
        "{}/api/v1/desktop/connect/exchange",
        hub.trim_end_matches('/')
    );
    let body = serde_json::json!({ "code": code, "verifier": verifier });
    let response = crate::tls::client()?
        .post(&url)
        .timeout(Duration::from_secs(30))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Không gọi được hub: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Không đọc được trả lời của hub: {e}"))?;
    if !status.is_success() {
        let message = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v["message"].as_str().map(String::from));
        return Err(message.unwrap_or_else(|| format!("Hub từ chối đăng nhập (mã {status}).")));
    }
    serde_json::from_str(&text).map_err(|_| "Hub trả dữ liệu đăng nhập không đọc được.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_base64url() {
        // Giá trị mong đợi tính riêng bằng: printf %s <verifier> | openssl dgst -sha256 -binary | base64url.
        assert_eq!(
            challenge_of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gXFI2oWwQ"),
            "5T0-Pw8B-1M7_tZZh_g3cM6AJDRqgbDQu25bASImiBc"
        );
        let p = new_pkce().unwrap();
        assert_eq!(p.verifier.len(), 43);
        assert_eq!(p.challenge.len(), 43);
        assert_ne!(p.verifier, new_pkce().unwrap().verifier);
    }

    #[test]
    fn machine_name_like_worker() {
        assert_eq!(
            machine_from_hostname("Duys-MacBook-Pro.local"),
            "duys-macbook-pro"
        );
        assert_eq!(machine_from_hostname("DESKTOP_42 (Hà)"), "desktop-42-h");
        assert_eq!(machine_from_hostname("  "), "worker");
        assert_eq!(machine_from_hostname(&"a".repeat(80)).len(), 63);
    }

    #[test]
    fn builds_connect_url_with_all_params() {
        let p = Pkce {
            verifier: "v".into(),
            challenge: "c".repeat(43),
            state: "s".repeat(32),
        };
        let url = connect_url(
            "http://10.0.0.1:3000",
            51234,
            &p,
            "mac-ha",
            Purpose::Register,
        )
        .unwrap();
        assert!(url.starts_with("http://10.0.0.1:3000/desktop/connect?port=51234&state="));
        assert!(url.ends_with("&machine=mac-ha"));
        let url =
            connect_url("https://192.0.2.10", 51234, &p, "mac-ha", Purpose::SignIn).unwrap();
        assert!(
            url.ends_with("&machine=mac-ha&purpose=cli&client=desktop"),
            "{url}"
        );
    }

    #[test]
    fn reads_callback_and_checks_state() {
        let st = "abc123abc123abc123";
        let ok = format!("GET /callback?code=hdc_x&state={st} HTTP/1.1");
        assert_eq!(
            parse_callback(&ok, st),
            Some(Ok(Callback::Code("hdc_x".into())))
        );
        let denied = format!("GET /callback?error=access_denied&state={st} HTTP/1.1");
        assert_eq!(parse_callback(&denied, st), Some(Ok(Callback::Denied)));
        assert!(matches!(
            parse_callback("GET /callback?code=hdc_x&state=other HTTP/1.1", st),
            Some(Err(_))
        ));
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1", st), None);
    }

    #[test]
    fn waits_for_the_browser_on_loopback() {
        let (listener, port) = listen().unwrap();
        let state = "state-for-test-000".to_string();
        let st = state.clone();
        let waiter = std::thread::spawn(move || wait_for_code(listener, &st));
        let send = |path: &str| {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(s, "GET {path} HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n").unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            out
        };
        assert!(send("/favicon.ico").starts_with("HTTP/1.1 404"));
        assert!(send(&format!("/callback?code=hdc_ok&state={state}")).contains("Đã kết nối"));
        assert_eq!(waiter.join().unwrap(), Ok("hdc_ok".into()));
    }

    /// Hub giả nhận POST /api/v1/desktop/connect/exchange: trả 200 khi verifier khớp challenge, không thì 401.
    fn fake_hub(challenge: String) -> (u16, std::thread::JoinHandle<serde_json::Value>) {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut s, _) = server.accept().unwrap();
            let mut buf = vec![0u8; 64 * 1024];
            let mut got = Vec::new();
            loop {
                let n = s.read(&mut buf).unwrap();
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).to_string();
                if let Some(at) = text.find("\r\n\r\n") {
                    let len: usize = text
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    if got.len() >= at + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let text = String::from_utf8_lossy(&got).to_string();
            let (head, body) = text.split_once("\r\n\r\n").unwrap();
            assert!(
                head.starts_with("POST /api/v1/desktop/connect/exchange "),
                "{head}"
            );
            let body: serde_json::Value = serde_json::from_str(body).unwrap();
            let ok = challenge_of(body["verifier"].as_str().unwrap()) == challenge;
            let (status, reply) = if ok {
                (
                    "200 OK",
                    r#"{"hubUrl":"http://hub","machine":"mac-test","teamId":"t1","registrationToken":"hwr_x","personalToken":"hive_pat_y","personalTokenExpiresAt":"2027-01-01T00:00:00.000Z"}"#,
                )
            } else {
                (
                    "401 Unauthorized",
                    r#"{"message":"Mã đăng nhập không hợp lệ."}"#,
                )
            };
            write!(s, "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len()).unwrap();
            body
        });
        (port, handle)
    }

    /// Cả luồng của lệnh browser_login trừ cửa sổ Tauri: cổng tạm, trình duyệt gọi về, đổi mã với hub bằng client
    /// HTTP thật. v0.2.1 hỏng ở đây (client panic vì chưa có TLS provider) mà không test nào bắt được.
    #[test]
    fn full_flow_against_a_fake_hub() {
        let pkce = new_pkce().unwrap();
        let (listener, port) = listen().unwrap();
        let url = connect_url(
            "http://hub.test",
            port,
            &pkce,
            "mac-test",
            Purpose::Register,
        )
        .unwrap();
        assert!(url.contains(&format!("challenge={}", pkce.challenge)));
        let state = pkce.state.clone();
        let browser = std::thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(
                s,
                "GET /callback?code=hdc_from_hub&state={state} HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n"
            )
            .unwrap();
            let mut page = String::new();
            let _ = s.read_to_string(&mut page);
            page
        });
        let code = wait_for_code(listener, &pkce.state).unwrap();
        assert_eq!(code, "hdc_from_hub");
        assert!(browser.join().unwrap().contains("Đã kết nối"));

        let (hub_port, hub) = fake_hub(pkce.challenge.clone());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let ex = rt
            .block_on(exchange(
                &format!("http://127.0.0.1:{hub_port}"),
                &code,
                &pkce.verifier,
            ))
            .unwrap();
        assert_eq!(ex.machine, "mac-test");
        assert_eq!(ex.registration_token.as_deref(), Some("hwr_x"));
        assert_eq!(ex.personal_token, "hive_pat_y");
        assert_eq!(hub.join().unwrap()["code"], "hdc_from_hub");

        // Verifier sai: hub từ chối, app trả câu lỗi của hub thay vì panic.
        let (hub_port, hub) = fake_hub(pkce.challenge.clone());
        let err = rt
            .block_on(exchange(
                &format!("http://127.0.0.1:{hub_port}"),
                &code,
                &new_pkce().unwrap().verifier,
            ))
            .unwrap_err();
        assert_eq!(err, "Mã đăng nhập không hợp lệ.");
        hub.join().unwrap();
    }
}
