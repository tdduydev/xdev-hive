# Contract: lệnh `hive-worker` cho nhiều đăng ký

Mọi lệnh in JSON khi có `--json`. Lỗi in tiếng Việt ra stderr, mã thoát khác 0.

## `hive-worker registrations list`

```json
{
  "machineLimit": 4,
  "registrations": [
    {
      "id": "reg_legacy", "label": "Công ty A", "hubUrl": "https://hive.a.vn", "orgName": "Công ty A",
      "machineId": "ha-laptop", "isolation": "shared_user", "limit": 3, "weight": 1, "enabled": true,
      "legacy": true, "status": "online", "running": 1, "outboxPending": 0
    }
  ]
}
```

`status`: `online` | `offline` | `revoked` | `incompatible` | `policy_unmet` | `disabled`.

## `hive-worker registrations add`

```
hive-worker registrations add --hub URL --token hwr_… [--label TEXT] [--machine NAME] [--limit N]
```

- Gọi `fleet.register` như `hive-worker register` hiện nay, với khoá máy mới.
- Trùng (hub, tổ chức) với đăng ký có sẵn: mã thoát 3, stderr "Máy đã đăng ký với tổ chức này. Dùng `registrations
  reregister`."
- Đã đủ số đăng ký tối đa: mã thoát 4.
- Thành công: in mục mới. Worker đang chạy thì nhận qua socket và mở kênh ngay.

## `hive-worker registrations reregister --registration ID --token hwr_…`

Thay token và khoá máy của đăng ký có sẵn. Giữ thư mục.

## `hive-worker registrations set --registration ID [--label] [--limit] [--weight] [--isolation] [--enabled] [--disclose]`

## `hive-worker registrations remove --registration ID [--outbox flush|export=PATH|drop] [--wait|--cancel-runs]`

Theo FR-063. In danh sách đã xoá.

## `hive-worker registrations set-limit --machine N`

Đặt `machineLimit`.

## Cờ `--registration ID` trên lệnh có sẵn

`projects`, `accounts`, `outbox`, `memory`, `context`, `ssh`, `config`, `secrets` (031). Thiếu cờ:

| Số đăng ký | Hành vi |
|---|---|
| 0 hoặc 1 | Dùng đăng ký duy nhất (như hiện nay) |
| ≥ 2 | Lệnh đọc: gộp, mỗi dòng có `registration`. Lệnh ghi: lỗi "Máy có nhiều tổ chức. Thêm --registration." |

## `hive-worker accounts assign --account ID --registrations reg_a,reg_b|shared`

Ghi `registrations` của tài khoản (FR-040).

## Biến môi trường trong run

| Biến | Nghĩa |
|---|---|
| `HIVE_HUB_URL`, `HIVE_RUN_TOKEN` | Như hiện nay; của đăng ký sở hữu run |
| `HIVE_RUN_SESSION` | Mới. Mã phiên cho socket cục bộ (research D6) |
| `HIVE_REGISTRATION` | Mới. Id đăng ký, để `hive` CLI in nhãn; không dùng để xác thực |
