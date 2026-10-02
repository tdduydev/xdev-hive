# 34. Chốt chặn theo từng bước của vòng đời (AI SDLC)

Viết ngày 2/10. Người dùng hỏi: "nghiên cứu thêm AI SDLC, làm thêm các chốt chặn ở từng bước và thêm cấu hình bypass giao cho AI từng bước đó luôn". Người dùng chọn:
- chốt ở cả bốn nhóm bước: Spec → Plan → Tasks, Giao việc và sửa, Review, Merge;
- mỗi chốt chọn một trong ba chế độ: **Người duyệt**, **AI kiểm rồi cho qua** (agent vendor khác đọc kết quả, không chắc thì chuyển cho người), **Tự động** (cho qua, không kiểm);
- **admin hub đặt trần** (bước nào được giao cho AI tới mức nào), **quản trị dự án chọn trong trần**, không nới được, như chính sách agent 27a;
- **mặc định giữ như hiện nay**: bước đang tự động vẫn tự động (review chéo, sửa CI, task xong khi merge), chốt mới mặc định là *Người duyệt*.

## Tham khảo

- AWS AI-DLC Workflows ([phases and stages](https://awslabs.github.io/aidlc-workflows/guide/04-phases-and-stages/)): mỗi bước của Ideation / Inception / Construction / Operation có chốt duyệt của người; từ chối thì bước mở lại để sửa. Chế độ *Continue automatically* bỏ các chốt hoàn thành thường nhưng giữ duyệt kế hoạch, lệnh kiểm tra và lỗi. Mọi quyết định được ghi lại (audit trail).
- Kiro: *Supervised* (đề xuất, chờ duyệt) và *Autopilot* (tự làm); spec theo requirements → design → tasks.
- Phân mức tự chủ hay gặp: human-in-the-loop (duyệt từng việc), human-on-the-loop (agent chạy, người theo dõi), autonomous (agent tự chạy trong giới hạn).

Hive lấy ba điều: chốt rõ ràng ở từng bước, chế độ tự chủ chọn theo từng bước (không phải một công tắc chung), và những giới hạn không bypass được.

## Hiện trạng (rà ngày 2/10)

| Bước | Hiện tại | Ở đâu |
|---|---|---|
| specify → plan → tasks | người bấm từng bước trên trang *Spec*, không có duyệt giữa các bước, run bước không có review chéo | `Specs.tsx` (tasks.create + runs.dispatch, `reviewAfter:false`) |
| Nhập tasks.md | người bấm, quyền *Tạo/sửa task* | `specs.importTasks` |
| Giao việc | người xếp run (Board, *Gửi cho máy*, đợt chạy 31a) | `runs.dispatch`, `runs.dispatchMany` |
| Review chéo | tự động nếu `reviewAfter`; kết luận chỉ quyết MR mở thường hay nháp | `runner.ts`, `verdict.ts`, `mr.ts` |
| Sửa sau *cần sửa* | người bấm *Xếp lượt sửa* | `Runs.tsx` (18b) |
| Sửa CI | tự động theo `mr.fixCi` / `mr.maxCiFixes` (cấu hình máy) | `ci-fix.ts` |
| Merge | chỉ người (`runs.merge`, quyền *Review code*, không tự duyệt việc mình) | 18c |
| Task xong | người, hoặc tự động khi MR merge (`mr.doneOnMerge`) | `watch.ts` |

## Mô hình

```ts
export const SDLC_GATES = ["spec", "plan", "tasks", "dispatch", "review", "fix", "merge"] as const;
export const GATE_MODES = ["human", "ai", "auto"] as const; // thứ tự = mức tự chủ tăng dần
```

| Chốt | Khi nào tới | *Người duyệt* | *AI kiểm* | *Tự động* |
|---|---|---|---|---|
| `spec` | run *specify* xong | người bấm *Duyệt, lập kế hoạch* hoặc *Yêu cầu sửa* | review run vendor khác đọc `spec.md`; đạt → lập kế hoạch | lập kế hoạch luôn |
| `plan` | run *plan* xong | như trên, *Duyệt, chia việc* | như trên với `plan.md` | chia việc luôn |
| `tasks` | run *tasks* xong | như trên, *Duyệt, nhập task* | như trên với `tasks.md` | nhập task luôn |
| `dispatch` | task của luồng đã sẵn sàng | người xếp run như hiện nay | review run đọc task (đủ rõ, có tiêu chí xong) rồi giao | giao luôn (đợt chạy, máy rảnh) |
| `review` | run làm task xong | như hiện nay: người review / merge | kết luận *đạt* của review chéo là đủ | không cần review |
| `fix` | review kết luận *cần sửa* | người bấm *Xếp lượt sửa* | review run xét các điểm cần sửa có đúng không rồi xếp sửa | xếp sửa luôn (tối đa N lượt) |
| `merge` | review đã qua, MR có CI xanh | người merge (18c) | review run kiểm lần cuối rồi merge | merge luôn |

**AI kiểm** dùng run review sẵn có: hub xếp một run `review` (máy chọn gói vendor khác bên làm) với chỉ dẫn của chốt, kết thúc bằng `Verdict: approve` hoặc `Verdict: changes` (`parseVerdict`). *approve* → chốt qua; *changes* hoặc không đọc được → chốt chuyển cho người, kèm báo cáo của agent.

**Không bypass được** (ghi cứng, chế độ nào cũng giữ):
- run lỗi, hết giờ, bị huỷ → dừng luồng, chờ người;
- dự án/hub đang dừng agent (27d), trần chi tiêu (27b), chính sách agent (27a) giữ nguyên;
- `fix` tự động tối đa `maxFixRounds` (mặc định 2) lượt cho một task, quá thì chuyển cho người;
- `merge` tự động chỉ khi pipeline *success*, MR không phải nháp, review đã qua; không có CI thì chuyển cho người;
- người duyệt vẫn theo luật không tự duyệt việc mình (27c).

**Luồng** (*flow*): chốt chỉ áp cho việc đi qua engine của hub, để task thường không bị tự giao bất ngờ. Một luồng bắt đầu khi người bấm bước Spec Kit trên trang *Spec* (34b); task nhập từ `tasks.md` của luồng thuộc luồng đó (34c, 34d). Task ngoài luồng chạy như hiện nay.

**Ghi lại**: mỗi lần tới chốt là một dòng `sdlc_gates` (dự án, task, chốt, chế độ lúc đó, trạng thái `waiting / checking / passed / rejected / escalated`, ai quyết: người, run review, hay `auto`, ghi chú, thời gian). Trang task và trang *Hôm nay* hiện chốt đang chờ người.

## Cấu hình

`settings.sdlcPolicy`:
```ts
interface SdlcPolicy {
  /** Trần của hub: mức cao nhất mỗi chốt được đặt. Mặc định "auto" cho mọi chốt (không giới hạn). */
  ceiling: Record<SdlcGate, GateMode>;
  /** Chế độ của từng dự án; thiếu thì "human". */
  projects: Record<string, { gates: Partial<Record<SdlcGate, GateMode>>; maxFixRounds?: number; maxParallel?: number }>;
}
```
- Chế độ hiệu lực = min(chế độ dự án, trần). Hạ trần thì dự án đang cao hơn bị kéo xuống ngay (hiện rõ trên trang).
- `sdlc.get { project? }` (đọc: quyền xem dự án; trần: ai cũng xem được), `sdlc.setCeiling` (admin hub), `sdlc.setProject` (quyền *Cài đặt dự án*). Đặt chế độ cao hơn trần → lỗi có khoá.
- Giao diện: Web Admin *Chính sách* có bảng trần; cài đặt dự án (trang dự án, web và app chế độ hub) có bảng 7 chốt × 3 chế độ, chế độ vượt trần bị khoá.

## Tách việc

- **R-34a. sdlc-policy**: `SDLC_GATES`, `GATE_MODES`, `sdlcPolicy` (trần + dự án), `sdlc.get` / `sdlc.setCeiling` / `sdlc.setProject`, bảng `sdlc_gates` và `sdlc.gates { project?, status? }`, giao diện cấu hình (Web Admin + cài đặt dự án), nhật ký quản trị. Chưa đổi hành vi run.
- **R-34b. spec-flow**: `specs.runStep { project, dir, branch, step, machineId, profileId }` thay cho tasks.create + runs.dispatch ở trang *Spec*, ghi luồng (`sdlc_flows`); khi run bước xong (`runs.push`), áp chốt `spec` / `plan` / `tasks`: chờ người, xếp run AI kiểm (review) rồi đọc kết luận, hoặc làm bước kế luôn trên cùng máy. Chốt `tasks` qua → nhập `tasks.md` (chờ máy đẩy spec nếu hub chưa có bản mới). Nút *Duyệt* / *Yêu cầu sửa* trên trang *Spec* và panel task.
- **R-34c. dispatch-fix**: task nhập từ luồng có chốt `dispatch`: tự động → thêm vào đợt chạy của luồng (máy rảnh, `maxParallel` của dự án); AI kiểm → run review đọc task trước. Chốt `fix`: review *cần sửa* → tự xếp lượt sửa (chỉ dẫn là báo cáo review, như 18b), tối đa `maxFixRounds`.
- **R-34d. review-merge**: chốt `review`: AI kiểm = kết luận *đạt* của review chéo đủ để đi tiếp; tự động = không cần review. Chốt `merge`: khi review qua và MR có CI *success*, tự động → hub yêu cầu máy merge (như `runs.merge`, người yêu cầu là `sdlc`); AI kiểm → run review kiểm lần cuối rồi merge.

## Chưa làm trong mục này

- Chốt cho phát hành / deploy của dự án (Hive không chạy deploy của dự án người dùng).
- Điều kiện theo nội dung (vd. chỉ tự merge khi diff dưới N dòng, không đụng thư mục nhạy cảm).
- Áp chốt cho task ngoài luồng.

## Đã làm khác spec (34b)

- Trạng thái luồng thêm `check`: run AI kiểm được xếp ở heartbeat sau, vì lúc máy báo run bước xong, danh sách run của máy (gửi ở heartbeat) có thể vẫn ghi run đó đang chạy và hub sẽ từ chối yêu cầu mới.
- App gọi `afterReport` (sau `pushRuns`) để đẩy spec, kể cả khi không đổi: hub chỉ nhập `tasks.md` đẩy sau lúc chốt `tasks` được ghi.
- Chạy lại bước bằng tay trên trang *Spec* khi luồng đang chờ ở chốt: chốt đó chuyển *rejected*, luồng chạy bước mới. Task trong luồng đang chạy thì `runs.dispatch` từ chối.
- Người duyệt chốt spec/plan/tasks không bị luật "không tự duyệt việc mình" (27c): đó là quyết định của người yêu cầu về đặc tả, không phải duyệt code. Chốt review/merge (34d) vẫn theo luật đó.

