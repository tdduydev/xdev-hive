# Mục tiêu: hoàn thiện xDev Hive

xDev Hive tự quản lý chính nó trên hive.example.com. Mọi mục roadmap xong. Mỗi phần có test tự động, hoặc một lần kiểm thử thật được ghi lại. Mỗi việc đi qua task Hive: tạo task, claim, *Review* có ghi chú bàn giao, rồi *Xong* sau khi merge, deploy và phát hành.

Đặt ra ngày 1/10/2026, sau bản 0.88.0. Trang này là gốc trong repo (`docs/goals.md`) và tự đồng bộ lên Hive.

## Cách đọc

- Chữ đậm ở đầu mỗi mục (QA-1, R-27a, OPS-1…) là id task trên Hive. Mục có **Xong khi** (tiêu chí) và **Test** (tự động hay kiểm tay, ở đâu).
- Thứ tự: G1 rồi G2, G3. G4 làm song song. Trong một nhóm, làm từ trên xuống.
- Trạng thái thật nằm ở task trên Hive. Trang này chỉ đổi khi thêm, bớt hay đổi mục.

## Hiện trạng (1/10, bản 0.88.0)

- 499 test: 498 qua, 0 lỗi. Độ phủ dòng 97% trên các file mà test tải tới. Thấp nhất: `updater.ts` 72%, `docdraft.ts` 77%, `hub-client.ts` 77%, `kill.ts` 79%.
- Phần test không tải tới: main process Electron (`apps/desktop/src/main/index.ts`, chỉ có smoke), `apps/web/src/server.ts`, CLI hub, script phát hành, và mọi trang React. Trang React mới chỉ được kiểm bằng script chụp màn hình chạy tay, không nằm trong repo.
- 15 mục roadmap còn mở. Trong đó 18c và 18d đang chờ câu trả lời.
- Chỉ R-18e (agent trên Mac mini) và R-26 đi trọn vòng qua task Hive.

## G1. Kiểm chứng những gì đã làm

- **QA-1. e2e cho web trong repo.** `npm run e2e -w @xdev-hive/web` dựng một hub tạm (bản build production, DB tạm, token admin), seed dữ liệu, rồi chạy trình duyệt headless qua các luồng:
  - đăng nhập bằng token;
  - Tài liệu: trình soạn Tiptap (menu `/`, bảng, liên kết trang), Markdown, Mermaid (vẽ, báo lỗi);
  - Đề xuất và Memory: duyệt hàng loạt;
  - phân quyền: hộp Phân quyền, trang Thành viên; reviewer duyệt được tài liệu thường nhưng không duyệt được AGENTS.md;
  - trang Hub, tệp tài liệu.

  Mỗi luồng chụp ảnh vào thư mục chỉ định; một bước hỏng thì lệnh thoát khác 0.
  Xong khi: chạy được trên máy sạch (`npm ci`); README ghi cách chạy; AGENTS.md nói chạy nó khi đổi giao diện web.
  Test: chính lệnh này.
- **QA-2. Smoke desktop phủ phần mới.** `npm run smoke` thêm:
  - thêm tài khoản Claude và ChatGPT (gói mới, thư mục đăng nhập riêng, script đăng nhập đúng lệnh, gói tính là chưa đăng nhập);
  - đồng bộ tài liệu từ repo (dự án demo có `.xdev-hive/docs.json`);
  - trang Tài liệu trong app (Tiptap, Mermaid với CSP của app).

  Xong khi: smoke kiểm các điều đó, không chỉ chụp ảnh.
- **QA-3. CLI của hub.** Test cho `npm run files -- restore` (đưa tệp từ backup vào filer giả, bỏ tệp sai SHA-256), `backup` và `token`, chạy CLI thật bằng `node`.
- **QA-4. Script phát hành.** Tách phần tải lên hub ra module test được. Test với hub giả: bỏ qua tệp đã có, gửi lại tệp bị cắt từ phần đầu, dừng sau 3 lần.
- **QA-5. MR watcher khi máy thiếu Review code.** MR đã merge mà tài khoản của máy không có quyền Review code: task ở lại *Review*, ghi chú thêm dòng "MR đã merge, chờ người có quyền Review code chuyển Xong", Hôm nay của reviewer có mục đó. Có test.
- **QA-6. Độ phủ thấp.** Thêm test cho các nhánh chưa chạy của `updater.ts` (tải lỗi, sai SHA-256, cài khi thoát), `docdraft.ts` (outbox), `hub-client.ts` (mất mạng, lỗi có key), `kill.ts`. Xong khi: mỗi file ít nhất 90% dòng.
- **QA-7. Kiểm tay trên máy thật**, mỗi cái một ghi chú kết quả trên task:
  - Windows: đóng cửa sổ thì app ở khay và vẫn nhận run; bấm biểu tượng mở lại; *Mở cùng máy* chạy ẩn sau khi khởi động lại máy. Cần một máy Windows (win-2?).
  - Đăng nhập tài khoản Claude thứ hai và ChatGPT thật trên Mac mini (thường, SSO, mã thiết bị); run sau đó chạy vào gói còn nhiều quota nhất.
  - Linux: khay và AppImage (nếu có máy).

## G2. Quản trị agent (roadmap 27)

Xếp theo nghiên cứu ngày 1/10 (GitHub Agent HQ, Codex, Cursor, Devin, Factory, Claude Code, Entra Agent ID, AgentCore).

