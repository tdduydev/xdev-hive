# Contract: thay đổi ở hub và `packages/contracts`

Mọi trường mới tuỳ chọn. Hub cũ và worker cũ không vỡ.

## 1. Đăng ký máy (`packages/contracts/src/fleet.ts`)

```ts
export const registerOutput = z.object({
  id, orgId: id, teamId: id, machineId, machineToken: z.string(),
  /** Tên tổ chức, để máy nhiều tổ chức đặt nhãn mặc định (spec 034 FR-006). Hub cũ không gửi. */
  orgName: z.string().max(200).optional(),
});
```

## 2. Từ chối đề nghị (`worker-protocol.ts`, đang khoá trong nhánh này)

`jobReject.reason` vẫn là chuỗi. Hằng số chung:

```ts
/** Máy hết slot chung vì đăng ký khác; hub không loại máy khỏi run (spec 034 FR-055). */
export const MACHINE_BUSY_REASON = "machine_busy";
```

Đặt hằng số trong `fleet.ts` hoặc module riêng không khoá; khi 027 xong thì chuyển vào `worker-protocol.ts`.

Hub (`runs/engine.ts` `onReject`):

| `reason` | `rejectedBy` | Máy | Hành động |
|---|---|---|---|
| `machine_busy` | Không thêm | Bận trong bộ nhớ tới heartbeat kế, tối đa 30 giây | Giao máy khác; heartbeat kế giao lại |
| khác | Thêm | — | Như hiện nay |

## 3. Heartbeat (`worker-protocol.ts`, chờ 027)

```ts
/** Sức chứa hiện dành cho tổ chức này; đổi theo chia công bằng. Thiếu thì hub giữ capacity của hello. */
capacity: z.number().int().min(0).max(64).optional(),
/** Ghi chú đồng thuê do chủ máy bật (spec 034 US8). null là xoá. */
coTenancyNote: z.string().max(200).nullable().optional(),
/** Máy không đủ điều kiện chính sách tổ chức (FR-061). */
policyUnmet: z.boolean().optional(),
```

## 4. Chính sách tổ chức (`governance`, đang khoá trong nhánh này)

```ts
aiAccountSharing: z.enum(["allow", "dedicated"]).default("allow"),
machineIsolation: z.enum(["shared_user", "separate_user"]).default("shared_user"),
```

Gửi xuống trong `welcome.policy`. Web: hai mục trên `/admin/policies`.

## 5. Máy (`fleet.ts` `machine`)

```ts
coTenancyNote: z.string().nullable().optional(),
```

## 6. Sửa phân quyền

Không đổi hình dạng API. Đổi lỗi trả về:

| Procedure | Trước | Sau |
|---|---|---|
| `leader.threads.list` | Mọi hội thoại của tổ chức | Chỉ hội thoại thấy được (FR-090) |
| `leader.threads.get`, `threads.send` | Mọi thành viên | `LEADER_THREAD_NOT_FOUND` nếu không thấy được |
| `leader.approvals.list` | Mọi đề xuất | Chỉ đề xuất của hội thoại thấy được |
| `leader.approvals.reject` | Mọi thành viên | Cần `member` của đội; viewer/ba nhận `TEAM_ROLE_REQUIRED` |
| Mọi procedure với token cá nhân | Tổ chức theo đường dẫn | `UNAUTHORIZED` nếu khác tổ chức của token |
| Router fleet | Không kiểm thành viên | `NOT_ORG_MEMBER` |
| `fleet.register` cùng tên | Ai có mã cũng thay | `MACHINE_NAME_TAKEN` nếu người tạo mã không phải chủ cũ hay admin đội |
| `fleet.machines.pause/resume/revoke` | Admin đội | Admin đội hoặc chủ máy cá nhân |
| `roles.unassign` | `roles.write` | `roles.write` + `requireCanGrant` |
| `roles.assign` cho đội | Mọi vai trò | Từ chối vai trò phạm vi tổ chức (`ROLE_SCOPE_MISMATCH`) |
