# 29. Chat làm orchestrator

Viết ngày 2/10. Người dùng hỏi: quản trị được qua web và qua cả chat không, để web đóng vai một AI orchestrator. Người dùng chọn:
- làm cả 28e và 29;
- leader tự làm tới đâu là cài đặt của từng dự án, mặc định mọi đề xuất chờ duyệt (29c).

Mỗi phần là một task: R-29a, R-29b, R-29c. 29a và 29b không phụ thuộc nhau. 29c chờ 29b và không nằm trong lượt giao này, nhưng 29b phải chừa chỗ cho nó (xem cuối trang).

## Cơ chế có sẵn

- **Token của leader**: mỗi câu trả lời trong chat có một token riêng. `tokenActor` trong `apps/web/src/app.ts` biến nó thành `Actor` có `chatReply`, với `role` và `access` đã cắt theo quyền của người gửi tin và của máy (`ChatGrants`, `apps/web/src/grants.ts`).
- **MCP của leader**: `createHiveMcpServer` trong `packages/mcp/src/server.ts`.
  - Khi `actor.chatReply` có giá trị thì `leader = true`: không có `task_claim` / `task_update`, thay bằng `propose_task`, `propose_task_status`, `propose_run`.
  - Leader đọc được: `doc_*`, `skill_*`, `memory_search`, `task_list`, `task_next`, `run_list`, `run_get`, `machine_list`.
  - `LEADER_INSTRUCTIONS` là phần hướng dẫn server gửi cho leader.
- **Đề xuất**:
  - `chatAction` (discriminatedUnion) trong `packages/core/src/methods.ts` (khoảng dòng 148) và `CHAT_ACTION_KINDS` trong `packages/core/src/types.ts`.
  - Trong `packages/core/src/sqlite.ts`:
    - `chat.propose` (khoảng dòng 3171): kiểm đầu vào và lưu `chat_actions.input` đúng bằng input của method sẽ gọi;
    - `chat.decide` (khoảng dòng 3239): khi duyệt thì gọi `this.call(method, input, actor)` với actor là người duyệt, nên vai trò, quyền (`#check`), nhật ký và sự kiện đều chạy như khi người đó bấm trên web;
    - `chat.decideAll`: duyệt lần lượt theo bảng `order`.
- **Quyền** (`#check` trong `sqlite.ts`, quyền ở `packages/core/src/access.ts`):
  - `chat.propose` cần `view`;
  - `chat.decide` / `chat.decideAll` cần `chatApprove`;
  - mỗi method được gọi khi duyệt tự kiểm quyền riêng của nó.
- **Thẻ đề xuất**: `ActionItem` trong `packages/ui/src/pages/Chat.tsx` (khoảng dòng 771); helper ở `packages/ui/src/lib/chat.ts` (`actionTask`, `withAction`).
- **Test có sẵn**: `packages/core/test/chat.test.ts`, `apps/web/test/chat.test.ts`, `packages/mcp/test/mcp.test.ts`.

## R-29a. Leader đọc thêm

Thêm tool chỉ đọc vào `createHiveMcpServer`. Đăng ký cho mọi token đọc được, như `run_list`, không riêng leader, để agent làm task cũng dùng được.

| Tool | Gọi | Trả về |
|---|---|---|
| `cost_summary` | `costs.summary` + `budgets.list` | Chi phí 24 giờ / 7 ngày / 30 ngày của dự án (lọc theo `project` nếu truyền vào), các trần liên quan tới dự án và phần đã dùng. |
| `run_requests` | `runs.requests` | Yêu cầu run (chờ, đã nhận, từ chối kèm lý do, huỷ, hết hạn) của dự án. Run đang chờ trên máy và lý do chờ đã có trong `run_list`. |
| `policy_get` | `agentPolicy.get` + `policy.get` + `agents.paused` | Chính sách agent có hiệu lực cho dự án (model, mức tự chủ, mạng, MCP), các phần cài đặt bắt buộc của dự án, dự án hay cả hub có đang dừng agent không. Chỉ phần của dự án được hỏi. |
| `setup_missing` | method mới `machines.setupMissing` | Mỗi máy có dự án: các mục cài đặt `missing` / `manual` của máy (`cli:*`, `shim`) và của dự án (`<dự án>:*`), kèm `detail`. |
| `alert_list` | `alerts.list` qua tuỳ chọn mới | Cảnh báo đang mở. Chỉ đăng ký khi server được truyền `alerts` và actor là admin hub, giống `requireHubAdmin` trên web. |

**Method mới `machines.setupMissing`**
- Input `{ project }`, role `viewer`, cần quyền `view` trên dự án (thêm case vào `#check`).
- Đọc báo cáo cài đặt máy đã gửi (cột `machines.setup`, cũng là nguồn của `admin.machines`).
- Trả `Array<{ machineId, machine, items: SetupItem[] }>`, chỉ gồm máy có dự án và mục chưa `installed`. Không trả `action`, `command` hay đường dẫn tuyệt đối của máy (người không phải admin không cần những thứ đó).
- Thêm vào `schemas`, `MethodOutput`, `roles`.

