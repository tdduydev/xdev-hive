# 49. Giao diện web theo vai trò trong AI SDLC

Viết ngày 6/10. Người dùng yêu cầu:
- nghiên cứu AI SDLC và cách quản trị nội dung, bộ nhớ, skill, UX/UI;
- thêm skill [ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) để agent dùng khi thiết kế;
- đóng vai từng vai trò trong quy trình AI SDLC, xem mỗi vai làm gì, rồi thiết kế lại web cho dễ dùng và hợp với hệ thống.

Task:
- **R-49** cho mục này;
- **SKILL-uiux** cho việc thêm skill.

Tài liệu này gồm ba phần:
1. nghiên cứu;
2. đóng vai, đi qua web hiện tại (main `c8366ce`, bản 0.131.0);
3. thiết kế mới và cách chia việc.

## 1. Nghiên cứu (tóm tắt)

Nguồn đọc ngày 5–6/10/2026, qua công cụ tóm tắt trang; có chỗ chưa kiểm được nguyên văn, ghi [chưa kiểm].

**Khung AI SDLC:**
- **AWS AI-DLC** ([AWS, 7/2025](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)):
  - ba pha Inception → Construction → Operations;
  - AI đề xuất và hỏi lại, người chốt các quyết định quan trọng;
  - việc chia thành *Unit of Work* (thay epic) và chạy theo *Bolt*, mỗi Bolt vài giờ tới vài ngày (thay sprint);
  - artifact nằm trong repo.
