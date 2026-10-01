# 27a. Chính sách agent theo dự án

Hub giữ một chính sách mặc định cho cả hub và một chính sách riêng cho từng dự án. Máy nhận chính sách qua heartbeat. Runner ép chính sách khi dựng lệnh cho một run. Cấp dưới chỉ siết thêm, không nới: chính sách của dự án, cấu hình gói trên máy.

Chia làm hai task:
- **R-27a-1**: core, hub, giao diện.
- **R-27a-2**: runner. Phụ thuộc R-27a-1.

## Mô hình (packages/core/src/agent-policy.ts, chạy được trên trình duyệt)

```ts
export const AUTONOMY = ["read", "propose", "edit", "full"] as const;   // tăng dần
export const NETWORK = ["off", "allowlist", "open"] as const;            // tăng dần
export interface AgentPolicy {
  /** Model được dùng theo loại agent (claude, codex, gemini). Không có hoặc []: model nào cũng được. */
  models: Partial<Record<AgentKind, string[]>>;
  /** Mức cao nhất một run được làm. */
  autonomy: Autonomy;
  /** allow: host, .domain hoặc host:port như container.allow của gói; chỉ dùng khi mode là allowlist. */
  network: { mode: NetworkMode; allow: string[] };
  /** Tên MCP server được bật thêm ngoài xdev-hive (xdev-hive luôn bật). null: mọi server. */
  mcp: string[] | null;
}
export const OPEN_POLICY: AgentPolicy;   // models {}, full, open, mcp null: hub chưa đặt gì thì không đổi gì
export function tighten(base: AgentPolicy, over: Partial<AgentPolicy> | null): AgentPolicy;
export function effectivePolicy(hub: AgentPolicy, project: Partial<AgentPolicy> | null): AgentPolicy; // = tighten
```

`tighten` cho kết quả không bao giờ lỏng hơn `base`:
- **models**: cả hai cùng có danh sách thì lấy giao. Một bên rỗng thì lấy bên kia. Giao rỗng thì không model nào được dùng, và runner báo lỗi.
- **autonomy**: lấy mức thấp hơn.
- **network**: lấy mode thấp hơn. Hai bên đều là allowlist thì allow là giao. Bên còn lại là open thì giữ allow của bên allowlist.
- **mcp**: lấy giao, trong đó null nghĩa là mọi server.

## Hub (R-27a-1)

- **Lưu trữ**: cạnh team policy (policy.get / policy.set) trong cùng bảng settings, key `agentPolicy`. Lưu dạng `{ hub: AgentPolicy, projects: Record<string, Partial<AgentPolicy>> }`, kèm updatedAt và updatedBy.
- **Method**:
  - `agentPolicy.get {}` (viewer) trả `{ hub, projects, effective: Record<project, AgentPolicy> }`, chỉ gồm các dự án người gọi thấy.
  - `agentPolicy.set { project: string | null, policy }`. Với `project: null` (mặc định của hub) cần admin hub. Với một dự án cần quyền `projectSettings` của dự án đó. `policy: null` xoá phần riêng của dự án.
  - Zod kiểm từng trường: model là chuỗi 1–80 ký tự `[\w.:/-]`, mỗi loại tối đa 20 model; allow theo regex của container.allow; mcp là tên `[\w-]{1,40}`, tối đa 20 tên.
  - Ghi audit. Phát event để webhook báo khi chính sách đổi.
- **Heartbeat**: `machines.heartbeat` trả thêm `agentPolicy: { hub, projects }`, chỉ gồm các dự án máy báo có. App cũ bỏ qua trường này.
- **Giao diện**: trang *Chính sách* của Web Admin có thêm phần "Agent":
  - mặc định của hub;
  - mỗi dự án một dòng: model theo loại (ô nhập, cách nhau bằng dấu phẩy), mức tự chủ, mạng và danh sách host, MCP;
  - cột "Hiệu lực" cho thấy kết quả sau khi gộp.

  Người quản trị dự án sửa được dòng của dự án mình. Chuỗi giao diện thêm vào vi.ts và en.ts.
- **Test**:
  - `packages/core/test/agent-policy.test.ts`: tighten từng trường, kết quả không bao giờ lỏng hơn mặc định.
  - Test hub ở `packages/core/test` hoặc `apps/web/test`:
    - admin đặt được mặc định của hub;
    - lead đặt được chính sách của dự án mình nhưng không đặt được dự án khác, cũng không đặt được mặc định của hub;
    - member bị từ chối;
    - heartbeat mang chính sách của đúng các dự án máy có.

## Runner (R-27a-2)

