# Contract: tool MCP (agent thấy)

File: `packages/mcp/src/server.ts`. Mọi trường mới là **tuỳ chọn**, nên agent và prompt cũ vẫn chạy như hôm nay. Tổng mô tả thêm vào danh sách tool MUST ≤ 300 token (FR-010). Kiểm bằng test đo cỡ `tools/list`.

## `doc_get`

Input:

```ts
{
  key: string;
  have?: number;      // phiên bản agent đang có
  full?: boolean;     // luôn trả cả nội dung (bỏ qua have, biên nhận và digest)
  section?: string;   // từ 80c: id mục trong toc
}
```

Output (một trong các dạng):

```jsonc
// 1. Không đổi: < 100 token (SC-003)
{ "key": "…", "version": 7, "unchanged": true, "hint": "full:true for the content" }

// 2. Digest: tài liệu > ngưỡng, không section, không full (FR-011)
{ "key": "…", "version": 7, "digest": true, "chars": 107900,
  "summary": "…" | null,
  "toc": [{ "id": "1-bot-token", "title": "1. Bớt token", "level": 2, "chars": 9100 }],
  "hint": "section:<id> for one section, full:true for everything" }

// 3. Đầy đủ: như hôm nay (Doc), có thêm version
{ "key": "…", "version": 7, "content": "…", … }

// 4. Một mục (80c): nguyên văn (FR-014)
{ "key": "…", "version": 7, "section": "1-bot-token", "content": "…" }
```

Lỗi:

- Đã gỡ: `not_found: <key> was removed on <date>` (giữ nguyên chữ hiện tại).
- Không có quyền: lỗi quyền như hôm nay.
- Hai lỗi này MUST có ưu tiên hơn `unchanged` (FR-008).

Quy tắc chọn dạng (theo thứ tự):

1. Quyền + `removed_at`, có lỗi thì trả lỗi.
2. `full` thì trả dạng 3.
3. `section` thì trả dạng 4. Trả "không đổi" nếu biên nhận `(run, digest|doc, key)` có cùng version và cùng section đã trả. [Chi tiết section chờ 80c]
4. `have === version`, hoặc biên nhận `(run, doc, key, version)` khớp, thì trả dạng 1.
5. Tài liệu > ngưỡng thì trả dạng 2 (nếu đã trả digest cùng version trong run thì trả dạng 1).
6. Còn lại thì trả dạng 3.

## `skill_get`

Input: `{ name: string; project?: string; have?: number; full?: boolean }`.

- Quy tắc 1, 2, 4, 6 như `doc_get`. Không có digest (skill cần nguyên văn để làm theo).
- Thêm kiểm `removed_at`, điều mà hôm nay chưa có (`server.ts:386-405`).

## `memory_search`

Input: không đổi (`{project?, query?, limit?, verbose?}`) + `full?: boolean`.

Output thêm dạng:

```jsonc
{ "same": true, "ids": ["m_…", "m_…"], "hint": "same results and flags as your last identical search; full:true to list them" }
```

- Trả `same` chỉ khi có biên nhận `(run, memory, sha256(project|query|limit))` và `hash` của tập kết quả + cờ bằng nhau (FR-009).
- `use_count` / `last_used_at` vẫn được cập nhật như khi trả đầy đủ.

## `doc_list`

Không đổi trong 81 (80c lo phần gọn). Mỗi dòng đã có `version`, để agent dùng làm `have`.

## Mô tả tool (gợi ý, đếm token trong test)

- `doc_get`: "… Pass `have` (the version you already read) to get a short 'unchanged' reply; `full:true` always returns the content. Long docs return a contents list first; read one part with `section`."
- `skill_get`: "… `have`/`full` as in doc_get."
- `memory_search`: "… A repeated identical search in the same run returns `same:true` with ids; `full:true` lists them again."
