# 39. Client dễ dùng hơn

Viết ngày 3/10. Sau khi nối dự án khách hàng vào Hive, người dùng nói: "client làm giao diện lại dễ sử dụng hơn đi". Ngày 3/10 họ chọn:
- **sửa các màn hiện có và thêm luồng *Bắt đầu*** cho máy mới, giữ thiết kế của roadmap 22 (token, màu, font, logo);
- **làm cả bốn chỗ**: cài máy và dự án mới, Agent và quota, Cài đặt kết nối, Lượt chạy;
- **làm cả chế độ cục bộ**, không chỉ chế độ hub.

Mỗi bước phát hành kèm ảnh chụp trước và sau, như roadmap 35. Ảnh "trước" là ảnh smoke của main 7fd1ff6 (0.120.0), các bước `hub-*` và các trang chế độ cục bộ.

## Vấn đề thấy trên ảnh chụp (3/10)

**Chế độ hub** (5 mục, `DESK_GROUPS` trong `packages/ui/src/App.tsx:189`):
- *Dự án & công cụ* (`pages/Setup.tsx`):
  - mỗi repo có khoảng 6 dòng (Cấu hình agent, codegraph, Index codegraph, superpowers…), mỗi dòng một nút;
  - chữ chính là tên file và lệnh (`.mcp.json`, `.gemini/settings.json`, `uv tool install …`);
  - với dự án khách hàng 8 repo, trang này có khoảng 50 dòng và khoảng 50 lần bấm.
- *Agent và quota* (`pages/Agents.tsx`):
  - 9 gói thì 8 dòng lặp `agents.noUsage` ("Chưa có số liệu mức dùng…");
  - trạng thái *Chưa đăng nhập* hay *Tắt* hiện trong bảng, nhưng nút sửa nằm ở *Quản lý gói* bên dưới;
  - dưới bảng có một đoạn giải thích dài.
- *Cài đặt* (`pages/Projects.tsx`): URL hub, hai cách đăng nhập, đăng nhập qua trình duyệt, tên máy kèm đường dẫn `config.json`, và 2 ô tích hiện cùng lúc, kể cả khi máy đã kết nối.
- *Lượt chạy* (`pages/Runs.tsx`):
  - mã run, tên gói và log thô nổi hơn tên task và kết quả;
  - phụ đề `navSub.runsOn` ghi "và máy khác trong nhóm", trái với 35a.
- Chưa có luồng nào cho máy mới. Người dùng phải tự biết thứ tự: kết nối hub → cài CLI và `hive-mcp` → thêm repo → cài cấu hình từng repo → đăng nhập gói → bật nhận việc. Phần lớn những chỗ phải đi vòng ở roadmap 38 nằm trong luồng này.

**Chế độ cục bộ** (`LOCAL_GROUPS`, `App.tsx:162`):
- Menu có khoảng 20 mục trong 5 nhóm, phải cuộn ở cửa sổ 1440×900.
- Có cả *Board* lẫn *Task*; trên web, *Task* đã mở vào Board (7468a3d).
- Ba chỗ nghe như cài đặt: *Dự án & công cụ*, *Tool* (danh mục của hub, kèm dòng "Máy dùng danh mục này từ bản app có 28b…") và *Cài đặt*.
- *Board* (`pages/Board.tsx`) cuộn ngang ở bề rộng khoảng 1100px (cột *Bị chặn* bị cắt). Dải gói ở đầu (tên gói kèm trạng thái) chiếm hai dòng.
- *Skill*: panel chi tiết hiện "(chưa có mô tả)" và `SKILL.md` "—", trong khi danh sách có mô tả. Hai nút *Sửa skill* và *Ghi vào repo trên máy* bị mờ. [Unverified] Có thể do dữ liệu smoke; phải kiểm.
- Phụ đề trang viết bằng đường dẫn thay vì lời người dùng, ví dụ `navSub.skills` "Ghi vào .claude/skills khi đồng bộ repo".

## Nguyên tắc chung cho mọi task

- Câu chính viết bằng lời người dùng. Đường dẫn, lệnh, tên file, mã run đưa vào phần *Chi tiết* gập lại, hoặc chữ phụ nhỏ.
- Mỗi vấn đề kèm đúng một nút làm tiếp ngay tại chỗ. Không bắt người dùng sang trang khác để sửa thứ trang này báo.
- Phần đã ổn thì gập lại; phần cần làm lên đầu.
- Giữ token và component của DS (`packages/ui/src/tokens/`, [[ban-thiet-ke-2026-09]]). Không thêm màu hay font.
- Chữ mới có trong `vi.ts` (bản gốc) và `en.ts`. Bỏ key không còn dùng.
- Các trang dùng chung với web: thay đổi áp cho cả web. e2e web phải xanh.
- Smoke chụp thêm bước cho mỗi màn mới, ở cả chế độ hub và cục bộ khi trang có ở cả hai.
- Agent không tăng version, không đánh dấu roadmap: người merge làm và phát hành kèm ảnh trước và sau.

