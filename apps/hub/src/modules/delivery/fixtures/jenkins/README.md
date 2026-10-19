# Fixture Jenkins

Toàn bộ file ở đây viết tay theo tài liệu công khai của Jenkins (remote access API, plugin Pipeline Stage View,
`InputAction`) **[Suy luận]**. Chưa lấy từ Jenkins eHospital. Task T007 đối chiếu với Jenkins thật; khác thì người điều
phối thêm task sửa client (`clients/jenkins.ts`) và fixture. Tên người, URL, mã commit trong fixture là giả.

Chỗ cần đối chiếu:

| File | Điều chưa kiểm |
|---|---|
| `me.json` | Với Keycloak OIDC, `id` là username Keycloak hay mã nội bộ của Jenkins |
| `job-parameterized.json` | Dạng `property[parameterDefinitions[...]]` qua `?tree=`; `choices`, `defaultParameterValue` theo từng kiểu tham số |
| `builds.json`, `build-success.json` | Thứ tự `actions` (ParametersAction, CauseAction, BuildData); `lastBuiltRevision.branch[].name` có `refs/remotes/origin/` không; cause khi người dùng OIDC bấm |
| `wfapi-describe.json` | Trạng thái giai đoạn của plugin Pipeline Stage View (`PAUSED_PENDING_INPUT`…) |
| `wfapi-pending-input-actions.json` | Dạng `id`, `inputs`, `proceedUrl`, `abortUrl` |
| `queue-item-*.json` | `executable` có ngay khi build bắt đầu; mục bị huỷ có `cancelled: true` |
| `progressive-log.txt` | Test tự tính độ dài byte cho `X-Text-Size`, không lấy từ file (autocrlf đổi kích thước file) |
| `forbidden-crumb.txt` | Lời nhắn 403 khi thiếu crumb; Jenkins eHospital có đòi crumb khi POST bằng API token không |

Cách gọi chưa kiểm trên Jenkins thật, nằm trong `clients/jenkins.ts`:
- `buildWithParameters` gửi tham số bằng thân form, không để trên query;
- `input/<id>/proceed` kèm tham số gửi `json={"parameter":[…]}`.
