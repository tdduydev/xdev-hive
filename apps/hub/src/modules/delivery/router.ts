import type { DeliveryRouteDeps } from "./deps.ts";
import { approvalsRoutes } from "./routes/approvals.ts";
import { ciRoutes } from "./routes/ci.ts";
import { ciConnectionsRoutes } from "./routes/ci-connections.ts";
import { ciJobsRoutes } from "./routes/ci-jobs.ts";
import { ciTokensRoutes } from "./routes/ci-tokens.ts";
import { deploysRoutes } from "./routes/deploys.ts";
import { environmentsRoutes } from "./routes/environments.ts";
import { infraConnectionsRoutes } from "./routes/infra-connections.ts";
import { serversRoutes } from "./routes/servers.ts";
import { targetsRoutes } from "./routes/targets.ts";

// Mỗi nhóm một file route để các task song song không sửa chung file.
export function deliveryRouter(deps: DeliveryRouteDeps) {
  return {
    ciConnections: ciConnectionsRoutes(deps),
    ciTokens: ciTokensRoutes(deps),
    infraConnections: infraConnectionsRoutes(deps),
    ciJobs: ciJobsRoutes(deps),
    ci: ciRoutes(deps),
    servers: serversRoutes(deps),
    environments: environmentsRoutes(deps),
    deployTargets: targetsRoutes(deps),
    deploys: { ...deploysRoutes(deps), approvals: approvalsRoutes(deps) },
  };
}
