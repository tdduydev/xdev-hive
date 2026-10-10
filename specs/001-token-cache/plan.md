# Implementation Plan: Cache để agent đỡ tốn token (client, server, tài liệu)

**Branch**: `ai/SPEC-81` | **Date**: 2026-10-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-token-cache/spec.md`

**Note**: Plan này dựng bằng tay theo `.specify/templates/plan-template.md`: máy chạy không có `pwsh`, nên `setup-plan.ps1` không chạy được.

## Summary

Bớt token của agent bằng cách **dùng lại** thứ đã đọc, ở ba lớp:

1. **Phần đầu ngữ cảnh ổn định** (máy): đảo `buildPrompt` để phần giống nhau giữa các run đứng trước, phần riêng của run đứng sau. Tính dấu vân tay `prefixFp` và gửi kèm báo cáo cost, để biết khi nào và vì sao prompt cache vỡ.
2. **Đọc có điều kiện** (hub): `docs.get` / `skill_get` / `memory.search` trả "không đổi" (< 100 token) khi agent đã có bản mới nhất, dựa trên `have` hoặc biên nhận đọc theo run (`run_reads`). Luôn kiểm quyền và trạng thái gỡ trước.
3. **Mục lục + tóm tắt** (tài liệu): tài liệu dài trả digest tất định theo phiên bản (`doc_digests`), rồi đọc từng mục (dựa trên 80c).

Thêm số đo cache trên trang chi phí và cảnh báo khi ghi cache tăng vọt, cùng bản sao tài liệu theo phiên bản trên máy (P3).

**Bước đầu tiên là đo**: số nền 20–77k token ghi cache mỗi run là ước lượng. Chưa biết cache vỡ ở system prompt của CLI hay ở prompt của Hive ([research.md R1](./research.md)).

## Technical Context

**Language/Version**: TypeScript 7 (`typescript ^7.0.2`), Node ≥ 24 (`package.json` engines)

**Primary Dependencies**: `@modelcontextprotocol/sdk ^1.32` (packages/mcp), `node:sqlite` `DatabaseSync` (packages/core), React 19 (packages/ui, ui-kit), Electron 44 (apps/desktop)

**Storage**: SQLite trên hub (`SqliteHive`, migration nối đuôi `MIGRATIONS`). Bảng mới `run_reads`, `doc_digests`. Cột mới trong `run_costs`. Desktop: SQLite `runs.db` (`runner/store.ts`) + file trong appData cho bản sao tài liệu.

**Testing**: `node --test` + `node:assert/strict` (`packages/core/test`, `packages/mcp/test`, `apps/desktop/test`). e2e web (`npm run e2e[-mobile] -w @xdev-hive/web`) và smoke desktop khi đổi giao diện.

**Target Platform**: Hub là Linux trong Docker Compose (LAN). Máy chạy run: app Electron trên macOS, Windows, Linux.

**Project Type**: Monorepo: dịch vụ web (hub) + app desktop + máy chủ MCP + thư viện UI.

**Performance Goals**:
- Câu trả lời "không đổi" < 100 token (SC-003).
- Digest < 2k token (SC-004).
- Kiểm `run_reads` thêm ≤ 1 truy vấn SQLite theo khoá chính cho mỗi lần đọc.
- `doc_get` giảm từ 2 lần gọi `docs.get` xuống 1.

**Constraints**:
- Không bao giờ trả nội dung cũ, hoặc "không đổi" cho tài liệu đã gỡ / mất quyền (SC-005).
- Mô tả tool thêm ≤ 300 token (FR-010).
- Không lưu secret và không lưu nguyên văn prompt (FR-018).
- Tương thích ngược: trường mới đều tuỳ chọn. Hub cũ và app cũ vẫn chạy.
- [Unverified] Thời gian sống và giá prompt cache theo nhà cung cấp (R7).

**Scale/Scope**:
- Theo số của spec 80: ~88 doc/dự án, `doc_get` tới ~108 KB, 30–42 tool MCP mỗi run.
- [Inference] Vài chục run/ngày mỗi hub. `run_reads` giữ 48 giờ, nên chỉ vài nghìn dòng.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` vẫn là **mẫu chưa điền** (chỉ có placeholder), nên không có nguyên tắc nào để kiểm. Thay vào đó, plan kiểm theo quy chuẩn của repo trong `AGENTS.md`:

