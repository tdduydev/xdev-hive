# Data Model: Cache để agent đỡ tốn token

**Feature**: [spec.md](./spec.md) · **Research**: [research.md](./research.md)

Theo cách làm sẵn có, mọi bảng/cột mới là chuỗi SQL **nối vào cuối** `MIGRATIONS` trong `packages/core/src/sqlite.ts`. `#migrate` áp theo `PRAGMA user_version`, nên không được chèn vào giữa (xem chú thích ở `sqlite.ts:900`). Thời gian lưu dạng ISO text như các bảng khác.

## 1. Context prefix (phần đầu ngữ cảnh)

Máy tính lúc dựng prompt, rồi gửi kèm báo cáo cost của run. Không lưu nguyên văn prompt (FR-018).

Lưu trong `run_costs` (thêm cột):

| Cột | Kiểu | Ý nghĩa |
|---|---|---|
| `prefix_fp` | TEXT NULL | `sha256` hex của phần đầu (xem [contracts/run-prompt-layout.md](./contracts/run-prompt-layout.md)). NULL nếu app cũ. |
| `prefix_parts` | TEXT NULL | JSON `PrefixPart[]`, đã sắp theo thứ tự trong prompt |
| `prefix_chars` | INTEGER NULL | cỡ phần đầu (ký tự). Token ước tính = ký tự ÷ 4 |

```ts
// packages/core/src/types.ts
type PrefixPart =
  | { kind: "protocol"; hash: string }            // giao thức chung (prompt-layers)
  | { kind: "tools"; hash: string; count: number } // danh sách tool MCP đã chuẩn hoá
  | { kind: "doc"; key: string; version: number }  // AGENTS.md, CLAUDE.md, rule ghi vào worktree
  | { kind: "skill"; key: string; version: number }
  | { kind: "step"; hash: string };                // step prompt của vai trò
```

**Rules**:

- Hai run có cùng `(project, agentKind, role)` và cùng `prefix_parts` MUST có cùng `prefix_fp` (FR-001).
- `prefix_parts` không chứa id task, id run, worktree, SHA, thời gian, máy (FR-002).
- Thứ tự `kind` trong mảng: `protocol` → `tools` → `doc` → `skill` → `step` (FR-004).

## 2. Read receipt (biên nhận đọc): bảng `run_reads`

```sql
CREATE TABLE run_reads(
  run TEXT NOT NULL,          -- actor.runCredential.run
  kind TEXT NOT NULL,         -- 'doc' | 'skill' | 'digest' | 'memory'
  key TEXT NOT NULL,          -- doc key; với memory: sha256(project|query|limit)
  version INTEGER,            -- doc/skill/digest: phiên bản đã trả; memory: NULL
  hash TEXT,                  -- memory: sha256 tập kết quả + cờ; doc: NULL
  chars INTEGER NOT NULL,     -- cỡ nội dung đầy đủ đã trả, để ước token tránh được
  hits INTEGER NOT NULL DEFAULT 0, -- số lần trả "không đổi"/"giống lần trước"
  at TEXT NOT NULL,
  PRIMARY KEY(run, kind, key)
);
CREATE INDEX run_reads_at ON run_reads(at);
```

**Rules**:

- Chỉ ghi khi actor có `runCredential` (token `hiverun_…`). Leader/chat không có biên nhận.
- Ghi (UPSERT) khi trả nội dung đầy đủ. Tăng `hits` khi trả "không đổi".
- Trả "không đổi" chỉ khi: quyền đọc vẫn còn, `removed_at IS NULL`, và `version` bằng phiên bản hiện tại (FR-008).
- Memory: `hash = sha256(JSON [(id, updatedAt, review, stale, supersededBy, conflictsWith)…])` theo thứ tự trả. Bất kỳ cờ nào đổi thì hash đổi (FR-009).
- Dọn: xoá dòng có `at` cũ hơn 48 giờ trong `cleanupRound` (`apps/web/src/server.ts:116`).
- Hub khởi động lại không mất bảng. Mất bảng (khôi phục snapshot) chỉ làm lần đọc sau trả bản đầy đủ, không bao giờ trả sai.

**State**: `(không có dòng)` → đọc đầy đủ → `(có dòng, version=N)` → đọc lại, N vẫn mới nhất → `hits+1` → tài liệu lên N+1, đọc lại → UPSERT `version=N+1`.

