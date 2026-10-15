import { assetsRoutes } from "./routes/assets.ts";
import type { DocSyncRouteDeps } from "./routes/common.ts";
import { conflictsRoutes } from "./routes/conflicts.ts";
import { extractsRoutes } from "./routes/extracts.ts";
import { homesRoutes } from "./routes/homes.ts";
import { importsRoutes } from "./routes/imports.ts";
import { syncRoutes } from "./routes/sync.ts";
import { treeRoutes } from "./routes/tree.ts";

export function docsyncRouter(deps: DocSyncRouteDeps) {
  return {
    docHomes: { ...homesRoutes(deps), ...syncRoutes(deps) },
    docImports: importsRoutes(deps),
    docConflicts: conflictsRoutes(deps),
    docAssets: assetsRoutes(deps),
    docExtracts: extractsRoutes(deps),
    docTree: treeRoutes(deps),
  };
}