| Cổng (từ AGENTS.md) | Trước Phase 0 | Sau Phase 1 |
|---|---|---|
| Import khác thư mục dùng alias (`#core/`, `#mcp/`…), không `../` | N/A (chưa code) | Thiết kế chỉ thêm file trong package sẵn có ✅ |
| Chữ giao diện ở `packages/ui-kit/src/i18n/locales/vi.ts` + `en.ts` | — | Chữ mới của trang chi phí ghi vào ui-kit ✅ |
| Màu/khoảng cách theo token `packages/ui-kit/src/tokens/` | — | Không màu mới; dùng thẻ số liệu sẵn có của `OpsCosts` ✅ |
| Không ghi secret vào memory/tài liệu/cache | — | FR-018: bản sao chỉ chứa nội dung `docs.get`; prefix chỉ lưu hash ✅ |
| Quyền theo 76 là nguồn sự thật | — | Mọi nhánh "không đổi" kiểm `#check`/`sees()` + `removed_at` trước ✅ |
| CI: `npm ci`, `typecheck`, `test`; e2e/smoke khi đổi giao diện | — | quickstart ghi đủ lệnh ✅ |
| Mỗi mục roadmap xong: tăng `version` desktop, đánh dấu `docs/roadmap.md` | — | Ghi ở mục Thứ tự làm ✅ |
| Không sửa trực tiếp `AGENTS.md`/`CLAUDE.md`/`docs/decisions.md` | — | Plan không đổi các file đó ✅ |

**Clarifications chưa xong (ERROR theo skill, chưa được gỡ):** spec còn 3 dấu [NEEDS CLARIFICATION] (FR-012, FR-016, FR-023). Run headless không hỏi được người quản trị, nên plan chọn **hướng tạm** cho từng câu ([research.md "Câu hỏi còn mở"](./research.md)) và đánh dấu những phần thiết kế phụ thuộc vào chúng. Không bước `/speckit-tasks` nào nên làm phần US3 (tóm tắt) hay US5 (bản sao máy) trước khi chốt.

## Phụ thuộc

- **80c doc-lean** (`doc_get` có `section`, `maxChars`) là điều kiện trước của US3. Theo hướng tạm FR-023 (a), 80c làm như task riêng.
- **80e prompt-dedupe** (bỏ giao thức lặp) nên làm trước hoặc cùng T2: cả hai cùng sửa `frameLines` / `buildPrompt`.
- **80g** ngoài phạm vi.

## Project Structure

### Documentation (this feature)

```text
specs/001-token-cache/
├── spec.md
├── plan.md              # file này
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── mcp-tools.md          # doc_get / skill_get / memory_search
│   ├── hub-methods.md        # docs.get, docs.manifest, memory.search, costs.summary, báo cáo cost
│   └── run-prompt-layout.md  # bố cục prompt run + prefixFp
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks, chưa tạo)
```

### Source Code (repository root)

```text
packages/core/src/
├── sqlite.ts            # migration: run_reads, doc_digests, cột run_costs; docs.get/memory.search/costs.summary; docs.manifest
├── doc-digest.ts        # MỚI: buildDigest(content) tất định (toc + summary)
├── prompt-layers.ts     # stablePrefixLines / runLines, SEPARATOR
├── methods.ts           # schema input/output + min-role của method mới/mở rộng
└── types.ts             # PrefixPart, DigestSection, CacheSummary
packages/core/test/
├── doc-conditional.test.ts  # MỚI
├── doc-digest.test.ts       # MỚI
└── costs.test.ts            # mở rộng: số đo cache, cảnh báo

packages/mcp/src/server.ts   # doc_get/skill_get/memory_search: have, full, section; gộp 2 lần docs.get
packages/mcp/test/mcp.test.ts # mở rộng: dạng trả lời, đo cỡ tools/list

apps/desktop/src/main/
├── runner/command.ts    # buildPrompt theo bố cục mới; tính prefixFp/prefixParts
├── runner/runner.ts     # gửi prefix* trong báo cáo cost (≈1467)
├── sync.ts              # loadDocs/renderContext đọc từ bản sao (US5)
└── doc-cache.ts         # MỚI (US5): bản sao theo phiên bản trong appData
apps/desktop/test/prompt-prefix.test.ts  # MỚI

apps/web/src/
├── alerts.ts            # luật cache_write_spike
└── server.ts            # cleanupRound: dọn run_reads, doc_digests cũ

packages/ui/src/pages/admin/Ops.tsx      # OpsCosts: khối số đo cache
packages/ui-kit/src/i18n/locales/{vi,en}.ts  # chữ mới
```

