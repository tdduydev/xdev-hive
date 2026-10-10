# HTTPS cho cổng LAN của hub

Cổng LAN (`deploy/compose.lan.yaml`) trước đây là `http://<HOST_IP>:7780`: trình duyệt không coi đó là secure context
(thiếu `crypto.randomUUID`, clipboard, service worker, passkey) và token, mật khẩu đi không mã hoá. Giờ Caddy của cổng LAN
phục vụ HTTPS bằng CA nội bộ của chính nó.

## Cấu hình (`deploy/.env`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `HIVE_LAN_HOSTS` | bắt buộc | Tên và địa chỉ IP máy gõ vào, ví dụ `192.0.2.52,my-server`. Mỗi mục có một chứng chỉ (IP hay tên đều được) |
| `HIVE_LAN_HTTPS_PORT` | `7743` | Cổng HTTPS trên máy chủ |
| `HIVE_LAN_PORT` | `7780` | Cổng http cũ |
| `HIVE_LAN_HTTP_REDIRECT` | `1` | `1`: trang trình duyệt (GET ngoài `/api`, `/mcp`) ở cổng http chuyển sang HTTPS. `0`: không chuyển. `/api` và `/mcp` vẫn trả lời trên http để máy còn lưu `http://` chưa gãy (fetch bỏ header Authorization khi redirect sang cổng khác) |
| `HIVE_LAN_BIND` | `0.0.0.0` | Giao diện mạng để publish |

Khi muốn đóng hẳn cổng http (mọi máy đã chuyển), bỏ dòng `7780` trong `ports` của `compose.lan.yaml`.

## Root CA

Caddy giữ root CA trong volume `lan-caddy-data` (`/data/caddy/pki/authorities/local`), nên deploy không đổi CA. Tải:

- `https://<HOST>:7743/ca.crt` (hoặc `http://<HOST>:7780/ca.crt` cho điện thoại chưa tin gì); `/ca.sha256` là SHA-256 của nó.
- Đối chiếu SHA-256 với `hive-status` trên máy hub (dòng `lan https`) trước khi tin.

Cài tin cậy (cho trình duyệt):

- **Windows**: `certutil -addstore -f Root xdev-hive-ca.crt` (PowerShell quản trị), hoặc chạy file `.crt` → Install → Local Machine → Trusted Root Certification Authorities.
- **macOS**: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain xdev-hive-ca.crt`.
- **Ubuntu/Debian**: chép vào `/usr/local/share/ca-certificates/xdev-hive-ca.crt` rồi `sudo update-ca-certificates`. Firefox và Chrome Snap có kho riêng: nhập trong Settings → Certificates.
- **iOS**: mở `/ca.crt` bằng Safari → cho phép tải hồ sơ → Cài đặt → Đã tải hồ sơ → Cài; rồi Cài đặt → Cài đặt chung → Giới thiệu → Cài đặt tin cậy chứng nhận → bật cho "xDev Hive LAN CA".
- **Android**: tải `/ca.crt` → Cài đặt → Bảo mật → Mã hoá & thông tin xác thực → Cài chứng chỉ → Chứng chỉ CA.

## App desktop và hive-mcp: ghim CA, không cài vào hệ thống

Không cần cài CA vào hệ điều hành cho app và hive-mcp. Khi địa chỉ hub là `https://` mà hệ thống không tin chứng chỉ, app lấy
`/ca.crt`, hiện SHA-256 và hỏi một lần. Đồng ý thì `config.json` lưu `hub.ca` (PEM) và `hub.caSha256`; từ đó mọi request tới hub
đó (app, runner, hive-mcp đọc cùng `config.json`) kiểm chứng chỉ với CA này, chỉ với hub này. Kiểm chứng chứng chỉ không bị tắt ở đâu cả.
Nếu `hub.ca` không khớp `hub.caSha256` thì bị bỏ qua (không tin gì).

## Máy đang lưu `http://`

Hub báo cổng HTTPS ở header `x-hive-lan-https-port` trên `/api/me` (từ `HIVE_LAN_HTTPS_PORT`). App desktop đang lưu `http://`
thấy header này (lúc mở và mỗi 10 phút) sẽ hỏi xác nhận CA, thử token trên địa chỉ mới rồi đổi `hub.url` sang
`https://<cùng host>:<cổng>`. Token giữ nguyên. Từ chối thì app giữ `http://` đến lần mở sau.

## Xoay CA

1. Dừng dịch vụ `lan`, xoá volume: `docker compose -p xdev-hive -f deploy/compose.yaml -f deploy/compose.lan.yaml rm -sf lan && docker volume rm xdev-hive_lan-caddy-data`.
2. Chạy deploy: Caddy tạo root CA mới (SHA-256 mới ở `hive-status`).
3. Mọi máy tin CA cũ phải tin CA mới; app desktop sẽ hỏi lại vì CA đã ghim không còn khớp.
Đổi `HIVE_LAN_HOSTS` thì chỉ cấp thêm chứng chỉ, CA giữ nguyên. Chứng chỉ lá Caddy tự gia hạn.

## Kiểm tra sau deploy

`hive-deploy` tự chạy kiểm tra này và ghi cảnh báo (không rollback) nếu lỗi; `hive-status` in lại. Bằng tay:

```sh
curl -sk https://<HOST>:7743/ca.crt -o hive-ca.crt          # chỉ để đọc chứng chỉ công khai
sha256sum <(grep -v -- '-----' hive-ca.crt | base64 -d)     # so với /ca.sha256 và hive-status
curl --cacert hive-ca.crt https://<HOST>:7743/api/health     # {"ok":true,…}
```