- **GitHub Spec Kit** ([repo](https://github.com/github/spec-kit)): constitution → specify → plan → tasks → implement → converge, kèm clarify / checklist / analyze là cổng chất lượng tuỳ chọn. Người duyệt sau mỗi bước. Hive đã dùng Spec Kit (20c/20d, 34).
- **Kiro** ([docs](https://kiro.dev/docs/specs/)):
  - requirements → design → tasks;
  - có lối *Quick Spec* bỏ qua chốt;
  - task chạy theo "đợt" phụ thuộc.
- **Phản biện** (Böckeler, [martinfowler.com 10/2025](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html); Thoughtworks Radar mức *Assess*):
  - quy trình spec không co lại cho việc nhỏ: một lỗi nhỏ thành 4 user story và 16 tiêu chí;
  - markdown dài khó review.
  - → Hive cần **lối nhanh** cho việc nhỏ, không bắt mọi việc qua đủ 7 chốt.
- **BMAD** ([docs](https://docs.bmad-method.org/reference/skills-and-agents/)): các persona agent Analyst, PM, Architect, Developer, UX Designer, và tự nói quy trình phải "vừa cỡ" việc.

**Sản phẩm điều phối agent** (chi tiết và link: [49-research.md](49-research.md)):
- Linear:
  - người vẫn là chủ issue, agent chỉ là người được *giao* (delegate);
  - phiên của agent có trạng thái *chờ người trả lời* (`awaitingInput`);
  - hộp thư *Priority* tách việc cần mình khỏi phần còn lại.
- GitHub Copilot / Agent HQ:
  - bảng agent có ở mọi trang;
  - đọc log phiên trước rồi mới đọc diff;
  - gõ thêm chỉ dẫn vào phiên đang chạy.
- Jules và Factory: xem kế hoạch, duyệt, rồi mới chạy.
- Devin Review: nhóm và sắp xếp diff theo ý, cờ lỗi theo mức nặng.
- Devin Knowledge:
  - agent *gợi ý* tri thức, người duyệt từng mục;
  - một phiên định kỳ gộp trùng và đánh dấu mục cũ.
- Cursor rules / Claude skills: mỗi mục tri thức có **phạm vi và lúc áp dụng** (luôn, theo mô tả, theo đường dẫn, gọi tay), ưu tiên tổ chức → dự án → cá nhân.
- [chưa kiểm] Chưa thấy sản phẩm nào có phiên bản skill hay thống kê "agent nào dùng skill nào".

**Rút ra cho Hive:**
1. Một hộp thư "cần bạn" là trung tâm. Hive đã có *Hôm nay* (35c).
2. Người là chủ, agent đề xuất.
3. Quy trình vừa cỡ: có lối nhanh.
4. Mọi tri thức có phạm vi.
5. Agent tự gợi ý tri thức, người duyệt, và một việc định kỳ dọn trùng.

## 2. Đóng vai: đi qua web hiện tại

Cách làm:
- đọc code `packages/ui` trên main (menu `WEB_GROUPS` và `visible` ở `App.tsx`, quyền ở `packages/core/src/access.ts`);
- xem ảnh e2e và smoke của bản 0.131.0;
- **chưa** cho người dùng thật thử.

Số bước dưới đây đếm theo code, là [suy luận].

Hiện trạng chung:
- Menu web của admin hub có **27 mục** trong 4 nhóm theo *loại dữ liệu* (Công việc, Kiến thức, Vận hành, Quản trị). Thành viên thấy khoảng 15 mục.
- Không nhóm nào theo *bước* của quy trình hay theo *việc của vai trò*.

### Người yêu cầu / PO (quyền: Quản lý dự án, hoặc Thành viên + `taskManage` + `runDispatch`)

Việc: đưa ý định, duyệt spec, nghiệm thu.

- **Bắt đầu một việc có 5 lối**, mỗi lối một trang:
  - *Task mới* (thanh trên);
  - dòng tạo task trên trang Task (phải gõ mã `T-001`, dự án, phụ thuộc);
  - *Prompt cho agent* (trang Task và Bản đồ agent);
  - *Tính năng mới* (trang Spec);
  - *Chat*.
  - Không lối nào nói nên dùng lối nào cho việc gì.
- **Duyệt chốt Spec**:
  - đến từ *Hôm nay*, hoặc Task → bấm task → khung bên → thẻ luồng;
  - còn nội dung spec lại ở trang *Spec* khác, nên phải mở hai trang mới duyệt được.
- **Nghiệm thu** (chuyển Xong) cần quyền `codeReview`. PO không có quyền này thì không đóng được việc mình yêu cầu.
- **Chữ viết cho agent hiện cho người**: trang Task mở đầu bằng "Agent nhận task bằng task_claim (có hạn giữ), xong thì task_update…".

### Tech lead / Kiến trúc (Quản lý dự án)

Việc: duyệt Plan, giữ chuẩn (AGENTS.md, quyết định, skill, context), dọn memory, đặt chốt SDLC và chính sách agent.

- **Cài đặt dự án nằm rải rác**:
  - chốt SDLC và chính sách agent: admin hub thấy ở *Chính sách & chốt*, lead thấy ở *Hệ thống*;
  - tool của dự án ở *Tool*;
  - lệnh và mức tự chạy của leader ở hộp *Hướng dẫn leader* trong *Chat*;
  - thành viên ở *Thành viên*.
- **Context agent** (`#/context`) và nút *Yêu cầu máy đồng bộ* chỉ admin hub vào được, dù lead có quyền `contextEdit`.
- **Hướng dẫn leader sửa được ở hai nơi**: *Chat* và *Skill*.
- **Duyệt ở 5 nơi**: *Hôm nay*, *Đề xuất*, *Memory*, *Chat*, khung luồng trong Task.
- **Memory**: chỉ nối mục trùng khi người ghi tự khai `supersedes`; chưa có việc dọn trùng.

### Người giao việc cho agent (Thành viên có `runDispatch`)

Việc: chọn task, giao run, theo dõi, chỉnh hướng, xử lý lỗi.

- **Form *Chạy trên máy*** trong khung task có 6 lựa chọn: máy, việc, gói, ưu tiên loại gói, số bản, review chéo. Hầu hết lần nên để mặc định, nhưng không có chỗ gom "nâng cao".
- **Run nằm ở trang khác**: muốn xem log thì sang *Lượt chạy*; đợt chạy nhiều task lại ở *Đợt chạy*.
- **Run không có trạng thái "chờ người"**: agent hỏi lại thì người không biết, trừ khi đọc log.

### Reviewer (vai *Reviewer*)

Việc: review code agent làm, cho qua chốt review và merge, yêu cầu sửa.

- **Hàng chờ review** ở *Hôm nay* (thẻ *Chờ review*), nhưng phải đọc ở ba nơi:
  - ghi chú bàn giao (khung task);
  - log (*Lượt chạy*);
  - diff (GitLab/GitHub);
  - nút *Merge* ở *Lượt chạy*.
- **Lệch quyền**: chữ giải thích vai Reviewer (`vi.ts` `projectRoleHint.reviewer`) nói vai này "duyệt đề xuất tài liệu và skill", nhưng hub đòi `contextEdit`, quyền mà Reviewer không có.

### QA / Kiểm thử (chưa có vai riêng)

Việc: kịch bản kiểm thử, xác nhận tiêu chí "Xong khi".

- Không có trang, chốt hay quyền nào cho kiểm thử. Tiêu chí nằm lẫn trong ghi chú task. Checklist của Spec Kit chỉ là file trong repo.

### Người giữ tri thức (thường là lead)

Việc: tài liệu, memory, skill.

- **Đề xuất** là một trang riêng, tách khỏi tài liệu và skill mà nó sửa.
- **Skill** không hiện phạm vi (của nhóm hay của dự án, dự án nào đè cái nào) và lúc áp dụng. Cũng không biết run nào đã dùng skill nào.

### Vận hành / Admin hub

Việc: máy, gói, quota, chi phí, cảnh báo, phiên bản app, người dùng, tool, hub.

- **Trùng trang**:
  - *Bản đồ agent* và *Đội máy* cùng nói về máy;
  - bảng chi phí vẽ cả ở *Bản đồ agent* lẫn *Chi phí*;
  - hai trang cùng tên *Tổng quan* (`#/overview` mở từ bảng lệnh, `#/ops` ở menu).
- **Nút *Dừng mọi agent*** chỉ có ở *Tổng quan*.
- **Nhóm *Quản trị*** trộn việc của mọi người (*Token*, *Tool*, *Hệ thống*) với việc của admin.

### Người xem / Bên liên quan (vai *Người xem*)

Việc: biết tính năng tới đâu, cái gì đã xong.

- Không có trang tiến độ theo tính năng hay dự án. Chỉ có thanh tiến độ trong trang *Spec*, và trang *Tổng quan* thì chỉ mở được từ bảng lệnh.

### Agent (leader, agent làm task, agent review, giám khảo)

Agent là "người làm" trong hệ thống, không phải người dùng web. Giao diện hiện agent qua run và chat. Agent chỉ đề xuất, và điều đó đúng như các khung trên. Không đổi.

## 3. Thiết kế mới

### Nguyên tắc

1. **Đi theo việc, không theo bảng dữ liệu.** Menu theo vòng đời: *Hôm nay* → *Tính năng* → *Task* → *Agent đang chạy* → *Kiến thức*. Cài đặt và quản trị đưa ra khỏi lối chính.
2. **Một chỗ cho mỗi việc**:
   - một lối bắt đầu việc;
   - một chỗ duyệt mỗi loại, mà *Hôm nay* gom lại;
   - một trang máy;
   - một trang cài đặt dự án.
3. **Vừa cỡ**: mỗi lối bắt đầu có *Nhanh* (task + run ngay, chốt theo cài đặt) và *Đầy đủ* (luồng Spec → Plan → Tasks).
4. **Mặc định tốt, nâng cao gập lại**: form giao run chỉ hiện máy và nút *Chạy*, phần còn lại ở *Tuỳ chọn*.
5. **Quyền nhất quán**: giao diện ẩn hay khoá đúng như hub kiểm, không hiện nút mà bấm vào thì báo *forbidden*.
6. **Chữ cho người**: bỏ tên tool của agent (`task_claim`…) khỏi trang người dùng. Thuật ngữ thống nhất, có giải thích ngắn khi rê chuột.
7. **Giữ design system**: token ở `packages/ui/src/tokens/` và tài liệu thiết kế 2026-09. Skill ui-ux-pro-max dùng để *kiểm* (accessibility, bố cục, chữ, biểu đồ), không để đổi màu hay font.

### Menu mới (web)

| Nhóm | Mục | Gộp từ | Ai thấy |
|---|---|---|---|
| — | **Hôm nay** | Hôm nay | mọi người |
| — | **Chat** | Chat | `chatUse` |
| Làm việc | **Sơ đồ** | mới (roadmap 51, React Flow) | `view` |
| | **Tính năng** | Spec, phần luồng và chốt của Task | `view` |
| | **Task** | Task | `view` |
| | **Agent đang chạy** | Lượt chạy, Đợt chạy (thành bộ lọc) | `view` |
| Kiến thức | **Tài liệu** | Tài liệu, đề xuất tài liệu (tab *Chờ duyệt*) | `view` |
| | **Skill** | Skill, đề xuất skill (tab *Chờ duyệt*), hướng dẫn leader | `view` |
| | **Memory** | Memory | `view` |
| Dự án | **Cài đặt dự án** | chốt SDLC, chính sách agent, tool của dự án, Context agent, lệnh và mức tự chạy của leader, thành viên, hệ thống | `projectSettings` hoặc `membersManage` |
| Máy | **Máy & agent** | Bản đồ agent, Đội máy, Hàng đợi, Chi phí (tab) | `view` (admin có thêm tab) |
| Quản trị hub | **Quản trị** (một mục, nhiều tab) | Tổng quan vận hành, Người dùng & quyền, Tool (danh mục), Ngân sách, Cảnh báo, Nhật ký, Thông báo & webhook, Phiên bản app, Hub | admin hub |

*Token* và *Đổi mật khẩu* chuyển vào menu tài khoản (ảnh đại diện).

Kết quả:
- admin hub còn **12 mục** (gồm *Sơ đồ* của 51), thay vì 27;
- thành viên còn 10.

Địa chỉ cũ chuyển hướng như 35b đã làm (`lib/route.ts`).

### Lối bắt đầu việc: nút **+ Mới**

Một nút ở thanh trên, thay *Task mới* và các *Prompt cho agent*. Nó mở một hộp:
- **Hỏi leader**: mở Chat với câu đã gõ.
- **Giao việc nhanh**:
  - tiêu đề, mô tả, "Xong khi", dự án;
  - tạo task rồi chạy luôn trên máy rảnh, hoặc chỉ tạo;
  - mã task tự sinh.
- **Tính năng mới (đầy đủ)**: chạy luồng Spec, chốt theo cài đặt SDLC của dự án.

Hộp ghi rõ khi nào dùng lối nào: việc nhỏ, rõ thì *nhanh*; việc cần spec thì *đầy đủ*. Chỉ hiện lối người đó có quyền.

### Trang **Tính năng** (thay trang Spec)

- **Bảng theo bước**:
  - các cột Spec → Plan → Tasks → Đang làm → Review → Xong;
  - mỗi thẻ là một tính năng: luồng 34b, hoặc một task lẻ không có luồng thì nằm ở trang Task;
  - thẻ đang chờ chốt có nhãn *Chờ bạn* nếu người xem có quyền chốt.
- **Trang tính năng**, các tab:
  - Spec, Plan, Tasks (đọc tài liệu ngay đó);
  - **Kiểm thử**: tiêu chí "Xong khi" và checklist, đánh dấu đã kiểm từng mục;
  - **Lượt chạy** của tính năng;
  - **Lịch sử chốt**.
- **Nút chốt nằm cạnh nội dung đang duyệt**: *Cho qua* / *Yêu cầu sửa* kèm ghi chú.

### Agent đang chạy (thay Lượt chạy và Đợt chạy)

- Danh sách run, mặc định *đang chạy* và *cần bạn*. Thêm trạng thái **Chờ người**: run hỏi lại, CI lỗi, hoặc hết quota.
- Bộ lọc theo đợt, task, máy.
- **Trang một run**, thứ tự đọc từ trên xuống:
  1. tóm tắt bàn giao (ĐÃ LÀM / CHƯA LÀM / CÁCH KIỂM / RỦI RO);
  2. log theo loại;
  3. diff hay MR;
  4. nút *Merge* / *Yêu cầu sửa* (tạo lượt sửa của 34c).

### Form giao run

- **Mặc định**: máy (tự chọn máy rảnh) và nút *Chạy*.
- **Tuỳ chọn** (gập lại): việc, gói, ưu tiên loại gói, số bản, review chéo, chỉ dẫn thêm.

### Kiến thức

- **Tài liệu và Skill có tab *Chờ duyệt***, nên bỏ trang *Đề xuất* riêng. *Hôm nay* vẫn gom.
- **Skill hiện**:
  - phạm vi (nhóm, hay dự án nào), và skill của dự án nào đè skill cùng tên của nhóm;
  - lúc áp dụng (mô tả);
  - lần sửa cuối.
- **Memory: việc dọn định kỳ**. Một run AI hằng tuần, bật trong *Cài đặt dự án*, tìm mục trùng hay đã cũ và tạo **đề xuất gộp hay bỏ**. Người duyệt ở tab *Chờ duyệt*. Không tự xoá.
- *Chưa làm*: thống kê run nào dùng skill nào. Cần runner ghi lại, để mục sau.

### Hôm nay theo vai trò

- Giữ một hộp thư; thêm **nhóm theo việc**: *Cần bạn quyết*, *Cần bạn review*, *Agent đang chờ bạn*, *Theo dõi*.
- Một người có nhiều quyền thì thấy nhiều nhóm. Thứ tự ưu tiên lấy theo vai cao nhất của họ trong phạm vi đang chọn.
- Mỗi mục có nút làm ngay, như hiện tại.

### Lỗi quyền sửa ngay (không chờ thiết kế mới)

1. Nút *Sửa* phụ thuộc hiện theo `runDispatch`, nhưng hub kiểm `taskManage` (`Tasks.tsx` `tasks.editDeps`, `sqlite.ts` `tasks.setDeps`).
2. *Model và mức nỗ lực*, lệnh và mức tự chạy của leader hiện cho người có `chatUse`, nhưng hub đòi `projectSettings` (`Chat.tsx`, `LeaderGuide.tsx`, `sqlite.ts` `chat.setDefaults`/`setCommands`/`setAutonomy`).
3. Câu giải thích vai Reviewer nói duyệt được đề xuất skill, nhưng hub đòi `contextEdit`. Chọn một trong hai:
   - sửa câu chữ;
   - hoặc cho Reviewer duyệt đề xuất skill. Việc này cần đổi `access.ts`; chọn khi làm 49a, ghi rõ lý do.
4. Nút xoá cooldown kiểm `me.role !== "viewer"` thay vì quyền theo dự án (`Machines.tsx`).
5. Tên cũ còn sót: "Hàng duyệt" / "Đề xuất"; "Dự án & hệ thống" / "Cài đặt".
6. Lead có `contextEdit` nhưng không vào được *Context agent*.
7. Nghiệm thu (chuyển Xong) cần `codeReview`. Giữ nguyên, nhưng giao diện nói rõ ai đóng được, thay vì để người bấm rồi bị từ chối.

## Chia việc

Làm lần lượt. Mỗi mục là một task R-49x, chạy qua Hive. Mỗi mục có ảnh trước/sau (smoke và e2e), như 35.

| Mục | Nội dung | Phụ thuộc |
|---|---|---|
| **49a. ux-perm-fixes** | 7 lỗi quyền ở trên; test UI và hub cho từng lỗi | — |
| **49b. nav-regroup** | Menu mới, menu tài khoản, trang *Cài đặt dự án* (gom thẻ có sẵn, không viết lại), *Máy & agent* (gộp Bản đồ agent, Đội máy, Hàng đợi, Chi phí), *Quản trị* một mục nhiều tab, chuyển hướng địa chỉ cũ | 49a |
| **49c. new-work** | Nút *+ Mới* với ba lối; bỏ dòng tạo task gõ mã; chữ cho người trên trang Task | 49b |
| **49d. features-page** | Trang *Tính năng* (bảng theo bước, trang tính năng với tab Kiểm thử và Lịch sử chốt, nút chốt cạnh nội dung) | 49b |
| **49e. runs-review** | *Agent đang chạy*: trạng thái *Chờ người*, trang run đọc bàn giao trước, form giao run gập *Tuỳ chọn* | 49b |
| **49f. knowledge** | Tab *Chờ duyệt* trong Tài liệu và Skill, bỏ trang Đề xuất; skill hiện phạm vi và lúc áp dụng; việc dọn memory định kỳ (tạo đề xuất) | 49b |
| **49g. today-roles** | *Hôm nay* nhóm theo việc, thứ tự theo vai | 49d, 49e |
| **49h. mobile-pass** | Rà mọi trang web ở 390×844 bằng skill `ui-ux-pro-max` (vùng chạm, cỡ chữ ô nhập ≥ 16px, tương phản, focus, `prefers-reduced-motion`, nhãn), bảng phát hiện trong ghi chú task, sửa; ảnh e2e:mobile trước/sau | MOBILE-42-land, SKILL-uiux |

**Cách làm chung cho mọi mục:**
- Mỗi mục (49, 50, 51) phải qua `npm run e2e:mobile -w @xdev-hive/web` (390×844, không tràn ngang), và người làm tự rà trang đã đổi theo checklist của skill `ui-ux-pro-max`, ghi kết quả vào ghi chú.
- Agent đọc skill `ui-ux-pro-max` (sau khi SKILL-uiux vào main) để kiểm accessibility và bố cục từng trang đổi. Không đổi token, màu hay font.
- Chữ giao diện viết vào `vi.ts` trước, rồi `en.ts`.
- Chạy `npm run typecheck`, `npm test`, e2e web. Đổi giao diện desktop dùng chung (`packages/ui`) thì chạy thêm build và smoke desktop.
- App desktop giữ 6 mục của 35a/44 và chỉ việc của máy. Đổi menu web không được làm đổi menu app.

## Ngoài phạm vi

- Vai QA như một vai trò quyền mới (thêm vào `access.ts`): chờ người dùng thử tab Kiểm thử của 49d rồi quyết.
- Xem diff ngay trong Hive (thay GitLab/GitHub): mục sau, nếu cần.
- Thống kê skill theo run.
- Thử với người dùng thật: sau 49b nên nhờ 2–3 người làm 3 việc (giao việc nhanh, duyệt chốt Spec, review một run) rồi ghi số bước và chỗ vướng vào tài liệu này.