**Cảnh báo**
- Cảnh báo nằm ở `apps/web/src/alerts.ts`, không có trong core.
- Thêm `alerts?: { list(): Promise<unknown[]> }` vào `HiveMcpOptions`. `app.ts` truyền vào khi tạo server MCP cho hub.
- Tool chỉ có khi được truyền và `actor.role === "admin" && !actor.access`.

**Hướng dẫn**: thêm vào `LEADER_INSTRUCTIONS` một câu nói khi nào dùng các tool đọc mới, ví dụ: hỏi về chi phí thì đọc `cost_summary`, run không chạy thì đọc `run_requests` và `setup_missing`. Cập nhật thêm `READ_ONLY_INSTRUCTIONS` (danh sách tool đọc).

**Test**
- `packages/mcp/test/mcp.test.ts`:
  - mỗi tool trả đúng dữ liệu của dự án;
  - token chỉ có quyền ở dự án A không thấy dữ liệu dự án B;
  - `alert_list` không có với token không phải admin, và không có khi không truyền `alerts`.
- `packages/core/test/`: `machines.setupMissing` lọc đúng máy và mục, từ chối người không có `view`, không lộ `action`/`command`.

## R-29b. Leader đề xuất mọi thao tác web

**Loại đề xuất mới** (thêm vào `chatAction` và `CHAT_ACTION_KINDS`). Dự án luôn là dự án của chat; leader không nêu dự án khác được.

| `kind` | Leader gửi | Lưu `input` để gọi | Method khi duyệt |
|---|---|---|---|
| `run.cancel` | `machine`, `runId` | `{ machineId, runId }` | `runs.cancel` |
| `run.merge` | `machine`, `runId` | `{ machineId, runId }` | `runs.merge` |
| `machine.profile` | `machine`, `profileId`, `enabled?`, `priority?` | `{ machineId, profileId, enabled?, priority? }` | `machines.setProfile` |
| `agent.policy` | `policy` (phần của dự án, `null` để bỏ) | `{ project, policy, before }` | `agentPolicy.set` với `{ project, policy }` |
| `agents.stop` | (không có) | `{ project }` | `agents.stop` |
| `agents.resume` | (không có) | `{ project }` | `agents.resume` |
| `machine.install` | `machine`, `itemId` | `{ machineId, itemId }` | `admin.commandCreate` |

- `machine` là id trên hub hoặc tên máy, tìm giống `run.dispatch` (`SELECT id FROM machines WHERE id = ? OR machine = ?`). Không tìm thấy thì báo `errors.machineNotFound`.
- Dùng lại `machineRef`, `setupItemId`, `agentPolicyPartSchema` đã có trong `methods.ts`. `runId` dùng cùng regex với `runs.cancel` (`/^[\w.-]{1,40}$/`); có thể tách thành một hằng dùng chung.
- `machine.profile` cần `enabled` hoặc `priority`. Zod 4 có thể không nhận `.refine` trong discriminatedUnion; khi đó kiểm trong handler `chat.propose` (`errors.chatProfileNothing`).

**Kiểm lúc đề xuất** (trong `chat.propose`, trước khi lưu; mỗi lỗi có key, thêm vào `vi.ts` / `en.ts` ở nhóm `errors`):
- `run.cancel`, `run.merge`: run có trong `run_records` của đúng máy và cùng dự án với chat (`errors.chatRunNotFound`, vars `id`, `project`).
  - `run.cancel`: run còn `queued` / `running` (`errors.chatRunEnded`).
  - `run.merge`: run có MR/PR (`mr_url`) (`errors.chatRunNoMr`).
- `machine.profile`: máy đã báo gói `profileId` (`machines.profiles`) (`errors.chatProfileNotFound`).
- `agent.policy`: `before` là phần chính sách hiện tại của dự án (`null` nếu chưa có), lấy lúc đề xuất để thẻ hiện bản trước và bản sau.
- `machine.install`: `itemId` là mục của máy (`cli:*`, `shim`) hoặc của dự án này (`<dự án của chat>:<phần>`); mục của dự án khác thì từ chối (`errors.chatInstallOtherProject`).
- Như hiện nay: `reason` không có ký tự ẩn và không giống secret; mỗi câu trả lời tối đa `CHAT_ACTIONS_PER_REPLY` đề xuất.

**Khi duyệt** (`chat.decide`)
- Thay chuỗi ba nhánh `action.kind === …` bằng một bảng `kind → (method, input dùng để gọi)`, để 29c và 28e chỉ cần thêm dòng.
  - `agent.policy` gọi với `{ project, policy }`, không gửi `before`.
