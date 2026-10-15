//! Chỉ bắt tay TLS khi dò chứng chỉ. Lời gọi /ca.crt tiếp theo ghim đúng leaf vừa thấy, không mang token/cookie.
//! CA chỉ được lưu sau khi người dùng đối chiếu vân tay và CA đó xác thực được hub bằng verifier bình thường.

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CA: usize = 64 * 1024;
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub hub: String,
    pub name: String,
    pub fingerprint: String,
    pub previous_fingerprint: Option<String>,
}

#[derive(Clone)]
struct Pending {
    info: Candidate,
    pem: Vec<u8>,
}

pub fn ca_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("HIVE_CA_FILE").filter(|p| !p.is_empty()) {
        return Ok(path.into());
    }
    let home = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(home)
        .map(|p| PathBuf::from(p).join(".xdev-hive").join("hub-ca.pem"))
        .ok_or_else(|| "Không tìm được thư mục nhà để đọc CA hub.".into())
}

pub fn read_ca(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(pem) if pem.len() <= MAX_CA => Ok(Some(pem)),
        Ok(_) => Err("File CA hub quá lớn.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if std::env::var_os("HIVE_CA_FILE").is_some_and(|p| !p.is_empty()) {
                Err(format!("Không đọc được CA hub {}: {e}", path.display()))
            } else {
                Ok(None)
            }
        }
        Err(e) => Err(format!("Không đọc được CA hub {}: {e}", path.display())),
    }
}

pub fn parse_ca(pem: &[u8]) -> Result<Vec<u8>, String> {
    let (rest, block) = x509_parser::pem::parse_x509_pem(pem)
        .map_err(|_| "CA hub không phải chứng chỉ PEM hợp lệ.")?;
    if block.label != "CERTIFICATE" || !rest.iter().all(u8::is_ascii_whitespace) {
        return Err("CA hub phải chứa đúng một chứng chỉ gốc.".into());
    }
    let (rest, cert) = x509_parser::parse_x509_certificate(&block.contents)
        .map_err(|_| "Chứng chỉ CA hub không hợp lệ.")?;
    if !rest.is_empty() || !cert.is_ca() || cert.subject() != cert.issuer() {
        return Err("Chứng chỉ tải về không phải CA gốc.".into());
    }
    cert.verify_signature(None)
        .map_err(|_| "Chữ ký CA gốc không hợp lệ.")?;
    Ok(block.contents)
}

fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

#[derive(Debug)]
struct ProbeVerifier {
    pin: Option<Vec<u8>>,
}

