# Review bảo mật: điều khiển từ xa phiên CLI (specs/010, T091)

Ngày: 2026-10-23 · Nhánh: `ai/CLI010B` · Phạm vi: worker (`internal/terminal`, `internal/remoteauth`), hub (`modules/terminal`),
`hive attach`. Không gồm PWA, Web Push, xem cùng (T070–T081, ngoài phạm vi).

Cách làm: đọc code theo mô hình đe doạ ở `plan.md` (hub không được tin: hub hay người đứng giữa đường HTTP có mọi gói đi
qua hub), rồi viết test đóng vai từng kẻ tấn công. Review này do agent đọc code và chạy test; chưa có người review lại và
chưa chạy công cụ quét tự động (`/security-review`).

## Kết quả

Không thấy lỗ hổng cần sửa ngay. Có 6 điểm rủi ro còn lại, ghi ở mục "Phát hiện" kèm mức và việc tiếp theo.

| Test | Lệnh | Kết quả |
|---|---|---|
| `worker/internal/terminal/attack_test.go` (mới, chỉ chạy trên Unix) | `go test -race -count=3 ./internal/terminal/ ./internal/remoteauth/` trong `golang:1.27.2` (Linux, Docker) | xanh |
| `apps/hub/src/terminal-attack.db.test.ts` (mới) | `vitest run --project db src/terminal-attack.db.test.ts` | 11/11 xanh |

## Bảng đe doạ và test

| Kẻ tấn công / ca | Chặn ở đâu | Test |
|---|---|---|
| Passkey giả chữ ký, sai origin, sai rpId, thiếu UV, khoá lạ, người khác, counter lùi | worker `remoteauth.VerifyAuth` | `TestAttackPasskeyControl` |
| Phát lại yêu cầu (cùng nonce), kể cả gắn sang `connId` khác | worker, bảng nonce trong bộ nhớ | `TestAttackPasskeyControl` |
| Lệch giờ quá ±120 s | worker `remoteauth.Skew` | `TestAttackPasskeyControl` |
| Hub đổi `connId` sau khi điện thoại ký | worker, `connId` nằm trong challenge | `TestAttackPasskeyControl` |
| Hub gõ thay (không có khoá phiên): phát lại gói nhập, đoán khoá, dùng MAC của kết nối khác | worker HMAC + `seq` tăng dần | `TestAttackHubWithoutSessionKey`, `TestControlRejectsBadInput` |
| Hub dùng `resumeToken` lấy quyền | worker cấp lại nhưng hub không có khoá nhập nên không gõ được | `TestAttackHubWithoutSessionKey` |
| TOTP: sai, dùng lại, khoá 5 lần sai và gấp đôi, khởi động lại không mở khoá, hub HTTPS, chính sách tắt, thiếu `auth` | worker `TOTPStore` | `TestAttackTOTP` |
| `term_start`: `subdir` thoát qua symlink, mã rỗng, thiếu `auth`, máy đã tắt | worker `verifyStart` | `TestAttackStart` |
| Hub tự nhận chủ máy mới | worker xoá thiết bị đã ghép, không đặt lại khoá TOTP | `TestAttackHubClaimsOwner`, `TestOwnerChangeRemovesDevices` |
| Hub bật từ xa hay bật lại máy dùng chung | worker không có gói bật từ hub; `welcome` dùng chung tắt | `TestAttackHubClaimsOwner`, `TestRemoteHubOnlyDisables`, `TestRemoteSharedMachine` |
| Ghép thiết bị: tag sai, người khác, không xác nhận tại máy | worker `HandlePair` | `TestPairRejected`, `TestPairDeniedAtMachine` |
| Người tổ chức khác | hub RLS + `withTenant` | `terminal-attack` "tổ chức khác" |
| Người cùng đội: dùng `resumeToken` của chủ, gõ, xin quyền | hub `ws.ts` đóng 4403, từ chối `AUTH_STALE` | `terminal-attack` "người cùng đội", "quản trị đội" |
| Máy dùng chung | hub không ghi phiên, `MACHINE_SHARED` ở `remote.start` | `terminal-attack` "máy dùng chung" |
| Vé WS dùng lại, hết hạn, đoán bừa; vé Leader mở phiên máy cá nhân | hub `ticket.ts` (một lần, 256 bit, có hạn), hai loại vé không thay nhau | `terminal-attack` "vé /ws/terminal" |
| Trang lạ (CSWSH): Origin lạ, thiếu, `null`, giả host | hub `originAllowed`, đốt vé trước khi xét Origin | `terminal-attack` "Origin…" |
| Chủ máy gõ khi chưa có quyền | hub không chuyển `term_input` | `terminal-attack` "gói giả" |
| Máy khác cùng tổ chức gửi `term_granted`/`term_event`/`term_revoked`/`term_output` cho phiên không phải của nó | hub `ownLive`, ghi output theo đúng `machine_id` | `terminal-attack` "gói giả" |
| Mã TOTP khi chính sách tổ chức tắt (`control`, nối lại, `remote.start`) | hub chặn trước khi gửi tới máy | `terminal-attack` "chính sách tắt mã" |
| Mã TOTP nằm lại trong DB hay log của hub | hub chỉ chuyển tiếp | `terminal-attack` "mã Authenticator không lưu" (dò mọi bảng schema `hive` và log) |

