# @xdev-hive/skill-pack

Bộ skill mặc định của Hive: mọi tổ chức thấy ở trang Skills với nhãn "Hive mặc định", bật/tắt theo tổ chức và theo
dự án; run nhận qua `skill_list`/`skill_get`, worker chép skill đã bật vào worktree cho Claude Code.

## Nguồn

Nguồn là submodule `xdev-skills/` ở gốc repo, trỏ tới
[tdduydev/xdev-skills](https://github.com/tdduydev/xdev-skills). Kho đó giữ danh sách, giấy phép và commit gốc
của từng skill (`sources.json`, `library/<tên>/SOURCE.md`, `NOTICE.md`). `pull` lấy nội dung từ HEAD của submodule,
ghi commit đó vào `pack.json` → `source.commit`; `check` bắt buộc hai commit và toàn bộ bản sao khớp nhau.

Giữ bản vendored trong `skills/` vì hub/Node, image Docker và mã gửi qua `deploy/remote.sh` (`git archive` không
chứa nội dung submodule) phải chạy được không cần Git, mạng hay token GitHub. Test của package kiểm hash bản vendored
mà không cần submodule. Chỉ job TypeScript của CI tải submodule để kiểm nguồn; job Docker, worker và desktop dùng
bản vendored. Biome bỏ qua `xdev-skills/`; glob workspace chỉ lấy `apps/*`, `packages/*`, nên pnpm/Turbo không nhận
package trong kho skill làm package của Hive.

## Clone và worktree mới cho agent

Chạy tại gốc mỗi clone/worktree cần sửa hoặc kiểm đồng bộ skill:

```bash
git submodule update --init xdev-skills
node packages/skill-pack/scripts/sync.ts check
```

Git không tự khởi tạo submodule khi tạo worktree. Sau khi chuyển nhánh hoặc lấy thay đổi có bump gitlink, chạy lại
`git submodule update --init xdev-skills` để lấy đúng commit được nhánh ghim. `pnpm ci:local` và hook pre-push kiểm
đồng bộ khi submodule, `.gitmodules` hoặc skill-pack đổi; nếu thiếu submodule thì báo lệnh khởi tạo, không tự clone tạm.

## Cập nhật

```bash
# Sau khi PR ở xdev-skills đã merge, chọn commit đã duyệt:
git -C xdev-skills fetch origin main
git -C xdev-skills checkout --detach <commit-da-merge>
node packages/skill-pack/scripts/sync.ts pull
node packages/skill-pack/scripts/sync.ts check
node packages/skill-pack/scripts/sync.ts dev  # nếu muốn cập nhật skill UI cho agent của Hive
git add xdev-skills packages/skill-pack
pnpm ci:local
```

Với skill tự viết: tạo nhánh trong `xdev-skills/`, sửa `library/<tên>/` cùng khai báo trong `sources.json`, chạy
`node scripts/update-skills.mjs --check` từ kho đó, commit và mở PR **ở repo xdev-skills** trước. Sau khi merge,
làm các bước trên rồi commit gitlink và bản vendored cùng nhau ở xdev-hive.
Không sửa trực tiếp `packages/skill-pack/skills/`: lần `pull` kế tiếp sẽ ghi đè. `pull/check` yêu cầu cây
submodule sạch, kể cả file chưa track; dọn cả file bị Git ignore trong `library/` để commit trong manifest mô tả
đúng nội dung đóng gói.

Gói chỉ nhận file chữ UTF-8 (gửi qua JSON cho worker và app desktop); file nhị phân phải được loại ở `sources.json`
của xdev-skills (`exclude`). Skill nào bật sẵn cho tổ chức mới do `defaultOn` trong `sources.json` quyết định.

Giấy phép: xem `NOTICE.md` và `skills/<tên>/LICENSE*`, `skills/<tên>/SOURCE.md`. Skill của Trail of Bits theo
CC BY-SA 4.0, không phải MIT.