impl ServerCertVerifier for ProbeVerifier {
    fn verify_server_cert(
        &self,
        leaf: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if self.pin.as_ref().is_some_and(|pin| pin != leaf.as_ref()) {
            return Err(rustls::Error::General(
                "Chứng chỉ server đã đổi khi tải CA; thử lại.".into(),
            ));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn probe_config(pin: Option<Vec<u8>>) -> rustls::ClientConfig {
    crate::tls::ensure();
    rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(ProbeVerifier { pin }))
        .with_no_client_auth()
}

fn handshake(url: url::Url) -> Result<Vec<u8>, String> {
    use std::net::{TcpStream, ToSocketAddrs};
    let host = url.host_str().ok_or("Địa chỉ hub thiếu máy chủ.")?;
    let addresses = (host, url.port_or_known_default().unwrap_or(443))
        .to_socket_addrs()
        .map_err(|e| format!("Không tìm được máy chủ: {e}"))?;
    let mut socket = addresses
        .filter_map(|a| TcpStream::connect_timeout(&a, TIMEOUT).ok())
        .next()
        .ok_or("Không kết nối được tới hub để xem chứng chỉ.")?;
    socket
        .set_read_timeout(Some(TIMEOUT))
        .map_err(|e| e.to_string())?;
    socket
        .set_write_timeout(Some(TIMEOUT))
        .map_err(|e| e.to_string())?;
    let name = ServerName::try_from(host.to_string()).map_err(|e| e.to_string())?;
    let mut conn = rustls::ClientConnection::new(Arc::new(probe_config(None)), name)
        .map_err(|e| e.to_string())?;
    while conn.is_handshaking() {
        conn.complete_io(&mut socket)
            .map_err(|e| format!("Không đọc được chứng chỉ hub: {e}"))?;
    }
    conn.peer_certificates()
        .and_then(|c| c.first())
        .map(|c| c.to_vec())
        .ok_or_else(|| "Hub không gửi chứng chỉ HTTPS.".into())
}

async fn discover_at(raw: &str, path: &Path) -> Result<Pending, String> {
    let hub = crate::register::normalize_hub(raw)?;
    let mut url = url::Url::parse(&hub).map_err(|e| e.to_string())?;
    if url.scheme() != "https" {
        return Err("Chỉ xem CA cho địa chỉ HTTPS.".into());
    }
    let leaf = tauri::async_runtime::spawn_blocking({
        let url = url.clone();
        move || handshake(url)
    })
    .await
    .map_err(|e| e.to_string())??;
    url.set_path("/ca.crt");
    let client = reqwest::Client::builder()
        .tls_backend_preconfigured(probe_config(Some(leaf)))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Không tải được /ca.crt qua kết nối đã ghim: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Hub chưa phát CA ở /ca.crt: {e}"))?;
    let mut pem = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if pem.len() + chunk.len() > MAX_CA {
            return Err("CA hub tải về quá lớn.".into());
        }
        pem.extend_from_slice(&chunk);
    }
    let der = parse_ca(&pem)?;
    // Kiểm chuỗi, tên máy và hạn dùng trước khi cho phép người dùng tin CA.
    verify_hub(&hub, &pem).await?;
    let (_, cert) = x509_parser::parse_x509_certificate(&der).map_err(|e| e.to_string())?;
    let previous_fingerprint = read_ca(path)?
        .map(|p| parse_ca(&p).map(|der| fingerprint(&der)))
        .transpose()?;
    Ok(Pending {
        info: Candidate {
            hub,
            name: cert.subject().to_string(),
            fingerprint: fingerprint(&der),
            previous_fingerprint,
        },
        pem,
    })
}

async fn verify_hub(hub: &str, pem: &[u8]) -> Result<(), String> {
    let der = parse_ca(pem)?;
    let client = reqwest::Client::builder()
        .tls_certs_only([reqwest::Certificate::from_der(&der).map_err(|e| e.to_string())?])
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(format!("{hub}/api/v1/health"))
        .send()
        .await
        .map_err(|e| {
            format!(
                "CA tải về không xác thực được hub (tên máy, hạn dùng hoặc chuỗi chứng chỉ): {e}"
            )
        })?;
    if !response.status().is_success() {
        return Err("Địa chỉ này không trả health của hub Hive.".into());
    }
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !serde_json::from_str::<serde_json::Value>(&body).is_ok_and(|v| v["status"] == "ok") {
        return Err("Địa chỉ này không phải hub Hive.".into());
    }
    Ok(())
}

pub async fn discover(raw: &str) -> Result<Candidate, String> {
    let path = ca_path()?;
    let pending = tokio::time::timeout(Duration::from_secs(30), discover_at(raw, &path))
        .await
        .map_err(|_| "Hub không trả chứng chỉ sau 30 giây. Kiểm lại mạng hay VPN.")??;
    let info = pending.info.clone();
    *PENDING
        .lock()
        .map_err(|_| "Không lưu được CA đang chờ xác nhận.")? = Some(pending);
    Ok(info)
}

fn save(path: &Path, pem: &[u8]) -> Result<(), String> {
    use std::io::Write;
    parse_ca(pem)?;
    let dir = path.parent().ok_or("Đường dẫn CA không hợp lệ.")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut nonce = [0; 8];
    getrandom::fill(&mut nonce).map_err(|e| format!("Không tạo được file CA tạm: {e}"))?;
    let tmp = dir.join(format!(".hub-ca-{:x}.pem", u64::from_le_bytes(nonce)));
    let write = || -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(pem)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Không lưu được CA hub: {e}")
    })
}

pub async fn trust(hub: &str, fingerprint: &str) -> Result<(), String> {
    let pending = PENDING
        .lock()
        .map_err(|_| "Không đọc được CA đang chờ xác nhận.")?
        .take()
        .ok_or("Xem lại chứng chỉ hub trước khi xác nhận.")?;
    trust_pending(pending, hub, fingerprint, &ca_path()?).await
}

async fn trust_pending(
    pending: Pending,
    hub: &str,
    fingerprint: &str,
    path: &Path,
) -> Result<(), String> {
    if pending.info.hub != hub || pending.info.fingerprint != fingerprint {
        return Err("Địa chỉ hoặc vân tay đã thay đổi. Xem lại chứng chỉ hub.".into());
    }
    verify_hub(hub, &pending.pem).await?;
    save(path, &pending.pem)
}

