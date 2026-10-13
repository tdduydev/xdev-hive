// M6: Postgres → hub → runner host → gVisor → egress → commit → PR, rồi huỷ một run đang sống.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { EffectiveAllowlist, Project, Run, Task } from "../packages/contracts/src/index.ts";
import { type ProxyResponse, probeProxy } from "./e2e-sandbox-probe.ts";
import {
  CLI,
  checkPr,
  checkWorktree,
  cleanEnv,
  cleanup,
  connectGit,
  createProject,
  type HubClient,
  type LocalGit,
  type Proc,
  ROOT,
  runCmd,
  setupTenant,
  startHub,
  startPostgres,
  startProc,
  startWorker,
  state,
} from "./e2e-smoke.ts";

const env = process.env;
const SKIP = 77;
const outputDir = join(ROOT, ".e2e", "sandbox");
const report: {
  status: "đang chạy" | "đạt" | "không đạt" | "bỏ qua";
  checks: Array<{ name: string; evidence: unknown }>;
  reason?: string;
} = { status: "đang chạy", checks: [] };
let proxy: Proc | undefined;
let server: Server | undefined;
let image: string | undefined;
let hostId: string | undefined;
let finishing: Promise<void> | undefined;

async function saveReport() {
  await writeFile(join(outputDir, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
}

async function checked(name: string, action: () => Promise<unknown>) {
  console.log(`\n▶ ${name}`);
  const evidence = await action();
  report.checks.push({ name, evidence: evidence ?? true });
  await saveReport();
  console.log("  ✓ đạt");
  return evidence;
}

async function preflight(): Promise<string | undefined> {
  let runtimes: Record<string, unknown>;
  try {
    runtimes = JSON.parse(await runCmd("docker", ["info", "--format", "{{json .Runtimes}}"]));
  } catch {
    return "Không có Docker hoặc daemon Docker không sẵn sàng.";
  }
  if (!runtimes.runsc) return "Docker chưa đăng ký runtime gVisor runsc.";
  if (process.platform !== "linux") return "Runner host cần Linux; máy này không chạy được e2e gVisor.";
  try {
    await runCmd("runsc", ["--version"]);
  } catch {
    return "Không tìm thấy runsc trong PATH của runner host.";
  }
  assert.notEqual(process.getuid?.(), 0, "Runner host phải chạy bằng user không phải root.");
  return undefined;
}

async function finish() {
  finishing ??= (async () => {
    const errors: unknown[] = [];
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        errors.push(error);
      }
    };
    if (state.worker) await attempt(() => state.worker?.stop() ?? Promise.resolve());
    // Remove only this host's leftovers on failure or interruption on the shared CI daemon.
    if (hostId) {
      await attempt(async () => {
        const ids = await runCmd("docker", ["ps", "-aq", "--filter", `label=hive.host=${hostId}`]);
        if (ids) await runCmd("docker", ["rm", "-f", ...ids.split(/\s+/)]);
      });
    }
    if (proxy) await attempt(() => proxy?.stop() ?? Promise.resolve());
    if (server)
      await attempt(() => new Promise<void>((resolve, reject) => server?.close((e) => (e ? reject(e) : resolve()))));
    if (image) await attempt(() => runCmd("docker", ["image", "rm", image as string]));
    await attempt(cleanup);
    if (errors.length) throw new AggregateError(errors, "Không dọn hết tài nguyên e2e sandbox.");
  })();
  return finishing;
}

interface ContainerView {
  State: { Running: boolean };
  Config: { Image: string; User: string };
  HostConfig: {
    Runtime: string;
    NetworkMode: string;
    ReadonlyRootfs: boolean;
    CapDrop: string[];
    SecurityOpt: string[];
    NanoCpus: number;
    Memory: number;
    PidsLimit: number;
  };
}

/** Log cuối của CLI trong run: lý do agent thoát chỉ nằm ở đây, CI không có cách nào khác để thấy. */
async function runLogTail(api: HubClient, runId: string): Promise<string> {
  try {
    const chunks = await api.get<Array<{ bytes: string }>>(`/api/v1/runs/${runId}/logs?after=0&limit=1000`);
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c.bytes, "base64"))).toString("utf8");
    const lines = text.split("\n").filter((l) => l.trim());
    return lines.length ? `Log cuối của run:\n${lines.slice(-40).join("\n")}` : "Run không có log.";
  } catch (err) {
    return `Không đọc được log của run: ${String(err)}`;
  }
}

