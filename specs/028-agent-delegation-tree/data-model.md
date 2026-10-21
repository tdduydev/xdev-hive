# Data Model: Cây giao việc của agent

**Plan**: [plan.md](plan.md) · **Research**: [research.md](research.md)

## `hive.leader_delegations` (mới, module `leader`)

Một dòng mỗi lần Leader tạo task hay giao run trong một phiên.

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid not null | RLS theo `hive.ctx_org()`, bật và ép |
| `thread_id` | uuid not null | FK `chat_threads(id, org_id)`, xoá theo phiên |
| `kind` | enum `leader_delegation_kind` (`task`, `run`) | |
| `task_id` | uuid not null | FK `tasks(id, org_id)` (migration viết tay vì khác module), xoá theo task |
| `run_id` | uuid null | FK `runs(id, org_id)`, `on delete set null`; có khi `kind = run` |
| `created_by` | text not null | Người duyệt hay người của phiên |
| `created_at` | timestamptz not null default now() | |

- Index `(org_id, thread_id, created_at)`, `(org_id, task_id)`, `(org_id, run_id)`.
- Không unique: Leader giao run nhiều lần cho một task là nhiều dòng.
- Không ghi ngược cho dữ liệu cũ.

## Sự kiện `subagent` (trong `hive.run_events`, không đổi schema)

`run_events.type = 'subagent'`, `data`:

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `id` | string ≤ 64 | `tool_use_id` của lần gọi |
| `parentId` | string ≤ 64, null | Sub-agent cha; null là gọi từ agent chính của run |
| `phase` | `start` \| `end` \| `unsupported` | |
| `type` | string ≤ 64 | `subagent_type` (vd. `Explore`, `general-purpose`) |
| `description` | string ≤ 120 | Đã che secret ở máy và ở hub |
| `status` | `running` \| `completed` \| `failed` \| `killed` \| `unknown` | |
| `depth` | int 0–10 | 0 là sub-agent không rõ độ lồng (bản Claude cũ không báo) |
| `tokens`, `toolUses`, `durationMs` | int ≥ 0, null | Có ở `end` |

Thứ tự: theo `seq` của `run_events`, không theo giờ máy.

## Nút cây (DTO, không lưu)

| Loại | Trường |
|---|---|
| `thread` | id, title, createdAt |
| `task` | id, key, title, status, createdBy: `leader` \| `user`, project |
| `run` | id, kind, state, attempt, machine {id, name}, cli, account, startedAt, endedAt, costUsd, error, parentRunId; `onThisMachine` do client tính |
| `subagent` | id, parentId, type, description, status, depth, tokens, toolUses, durationMs (thứ tự trong mảng là thứ tự bắt đầu) |

`hidden`: số task và run bị ẩn do quyền. `active`: còn nút đang chạy (client dùng để chọn nhịp poll).
