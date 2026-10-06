import { contextBridge, ipcRenderer } from "electron";

type Result = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; key?: string; vars?: unknown } };

async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Result;
  // key/vars let the interface show the error in the chosen language (see packages/ui/src/i18n).
  if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code, key: res.error.key, vars: res.error.vars });
  return res.value;
}

// Narrow, typed surface. The renderer never gets ipcRenderer or Node.
contextBridge.exposeInMainWorld("hive", {
  call: (method: string, input: unknown) => invoke("hive:call", method, input),
  me: () => invoke("hive:me"),
  desktop: {
    appInfo: () => invoke("desktop:appInfo"),
    hubStatus: () => invoke("desktop:hubStatus"),
    hubRetry: () => invoke("desktop:hubRetry"),
    updateStatus: () => invoke("desktop:updateStatus"),
    installUpdate: () => invoke("desktop:installUpdate"),
    settings: () => invoke("desktop:settings"),
    updateSettings: (patch: unknown) => invoke("desktop:updateSettings", patch),
    hubSignIn: (input: unknown) => invoke("desktop:hubSignIn", input),
    hubSignInBrowser: (input: unknown) => invoke("desktop:hubSignInBrowser", input),
    hubSignInCancel: () => invoke("desktop:hubSignInCancel"),
    setLocale: (locale: string) => invoke("desktop:setLocale", locale),
    logError: (text: string) => invoke("desktop:logError", text),
    addProject: (project: unknown) => invoke("desktop:addProject", project),
    scanRepos: (dir: string) => invoke("desktop:scanRepos", dir),
    addProjects: (items: unknown) => invoke("desktop:addProjects", items),
    removeProject: (name: string) => invoke("desktop:removeProject", name),
    pickFolder: () => invoke("desktop:pickFolder"),
    gitlabGroup: (input: unknown) => invoke("desktop:gitlabGroup", input),
    importGitlab: (input: unknown) => invoke("desktop:importGitlab", input),
    syncProject: (name: string) => invoke("desktop:syncProject", name),
    proposeAgents: (name: string) => invoke("desktop:proposeAgents", name),
    installAgents: (name: string) => invoke("desktop:installAgents", name),
    installShim: () => invoke("desktop:installShim"),
    showInFolder: (p: string) => invoke("desktop:showInFolder", p),
    profiles: () => invoke("desktop:profiles"),
    saveProfile: (profile: unknown, previousId?: string) => invoke("desktop:saveProfile", profile, previousId),
    removeProfile: (id: string) => invoke("desktop:removeProfile", id),
    resetCooldown: (id: string) => invoke("desktop:resetCooldown", id),
    refreshUsage: (ids?: string[]) => invoke("desktop:refreshUsage", ids),
    resetStats: (id: string) => invoke("desktop:resetStats", id),
    checkProfile: (id: string) => invoke("desktop:checkProfile", id),
    openLogin: (id: string, how?: unknown) => invoke("desktop:openLogin", id, how),
    addAccount: (account: unknown) => invoke("desktop:addAccount", account),
    recheckLogins: () => invoke("desktop:recheckLogins"),
    setProfileToken: (id: string, token: string) => invoke("desktop:setProfileToken", id, token),
    openSetupToken: (id: string) => invoke("desktop:openSetupToken", id),
    openCli: (id: string, project: string) => invoke("desktop:openCli", id, project),
    startRun: (request: unknown) => invoke("desktop:startRun", request),
    runs: (filter?: unknown) => invoke("desktop:runs", filter),
    runMessages: (id: string) => invoke("desktop:runMessages", id),
    runLog: (id: string) => invoke("desktop:runLog", id),
    runDiff: (id: string) => invoke("desktop:runDiff", id),
    steerRun: (id: string, text: string) => invoke("desktop:steerRun", id, text),
    cancelRun: (id: string) => invoke("desktop:cancelRun", id),
    removeWorktree: (id: string) => invoke("desktop:removeWorktree", id),
    pickCandidate: (id: string) => invoke("desktop:pickCandidate", id),
    updateProject: (name: string, patch: unknown) => invoke("desktop:updateProject", name, patch),
    checkGitLab: () => invoke("desktop:checkGitLab"),
    checkGitHub: () => invoke("desktop:checkGitHub"),
    createMergeRequest: (runId: string) => invoke("desktop:createMergeRequest", runId),
    setupStatus: () => invoke("desktop:setupStatus"),
    installSetup: (id: string) => invoke("desktop:installSetup", id),
    transferHub: (direction: "push" | "pull") => invoke("desktop:transferHub", direction),
    hubRequests: () => invoke("desktop:hubRequests"),
    toolTrust: (id: string, hash: string | null) => invoke("desktop:toolTrust", id, hash),
    answerCommand: (id: number, approve: boolean) => invoke("desktop:answerCommand", id, approve),
    chatMachine: () => invoke("desktop:chatMachine"),
    chatUpload: (project: string, name: string, bytes: Uint8Array) => invoke("desktop:chatUpload", project, name, bytes),
  },
});
