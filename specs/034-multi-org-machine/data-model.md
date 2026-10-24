# Data Model: Một máy làm việc cho nhiều tổ chức

## 1. `registrations.json` (máy, mới)

Đường dẫn: `UserConfigDir/xdev-hive/registrations.json`. Quyền 0600. Không chứa token.

```json
{
  "version": 1,
  "machineLimit": 4,
  "registrations": [
    {
      "id": "reg_legacy",
      "legacy": true,
      "hubUrl": "https://hive.a.vn",
      "orgId": "0b6f…",
      "orgName": "Công ty A",
      "label": "Công ty A",
      "color": "teal",
      "machineId": "ha-laptop",
      "configPath": "C:/Users/ha/AppData/Roaming/xdev-hive/worker.json",
      "dataDir": "C:/Users/ha/AppData/Local/xdev-hive/worker",
      "isolation": "shared_user",
      "limit": 3,
      "weight": 1,
      "enabled": true,
      "discloseCoTenancy": false,
      "createdAt": "2026-10-23T08:00:00Z"
    },
    {
      "id": "reg_k3j9x2qa",
      "legacy": false,
      "hubUrl": "https://hive.b.vn",
      "orgId": "7c21…",
      "orgName": "Công ty B",
      "label": "Khách hàng B",
      "color": "amber",
      "machineId": "ha-laptop-b",
      "configPath": "C:/Users/ha/AppData/Roaming/xdev-hive/orgs/reg_k3j9x2qa/worker.json",
      "dataDir": "C:/Users/ha/AppData/Local/xdev-hive/worker/orgs/reg_k3j9x2qa",
      "isolation": "shared_user",
      "limit": 2,
      "weight": 1,
      "enabled": true,
      "discloseCoTenancy": false,
      "createdAt": "2026-10-24T02:00:00Z"
    }
  ]
}
```

| Trường | Kiểu | Ràng buộc |
|---|---|---|
| `version` | số | 1 |
| `machineLimit` | số | 1..64; thiếu thì cách tính hiện có (`main.go`) |
| `id` | chuỗi | `reg_legacy` hoặc `reg_[a-z2-7]{8}`; duy nhất |
| `legacy` | bool | Tối đa một mục `true` |
| `hubUrl` | URL | Đã chuẩn hoá (không `/` cuối) |
| `orgId` | uuid | Cặp (`hubUrl`, `orgId`) duy nhất (FR-004) |
| `orgName`, `label` | chuỗi | ≤ 80 ký tự. `label` chỉ trên máy |
| `color` | chuỗi | Một trong bảng màu nhãn của app |
| `machineId` | chuỗi | Tên máy gửi hub (`hello.machineId`) |
| `configPath` | đường dẫn | `worker.json` của đăng ký |
| `dataDir` | đường dẫn | Thư mục dữ liệu của đăng ký |
| `isolation` | `shared_user` \| `separate_user` | Mặc định `shared_user` |
| `limit` | số | 0..`machineLimit`; 0 là tạm ngừng nhận việc |
| `weight` | số | 1..10 |
| `enabled` | bool | `false` thì không mở kênh |
| `discloseCoTenancy` | bool | US8 kịch bản 3 |

Luật:

- Không có file mà có `worker.json` ở đường dẫn mặc định: tạo file với một mục `reg_legacy` (FR-080).
- Có `HIVE_WORKER_CONFIG` hay `--config`: không đọc file này (FR-082).
- Ghi file theo kiểu ghi tạm rồi đổi tên; khoá bằng `instancelock` của worker, lệnh CLI chạy khi worker đang chạy thì
  gửi qua socket cục bộ.

## 2. Thư mục cấu hình của đăng ký (máy)

`UserConfigDir/xdev-hive/orgs/<id>/`:

| File | Như hiện nay ở | Ghi chú |
|---|---|---|
| `worker.json` | `config.Config` | `hubUrl`, `machineId`, `machineToken`, `teamId` |
| `projects.json` | `projects.Store` | Một thư mục chỉ thuộc một đăng ký (FR-032) |
| `remote.json` | `remoteauth` | Thiết bị ghép theo đăng ký |
| `gitgroups.json` | `gitgroups` | |
| `policy.json` | mới | Chính sách đã biết từ `welcome.policy` lần cuối |
| `secrets.json`, `secrets-policy.json` | spec 031 | Phạm vi đăng ký |
| `hub-ca.pem` | `hubtls` | Tuỳ chọn |

Đăng ký cũ giữ các file này cạnh `worker.json` cũ.

## 3. `accounts.json` (máy, mở rộng)

Thêm trường tuỳ chọn cho mỗi tài khoản:

| Trường | Kiểu | Nghĩa |
|---|---|---|
| `registrations` | chuỗi[] | Rỗng hoặc thiếu: dùng chung. Có giá trị: chỉ các đăng ký này |

Bản cũ bỏ qua trường lạ (`encoding/json`), nên rollback không hỏng.

## 4. Thư mục trạng thái CLI (máy, mới)

`~/.xdev-hive/cli-state/<accountId>/<registrationId>/`. Đăng ký cũ không dùng thư mục này: nó dùng `ConfigDir` của gói
như hiện nay, để run đang có không đổi trạng thái.

## 5. Bảng phiên run (bộ nhớ worker, mới)

`map[sessionToken]{registrationId, runId}`. Xoá khi run kết thúc. Không ghi đĩa.

## 6. Hub

| Bảng / JSON | Thay đổi |
|---|---|
| `machines` | Cột `co_tenancy_note text null` (≤ 200 ký tự), chỉ chủ máy đặt qua kênh worker |
| Chính sách agent của tổ chức (JSON có sẵn) | `aiAccountSharing: "allow" \| "dedicated"`, `machineIsolation: "shared_user" \| "separate_user"` |
| `runs.rejectedBy` | Không đổi; `machine_busy` không ghi vào |

Không bảng mới. Không bảng nối tổ chức.

## 7. Keychain desktop

| Dịch vụ | Tài khoản | Giá trị |
|---|---|---|
| `dev.xdev.hive` | `<hubUrl>#<orgId>` (mới) | Token cá nhân |
| `dev.xdev.hive` | `<hubUrl>` (cũ) | Đọc một lần, chuyển sang khoá mới rồi xoá |
