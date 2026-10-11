// Run của task: giao job cho máy, lease, chính sách kết quả, log và luồng SSE. Module khác chỉ import file này.
export {
  createRunsEngine,
  RUNS_TIMER_QUEUE,
  type RunsDeps,
  type RunsEngine,
  type RunTimer,
  runForUser,
  runsTimerQueue,
} from "./engine.ts";
export { evaluatePolicy, matchGlob } from "./policy.ts";
export { eventsAfter, getRun, listRuns, logsAfter } from "./queries.ts";
export { type RunsRouterDeps, runsRouter } from "./router.ts";
export { RUNS_CHANNEL } from "./state.ts";
export { parseCursor, RunNotifier, type RunStreamDeps, runStreamHandler } from "./stream.ts";
// Cổng MCP (M4) xác thực run token bằng hàm này.
export {
  createRunTokenVerifier,
  mcpAudience,
  type RunTokenClaims,
  type RunTokenVerifier,
  signRunToken,
} from "./token.ts";
