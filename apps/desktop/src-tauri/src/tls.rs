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
pub fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            ensure();
            reqwest::Client::builder()
                // Hub không tới được thì báo sớm, không đợi hết thời hạn của cả lời gọi.
                .connect_timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_default()
        })
        .clone()
}

#[cfg(test)]
mod tests {
    #[test]
    fn builds_a_client_without_the_updater_having_run() {
        // Trước đây panic: "No rustls crypto provider is configured".
        let _ = super::client();
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
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }
}
