# xDev Hive desktop

App Tauri 2 nhẹ: biểu tượng trên khay hệ thống, worker Go (`hive-worker`) chạy nền làm sidecar, cửa sổ web trỏ tới
hub mà máy đã đăng ký. App không chứa giao diện web của hub; nó chỉ có cửa sổ đăng ký máy (`src/`).

## Chạy tại máy

Cần Node 24+, pnpm, Go và Rust.

```sh
pnpm --filter @xdev-hive/desktop app:dev
```

`tauri dev` và `tauri build` tự chạy `pnpm prepare:app`. Lệnh này dựng giao diện đăng ký vào `dist/` và dựng
`hive-worker` vào `src-tauri/binaries/hive-worker-<target triple>`. Cả hai thư mục không commit.

Giao diện đăng ký lấy logo từ `docs/design-system/assets/logos/xdev-hive-icon.svg` và sinh `dist/tokens.css`
từ `docs/design-system/tokens.json` khi build, dùng cùng nguồn nhận diện với web.

Thử với cấu hình worker riêng, không đụng cấu hình thật của máy:

```sh
HIVE_WORKER_CONFIG=/tmp/hive-test/worker.json pnpm --filter @xdev-hive/desktop app:dev
```

## Cách app làm việc

- **Khởi động:** app gọi `hive-worker config --json`.
  - Máy đã đăng ký: app chạy `hive-worker run --status-json --stdin-control` và mở cửa sổ web của hub.
  - Máy chưa đăng ký: app mở cửa sổ đăng ký.
- **Đăng ký:** nhập địa chỉ hub và token, hoặc dán lệnh `hive-worker register --hub … --token …` lấy từ web. App tự
  tách lệnh, kể cả lệnh nhiều dòng của bash, PowerShell, cmd. Token truyền cho sidecar qua biến môi trường
  `HIVE_REGISTRATION_TOKEN`, không qua tham số dòng lệnh.
- **Khay hệ thống:** dòng trạng thái của worker, Mở xDev Hive, Bật/Tắt worker, Thoát. Đóng cửa sổ chỉ ẩn vào khay;
  worker vẫn chạy.
- **Trạng thái:** worker in mỗi trạng thái kết nối thành một dòng JSON trên stdout (`connecting`, `online`,
  `disconnected`, `stopped`). Máy trạng thái ở `src-tauri/src/worker.rs`:
  - Mất kết nối quá 1 phút thì có thông báo hệ thống, mỗi lần mất chỉ báo một lần.
  - Worker thoát bất thường thì chạy lại, chờ từ 5 giây tăng dần tới 5 phút.
  - Hub từ chối máy (mã thoát 3) thì không chạy lại; app mở cửa sổ đăng ký.
- **Dừng:** app gửi dòng `stop` qua stdin; Windows không có SIGTERM nên dùng cách này cho mọi hệ điều hành. Worker chờ
  run đang chạy ghi xong kết quả, tối đa 30 giây; quá 35 giây thì app giết tiến trình. App chết đột ngột thì stdin
  đóng và worker cũng tự dừng, không chạy mồ côi.
- **Bảo mật:** lệnh của app (`parse_registration`, `register_worker`) khai báo trong `build.rs`. Capability chỉ cấp
  các lệnh này cho cửa sổ `register`. Cửa sổ web của hub là trang từ xa, không có capability nào, nên không gọi được
  lệnh của app.

## Cập nhật tự động

`tauri-plugin-updater` đã cài, nhưng `pubkey` trong `tauri.conf.json` đang để trống. Khi `pubkey` trống, app không
kiểm bản mới. Để bật:

1. Tạo cặp khoá: `pnpm --filter @xdev-hive/desktop tauri signer generate -w ~/.tauri/xdev-hive.key`. Giữ khoá riêng
   ngoài repo, ví dụ trong secret của CI.
2. Ghi khoá công khai vào `plugins.updater.pubkey` và đặt `bundle.createUpdaterArtifacts: true` trong
   `tauri.conf.json`.
3. Dựng bản phát hành với `TAURI_SIGNING_PRIVATE_KEY`. Đặt `HIVE_WORKER_VERSION` để sidecar mang đúng phiên bản.
4. Hub trả file JSON cập nhật của Tauri tại `/api/v1/desktop/updates/<os>/<arch>/<phiên bản hiện tại>`. App lấy địa
   chỉ hub từ cấu hình của máy, nên không cần ghi `endpoints` trong `tauri.conf.json`. Cấu hình `HIVE_DESKTOP_RELEASES`
   ở hub là đường dẫn file JSON hoặc URL HTTPS tới manifest phát hành; hub đọc lại tối đa mỗi 5 phút. Định dạng
   manifest theo static JSON của Tauri updater, với platform như `darwin-aarch64`, `linux-x86_64` hoặc `windows-x86_64`.
