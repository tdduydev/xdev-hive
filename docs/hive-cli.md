# Lệnh `hive` và điều khiển từ xa

Hướng dẫn dùng lệnh `hive` trên máy cá nhân và điều khiển phiên agent từ điện thoại (specs/010). Thiết kế:
[architecture.md §5.4](architecture.md#54-phiên-terminal-và-điều-khiển-từ-xa-spec-010),
[ADR 0019](adr/0019-hive-cli-and-remote-sessions.md).

`hive` mở phiên agent CLI (Claude Code, Codex, Gemini) qua `hive-worker` đang chạy trên máy. Phiên được ghi lên hub
(output đã che bí mật), nên bạn xem lại và điều khiển được từ web. `hive` nói với worker qua socket nội bộ chỉ người
dùng hiện tại mở được (Unix socket 0600, Windows named pipe theo SID).

## 1. Cài

`hive` nằm cùng bản phát hành với `hive-worker`. Script cài đặt cài cả hai:

```sh
# Linux, macOS: cài vào ~/.local/bin
curl -fsSL https://github.com/tdduydev/xdev-hive/releases/latest/download/install.sh | sh -s -- --hub https://hive.example.com --token <token>
```

```powershell
# Windows: cài vào %LOCALAPPDATA%\xdev-hive\bin
irm https://github.com/tdduydev/xdev-hive/releases/latest/download/install.ps1 -OutFile "$env:TEMP\hive-install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\hive-install.ps1" -Hub https://hive.example.com -Token <token>
```

Máy dùng app desktop: vào màn **Điều khiển từ xa**, bấm **Cài lệnh hive** để đưa `hive` vào PATH.

Kiểm tra: `hive version` in phiên bản của `hive` và `hive-worker`.

## 2. Đăng nhập

Phần lớn lệnh chỉ cần worker đang chạy, không cần đăng nhập. Chỉ `--task`, `--project`, `ls --all` và `attach` vào
run hay vào phiên trên máy khác mới cần token cá nhân.

```sh
hive login                       # mở trình duyệt, xác nhận trên web
hive login --no-browser          # in URL để mở ở máy khác
hive login --with-token < token  # đọc token từ stdin (CI, máy không có trình duyệt)
hive login --hub https://hive.example.com
hive whoami
hive logout
```

- Hub lấy theo thứ tự: `--hub`, biến `HIVE_HUB_URL`, hub của lần đăng nhập trước, rồi hub mà `hive-worker` trên máy
  đã đăng ký.
- Token nằm trong keychain của hệ điều hành (mục `dev.xdev.hive`, dùng chung với app desktop). Máy không có keychain
  thì token nằm trong `hive.json` quyền 0600.

## 3. Phiên agent

```sh
hive chat                               # Claude Code trong thư mục hiện tại
hive chat --cli codex --model M
hive chat --task WEB-42                 # gắn phiên với task (cần đăng nhập)
hive run "Sửa test đang đỏ"             # như chat, gửi lời nhắc làm câu đầu
hive chat --no-record                   # không ghi lên hub; điện thoại không xem được
hive chat -- --resume                   # đối số sau -- chuyển thẳng cho CLI
```

Phím trong phiên:

| Phím | Việc |
|---|---|
| `Ctrl-]` `d` | Tách khỏi phiên; phiên chạy tiếp |
| `Ctrl-]` `t` | Giành lại quyền gõ (khi điện thoại đang gõ) |
| `Ctrl-]` `Ctrl-]` | Gửi `Ctrl-]` cho agent |

Đổi phím tiền tố bằng `--escape ctrl-a`; `--escape none` gửi mọi phím cho agent.

Quản lý phiên:

```sh
hive ls                 # phiên trên máy này
hive ls --all           # phiên đang chạy trên mọi máy của bạn (cần đăng nhập)
hive attach <id>        # gắn lại và gõ
hive attach <id> --view # chỉ xem
hive kill <id>
```

`hive attach` với id của run thì xem log và gõ chỉ dẫn; với id phiên trên máy khác thì chỉ xem.

## 4. Bật điều khiển từ xa

Mặc định tắt. Chỉ bật được tại máy (lệnh `hive` hay app desktop); hub không có lệnh bật hay thêm thiết bị.

```sh
hive remote on                          # hỏi xác nhận
hive remote roots add ~/code/web --label web
hive remote roots                       # thư mục điện thoại được mở phiên mới
hive remote roots rm <id>
hive remote status
```

Điện thoại chỉ mở phiên mới trong các thư mục đã thêm ở `roots`, và hub chỉ thấy nhãn, không thấy đường dẫn.

### Ghép điện thoại

1. Tại máy: `hive remote pair` (hoặc nút **Ghép điện thoại** trong app). Máy in mã QR, hạn 10 phút.
2. Trên điện thoại: quét mã, đăng nhập hub bằng đúng tài khoản chủ máy, tạo passkey.
3. Tại máy: bấm **Cho phép** khi được hỏi (có khoảng 50 giây).

Mã QR chứa một bí mật chỉ máy và điện thoại biết; hub không thấy nó. Nếu ai đó đổi khoá trên đường đi, máy từ chối với
lý do "Khoá của thiết bị không khớp mã ghép".

```sh
hive remote devices          # thiết bị đã ghép
hive remote devices rm <id>  # gỡ; web cũng gỡ được tại /remote/devices
```

### Dùng từ điện thoại

- `/remote`: danh sách phiên của bạn, xem trực tiếp.
- Bấm **Điều khiển** để gõ: xác thực bằng passkey (hoặc mã Authenticator, mục 6). Máy tự kiểm, rồi cấp khoá ký phím
  chỉ điện thoại và máy biết. Quyền gõ hết sau 15 phút không gõ; ở máy bấm `Ctrl-]` `t` để lấy lại ngay.
- **Mở phiên mới**: chọn máy, thư mục, CLI, lời nhắc. Máy kiểm chữ ký; bật `confirm-on-machine` thì máy hỏi trước.

### Cài đặt

```sh
hive remote set confirm-on-machine on   # hỏi tại máy trước khi mở phiên từ điện thoại
hive remote set idle-minutes 15         # thu quyền gõ khi không gõ
hive remote set detached-hours 2        # đóng phiên mở từ xa khi không ai gắn vào
hive remote set max-hours 12            # đóng phiên mở từ xa sau tổng thời gian này
hive remote set allow-full-access off   # máy hạ "full" về "workspace"
hive remote set totp-on-https off       # chỉ nhận mã Authenticator khi hub là http://
hive remote watch                       # theo dõi sự kiện, trả lời yêu cầu ghép
```

Phiên mở từ xa hết hạn thì nhận SIGHUP, 10 giây sau bị kill. Phiên `hive chat` tại máy không bị đóng theo các giới hạn
này.

Mọi việc từ xa được ghi vào `remote-audit.log` cạnh `worker.json` (quyền 0600, xoay vòng 10 MB × 5 file).

## 5. Tắt khẩn cấp

Một trong các cách:

- App desktop: nút hoặc mục trên khay **Tắt điều khiển từ xa ngay**.
- Terminal: `hive remote off`.
- Hub API: `POST /api/v1/remote/machines/{machineId}/disable`. Web hiện chưa có nút này.

Máy thu mọi quyền gõ, đóng phiên mở từ xa (SIGHUP, 10 giây sau kill), giữ phiên `hive chat`; hub đóng mọi người xem.
Bật lại chỉ làm được tại máy.

## 6. Hub chạy HTTP: mã Authenticator (TOTP)

Trình duyệt chỉ cho dùng passkey trên HTTPS (hoặc `localhost`). Hub nội bộ chạy `http://` thì dùng mã 6 số từ app
Authenticator thay passkey.

```sh
hive remote totp enroll    # in mã QR otpauth://, hỏi một mã để xác nhận
hive remote totp status
hive remote totp unlock    # mở khoá sau khi nhập sai quá nhiều lần
hive remote totp disable
```

App desktop có cùng chức năng. Khoá TOTP sinh tại máy, nằm trong `totp.json` (0600); hub không lưu khoá hay mã.

Máy chỉ nhận mã khi cả ba điều sau đúng:

- Hub là `http://`, hoặc chủ máy bật `totp-on-https`.
- Chính sách tổ chức cho phép (`remote.totpFallback` trong chính sách agent, mặc định `true`; quản trị viên đặt qua API
  `/api/v1/policies`, web chưa có ô này).
- Máy chưa bị khoá: 5 lần sai thì khoá 5 phút, mỗi lần khoá tiếp gấp đôi, tối đa 1 giờ. Khởi động lại worker không mở
  khoá.

### Rủi ro khi dùng hub HTTP

**Chỉ dùng trong mạng tin cậy.** Trên HTTP:

- Output phiên, mã TOTP và mọi gói đi qua mạng không mã hoá. Ai nghe được mạng thì đọc được output.
- Mã 6 số không ký nội dung yêu cầu (khoá ký phím, lời nhắc, thư mục). Hub, hay người đứng giữa đường HTTP, cầm được
  một mã còn hạn có thể dùng nó trước bạn để lấy quyền gõ hoặc mở phiên khác
  ([security-review.md](../specs/010-hive-cli-remote/security-review.md) mục B). Mỗi mã chỉ dùng một lần, nên lúc đó
  yêu cầu của bạn sẽ bị từ chối: gặp lỗi mã đã dùng mà bạn chưa dùng thì tắt khẩn cấp ngay (mục 5).
- Passkey an toàn hơn vì chữ ký gắn với kết nối và khoá ký phím. Có thể thì bật HTTPS cho hub (xem
  [self-hosting.md](self-hosting.md)) rồi tắt TOTP.

Tổ chức không chấp nhận rủi ro này thì đặt `remote.totpFallback` là `false`: máy từ chối mọi mã, web báo cần bật HTTPS.

## 7. Giới hạn

| Mục | Giá trị |
|---|---|
| Phiên ghi trên hub mỗi máy | 8 |
| Người xem mỗi phiên | 16 |
| Vòng đệm xem lại trên hub | 512 KiB mỗi phiên; cũ hơn thì đọc từ bản ghi |
| Băng thông xem | 512 KiB/s mỗi người xem, 2 MiB/s mỗi máy; xem chậm thì nhảy tới đuôi 128 KiB |
| Giữ quyền gõ khi rớt mạng | 2 phút |
| Vé mở kết nối xem | 60 giây, dùng một lần |
| Mã QR ghép | 10 phút |
| Đệm output chưa lên hub | 32 MB mỗi phiên trên đĩa; quá thì báo khoảng trống |

## 8. Chưa có

Ngoài phạm vi từ 2026-10-23: cài web thành ứng dụng (PWA đầy đủ), thông báo đẩy, tín hiệu "agent cần bạn", chế độ
cho đội xem phiên.