## Thứ tự

```
R-38b, R-38d, R-38e ── 39b ── 39a
39c   39d   39e                 (giao được ngay)
39f   39g   39h                 (chế độ cục bộ, giao sau đợt đầu để đỡ xung đột i18n)
```

## R-39a. Luồng *Bắt đầu* cho máy mới

- Trang *Bắt đầu*:
  - mở tự động khi máy chưa sẵn sàng (chưa kết nối hub ở chế độ hub, chưa có dự án, chưa có gói đăng nhập);
  - mở lại được từ *Hôm nay* và từ ⌘K.
- Các bước, mỗi bước một thẻ có trạng thái (xong / cần làm / bỏ qua được):
  1. **Kết nối**: nút chính *Đăng nhập qua trình duyệt*. URL hub, dán token và đăng nhập bằng mật khẩu để ở *Nâng cao*. Có lựa chọn *Dùng một mình trên máy này* (chế độ cục bộ).
  2. **Công cụ**: CLI (Claude Code, Codex, Gemini) và `hive-mcp` kèm *Thêm vào PATH* (R-38b), với một nút *Cài những gì còn thiếu*.
  3. **Dự án**: chọn thư mục, trong đó repo con được nhận ra (R-38d), hoặc nhập group GitLab (R-38e). Sau đó *Cài hết* cho mọi dự án vừa thêm (dùng thẻ của 39b).
  4. **Gói agent**: mỗi gói có nút *Đăng nhập*, gói nào xong thì đánh dấu.
  5. **Nhận việc** (chế độ hub): bật nhận run từ hub, chọn tối đa cùng lúc.
- Còn bước chưa xong thì *Hôm nay* có một mục "Máy này chưa sẵn sàng: còn n bước", mở thẳng *Bắt đầu*.
- **Xong khi**:
  - có test cho phần tính trạng thái từng bước từ dữ liệu sẵn có (không gọi thêm method mới nếu không cần);
  - smoke chụp *Bắt đầu* ở máy trống và ở máy đã xong một nửa;
  - README có đoạn hướng dẫn máy mới theo luồng này.

## R-39b. *Dự án & công cụ* theo thẻ

- Phần *Công cụ trên máy* gọn lại:
  - đã cài và đúng bản thì chỉ một dòng "Đã sẵn sàng: Claude Code 2.1.288, Codex 0.160.0…", bấm để xem chi tiết;
  - mục thiếu hay có bản mới thì hiện riêng kèm nút.
- Dự án gom theo hệ thống (`systems.list`), dự án ngoài hệ thống để cuối. Mỗi dự án là một thẻ gập, gồm:
  - tên, thư mục rút gọn, nhánh đích;
  - trạng thái "Sẵn sàng" hoặc "Thiếu n mục";
  - nút *Cài hết* chạy lần lượt các mục còn thiếu của dự án, có tiến độ, lỗi mục nào thì dừng ở mục đó và báo.
- Mở thẻ ra thì thấy từng mục như hiện nay. Tên file và lệnh nằm trong *Chi tiết*.
- Hệ thống có nút *Cài hết cho hệ thống*.
- Dải "n mục chưa sẵn sàng" ở đầu trang có nút *Cài hết những gì còn thiếu*.
- **Xong khi**:
  - có test cho phần gom nhóm và thứ tự cài;
  - smoke chụp trang khi có 2 dự án trong một hệ thống và 1 dự án ngoài, ở cả trạng thái thiếu lẫn đã sẵn sàng.
- Phụ thuộc R-38b, R-38d, R-38e vì cùng sửa trang này: nút PATH, thêm dự án, nhập GitLab.

## R-39c. *Agent và quota* sửa ngay tại chỗ

- Mỗi gói một dòng, gồm:
  - tên;
  - CLI và phiên bản;
  - trạng thái;
  - thanh phiên và tuần khi có số liệu;
  - nút ngay trong dòng: *Đăng nhập* (chưa đăng nhập), *Bật* / *Tắt*, *Nâng cấp CLI* (khi có bản mới), và menu *…* gồm *Sửa*, *Mở CLI*, *Xoá*.
- Gói không có số liệu mức dùng thì ô đó để "—", kèm một chú thích duy nhất dưới bảng thay cho câu lặp ở từng dòng.
- Gói đang tắt gập vào nhóm "n gói đang tắt".
- Đoạn giải thích ngưỡng dừng chuyển vào biểu tượng (?) cạnh tiêu đề cột.
- *Quản lý gói* giữ form thêm và sửa. Nút *Thêm gói* lên đầu trang.
- **Xong khi**: smoke chụp bảng có gói chưa đăng nhập, gói tắt và gói có số liệu. Bấm *Đăng nhập* trong dòng chạy đúng luồng 2e như nút cũ.

