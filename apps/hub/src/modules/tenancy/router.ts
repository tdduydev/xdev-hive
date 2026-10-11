import { orgMembersRouter } from "./members.ts";
import { orgsRouter } from "./orgs.ts";
import { procedures, type TenancyDeps } from "./procedures.ts";
import { systemsRouter } from "./systems.ts";
import { teamMembersRouter, teamsRouter } from "./teams.ts";

/** Router của tổ chức, đội, hệ thống, thành viên; app.ts gộp vào router chung. */
export function tenancyRouter(deps: TenancyDeps) {
  const p = procedures(deps);
  return {
    orgs: orgsRouter(p, deps),
    teams: teamsRouter(p),
    teamMembers: teamMembersRouter(p),
    systems: systemsRouter(p),
    orgMembers: orgMembersRouter(p),
  };
}