pub fn forget() -> Result<(), String> {
    *PENDING
        .lock()
        .map_err(|_| "Không xoá được CA đang chờ xác nhận.")? = None;
    match std::fs::remove_file(ca_path()?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Không quên được CA hub: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{
        BasicConstraints, CertificateParams, CertifiedIssuer, DnType, IsCa, KeyPair,
        KeyUsagePurpose,
    };
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Hub {
        url: String,
        pem: Vec<u8>,
        seen: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Drop for Hub {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            let _ = TcpStream::connect(self.url.trim_start_matches("https://"));
            self.thread.take().unwrap().join().unwrap();
        }
    }

    fn identity(name: &str) -> (Arc<rustls::ServerConfig>, Vec<u8>) {
        crate::tls::ensure();
        let mut params = CertificateParams::default();
        params.distinguished_name.push(DnType::CommonName, name);
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![
            KeyUsagePurpose::KeyCertSign,
            KeyUsagePurpose::DigitalSignature,
        ];
        let ca = CertifiedIssuer::self_signed(params, KeyPair::generate().unwrap()).unwrap();
        let key = KeyPair::generate().unwrap();
        let leaf = CertificateParams::new(vec!["127.0.0.1".into()])
            .unwrap()
            .signed_by(&key, &ca)
            .unwrap();
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![leaf.der().clone()],
                rustls::pki_types::PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
            )
            .unwrap();
        (Arc::new(config), ca.pem().into_bytes())
    }

    fn server(rotate_after_probe: bool, wrong_root: bool) -> Hub {
        let (config, pem) = identity("Hive Test Root");
        let (other, other_pem) = identity("Other Root");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("https://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let requests = seen.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let body = if wrong_root { other_pem } else { pem.clone() };
        let thread = std::thread::spawn(move || {
            let mut accepted = 0;
            for socket in listener.incoming().flatten() {
                if done.load(Ordering::SeqCst) {
                    return;
                }
                accepted += 1;
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let config = if rotate_after_probe && accepted > 1 {
                    other.clone()
                } else {
                    config.clone()
                };
                let conn = rustls::ServerConnection::new(config).unwrap();
                let mut stream = rustls::StreamOwned::new(conn, socket);
                let mut request = Vec::new();
                let mut buf = [0; 2048];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                if request.is_empty() {
                    continue;
                }
                let text = String::from_utf8_lossy(&request).to_string();
                let response = if text.starts_with("GET /ca.crt ") {
                    body.as_slice()
                } else {
                    br#"{"status":"ok"}"#
                };
                requests.lock().unwrap().push(text);
                let header = format!(
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    response.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(response);
                let _ = stream.flush();
            }
        });
        Hub {
            url,
            pem,
            seen,
            stop,
            thread: Some(thread),
        }
    }

    fn temp_path() -> PathBuf {
        let mut nonce = [0; 8];
        getrandom::fill(&mut nonce).unwrap();
        std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!("ca-test-{:x}", u64::from_le_bytes(nonce)))
            .join("hub-ca.pem")
    }

    #[test]
    fn untrusted_then_confirmed_and_changed_ca() {
        tauri::async_runtime::block_on(async {
            let hub = server(false, false);
            let path = temp_path();
            let error = crate::hub_switch::check(&hub.url).await.unwrap_err();
            assert!(error.starts_with("HIVE_CA_UNTRUSTED:"), "{error}");
            let pending = discover_at(&hub.url, &path).await.unwrap();
            assert_eq!(pending.info.name, "CN=Hive Test Root");
            assert!(pending.info.previous_fingerprint.is_none());
            assert!(!path.exists(), "dò CA không được tự lưu");
            let requests = hub.seen.lock().unwrap().clone();
            assert_eq!(requests.len(), 2, "bắt tay ban đầu không được gửi HTTP");
            assert!(requests[0].starts_with("GET /ca.crt "));
            assert!(
                requests
                    .iter()
                    .all(|r| !r.to_ascii_lowercase().contains("authorization:")
                        && !r.to_ascii_lowercase().contains("cookie:"))
            );
            assert!(
                trust_pending(pending.clone(), &hub.url, "sai-vân-tay", &path)
                    .await
                    .is_err()
            );
            assert!(!path.exists());
            trust_pending(pending.clone(), &hub.url, &pending.info.fingerprint, &path)
                .await
                .unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
            let stored = read_ca(&path).unwrap().unwrap();
            let result = crate::tls::with_ca(Some(&stored))
                .unwrap()
                .get(format!("{}/api/v1/health", hub.url))
                .send()
                .await
                .unwrap();
            assert!(result.status().is_success());
            assert!(
                crate::tls::with_ca(Some(&stored))
                    .unwrap()
                    .get(hub.url.replace("127.0.0.1", "localhost"))
                    .send()
                    .await
                    .is_err(),
                "CA đã tin vẫn phải kiểm tên máy"
            );
            let other = server(false, false);
            assert!(
                crate::tls::with_ca(Some(&stored))
                    .unwrap()
                    .get(&other.url)
                    .send()
                    .await
                    .is_err()
            );
            let changed = discover_at(&other.url, &path).await.unwrap();
            assert_ne!(changed.info.fingerprint, pending.info.fingerprint);
            assert_eq!(
                changed.info.previous_fingerprint,
                Some(pending.info.fingerprint)
            );
            assert_eq!(std::fs::read(&path).unwrap(), stored, "không tự thay CA cũ");
            std::fs::remove_file(&path).unwrap();
            std::fs::remove_dir(path.parent().unwrap()).unwrap();
        });
    }

    #[test]
    fn rejects_changed_leaf_and_unrelated_ca() {
        tauri::async_runtime::block_on(async {
            let rotating = server(true, false);
            assert!(discover_at(&rotating.url, &temp_path()).await.is_err());
            assert!(
                rotating.seen.lock().unwrap().is_empty(),
                "không gửi HTTP khi leaf khác bản đã ghim"
            );
            let unrelated = server(false, true);
            assert!(discover_at(&unrelated.url, &temp_path()).await.is_err());
        });
    }

    #[test]
    fn rejects_malformed_or_multiple_roots() {
        let hub = server(false, false);
        assert!(parse_ca(b"broken").is_err());
        let mut multiple = hub.pem.clone();
        multiple.extend_from_slice(&hub.pem);
        assert!(parse_ca(&multiple).is_err());
    }
}