- Quyền là của chính method, với người duyệt:
  - huỷ run, dừng / chạy lại agent của dự án: `runDispatch`;
  - merge: `codeReview`, và không merge run do chính mình yêu cầu (`#notSelf`);
  - gói của máy: admin hub hoặc chủ máy;
  - chính sách dự án: `projectSettings`;
  - yêu cầu máy cài: admin hub.

  Người có `chatApprove` mà thiếu quyền đó thì đề xuất thành `failed` với lỗi đã dịch, như `run.dispatch` hiện nay. Không thêm đường tắt nào.
- `result` lưu thứ cần cho thẻ: `requestId` (run.dispatch như cũ), `commandId` (`machine.install`), không có gì với loại khác.

**Thứ tự `decideAll`** (bảng `order`):
1. `task.create`
2. `task.update`
3. `agent.policy`
4. `machine.profile`
5. `machine.install`
6. `agents.resume`
7. `run.cancel`
8. `run.merge`
9. `run.dispatch`
10. `agents.stop`

Lý do: chạy lại agent trước khi xếp run, và dừng agent sau cùng, để một câu trả lời "dừng hết" không chặn các việc khác đã duyệt cùng.

**MCP**: thêm `propose_cancel_run`, `propose_merge`, `propose_profile`, `propose_policy`, `propose_stop_agents`, `propose_resume_agents`, `propose_install`.
- Mô tả kết thúc bằng câu `confirm` như các tool propose hiện có.
- Mỗi tool có `reason`.
- `LEADER_INSTRUCTIONS` liệt kê đủ.

**Thẻ đề xuất** (`ActionItem`)
- Mỗi loại một dòng mô tả, key mới trong `chat.*`, có ở cả `vi.ts` (gốc) và `en.ts`:
  - `chat.actionCancel`: "Huỷ run {run} trên {machine}";
  - `chat.actionMerge`: "Merge MR/PR của run {run}", kèm link MR từ `runs.list` nếu thấy;
  - `chat.actionProfile`: "Gói {profile} trên {machine}: bật/tắt, ưu tiên {n}";
  - `chat.actionPolicy`: "Đổi chính sách agent của dự án";
  - `chat.actionStop` / `chat.actionResume`: "Dừng / chạy lại mọi agent của dự án";
  - `chat.actionInstall`: "Yêu cầu {machine} cài {item}".
- Mã run là link tới `#/runs?run=<id>` như `idHref`.
- `agent.policy` hiện hai dòng *Trước* / *Sau* bằng `policySummary` (`packages/core/src/agent-policy.ts`).
- `actionTask` hiện trả id task cho mọi loại. Loại không gắn task phải trả `null`, và thẻ không vẽ link task cho loại đó.

**Test**
- `packages/core/test/chat.test.ts`, cho mỗi loại:
  - đề xuất lưu đúng `input`;
  - đề xuất sai (run dự án khác, run đã xong, run không có MR, gói không có, mục cài của dự án khác) bị từ chối với đúng key;
  - người có `chatApprove` và đủ quyền duyệt được, method thật chạy (ví dụ `agents.paused` đổi, `machine_commands` có lệnh);
  - người có `chatApprove` mà thiếu quyền của method thì thành `failed`;
  - merge run do chính người duyệt yêu cầu thì `failed`;
  - `decideAll` theo đúng thứ tự trên.
- `packages/mcp/test/mcp.test.ts`: các tool `propose_*` mới chỉ có với token leader.
- `apps/web/test/chat.test.ts`: một vòng qua RPC: đề xuất huỷ run, duyệt, run có `cancel_by`.

## R-29c (sau): leader tự chạy theo cài đặt dự án

Không làm trong lượt này. 29b cần:
- giữ bảng `kind → method` ở một chỗ;
- có hằng `CHAT_ACTION_ALWAYS_CONFIRM = ["agent.policy", "agents.resume"]` trong `types.ts`, kèm comment lý do: leader không được tự nới giới hạn của chính nó. 29c sẽ đọc hằng này.

## Ràng buộc khi làm

- Máy chạy agent (claude-1) không chạy được `npm` hay `node`. Viết code và test cẩn thận; người merge sẽ chạy `npm run typecheck`, `npm test` và e2e.
- Không tăng `version` trong `apps/desktop/package.json`, không đánh dấu [x] trong `docs/roadmap.md`: người merge làm.
- Import khác thư mục dùng alias (`#core/`, `#ui/`, `#web/`, `#mcp/`), không dùng `../`. Chuỗi giao diện thêm vào `vi.ts` trước, rồi `en.ts`. Test quét key lỗi (`errors.*`) bắt key thiếu.
- Comment giải thích vì sao, không phải cái gì.
- Kết thúc: `task_update` sang `review`, ghi chú đã làm / chưa làm / cách kiểm / rủi ro, kể cả chỗ nào chưa chắc vì không chạy được test.
