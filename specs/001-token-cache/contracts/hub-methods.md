# Contract: method hub (`/api/rpc`, `packages/core/src/methods.ts`)

Schema input khai trong `methods.ts` (các dòng hiện có: `docs.get` ở 323, `costs.summary` ở 1115/1479/1714). Quyền tối thiểu khai ở bảng min-role (`methods.ts:1617+`). Thêm vào `AGENT_METHODS` (`sqlite.ts:2043`) những method mà run được gọi.

## `docs.get` (mở rộng)

```ts
input:  { key: string; have?: number; full?: boolean; section?: string; digest?: boolean }
output: Doc & { version: number; removedAt?: string }
      | { key: string; version: number; unchanged: true }
      | DocDigest   // { key, version, digest: true, chars, summary, toc }
```

- `digest:true` chỉ được MCP đặt khi tài liệu dài và agent không xin `full`/`section`. Gọi trực tiếp (web/desktop) không đặt thì nhận `Doc` như cũ, nên giao diện không đổi.
- Trả `removedAt` trong cùng câu trả lời, để `doc_get` chỉ cần gọi một lần.
- Biên nhận ghi ở đây (không ở MCP), vì `/mcp` không có phiên và `actor.runCredential` có ở tầng hub.

## `docs.manifest` (mới)

```ts
input:  { project: string }
output: { key: string; version: number; removed: boolean }[]
```

- Quyền như `docs.list` (`view` trên dự án, lọc `sees()`).
- Dùng cho bản sao trên máy (US5). Trả cả mục đã gỡ (`removed:true`), để máy xoá bản sao.

## `memory.search` (mở rộng)

```ts
input:  (như cũ) & { full?: boolean }
output: (như cũ) | { same: true; ids: string[] }
```

## `costs.summary` (mở rộng)

```ts
input:  (như cũ)            // khoảng 24h | 7d | 30d, theo dự án / gói
output: (như cũ) & { cache: CacheSummary; byProject: {…, cache: CacheSummary}[]; byProfile: {…, cache: CacheSummary}[] }
```

`CacheSummary`: xem [data-model.md §5](../data-model.md).

## Báo cáo cost của run (máy → hub, mở rộng)

Payload hiện có ở `apps/desktop/src/main/runner/runner.ts:1467-1482` thêm:

```ts
{ prefixFp?: string; prefixParts?: PrefixPart[]; prefixChars?: number }
```

Hub cũ bỏ qua trường lạ. App cũ không gửi, nên các cột là NULL và trang chi phí hiện "chưa rõ".

## Cảnh báo

`AlertRule` thêm `cache_write_spike` (`apps/web/src/alerts.ts`, mức `warn`), payload `{ project, writePerRun24h, writePerRunPrev, changedParts: PrefixPart[] }`.
