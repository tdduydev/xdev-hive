import { assetsRoutes } from "./routes/assets.ts";
import type { DocSyncRouteDeps } from "./routes/common.ts";
import { conflictsRoutes } from "./routes/conflicts.ts";
import { extractsRoutes } from "./routes/extracts.ts";
import { homesRoutes } from "./routes/homes.ts";
import { importsRoutes } from "./routes/imports.ts";
import { syncRoutes } from "./routes/sync.ts";
import { treeRoutes } from "./routes/tree.ts";
import { wordCommitRoutes } from "./routes/word-commit.ts";
import { wordImportsRoutes } from "./routes/word-imports.ts";
import { wordLinkRoutes } from "./routes/word-link.ts";
import { wordStagingRoutes } from "./routes/word-staging.ts";

export function docsyncRouter(deps: DocSyncRouteDeps) {
  return {
    docHomes: { ...homesRoutes(deps), ...syncRoutes(deps) },
    docImports: importsRoutes(deps),
    docConflicts: conflictsRoutes(deps),
    docAssets: assetsRoutes(deps),
    docExtracts: extractsRoutes(deps),
    docTree: treeRoutes(deps),
    // Mỗi phần của nhập Word một file route để các task song song không sửa chung file.
    wordImports: {
      ...wordImportsRoutes(deps),
      ...wordCommitRoutes(deps),
      ...wordLinkRoutes(deps),
      ...wordStagingRoutes(deps),
    },
  };
}
