import { contextBridge, ipcRenderer } from "electron";

type Result = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Result;
  if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.value;
}

// Narrow, typed surface. The renderer never gets ipcRenderer or Node.
contextBridge.exposeInMainWorld("hive", {
  call: (method: string, input: unknown) => invoke("hive:call", method, input),
  me: () => invoke("hive:me"),
  desktop: {
    settings: () => invoke("desktop:settings"),
    updateSettings: (patch: unknown) => invoke("desktop:updateSettings", patch),
    addProject: (project: unknown) => invoke("desktop:addProject", project),
    removeProject: (name: string) => invoke("desktop:removeProject", name),
    pickFolder: () => invoke("desktop:pickFolder"),
    syncProject: (name: string) => invoke("desktop:syncProject", name),
    installAgents: (name: string) => invoke("desktop:installAgents", name),
    installShim: () => invoke("desktop:installShim"),
    showInFolder: (p: string) => invoke("desktop:showInFolder", p),
    profiles: () => invoke("desktop:profiles"),
    saveProfile: (profile: unknown, previousId?: string) => invoke("desktop:saveProfile", profile, previousId),
    removeProfile: (id: string) => invoke("desktop:removeProfile", id),
    resetCooldown: (id: string) => invoke("desktop:resetCooldown", id),
    checkProfile: (id: string) => invoke("desktop:checkProfile", id),
    startRun: (request: unknown) => invoke("desktop:startRun", request),
    runs: (filter?: unknown) => invoke("desktop:runs", filter),
    runLog: (id: string) => invoke("desktop:runLog", id),
    runDiff: (id: string) => invoke("desktop:runDiff", id),
    cancelRun: (id: string) => invoke("desktop:cancelRun", id),
    removeWorktree: (id: string) => invoke("desktop:removeWorktree", id),
    updateProject: (name: string, patch: unknown) => invoke("desktop:updateProject", name, patch),
    checkGitLab: () => invoke("desktop:checkGitLab"),
    createMergeRequest: (runId: string) => invoke("desktop:createMergeRequest", runId),
  },
});
