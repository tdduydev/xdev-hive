//! Nhập và đổi địa chỉ hub của app. Hub có thể đổi địa chỉ (http sang https, bỏ cổng cũ) mà vẫn là hub cũ: máy đã
//! đăng ký chỉ cần sửa `hubUrl` của worker, không phải đăng ký lại. Trước khi dùng địa chỉ mới, app gọi
//! `/api/v1/health` để báo đúng nguyên nhân (không tới được, chứng chỉ không tin cậy, sai giao thức) thay vì một câu
//! "không gọi được hub" chung chung, rồi thử token máy cũ với hub mới để biết có cần đăng ký lại hay không.

use std::path::Path;
use std::time::Duration;

const HEALTH: &str = "/api/v1/health";
const WORKER_WS: &str = "/ws/worker";
const TIMEOUT: Duration = Duration::from_secs(10);

/// Chuỗi lỗi của reqwest cùng mọi nguyên nhân bên dưới: lỗi chứng chỉ của rustls nằm sâu vài lớp.
fn chain(e: &dyn std::error::Error) -> String {
    let mut text = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        text.push_str(": ");
        text.push_str(&s.to_string());
        source = s.source();
    }
    text
}

fn host_of(hub: &str) -> String {
    url::Url::parse(hub)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| u.port().map_or(h.to_string(), |p| format!("{h}:{p}")))
        })
        .unwrap_or_else(|| hub.to_string())
}

/// Đổi lỗi gọi hub thành câu hướng dẫn. Tách khỏi lời gọi mạng để test được cả lỗi chứng chỉ mà không cần dựng hub
/// HTTPS với CA giả.
pub fn explain(hub: &str, detail: &str, timeout: bool) -> String {
    let lower = detail.to_ascii_lowercase();
    let https = hub.starts_with("https://");
    let host = host_of(hub);
    if lower.contains("certificate")
        || lower.contains("unknownissuer")
        || lower.contains("self signed")
    {
        if lower.contains("notvalidforname") || lower.contains("not valid for name") {
            return format!(
                "Chứng chỉ HTTPS của hub không dành cho địa chỉ {host}. Nhập đúng tên hay IP ghi trên chứng chỉ của hub."
            );
        }
        if lower.contains("expired") {
            return format!(
                "Chứng chỉ HTTPS của {host} đã hết hạn. Báo quản trị hub gia hạn chứng chỉ."
            );
        }
        return format!(
            "Máy này chưa tin chứng chỉ HTTPS của {host}. Hub dùng chứng chỉ nội bộ (vd. Caddy local CA) thì xin quản \
             trị hub file chứng chỉ gốc (root.crt) rồi cài vào máy: macOS mở file bằng Keychain Access, thêm vào \
             System và chọn Always Trust; Windows mở file → Install Certificate → Local Machine → Trusted Root \
             Certification Authorities. Cài xong thử lại."
        );
    }
    // rustls gặp câu trả lời HTTP thường thay cho bắt tay TLS: hub chỉ chạy http.
    if https
        && (lower.contains("invalidcontenttype")
            || lower.contains("invalidmessage")
            || lower.contains("corrupt message")
            || lower.contains("wrong version number"))
    {
        return format!(
            "{host} không trả lời bằng HTTPS. Hub có thể chạy http://: thử {}.",
            hub.replacen("https://", "http://", 1)
        );
    }
    if timeout {
        return format!(
            "{host} không trả lời sau {} giây. Kiểm lại địa chỉ, mạng hay VPN.",
            TIMEOUT.as_secs()
        );
    }
    if lower.contains("connection refused")
        || lower.contains("dns")
        || lower.contains("failed to lookup")
        || lower.contains("tcp connect")
        || lower.contains("unreachable")
        || lower.contains("connect error")
    {
        return format!(
            "Không kết nối được tới {host}. Kiểm lại địa chỉ và cổng (hub chuyển sang https thường bỏ cổng cũ như \
             :3000 hay :7780), mạng hay VPN."
        );
    }
    format!("Không gọi được hub {host}: {detail}")
}

