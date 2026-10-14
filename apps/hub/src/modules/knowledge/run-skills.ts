import { runSkillsRequest } from "@xdev-hive/contracts/worker-protocol";
import type pg from "pg";
import type { RunTokenVerifier } from "../mcp/index.ts";
import { ForbiddenError, withTenant } from "../platform/index.ts";
import { knowledgePrincipal } from "./mcp-tools.ts";
import { runSkillBundle } from "./skill-pack.ts";

/** Run được chép skill vào worktree: run sửa code và run review (Claude Code nạp skill từ `.claude/skills/`). */
const SKILL_RUN_KINDS = new Set(["code", "review"]);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/**
 * `POST /api/v1/run/skills` cho worker (contracts/worker-protocol `runSkillsRequest`). Xác thực bằng run token như
 * cổng MCP, vì worker đã có token đó trong môi trường của run; ngoài oRPC vì không có phiên người dùng.
 */
export async function handleRunSkills(
  deps: { pool: pg.Pool; runTokens: RunTokenVerifier },
  request: Request,
): Promise<Response> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
  const principal = token ? await deps.runTokens.verify(token) : null;
  if (principal?.kind !== "run" || !principal.orgId)
    return json(401, { code: "RUN_TOKEN_INVALID", message: "Cần run token hợp lệ." });
  if (!principal.runKind || !SKILL_RUN_KINDS.has(principal.runKind)) return json(200, { skills: [] });
  const body = runSkillsRequest.safeParse(await request.json().catch(() => ({})));
  if (!body.success) return json(400, { code: "BAD_REQUEST", message: "Thân request không hợp lệ." });
  try {
    const result = await withTenant(deps.pool, { orgId: principal.orgId, userId: principal.userId }, async (tx) => {
      const who = await knowledgePrincipal(tx, principal);
      return who.kind === "run" ? runSkillBundle(tx, who, body.data.have) : { skills: [] };
    });
    return json(200, result);
  } catch (e) {
    // Run đã mất dự án hoặc task: worker chạy tiếp không có skill, như hub cũ.
    if (e instanceof ForbiddenError) return json(403, { code: e.code, message: e.message });
    throw e;
  }
}