## 3. Doc digest (bản rút gọn tài liệu): bảng `doc_digests`

```sql
CREATE TABLE doc_digests(
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  toc TEXT NOT NULL,          -- JSON DigestSection[]
  summary TEXT,               -- NULL nếu không có đoạn mở đầu (FR-012, hướng tạm)
  chars INTEGER NOT NULL,     -- cỡ cả tài liệu
  created_at TEXT NOT NULL,
  PRIMARY KEY(key, version)
);
```

```ts
type DigestSection = { id: string; title: string; level: 1 | 2 | 3; chars: number };
// id: slug của tiêu đề, thêm hậu tố -2, -3 nếu trùng; dùng làm `section` của doc_get (80c)
```

**Rules**:

- Làm một lần cho mỗi `(key, version)`, làm lười ở lần đọc đầu (FR-013). Hàm tất định `buildDigest(content)` nằm trong `packages/core/src/doc-digest.ts` (mới).
- Đọc digest luôn theo `version` hiện tại của `docs`, nên không bao giờ trả digest của phiên bản cũ (US3-AS2).
- `summary`: đoạn trước tiêu đề `##` đầu tiên, bỏ tiêu đề `#`, cắt ~800 ký tự ở ranh giới câu. [Hướng tạm, chờ FR-012]
- Chỉ áp cho tài liệu có `chars / 4 > 4000` (FR-011). Tài liệu ngắn hơn thì trả cả nội dung như hôm nay.
- Dọn: xoá dòng có `version < docs.version` của cùng key trong `cleanupRound`.

## 4. Machine copy (bản sao trên máy)

File trên máy, không phải bảng. [Hướng tạm (b), chờ FR-016]

```
<appData>/doc-cache/<hubId>/<accountId>/<project>/
  manifest.json            # { [key]: version }
  <sha256(key)>.json       # { key, version, content }
```

**Rules**:

- Run mới: `docs.manifest({project})`, so với `manifest.json`, chỉ `docs.get` key lệch (FR-015).
- Xoá `<hubId>/<accountId>/` khi đăng xuất. Xoá `<project>/` khi hub gỡ dự án khỏi máy (`machine-projects.ts`), hoặc khi `docs.manifest` trả lỗi quyền (FR-017).
- Không ghi token/credential vào thư mục này. Quyền thư mục 0700 trên macOS/Linux (FR-018).
- `renderContext` (`apps/desktop/src/main/sync.ts:278`) đọc từ bản sao thay vì gọi `docs.get` từng tài liệu.

## 5. Cache metrics (số đo cache)

Không có bảng mới: số đo gộp từ `run_costs` (cột sẵn có `cache_write_tokens`, `cache_read_tokens`, cột mới ở mục 1) và từ `run_reads`.

```ts
// thêm vào kết quả costs.summary (methods.ts:1115/1479)
type CacheSummary = {
  writePerRun: number | null;      // trung bình cache_write_tokens / run có số
  readRatio: number | null;        // cache_read / (input + cache_read + cache_write)
  unchangedHits: number;           // SUM(run_reads.hits)
  avoidedTokensEst: number;        // SUM(run_reads.hits * chars / 4), ghi rõ là ước tính
  unknownRuns: number;             // run của loại agent không báo cache write (FR-022)
  prefixChanges: number;           // số lần prefix_fp đổi so với run trước cùng (project, kind, role)
  expiredRuns: number;             // cùng prefix_fp với run trước nhưng ghi lại cache (hết hạn, không phải vỡ)
};
```

**Rules**:

- `cacheWriteKnown(kind)`: Claude, Kilo, OpenCode = true. Codex, Gemini, loại khác = false, nên `writePerRun` không tính các run đó (FR-022, R6).
- Cảnh báo `cache_write_spike` (FR-021): `writePerRun(24h) > 2 × writePerRun(8 ngày trước → 1 ngày trước)` và ≥ 5 run trong 24h. Nội dung cảnh báo là các `PrefixPart` khác nhau giữa run gần nhất và `prefix_parts` thường gặp nhất của kỳ trước.

## Quan hệ

```
docs(key, version) 1──* doc_digests(key, version)
docs(key, version) 1──* run_reads(kind∈{doc,skill,digest}, key, version)
runs(id) 1──1 run_costs(run, prefix_fp, prefix_parts, …)
runs(id) 1──* run_reads(run)
```
