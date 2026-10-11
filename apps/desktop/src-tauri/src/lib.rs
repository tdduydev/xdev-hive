// M0: chỉ mở cửa sổ web. Worker Go gắn làm sidecar (tauri-plugin-shell) và cập nhật tự động thêm ở M8.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("không khởi động được xDev Hive desktop");
}