async function waitUntil<T>(
  api: HubClient,
  runId: string,
  what: string,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (state.worker?.exited) throw new Error("Runner host đã thoát khi chờ container.");
    const now = await api.get<Run>(`/api/v1/runs/${runId}`);
    if (["failed", "lost", "no_changes"].includes(now.state)) {
      throw new Error(`Run ${now.state}: ${JSON.stringify(now.result)}\n${await runLogTail(api, runId)}`);
    }
    const evidence = await probe();
    if (evidence !== undefined) return evidence;
    await delay(200);
  }
  throw new Error(`Hết thời gian chờ ${what} của run ${runId}.`);
}

async function inspectLive(api: HubClient, run: Run, expectedImage: string) {
  const name = `hive-${run.id}`;
  const view = await waitUntil(api, run.id, "container đang chạy", async () => {
    const names = await runCmd("docker", ["ps", "--filter", `label=hive.run=${run.id}`, "--format", "{{.Names}}"]);
    if (names !== name) return undefined;
    const [v] = JSON.parse(await runCmd("docker", ["inspect", name])) as ContainerView[];
    return v?.State.Running ? v : undefined;
  });
  const h = view.HostConfig;
  assert.equal(h.Runtime, "runsc", "Container phải dùng runtime runsc.");
  assert.equal(h.NetworkMode, "none", "Container phải tắt mạng.");
  assert.equal(h.ReadonlyRootfs, true, "Filesystem gốc phải chỉ đọc.");
  assert.ok(h.CapDrop.includes("ALL"), "Container phải bỏ mọi capability.");
  assert.ok(h.SecurityOpt.some((s) => s.startsWith("no-new-privileges")));
  assert.ok(h.NanoCpus > 0 && h.Memory > 0 && h.PidsLimit > 0, "Phải giới hạn CPU, RAM và PID.");
  assert.ok(view.Config.User && !["0", "root"].includes(view.Config.User.split(":")[0] ?? ""));
  assert.equal(view.Config.Image, expectedImage, "Phải dùng image dự án từ API sandbox.");
  // Never persist Config.Env: docker inspect includes the ephemeral run token.
  return {
    runId: run.id,
    name,
    image: view.Config.Image,
    user: view.Config.User,
    runtime: h.Runtime,
    networkMode: h.NetworkMode,
    readonlyRootfs: h.ReadonlyRootfs,
    capDrop: h.CapDrop,
    securityOpt: h.SecurityOpt,
    nanoCpus: h.NanoCpus,
    memory: h.Memory,
    pidsLimit: h.PidsLimit,
  };
}

interface NetworkEvidence {
  allowed: ProxyResponse;
  blocked: ProxyResponse;
  interfaces: string[];
}

async function checkNetwork(api: HubClient, run: Run, expectedBody: string) {
  const work = join(state.workerDataDir as string, "runs", `${run.id}-${run.attempt}`);
  const evidence = await waitUntil(api, run.id, "kết quả mạng từ CLI", async () => {
    const file = join(work, "sandbox-network.json");
    if (!existsSync(file)) return undefined;
    return JSON.parse(await readFile(file, "utf8")) as NetworkEvidence;
  });
  assert.equal(evidence.allowed.status, 200, "Host trong allowlist phải đi được.");
  assert.equal(evidence.allowed.body, expectedBody, "Yêu cầu phải tới được HTTP server qua proxy.");
  assert.equal(evidence.blocked.status, 403, "Host ngoài allowlist phải bị proxy trả 403.");
  assert.deepEqual(evidence.interfaces, ["lo"], "Container chỉ được có card mạng lo.");
  return evidence;
}

async function assertRemoved(run: Run) {
  const ids = await runCmd("docker", ["ps", "-aq", "--filter", `label=hive.run=${run.id}`]);
  assert.equal(ids, "", `Container run ${run.id} phải được xoá, không chỉ dừng.`);
  await checkWorktree(run);
  const remaining = (await readdir(state.workerDataDir as string)).filter((name) => name.startsWith("eg-"));
  assert.deepEqual(remaining, [], "Socket proxy riêng của run phải được dọn.");
  return { runId: run.id, containers: 0, worktrees: 0, proxySockets: 0 };
}