Runner (apps/desktop/src/main/runner) giữ `agentPolicy` của heartbeat cuối cùng. Ở chế độ local thì dùng OPEN_POLICY. Khi chọn gói và dựng lệnh cho một run của dự án P, runner lấy `pol = effectivePolicy(hub, projects[P])`.

1. **Gói hợp lệ** (`policyBlocks(profile, pol)`: trả về lý do, hoặc null nếu gói dùng được). Gói bị chặn thì runner bỏ qua như gói hết quota, và ghi lý do vào log run. Không còn gói nào dùng được thì run lỗi với khoá `errors.policyNoProfile` (vars: lý do của từng gói).
   - **model**: `pol.models[kind]` có danh sách mà gói đặt model ngoài danh sách thì chặn. Model của gói đọc từ args: `--model X`, `--model=X`, `-m X`. Gói không đặt model thì thêm `--model <model đầu tiên của danh sách>`.
   - **mạng**: `pol.network.mode` khác `open` mà gói không chạy trong container thì chặn, vì ngoài container mạng không ép được. Gói chạy trong container thì:
     - `off`: chỉ cho tới API của vendor và hub, như container restricted không có allow thêm;
     - `allowlist`: container.allow chỉ giữ các mục có trong `pol.network.allow`;
     - nếu container của gói đang `network: "open"` mà chính sách không phải `open` thì ép thành `restricted`.
2. **Mức tự chủ** (`applyAutonomy(kind, args, level)` trong `command.ts`): mức dùng là mức thấp hơn giữa chính sách và mức gói tự đặt. Hàm bỏ các cờ quyền có sẵn trong args rồi thêm cờ của mức dùng. Gói đặt mức thấp hơn chính sách thì giữ mức của gói.

   | mức | claude | codex (`exec`) | gemini |
   |---|---|---|---|
   | read | `--permission-mode plan`, Hive chỉ đọc (readOnly) | `--sandbox read-only`, Hive chỉ đọc | `--approval-mode plan`, Hive chỉ đọc |
   | propose | `--permission-mode plan`, Hive ghi được (đề xuất, memory, task) | `--sandbox read-only` | `--approval-mode plan` |
   | edit | `--permission-mode acceptEdits` (như hiện nay) | `--sandbox workspace-write` (như hiện nay) | `--approval-mode auto_edit` (như hiện nay) |
   | full | `--permission-mode bypassPermissions` | `--sandbox danger-full-access` | `--approval-mode yolo` |

   Cờ bị bỏ:
   - claude: `--permission-mode`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`;
   - codex: `--sandbox`, `-s`, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`;
   - gemini: `--approval-mode`, `-y`, `--yolo`.

   Mức gói tự đặt đọc từ chính các cờ đó. Ví dụ `plan` là read, `acceptEdits` là edit, `bypassPermissions` hay `--dangerously-skip-permissions` là full. Cờ không nhận ra thì coi là edit.

   Run review của gói `readOnly` vẫn là read như hiện nay.
3. **MCP**:
   - claude: danh sách server trong `--mcp-config` (`runMcpServers`) chỉ giữ xdev-hive và các tên có trong `pol.mcp`.
   - gemini: thêm `--allowed-mcp-server-names` với đúng danh sách đó.
   - codex: với mỗi server bị chặn, thêm `-c mcp_servers.<tên>.enabled=false`.
4. **Log run**: thêm một dòng ghi chính sách đang dùng (model, mức tự chủ, mạng, MCP), để nhật ký 27c đọc lại được.
5. **Test** (`apps/desktop/test`):
   - `applyAutonomy` cho từng loại agent và từng mức, kể cả khi gói đặt mức thấp hơn và khi gói có cờ dangerously;
   - `policyBlocks` cho model, mạng và container;
   - runner test: chính sách read làm lệnh của run có `--permission-mode plan` và readOnly; gói bị chặn bị bỏ qua; không còn gói nào thì có lỗi `errors.policyNoProfile`.

## [Unverified] cần kiểm bằng run thật

Phần dưới chưa thử trên máy:
- `--permission-mode plan` của Claude Code 2.1.283 ở chế độ `-p` có chặn Write/Edit/Bash mà vẫn cho gọi MCP hay không.
- Codex 0.157 có nhận `mcp_servers.<tên>.enabled=false` hay không.
- `--approval-mode plan` của Gemini 0.61 có chặn sửa file hay không.

Kiểm sau khi phát hành:
1. Đặt dự án xdev-hive ở mức read.
2. Giao một run trên Mac mini với yêu cầu "tạo file x.txt".
3. Xác nhận branch của run không có x.txt và log có dòng chính sách.
4. Trả chính sách về mức cũ.
