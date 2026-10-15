import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { RequestContext } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { autoApprovalRoutes } from "./autoapprove.ts";
import { breakdownRoutes } from "./breakdown.ts";
import { contractRoutes } from "./contracts.ts";
import { importRoute } from "./import.ts";
import {
  cancelItem,
  changeItemMode,
  createItem,
  getItem,
  itemBoard,
  itemDetail,
  listItems,
  pauseItem,
  resumeItem,
  suggestItem,
} from "./items.ts";
import { dryRunMode, listModes, removeMode, saveMode } from "./modes.ts";
import { overrideRoutes } from "./overrides.ts";
import { participantRoutes } from "./participants.ts";
import { type SdlcDeps, skipPhase } from "./phases.ts";
import { questionRoutes } from "./questions.ts";
import { stepRoutes } from "./steps.ts";
import { syncRoute } from "./sync.ts";
import { traceRoute } from "./trace.ts";
import { waveRoutes } from "./waves.ts";

/**
 * Route `sdlc.*`. Route lõi (chế độ, gợi ý, hạng mục, bảng) viết ở đây; phần còn lại nằm trong hàm đăng ký ở file của
 * nghiệp vụ đó để mỗi file tự giữ middleware và deps của mình. `metrics` chưa có (T082).
 */
export function sdlcRouter(deps: OrgDeps & SdlcDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.sdlc).$context<RequestContext>().use(authed).use(inOrg);
  return {
    modes: {
      list: os.modes.list.handler(({ context: { tx, user }, input }) => listModes(tx, user.id, input)),
      save: os.modes.save.handler(({ context: { tx, user }, input }) => saveMode(tx, user.id, input)),
      remove: os.modes.remove.handler(({ context: { tx, user }, input }) => removeMode(tx, user.id, input.id)),
      dryRun: os.modes.dryRun.handler(({ context: { tx, user }, input }) => dryRunMode(tx, user.id, input)),
    },
    suggest: os.suggest.handler(({ context: { tx, user }, input }) => suggestItem(tx, user.id, input)),
    items: {
      create: os.items.create.handler(({ context: { tx, user }, input }) => createItem(tx, user.id, input, deps)),
      list: os.items.list.handler(({ context: { tx, user }, input }) => listItems(tx, user.id, input)),
      get: os.items.get.handler(({ context: { tx, user }, input }) => getItem(tx, user.id, input)),
      pause: os.items.pause.handler(({ context: { tx, user }, input }) => pauseItem(tx, user.id, input.id)),
      resume: os.items.resume.handler(({ context: { tx, user }, input }) => resumeItem(tx, user.id, input.id, deps)),
      cancel: os.items.cancel.handler(({ context: { tx, user }, input }) => cancelItem(tx, user.id, input)),
      changeMode: os.items.changeMode.handler(({ context: { tx, user }, input }) =>
        changeItemMode(tx, user.id, input, deps),
      ),
      skipPhase: os.items.skipPhase.handler(async ({ context: { tx, user }, input }) => {
        await skipPhase(tx, user.id, input, deps);
        return itemDetail(tx, user.id, input.id);
      }),
      import: importRoute(deps),
      ...stepRoutes(deps),
      projects: participantRoutes(deps),
    },
    board: os.board.handler(({ context: { tx, user }, input }) => itemBoard(tx, user.id, input)),
    contracts: contractRoutes(deps),
    autoApprovals: autoApprovalRoutes(deps),
    ...questionRoutes(deps),
    breakdown: breakdownRoutes(deps),
    waves: waveRoutes(deps),
    ...overrideRoutes(deps),
    trace: traceRoute(deps),
    sync: syncRoute(deps),
  };
}
