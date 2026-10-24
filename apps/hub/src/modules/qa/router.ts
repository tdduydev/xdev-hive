import type { QaRouteDeps } from "./deps.ts";
import { areasRoutes } from "./routes/areas.ts";
import { casesRoutes } from "./routes/cases.ts";
import { dashboardRoutes } from "./routes/dashboard.ts";
import { myWorkRoutes } from "./routes/my-work.ts";
import { projectSettingsRoutes } from "./routes/project-settings.ts";
import { roundsRoutes } from "./routes/rounds.ts";
import { roundsExportRoutes } from "./routes/rounds-export.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { sourcesRoutes } from "./routes/sources.ts";

// Mỗi nhóm một file route để các story song song chỉ thay file của mình, không sửa file này. Xuất CSV tách khỏi
// `rounds` vì đi theo story khác (US5).
export function qaRouter(deps: QaRouteDeps) {
  return {
    settings: settingsRoutes(deps),
    projectSettings: projectSettingsRoutes(deps),
    areas: areasRoutes(deps),
    cases: casesRoutes(deps),
    sources: sourcesRoutes(deps),
    rounds: { ...roundsRoutes(deps), ...roundsExportRoutes(deps) },
    myWork: myWorkRoutes(deps),
    dashboard: dashboardRoutes(deps),
  };
}
