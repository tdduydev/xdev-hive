//! Bộ mã hoá TLS cho reqwest. Cây phụ thuộc dùng reqwest với `rustls-no-provider` (theo tauri-plugin-updater), nên
//! phải tự cài provider trước khi tạo client; không thì `reqwest::Client::new()` panic. Updater chỉ cài khi kiểm bản
//! mới, tức là sau khi máy đã đăng ký; máy mới đăng nhập bằng trình duyệt gọi hub trước lúc đó.

/// Cài provider `ring` (cùng bản updater dùng) nếu chưa có. Gọi lại nhiều lần không sao.
pub fn ensure() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        // Chỉ lỗi khi đã có provider khác cài trước (luồng khác vừa cài): khi đó cũng dùng được.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// Client HTTP cho mọi lời gọi hub của app. Dùng chung một client để giữ kết nối keep-alive: mỗi màn gọi hub nhiều
/// lần, client mới mỗi lần thì lần nào cũng bắt tay TCP và TLS lại từ đầu.
pub fn client() -> Result<reqwest::Client, String> {
    use std::sync::Mutex;
    static CLIENT: Mutex<Option<(Option<Vec<u8>>, reqwest::Client)>> = Mutex::new(None);
    let pem = crate::hub_ca::read_ca(&crate::hub_ca::ca_path()?)?;
    let mut cached = CLIENT.lock().map_err(|_| "Không đọc được bộ đệm TLS.")?;
    if let Some((saved, client)) = cached.as_ref()
        && *saved == pem
    {
        return Ok(client.clone());
    }
    let client = with_ca(pem.as_deref())?;
    *cached = Some((pem, client.clone()));
    Ok(client)
}

pub fn with_ca(pem: Option<&[u8]>) -> Result<reqwest::Client, String> {
    ensure();
    let mut builder =
        reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(10));
    if let Some(pem) = pem {
        let cert = crate::hub_ca::parse_ca(pem)?;
        builder = builder.tls_certs_merge([reqwest::Certificate::from_der(&cert)
            .map_err(|e| format!("Chứng chỉ CA không hợp lệ: {e}"))?]);
    }
    builder
        .build()
        .map_err(|e| format!("Không tạo được kết nối TLS: {e}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn builds_a_client_without_the_updater_having_run() {
        // Trước đây panic: "No rustls crypto provider is configured".
        let _ = super::client().unwrap();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[test]
    fn calls_to_the_hub_reuse_one_connection() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/rpc/x", listener.local_addr().unwrap());
        let accepted = Arc::new(AtomicUsize::new(0));
        let count = accepted.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                count.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut stream = stream;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 {
                            return;
                        }
                        if line == "\r\n" {
                            let _ = stream.write_all(
                                b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\ncontent-type: application/json\r\n\r\n{}",
                            );
                        }
                    }
                });
            }
        });
        let started = std::time::Instant::now();
        tauri::async_runtime::block_on(async {
            for _ in 0..10 {
                let body = super::client()
                    .unwrap()
                    .get(&url)
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap();
                assert_eq!(body, "{}");
            }
        });
        eprintln!(
            "10 lời gọi: {} kết nối, {:?}",
            accepted.load(Ordering::SeqCst),
            started.elapsed()
        );
        // hyper trả kết nối về pool không đồng bộ sau khi đọc xong body, nên lời gọi kế có lúc mở thêm một kết nối
        // (CI từng thấy 2). Không dùng chung client thì là 10.
        assert!(accepted.load(Ordering::SeqCst) <= 3);
    }
}