## Phát hiện

### A. Phát lại passkey sau khi worker khởi động lại — Thấp, còn mở

Bảng nonce chỉ nằm trong bộ nhớ (`remoteauth/verify.go`, `Verifier.nonces`). Passkey đồng bộ (iCloud, Google) luôn có
`signCount = 0` nên không có counter để bắt phát lại. Kẻ giữ hub có thể lưu một yêu cầu hợp lệ, chờ worker khởi động lại
(cập nhật, mất điện) trong ±120 s rồi gửi lại.

- `control`: hub được cấp quyền nhưng không có khoá riêng của `ephPub` nên không gõ được; chỉ đá điện thoại ra (từ chối
  dịch vụ).
- `term_start`: máy mở lại đúng phiên đã ký (CLI, thư mục, lời nhắc) thêm một lần. Bật "Hỏi tại máy" (`confirmOnMachine`)
  thì chủ máy thấy và từ chối được.

Việc tiếp: hoặc ghi nonce đã dùng xuống đĩa cạnh khoá TOTP, hoặc từ chối `ts` trước lúc tiến trình khởi động. Chỗ tạo
`Verifier` ở `worker/cmd/hive-worker/local.go`, nằm ngoài phạm vi sửa của CLI010B.

### B. Mã TOTP không ràng buộc nội dung yêu cầu — Chấp nhận theo thiết kế

Mã 6 số không ký `ephPub`, `prompt` hay `subdir`. Hub hay người đứng giữa đường HTTP cầm được mã còn hạn có thể thay
`ephPub` của mình vào, rồi gõ được vào phiên. Đây là lý do TOTP chỉ là đường lui cho hub HTTP (D15): tắt khi hub HTTPS trừ
khi chủ máy bật `totpOnHttps`, tổ chức tắt được bằng chính sách, khoá sau 5 lần sai, mỗi mã dùng một lần. `docs/hive-cli.md`
ghi rủi ro này cho người dùng.

### C. Hub chọn mức quyền và model khi mở phiên — Thấp, chấp nhận

`term_start.permissions` và `model` do hub gắn theo chính sách tổ chức, không nằm trong chữ ký. Model chỉ nhận theo mẫu
tên cố định. Máy chỉ hạ `full` về `workspace`, không bao giờ nâng, trừ khi chủ máy bật `allowFullAccess` tại máy.

### D. Hub tự nhận chủ máy mới qua `welcome` — Thấp, còn mở

Worker tin `welcome.owner`: đổi chủ thì xoá mọi thiết bị đã ghép (từ chối dịch vụ). Khoá TOTP không bị đặt lại nên kẻ giữ
hub vẫn phải có mã. Việc tiếp: hỏi tại máy trước khi xoá thiết bị khi chủ đổi.

### E. Hub thấy `resumeToken` — Thấp, chấp nhận

Hub chuyển `resumeToken` nên dùng được nó để chiếm quyền gõ của điện thoại, nhưng không gõ được vì không có khoá nhập.
Kết quả là từ chối dịch vụ, cùng mức với việc hub ngừng chuyển gói.

### F. Vé WS nằm trên query string — Thấp, chấp nhận

Proxy ngược có thể ghi URL vào log. Vé dùng một lần (bị đốt cả khi Origin sai), hạn `TERMINAL_TICKET_TTL_SEC`, gắn đúng
người, đúng phiên, đúng loại, nên vé lấy từ log hầu như đã hết hiệu lực.

## Ghi chú review phía hub

- Xem output chỉ cần phiên đăng nhập web (có vé), không cần passkey: ai lấy được phiên web của chủ máy thì xem được
  output của chủ máy, nhưng không gõ được. Output đi qua `maskSecrets` trước khi lưu.
- Sau `term_exit`, khung `control` vẫn được chuyển tới worker (hub chỉ đặt `canControl = false`). Worker từ chối vì
  phiên đã đóng, nên đây không phải lỗ hổng.
- Hub không giới hạn số khung `control` của chủ máy. Đoán mã TOTP vẫn bị worker khoá sau 5 lần sai.