**Structure Decision**: Không thêm package. Hub logic nằm trong `packages/core` (nơi có `SqliteHive` và quyền). MCP chỉ chuyển tham số và định dạng câu trả lời. Máy lo bố cục prompt và bản sao. Giao diện chỉ mở rộng `OpsCosts`.

## Thứ tự làm (gợi ý cho `/speckit-tasks`)

| # | Việc | Story | Phụ thuộc | Cỡ |
|---|---|---|---|---|
| T0 | Kiểm tài liệu prompt cache Claude/Codex/Gemini (TTL, giá ghi/đọc, độ dài tối thiểu), cập nhật R7 | — | — | s |
| T1 | Đo nền theo quickstart Kịch bản 1, lưu artifact. Chốt hướng R2 (thứ tự / khe đường dẫn / TTL) | US1 | T0 | s |
| T2 | Bố cục prompt mới + `prefixFp`/`prefixParts` + test byte-identical | US1 | T1, 80e | m |
| T3 | Migration `run_costs` cột prefix. Báo cáo cost gửi prefix | US1, US4 | T2 | s |
| T4 | `run_reads` + `docs.get {have, full}` + kiểm quyền/gỡ trước + gộp 2 lần gọi trong `doc_get` | US2 | — | m |
| T5 | `skill_get`, `memory.search` có điều kiện (hash cờ) | US2 | T4 | s |
| T6 | Mô tả tool + test đo cỡ `tools/list` (≤ 300 token thêm) | US2 | T4, T5 | s |
| T7 | `costs.summary.cache` + `OpsCosts` + chữ vi/en + e2e | US4 | T3, T4 | m |
| T8 | Luật `cache_write_spike` | US4 | T3, T7 | s |
| T9 | `doc_digests` + `buildDigest` + dạng digest trong `doc_get` | US3 | 80c, **FR-012** | m |
| T10 | `docs.manifest` + bản sao trên máy + xoá khi đăng xuất/mất quyền + smoke | US5 | **FR-016** | m |
| T11 | Đo lại sau khi làm (SC-001, SC-002, SC-007), ghi artifact | — | T2–T8 | s |

Mỗi mục xong: tăng `version` trong `apps/desktop/package.json` nếu đụng app, và thêm/đánh dấu mục 81 trong `docs/roadmap.md`.

## Rủi ro

- **Sửa sai chỗ**: nếu cache vỡ ở system prompt của CLI (đường dẫn worktree, ngày giờ), đảo `buildPrompt` lợi ít. T1 trước T2 để tránh việc này. Khe đường dẫn cố định là thay đổi lớn ở runner (khoá, chạy song song).
- **Trả "không đổi" sai**: ví dụ agent đã bị nén ngữ cảnh và không còn nội dung. Giảm rủi ro bằng `full:true` luôn có, `hint` trong câu trả lời, và mô tả tool. Đo số lần agent gọi `full:true` ngay sau `unchanged` để biết agent có bị lạc không.
- **`memory.search` ghi khi đọc** (`use_count`): nhánh `same` phải giữ cập nhật này, nếu không xếp hạng sẽ lệch.
- **Codex/Gemini không báo cache write**: SC-001 chỉ đo được với Claude/Kilo/OpenCode.
- **Ba câu hỏi chưa chốt**: T9, T10 có thể phải làm lại nếu người quản trị chọn khác hướng tạm.

## Complexity Tracking

Không có vi phạm cổng nào cần biện minh.