/// Bỏ `/api/v1/health` khỏi địa chỉ cuối cùng sau chuyển hướng: hub đặt sau proxy hay chuyển http sang https thì app
/// lưu địa chỉ thật, để worker mở WSS đúng giao thức thay vì vấp chuyển hướng.
fn base_of(final_url: &url::Url) -> Option<String> {
    let mut u = final_url.clone();
    let path = u.path().strip_suffix(HEALTH)?.to_string();
    u.set_path(&path);
    u.set_query(None);
    u.set_fragment(None);
    crate::register::normalize_hub(u.as_str()).ok()
}

/// Kiểm địa chỉ hub bằng `/api/v1/health`. Trả địa chỉ đã chuẩn hoá (theo chuyển hướng nếu có).
pub async fn check(raw: &str) -> Result<String, String> {
    let hub = crate::register::normalize_hub(raw)?;
    let response = crate::tls::client()
        .get(format!("{hub}{HEALTH}"))
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|e| explain(&hub, &chain(&e), e.is_timeout()))?;
    let status = response.status();
    let base = base_of(response.url()).unwrap_or_else(|| hub.clone());
    let body = response.text().await.unwrap_or_default();
    let host = host_of(&hub);
    if hub.starts_with("http://") && body.contains("HTTP request to an HTTPS server") {
        return Err(format!(
            "{host} chỉ nhận HTTPS. Thử {}.",
            hub.replacen("http://", "https://", 1)
        ));
    }
    if !status.is_success() {
        return Err(format!(
            "{host} trả mã {} ở {HEALTH}: địa chỉ này có thể không phải hub Hive.",
            status.as_u16()
        ));
    }
    let ok = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .is_some_and(|v| v["status"] == "ok");
    if !ok {
        return Err(format!(
            "{host} trả lời nhưng không phải hub Hive. Kiểm lại địa chỉ."
        ));
    }
    Ok(base)
}

/// Hai địa chỉ là một hub: so sau khi chuẩn hoá để `/` cuối hay chữ hoa ở tên máy không làm app tưởng là hub khác.
pub fn same_hub(a: &str, b: &str) -> bool {
    match (
        crate::register::normalize_hub(a),
        crate::register::normalize_hub(b),
    ) {
        (Ok(a), Ok(b)) => {
            url::Url::parse(&a).ok().map(|u| u.to_string())
                == url::Url::parse(&b).ok().map(|u| u.to_string())
        }
        _ => false,
    }
}

/// Hub có nhận token máy không: mở thử WSS của worker như worker thật (hub xác thực trước khi nâng cấp, sai thì 401).
/// Nâng cấp được thì đóng ngay; hub chỉ ghi nhận máy khi nhận gói hello, nên lần thử không làm máy hiện online hay
/// đá kết nối đang có.
pub async fn machine_token_accepted(hub: &str, token: &str) -> Result<bool, String> {
    let response = crate::tls::client()
        .get(format!("{}{WORKER_WS}", hub.trim_end_matches('/')))
        .timeout(TIMEOUT)
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "eGRldi1oaXZlLXByb2JlIQ==")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| explain(hub, &chain(&e), e.is_timeout()))?;
    match response.status().as_u16() {
        101 => Ok(true),
        401 | 403 => Ok(false),
        code => Err(format!(
            "Hub trả mã {code} khi kiểm đăng ký của máy. Thử lại sau."
        )),
    }
}

fn read_json(path: &Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("Không đọc được cấu hình worker {}: {e}", path.display()))?;
    match serde_json::from_str(&raw) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        _ => Err(format!("Cấu hình worker {} hỏng.", path.display())),
    }
}

/// Token máy (`hwm_…`) trong cấu hình worker. Chỉ dùng trong Rust để thử với hub mới, không về giao diện.
pub fn machine_token(path: &Path) -> Result<String, String> {
    read_json(path)?
        .get("machineToken")
        .and_then(|v| v.as_str())
        .filter(|t| !t.is_empty())
        .map(String::from)
        .ok_or_else(|| "Cấu hình worker không có token máy. Đăng ký lại máy.".into())
}

