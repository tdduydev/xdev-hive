# Implementation Plan: Skill learning

**Branch**: `014-skill-learning` | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md) | **ADR**:
[0025](../../docs/adr/0025-agent-skill-learning.md)

## Summary

Module hub mới `skilllearn` (phụ thuộc `runs`, `knowledge`, `governance`, `catalog`, `tenancy`) chọn run đáng học, lên lô
theo ngày, nhận đề xuất và xử lý duyệt. Lõi `runs` chỉ thêm kind `skill_proposal` (engine, tool MCP, worker); `knowledge`
thêm cầu nối (`skill-learning.ts`) để module mới không đụng bảng của nó.

## Cấu trúc

| Phần | File |
|---|---|
| Contract | `packages/contracts/src/skill-learning.ts`, `policies.ts` (`skillLearning`), `runs.ts` (`skill_proposal`) |
| Chọn run, tóm tắt | `skilllearn/select.ts` (p90, thử lại, đánh dấu), `load.ts` (tóm tắt từ task, kết quả run, `agent_report`, `tool_call`), `digest.ts` (lời nhắc) |
| Lô và nhận đề xuất | `skilllearn/service.ts` (`planSkillLearning`, `ingestSkillLearning`), `dedupe.ts` |
| Duyệt, đo | `skilllearn/proposals.ts`, `router.ts` |
| Job | `skilllearn/jobs.ts`: cron `*/15 * * * *` và hàng `skill-learning-pr`; nối ở `main.ts` |
| Run | `runs/engine.ts` (`createSkillProposalRun`, `verifySkillProposal`), `runs/mcp.ts` (`skill_proposal_submit`) |
| Worker | `worker/internal/runner/runner.go` (`KindSkillProposal`, chỉ đọc, capability), `accounts.go` (vai `plan`) |
| Git | `knowledge/skill-repo.ts` (`openSkillPR`), `knowledge/skill-learning.ts` |
| Web | `pages/knowledge/skill-learning-tab.tsx`, `skills-page.tsx` (tab), `policies-page.tsx`, `run-page.tsx` (nút đánh dấu) |
| DB | migration `0064_skill_learning.sql`: 3 bảng, FORCE RLS, hàm `hive.skill_learning_orgs()` |

## Kiểm thử

- Hub db: `skilllearn/skilllearn.db.test.ts` (chọn run, lô theo ngày, hạn mức, bỏ trùng, duyệt mở PR với SCM giả,
  số liệu, RLS), `runs.db.test.ts` (kind đi qua engine và máy khai capability), `mcp-run.db.test.ts` (tool MCP).
- Hub unit: `dedupe.test.ts`, `digest.test.ts`.
- Worker: `TestSkillProposalIsReadOnlyKindWithCapability` và các bảng kind sẵn có (cờ chỉ đọc, antigravity, worktree detach).
- Web e2e (fake hub): `e2e/skill-learning.spec.ts`, `e2e/policies.spec.ts`.
