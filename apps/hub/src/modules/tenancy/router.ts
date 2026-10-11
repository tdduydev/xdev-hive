import { invitationsRouter } from "./invitations.ts";
import { orgMembersRouter } from "./members.ts";
import { hubSetupRouter, orgsRouter } from "./orgs.ts";
import { procedures, type TenancyDeps } from "./procedures.ts";
import { ssoProvidersRouter } from "./sso.ts";
import { systemsRouter } from "./systems.ts";
import { teamMembersRouter, teamsRouter } from "./teams.ts";

/** Router của tổ chức, đội, hệ thống, thành viên, lời mời, SSO; app.ts gộp vào router chung. */
export function tenancyRouter(deps: TenancyDeps) {
  const p = procedures(deps);
  return {
    orgs: orgsRouter(p, deps),
    hubSetup: hubSetupRouter(p, deps),
    teams: teamsRouter(p),
    teamMembers: teamMembersRouter(p),
    systems: systemsRouter(p),
    orgMembers: orgMembersRouter(p),
    invitations: invitationsRouter(p, deps),
    ssoProviders: ssoProvidersRouter(p, deps),
  };
}
