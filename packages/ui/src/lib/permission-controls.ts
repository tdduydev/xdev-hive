import { HUB_SCOPE, may, ROLE_RANK, type Me } from "@xdev-hive/core";

/** Keep controls aligned with the permissions checked by the hub methods they call. */
export const canEditDependencies = (me: Me, project: string): boolean => may(me, project, "taskManage");
export const canUseHubChat = (me: Me): boolean => me.mode === "hub" && me.role === "admin" && !me.access;
export const canEditChatSettings = (me: Me, project: string): boolean => project === HUB_SCOPE ? canUseHubChat(me) : may(me, project, "projectSettings");
export const canCloseTask = (me: Me, project: string): boolean => may(me, project, "taskWork") && may(me, project, "codeReview");
export const contextProjects = (me: Me, projects: string[]): string[] => projects.filter((project) => may(me, project, "contextEdit"));

// cooldowns.clear has a method role of agent and no per-project check in sqlite.ts.
export const canClearCooldown = (me: Me): boolean => ROLE_RANK[me.role] >= ROLE_RANK.agent;
