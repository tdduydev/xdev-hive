# @xdev-hive/skill-pack

Bộ skill mặc định của Hive: mọi tổ chức thấy ở trang Skills với nhãn "Hive mặc định", bật/tắt theo tổ chức và theo
dự án; run nhận qua `skill_list`/`skill_get`, worker chép skill đã bật vào worktree cho Claude Code.

## Nguồn

Một nguồn duy nhất: thư mục `library/` của kho [tdduydev/xdev-skills](https://github.com/tdduydev/xdev-skills). Kho đó
giữ danh sách, giấy phép và commit gốc của từng skill (`sources.json`, `library/<tên>/SOURCE.md`, `NOTICE.md`). Ở đây
là bản sao ghim theo commit (`pack.json` → `source.commit`), vì hub phải chạy được không cần mạng hay token GitHub, và
CI kiểm được bản sao không bị sửa tay (`src/index.test.ts` so hash từng thư mục).

## Cập nhật

```bash
# Trong bản clone xdev-skills, nhánh đã merge, cây sạch:
node packages/skill-pack/scripts/sync.ts pull ../xdev-skills    # chép library/, ghi pack.json với commit HEAD
node packages/skill-pack/scripts/sync.ts check ../xdev-skills   # kiểm bản sao khớp commit đã ghim
node packages/skill-pack/scripts/sync.ts dev                    # chép skill UI vào .claude/skills của repo này
```

Gói chỉ nhận file chữ UTF-8 (gửi qua JSON cho worker và app desktop); file nhị phân phải được loại ở `sources.json`
của xdev-skills (`exclude`). Skill nào bật sẵn cho tổ chức mới do `defaultOn` trong `sources.json` quyết định.

Giấy phép: xem `NOTICE.md` và `skills/<tên>/LICENSE*`, `skills/<tên>/SOURCE.md`. Skill của Trail of Bits theo
CC BY-SA 4.0, không phải MIT.
