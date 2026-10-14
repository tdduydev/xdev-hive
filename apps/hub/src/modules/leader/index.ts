// Chat với leader agent và luồng đề xuất cần người duyệt. Module khác chỉ import file này.

import type { ThreadHost } from "../artifacts/index.ts";
import type { RunsEngine } from "../runs/index.ts";
import { postFixRequest } from "./mcp-tools.ts";
import { createThreadHost as createArtifactThreadHost } from "./thread-host.ts";

export function createThreadHost(runsEngine?: RunsEngine): ThreadHost {
  return {
    ...createArtifactThreadHost(),
    postFixRequest: (tx, input) => postFixRequest(runsEngine, tx, input),
  };
}

export {
  describeAction,
  emitLeaderActivity,
  executeLeaderAction,
  onLeaderActivity,
  tierChoice,
  tierTable,
} from "./actions.ts";
export { queuedLeaderPrompt } from "./continuation.ts";
export { registerMcpTools } from "./mcp-tools.ts";
export { type LeaderEvent, provideLeaderObserver } from "./observer.ts";
export { ARTIFACT_RULE, SDLC_RULE, TIER_RULE } from "./prompt.ts";
export { type LeaderRouterDeps, leaderRouter } from "./router.ts";
export { approvals, chatMessages, chatThreads } from "./schema.ts";
export {
  approvalView,
  approveApproval,
  createThread,
  listApprovals,
  rejectApproval,
  sendLeaderMessage,
} from "./service.ts";
export { appendLeaderSystemMessage } from "./system-message.ts";
export { createThreadLinkTarget } from "./thread-host.ts";