async function createRun(api: HubClient, project: Project, body: string) {
  const task = await api.post<Task>("/api/v1/tasks", {
    projectId: project.id,
    title: "Kiểm sandbox bằng CLI giả",
    body,
    preferredCli: CLI,
  });
  const run = await api.post<Run>("/api/v1/runs", { taskId: task.id, cli: CLI });
  return { task, run };
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  try {
    const skipReason = await preflight();
    if (skipReason) {
      report.status = "bỏ qua";
      report.reason = skipReason;
      console.log(`BỎ QUA e2e sandbox (mã ${SKIP}): ${skipReason}`);
      return SKIP;
    }
    assert.ok(
      !env.HIVE_E2E_DATABASE_ADMIN_URL && env.HIVE_E2E_GITHUB !== "1" && env.HIVE_E2E_REAL_CLI !== "1",
      "E2e sandbox cần Postgres Testcontainers, Git cục bộ và CLI giả.",
    );
    const tmp = await mkdtemp(join(ROOT, ".e2e", "sb-"));
    state.tmp = tmp;
    const localGit: LocalGit = { root: join(tmp, "git"), prDir: join(tmp, "prs") };
    await mkdir(localGit.root, { recursive: true });
    image = `hive-e2e-sandbox:${randomUUID()}`;
    await checked("Dựng image môi trường qua mirror", async () => {
      // CI tải sẵn ảnh Node từ registry còn hạn mức (scripts/ci/pull-image.sh); tại máy thì dùng mặc định của Dockerfile.
      const node = process.env.HIVE_E2E_NODE_IMAGE;
      const args = node ? ["--build-arg", `NODE_IMAGE=${node}`] : [];
      await runCmd("docker", ["build", ...args, "-f", "e2e/sandbox/Dockerfile", "-t", image as string, "."]);
      return { image };
    });
    const db = await startPostgres();
    const api = await startHub(db, tmp, localGit);
    const { team, system } = await setupTenant(api);
    const { conn, owner } = await connectGit(api);
    const project = await createProject(api, system.id, conn.id, owner, localGit);
    state.repoUrl = project.repo.httpUrl ?? undefined;

    const expectedBody = `hive-sandbox-${randomUUID()}`;
    server = createServer((_req, res) => res.end(expectedBody));
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const allowedHost = `127.0.0.1:${address.port}`;
    const allowedUrl = `http://${allowedHost}/probe`;
    const blockedUrl = `http://127.0.0.2:${address.port}/probe`;
    await checked("Bật sandbox, image và allowlist dự án qua API", async () => {
      await api.request("PATCH", `/api/v1/projects/${project.key}/settings`, {
        settings: { features: { sandbox: true } },
      });
      await api.request("PUT", `/api/v1/sandbox/projects/${project.id}/image`, {
        baseImage: image,
        setupScriptHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      });
      await api.post("/api/v1/sandbox/allowlist", { projectId: project.id, rule: allowedHost });
      const policy = await api.get<EffectiveAllowlist>(`/api/v1/sandbox/projects/${project.id}/allowlist`);
      assert.deepEqual(policy.rules, [allowedHost]);
      const updated = await api.get<Project>(`/api/v1/projects/${project.id}`);
      assert.equal(updated.settings.features.sandbox, true);
      return { projectId: project.id, allowlist: policy.rules };
    });
    const { bin, machineId, worker } = await startWorker(api, team.id, tmp, { image });
    hostId = machineId;
    await checked("Lệnh hive-worker egress-proxy thực thi allowlist", async () => {
      const list = join(tmp, "allowlist.txt");
      await writeFile(list, `${allowedHost}\n`, { mode: 0o600 });
      // A relative listen path stays within Unix's sun_path limit on long CI checkout paths.
      const socketPath = join(tmp, "egress.sock");
      const relativeSocket = relative(ROOT, socketPath);
      proxy = startProc("egress-proxy", bin, ["egress-proxy", "--allowlist", list, "--unix-socket", relativeSocket], {
        env: cleanEnv(),
        log: join(tmp, "egress.log"),
      });
      const until = Date.now() + 10_000;
      while (!existsSync(socketPath)) {
        if (proxy.exited || Date.now() > until) throw new Error(`Egress proxy không sẵn sàng: ${proxy.tail()}`);
        await delay(100);
      }
      const allowed = await probeProxy(allowedUrl, { socketPath: relativeSocket });
      const blocked = await probeProxy(blockedUrl, { socketPath: relativeSocket });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.body, expectedBody);
      assert.equal(blocked.status, 403);
      await proxy.stop();
      return { allowed, blocked };
    });

    const body = `[e2e-sandbox:${allowedUrl} ${blockedUrl}] Thêm ghi chú vào README.md rồi commit.`;
    const { task, run } = await createRun(api, project, body);
    await checked("Run thật chạy bằng runsc với giới hạn cách ly", () => inspectLive(api, run, image as string));
    await checked("CLI trong gVisor: allowlist 200, ngoài allowlist 403, chỉ có lo", () =>
      checkNetwork(api, run, expectedBody),
    );
    await writeFile(
      join(state.workerDataDir as string, "runs", `${run.id}-${run.attempt}`, ".e2e-release"),
      "release\n",
    );
    const completed = await waitUntil(api, run.id, "run succeeded", async () => {
      const now = await api.get<Run>(`/api/v1/runs/${run.id}`);
      return now.state === "succeeded" ? now : undefined;
    });
    await checked("Commit được push, PR được tạo, task sang review", async () => {
      await checkPr(completed, project, localGit);
      const current = await api.get<Task>(`/api/v1/tasks/${task.id}`);
      assert.equal(current.status, "review");
      const bare = join(localGit.root, project.repo.owner, `${project.repo.name}.git`);
      const committed = JSON.parse(
        await runCmd("git", ["--git-dir", bare, "show", `${completed.branch}:sandbox-network.json`]),
      ) as NetworkEvidence;
      assert.equal(committed.allowed.body, expectedBody);
      assert.equal(committed.blocked.status, 403);
      assert.deepEqual(committed.interfaces, ["lo"]);
      return { runId: run.id, headSha: completed.headSha, prUrl: completed.prUrl };
    });
    await checked("Container, worktree và proxy được xoá sau run", () => assertRemoved(completed));

    const { run: cancelled } = await createRun(api, project, body);
    await checked("Run để huỷ có container runsc đang sống", () => inspectLive(api, cancelled, image as string));
    await checked("Run để huỷ đã thực thi CLI và kiểm mạng", () => checkNetwork(api, cancelled, expectedBody));
    await waitUntil(api, cancelled.id, "run running trước khi huỷ", async () => {
      const now = await api.get<Run>(`/api/v1/runs/${cancelled.id}`);
      return now.state === "running" ? now : undefined;
    });
    await api.post(`/api/v1/runs/${cancelled.id}/cancel`, {});
    const terminal = await waitUntil(api, cancelled.id, "run cancelled", async () => {
      const now = await api.get<Run>(`/api/v1/runs/${cancelled.id}`);
      return now.state === "cancelled" ? now : undefined;
    });
    await checked("Huỷ run qua API cũng xoá container, worktree và proxy", async () => {
      assert.equal(terminal.prUrl, null);
      return assertRemoved(terminal);
    });
    assert.equal(worker.exited, false, "Runner host phải còn hoạt động sau khi huỷ run.");
    report.status = "đạt";
    return 0;
  } catch (error) {
    report.status = "không đạt";
    report.reason = error instanceof Error ? error.message : String(error);
    console.error(report.reason);
    for (const proc of [state.hub, state.worker, proxy]) if (proc) console.error(`\n${proc.name}:\n${proc.tail()}`);
    return 1;
  } finally {
    try {
      await finish();
    } catch (error) {
      report.status = "không đạt";
      report.reason = `${report.reason ?? ""}\n${String(error)}`;
      process.exitCode = 1;
    }
    await saveReport();
    if (env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `\nE2E sandbox (gVisor): **${report.status}**\n\n${report.reason ?? ""}\n\n${report.checks.map((c) => `- ${c.name}: đạt`).join("\n")}\n`,
      );
    }
    console.log(`\nE2E sandbox: ${report.status}. Báo cáo: ${join(outputDir, "result.json")}`);
  }
}

process.on("SIGINT", () => void finish().finally(() => process.exit(130)));
process.on("SIGTERM", () => void finish().finally(() => process.exit(130)));
const code = await main();
process.exitCode = report.status === "không đạt" ? 1 : code;