Spec: [`docs/specs/27a-agent-policy.md`](specs/27a-agent-policy.md) cho 27a, [`docs/specs/27bcd-governance.md`](specs/27bcd-governance.md) cho 27b, 27c và 27d. Phần code do agent `claude-1` trên Mac mini làm qua task Hive. Người merge chạy typecheck, test, e2e và smoke rồi mới phát hành.

- **R-27a. Chính sách agent theo dự án** (chia thành R-27a-1 cho hub và giao diện, R-27a-2 cho runner). Hub giữ cho từng dự án (và mặc định cho cả hub):
  - model được dùng;
  - mức tự chủ: chỉ đọc / đề xuất / sửa / đầy đủ;
  - mạng: tắt / allowlist / mở;
  - MCP được phép.

  Máy nhận qua heartbeat; runner ép khi chạy: chọn model, cờ quyền của CLI, chặn profile không hợp lệ, container với mạng theo chính sách. Cấp dưới (profile, dự án) không nới được. Trang *Chính sách* sửa được.
  Test: unit cho việc gộp chính sách và cờ CLI sinh ra; e2e đặt chính sách chỉ đọc thì run không sửa được file.
- **R-27b. Trần chi tiêu.** Trần theo dự án và theo tài khoản, cho mỗi ngày hoặc mỗi tháng, tính bằng ước tính USD hoặc số run. Cảnh báo ở 70% và 90% (Cảnh báo, webhook). Hết trần thì không giao run mới, và *Hàng đợi* ghi lý do. Admin nâng trần được.
  Test: unit cho việc tính trần; hub test cho việc từ chối giao run.
- **R-27c. Nhật ký agent và không tự duyệt.**
  - Mỗi việc agent ghi lên hub (task, tài liệu, memory, đề xuất, run) có: agent, thay mặt ai, run nào.
  - Trang *Nhật ký* lọc được theo agent hoặc người.
  - Người yêu cầu một run, hay người viết một đề xuất, không tự duyệt kết quả của nó (hub từ chối, có khoá lỗi). Admin hub là ngoại lệ, nếu bật.

  Test: hub test.
- **R-27d. Dừng mọi agent.** Nút trên Web Admin, cho một dự án hoặc cả hub:
  - huỷ hàng đợi;
  - gửi lệnh dừng run đang chạy (máy nhận ở heartbeat);
  - tạm ngưng nhận run mới cho tới khi bật lại.

  Mọi lần bấm đều ghi nhật ký.
  Test: hub test và runner test (máy dừng run khi nhận lệnh).

## G3. Roadmap còn mở

- **R-21a / R-21b / R-21c. Vòng đời MR:**
  - MR bị đóng mà không merge thì task sang trạng thái đã chọn;
  - MR merge xong thì xoá worktree và branch;
  - chu kỳ hỏi GitLab/GitHub chỉnh được.
- **R-22m-2. Thông báo hệ điều hành** trên app desktop cho admin khi hub mở cảnh báo.
- **R-22n-2. Nút "Yêu cầu máy đồng bộ"** (phần "Chưa có" của 22n).
- **R-19c / R-19d.** Tài liệu và memory của một hệ thống (nhiều service); task phụ thuộc chéo dự án và leader ở mức hệ thống.
- **R-20a → R-20d. Spec Kit:** cài đặt, trang Spec, nhập `tasks.md` thành task, run cho specify / plan / tasks. Spec: [docs/specs/20-speckit.md](specs/20-speckit.md).
- **R-18c / R-18d.** Đã trả lời 2/10:
  - 18c: merge bằng token của máy; hub chỉ ghi yêu cầu, máy nhận qua heartbeat.
  - 18d: chỉ admin hub và chủ máy đổi được gói của máy.
- **R-28a → R-28d. Danh mục tool** (hỏi 2/10): danh mục tool trên hub thay cho codegraph, superpowers, Spec Kit viết cứng; runner sinh MCP và hook theo danh mục; đo token có tách cache; RTK; leader trong chat đọc và đề xuất về tool (28e). 28b chờ 28a, 28d chờ 28b và 28c, 28e chờ 28b và 28c.
- **R-29a → R-29c. Chat làm orchestrator** (hỏi 2/10): leader đọc chi phí, cảnh báo, hàng đợi, chính sách; đề xuất mọi thao tác web đã có (huỷ, merge, gói, chính sách, dừng agent, cài); dự án chọn loại việc leader tự chạy (mặc định chờ duyệt hết). 29c chờ 29b.

## G4. Vận hành (làm song song)

- **OPS-1. Bản mới nhất trên mọi máy.** Đặt bản đích trên *Phiên bản app* sau mỗi lần phát hành (đang là 0.88.0, hỏi người dùng trước khi cài). Xong khi: *Phiên bản app* cho thấy mọi máy ở bản đích.
- **OPS-2. Diễn tập khôi phục.** Trên một hub tạm:
  - khôi phục DB từ một bản backup thật của .52;
  - đưa tệp từ `backups/files` vào một SeaweedFS mới bằng `npm run files -- restore`;
  - kiểm ảnh trong tài liệu hiện đủ.

  Ghi lại thời gian và các bước vào README.
- **OPS-3. Nhật ký hub.** Xem log của .52 sau mỗi lần deploy (lỗi lặp lại, SeaweedFS, mirror). Một lỗi lặp lại thì thành task.
