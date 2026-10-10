# Contract: bố cục prompt của run (máy)

File: `packages/core/src/prompt-layers.ts`, `apps/desktop/src/main/runner/command.ts` (`buildPrompt`, dòng 79-145).

**Trạng thái**: hướng làm, chốt sau số đo T1 ([research.md R1, R2](../research.md)).

## Bố cục

```
┌─ STABLE PREFIX ─────────────────────────────── (giống hệt giữa các run cùng project/kind/role/phiên bản)
│ 1. protocol     giao thức chung (sau 80e: không lặp AGENTS.md, không "đọc AGENTS.md trước")
│ 2. context note "conventions from xDev Hive are in <contextFile>" (chỉ khi repo có AGENTS.md riêng; đường dẫn tương đối)
│ 3. skills/rules skillAndRuleLines, sắp theo tên, đường dẫn tương đối với worktree
│ 4. artifacts    artifactLines (chỉ phần không chứa id task)
│ 5. step         stepPromptBlock của vai trò (không chèn taskId/branch vào phần này)
│ 6. steer        STEER_PROMPT
├─ SEPARATOR ──── một dòng cố định, ví dụ "--- This run ---"
└─ RUN PART ────────────────────────────────────
  7. frameLines (task id, tiêu đề, worktree, branch, SHA)
  8. references (đường dẫn, branch, SHA)
  9. note, attempt, candidate, RTK, ciFix
 10. step variables (taskId, taskTitle, service, branch), nếu step prompt cần
 11. Extra instructions from the admin
```

## Quy tắc

- Phần 1–6 MUST NOT chứa: id task/run, tiêu đề task, đường dẫn tuyệt đối, branch, SHA, ngày giờ, tên máy, id profile (FR-002). Có test: dựng prompt cho hai task khác nhau cùng dự án, so phần trước SEPARATOR, MUST bằng nhau từng byte.
- Danh sách trong phần 1–6 sắp tất định (theo tên), không theo thứ tự đọc thư mục (FR-001).
- `prefixFp = sha256(text(1–6) + "\n" + toolsHash + "\n" + JSON(docVersions))`, `prefixParts` theo [data-model.md §1](../data-model.md).
- `toolsHash` = sha256 của danh sách `{name, description, inputSchema}` mà server MCP xdev-hive đăng ký cho vai trò này. Máy lấy bằng một lần `tools/list` có cache theo phiên bản app + phiên bản hub.
- Judge (`c.judge`) giữ bố cục riêng như hôm nay, không tính `prefixFp`.

## [Chưa kiểm] Đường dẫn làm việc ổn định

Nếu T1 cho thấy system prompt của CLI có đường dẫn worktree và làm vỡ cache: runner chạy agent trong khe cố định `worktrees/<project>/slot-<n>` theo (dự án, vai trò), gắn worktree của task vào khe trước khi chạy và trả lại sau khi xong. Chỉ làm khi số đo cho thấy run thứ hai giảm ghi cache ≥ 30% nhờ việc này.
