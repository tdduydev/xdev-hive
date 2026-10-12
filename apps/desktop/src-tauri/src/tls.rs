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

/// Client HTTP cho mọi lời gọi hub của app.
pub fn client() -> reqwest::Client {
    ensure();
    reqwest::Client::new()
}

#[cfg(test)]
mod tests {
    #[test]
    fn builds_a_client_without_the_updater_having_run() {
        // Trước đây panic: "No rustls crypto provider is configured".
        let _ = super::client();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }
}