/// Ghi địa chỉ hub mới vào cấu hình worker, giữ nguyên mọi trường khác (tên máy, token máy, đội, trường của bản worker
/// mới hơn). Ghi file tạm rồi đổi tên như worker (config.Save), quyền 0600 vì file chứa token máy.
pub fn set_worker_hub(path: &Path, hub: &str) -> Result<(), String> {
    let mut map = read_json(path)?;
    map.insert("hubUrl".into(), serde_json::Value::String(hub.into()));
    let mut data =
        serde_json::to_vec_pretty(&serde_json::Value::Object(map)).map_err(|e| e.to_string())?;
    data.push(b'\n');
    let dir = path
        .parent()
        .ok_or("Đường dẫn cấu hình worker không hợp lệ.")?;
    let tmp = dir.join(format!(".worker-{}.json", std::process::id()));
    let write = || -> std::io::Result<()> {
        std::fs::write(&tmp, &data)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&tmp, path)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Không ghi được cấu hình worker {}: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    /// Hub giả trả lần lượt từng câu trả lời cho mỗi kết nối, ghi lại dòng đầu và header của request.
    fn fake_server(replies: Vec<String>) -> (u16, std::thread::JoinHandle<Vec<String>>) {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for reply in replies {
                let (mut s, _) = server.accept().unwrap();
                let mut buf = vec![0u8; 16 * 1024];
                let mut got = Vec::new();
                while !got.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = s.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    got.extend_from_slice(&buf[..n]);
                    // Bắt tay TLS (byte đầu 0x16) không bao giờ có dòng trống: trả lời ngay như server HTTP thường.
                    if got[0] == 0x16 {
                        break;
                    }
                }
                seen.push(String::from_utf8_lossy(&got).to_string());
                let _ = s.write_all(reply.as_bytes());
            }
            seen
        });
        (port, handle)
    }

    fn http(status: &str, extra: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n{extra}\r\n{body}",
            body.len()
        )
    }

    const HEALTHY: &str = r#"{"status":"ok","version":"0.9.0","time":"2026-10-15T00:00:00.000Z"}"#;

    #[test]
    fn healthy_hub_passes_and_is_normalized() {
        let (port, server) = fake_server(vec![http("200 OK", "", HEALTHY)]);
        let hub = block_on(check(&format!("  http://127.0.0.1:{port}/ "))).unwrap();
        assert_eq!(hub, format!("http://127.0.0.1:{port}"));
        assert!(server.join().unwrap()[0].starts_with("GET /api/v1/health HTTP/1.1"));
    }

    #[test]
    fn follows_redirect_and_keeps_the_final_address() {
        let (to, target) = fake_server(vec![http("200 OK", "", HEALTHY)]);
        let location = format!("location: http://localhost:{to}/api/v1/health\r\n");
        let (from, origin) = fake_server(vec![http("308 Permanent Redirect", &location, "")]);
        let hub = block_on(check(&format!("http://127.0.0.1:{from}"))).unwrap();
        assert_eq!(hub, format!("http://localhost:{to}"));
        origin.join().unwrap();
        target.join().unwrap();
    }

    #[test]
    fn not_a_hive_hub() {
        let (port, server) = fake_server(vec![
            http("404 Not Found", "", "{}"),
            http("200 OK", "", "<html>router</html>"),
        ]);
        let hub = format!("http://127.0.0.1:{port}");
        assert!(block_on(check(&hub)).unwrap_err().contains("mã 404"));
        assert!(
            block_on(check(&hub))
                .unwrap_err()
                .contains("không phải hub Hive")
        );
        server.join().unwrap();
    }

    #[test]
    fn https_against_plain_http_says_wrong_protocol() {
        // Hub chạy http mà người dùng nhập https: TLS bắt tay vấp câu trả lời HTTP thường.
        let (port, _server) = fake_server(vec![http("400 Bad Request", "", "{}")]);
        let err = block_on(check(&format!("https://127.0.0.1:{port}"))).unwrap_err();
        assert!(err.contains("không trả lời bằng HTTPS"), "{err}");
        assert!(err.contains(&format!("http://127.0.0.1:{port}")), "{err}");
    }

    #[test]
    fn http_against_https_only_says_use_https() {
        let (port, server) = fake_server(vec![http(
            "400 Bad Request",
            "",
            "Client sent an HTTP request to an HTTPS server.\n",
        )]);
        let err = block_on(check(&format!("http://127.0.0.1:{port}"))).unwrap_err();
        assert!(err.contains("chỉ nhận HTTPS"), "{err}");
        server.join().unwrap();
    }

    #[test]
    fn closed_port_says_cannot_connect() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let err = block_on(check(&format!("http://127.0.0.1:{port}"))).unwrap_err();
        assert!(err.contains("Không kết nối được tới 127.0.0.1"), "{err}");
    }

    #[test]
    fn explains_certificate_problems() {
        let hub = "https://192.0.2.10";
        let unknown = "error sending request for url (https://192.0.2.10/api/v1/health): client error (Connect): invalid peer certificate: UnknownIssuer";
        let text = explain(hub, unknown, false);
        assert!(
            text.contains("chưa tin chứng chỉ HTTPS của 192.0.2.10"),
            "{text}"
        );
        assert!(text.contains("root.crt"), "{text}");
        let name = "invalid peer certificate: NotValidForName";
        assert!(explain(hub, name, false).contains("không dành cho địa chỉ"));
        let expired = "invalid peer certificate: Expired";
        assert!(explain(hub, expired, false).contains("hết hạn"));
        assert!(explain(hub, "operation timed out", true).contains("không trả lời sau 10 giây"));
    }

    #[test]
    fn compares_hub_addresses() {
        assert!(same_hub("https://Hive.acme.vn/", "https://hive.acme.vn"));
        assert!(same_hub("https://hive.acme.vn:443", "https://hive.acme.vn"));
        assert!(!same_hub(
            "http://192.0.2.10:7780",
            "https://192.0.2.10"
        ));
        assert!(!same_hub("not a url", "not a url"));
    }

    #[test]
    fn probes_the_machine_token_like_the_worker() {
        let (port, server) = fake_server(vec![
            "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: x\r\n\r\n".into(),
            http("401 Unauthorized", "", "Machine token không hợp lệ."),
            http("502 Bad Gateway", "", ""),
        ]);
        let hub = format!("http://127.0.0.1:{port}");
        assert_eq!(block_on(machine_token_accepted(&hub, "hwm_ok")), Ok(true));
        assert_eq!(block_on(machine_token_accepted(&hub, "hwm_old")), Ok(false));
        assert!(block_on(machine_token_accepted(&hub, "hwm_ok")).is_err());
        let seen = server.join().unwrap();
        assert!(
            seen[0].starts_with("GET /ws/worker HTTP/1.1"),
            "{}",
            seen[0]
        );
        let head = seen[0].to_ascii_lowercase();
        assert!(head.contains("authorization: bearer hwm_ok"), "{head}");
        assert!(head.contains("upgrade: websocket"), "{head}");
    }

    #[test]
    fn rewrites_only_the_hub_address_in_worker_config() {
        let dir = std::env::temp_dir().join(format!("hive-hub-switch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("worker.json");
        std::fs::write(
            &path,
            r#"{"hubUrl":"http://192.0.2.10:7780","machineId":"mac-ha","machineToken":"hwm_secret","teamId":"t1","future":{"x":1}}"#,
        )
        .unwrap();
        assert_eq!(machine_token(&path).unwrap(), "hwm_secret");
        set_worker_hub(&path, "https://192.0.2.10").unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["hubUrl"], "https://192.0.2.10");
        assert_eq!(v["machineId"], "mac-ha");
        assert_eq!(v["machineToken"], "hwm_secret");
        assert_eq!(v["teamId"], "t1");
        assert_eq!(v["future"]["x"], 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // Không để lại file tạm cạnh cấu hình.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::write(&path, "not json").unwrap();
        assert!(set_worker_hub(&path, "https://x").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