## R-39d. *Cài đặt* chỉ hiện tóm tắt khi đã kết nối

- Đã kết nối thì thẻ đầu trang ghi: "Đã kết nối `<hub>` · tài khoản `<tên>` · máy `<tên máy>`", kèm trạng thái kết nối (22h) và hai nút *Đổi kết nối*, *Ngắt kết nối*. Form đăng nhập chỉ hiện khi bấm *Đổi kết nối* hoặc khi chưa kết nối.
- Chưa kết nối thì nút chính là *Đăng nhập qua trình duyệt*. Mật khẩu và token để ở *Cách khác*.
- Các mục sau vào *Nâng cao* (gập): tên máy và đường dẫn `config.json`, *Memory phải được duyệt*, *Tự commit khi đồng bộ* (38c sẽ thay ô này bằng chế độ đồng bộ), chuyển dữ liệu máy ↔ hub.
- GitLab và GitHub mỗi bên một thẻ có trạng thái "Đã cấu hình / Chưa", form gập.
- **Xong khi**: smoke chụp trang ở trạng thái đã kết nối và chưa kết nối. Lưu cài đặt vẫn như cũ (không đổi config).

## R-39e. *Lượt chạy* dễ đọc

- Dòng trong danh sách:
  - tên task là chữ chính;
  - dưới là kết quả bằng lời ("Xong · 1 commit · MR !12", "Lỗi: …", "Đang chạy · Viết code"), gói và giờ;
  - mã run và mã task thành chữ phụ.
- Chi tiết run:
  - đầu trang là tóm tắt (câu trả lời cuối của agent), các bước (22l), MR/CI, và nút chính theo trạng thái (*Mở MR*, *Chạy lại*, *Huỷ*);
  - log để ở tab *Log*, không mở sẵn;
  - phần `# profile …` và `# policy …` gập vào *Chi tiết kỹ thuật*.
- Lọc nhanh: *Đang chạy*, *Lỗi*, *Xong*.
- Phụ đề `navSub.runsOn` đổi thành "Run trên máy này", vì ở cả hai chế độ app chỉ hiện run của máy.
- **Xong khi**: smoke chụp danh sách có run xong, run lỗi và run đang chạy, và chi tiết run mở ở phần tóm tắt.

## R-39f. Menu chế độ cục bộ gọn

- Ở cửa sổ 1440×900, menu chế độ cục bộ không phải cuộn. Mục tiêu khoảng 12 mục.
- *Board* gộp vào *Task* như web: *Task* mở vào Board, có chế độ *Danh sách*.
- *Đợt chạy* thành một tab của *Lượt chạy*.
- *Tool* chuyển vào *Dự án & công cụ* (phần "Tool của dự án"). Ở chế độ cục bộ thì bỏ dòng nhắc bản app 28b.
- Nhóm *Quản trị* (Bản đồ agent, Người dùng, Thành viên, Token, Hệ thống) gộp thành một mục *Quản trị* có tab, hoặc một nhóm gập mặc định.
- Địa chỉ cũ chuyển sang trang mới. ⌘K vẫn tìm được mọi trang. Phím ⌘1–6 đổi theo menu mới.
- **Xong khi**: có test cho bảng chuyển địa chỉ, và smoke chụp menu cục bộ ở 1440×900.

## R-39g. Board vừa màn hình

- Ở bề rộng khoảng 1100px, *Board* không cuộn ngang:
  - cột co lại;
  - *Xong* và *Bị chặn* thu thành cột hẹp có số đếm khi trống hoặc khi màn hẹp, bấm thì mở ra.
- Dải gói ở đầu thành một chip tóm tắt, ví dụ "5/7 gói sẵn sàng · 1 đang nghỉ", bấm mở *Agent và quota* (trên web thì *Máy & run*).
- Trang dùng chung với *Task* trên web, nên e2e web phải xanh.
- **Xong khi**: smoke chụp Board ở 1100px và 1440px.

## R-39h. Các trang Kiến thức

Áp cho *Tài liệu*, *Spec*, *Skill*, *Memory*, *Đề xuất*:
- Kiểm và sửa panel chi tiết của *Skill* (xem phần vấn đề). Nếu là lỗi thật thì thêm test.
- Phụ đề trang (`navSub.*`) viết bằng lời người dùng. Ví dụ *Skill*: "Hướng dẫn cho agent, đồng bộ vào repo".
- Mỗi trang có trạng thái trống kèm việc nên làm, ví dụ "Chưa có skill nào. Tạo skill đầu tiên" kèm nút.
- Nút chính của mỗi trang ở cùng một chỗ (góc phải thanh công cụ của trang).
- **Xong khi**: smoke chụp trạng thái trống của *Skill* và *Memory*. e2e web xanh.
- Rủi ro: R-36b (các trang theo phạm vi) cũng sửa những trang này. Nếu 36b đã merge thì làm trên bản đó, không đụng bộ chọn phạm vi.
