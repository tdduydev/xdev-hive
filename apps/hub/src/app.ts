import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as zlibConstants } from "node:zlib";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { contract, WORD_IMPORT_UPLOAD_PATH } from "@xdev-hive/contracts";
import { Hono } from "hono";
import { compress } from "hono/compress";
import type pg from "pg";
import {
  registerMcpTools as artifactsMcpTools,
  artifactsRouter,
  frameRoutes,
  frameTicketKey,
  provideLinkTarget,
  provideThreadHost,
} from "./modules/artifacts/index.ts";
import {
  exportAudit,
  getAuditRetention,
  queryAudit,
  setAuditRetention,
  withAuditAccess,
} from "./modules/audit/index.ts";
import {
  registerMcpTools as catalogMcpTools,
  catalogRouter,
  findProject,
  findWebhookTarget,
  loadProject,
  projectMembersRouter,
  templateService,
} from "./modules/catalog/index.ts";
import { type ChatApiDeps, chatRouter, handleSlackWebhook, handleTelegramWebhook } from "./modules/chat/index.ts";
import { type CodeRunPort, codeReviewsRouter } from "./modules/codereview/index.ts";
import { costsRouter } from "./modules/cost/index.ts";
import { deliveryRouter, deployStreamHandler } from "./modules/delivery/index.ts";
import {
  registerMcpTools as docsyncMcpTools,
  docsyncRouter,
  handleAssetDownload,
  handleAssetUpload,
  handleDocsWebhook,
  handleWordMedia,
  handleWordOriginal,
  handleWordUpload,
  wordImportHealth,
} from "./modules/docsync/index.ts";
import { fleetRouter, WorkerReleaseCache } from "./modules/fleet/index.ts";
import { policiesRouter } from "./modules/governance/index.ts";
import { type Auth, mcpMode, meRouter, type TxtResolver } from "./modules/identity/index.ts";
import {
  type Embedder,
  handleRunSkills,
  handleSkillWebhook,
  registerMcpTools as knowledgeMcpTools,
  knowledgeRouter,
} from "./modules/knowledge/index.ts";
import {
  createThreadHost,
  createThreadLinkTarget,
  registerMcpTools as leaderMcpTools,
  leaderRouter,
} from "./modules/leader/index.ts";
import {
  createMcpEndpoint,
  issueDesktopToken,
  McpToolRegistry,
  mcpAdminRouter,
  type RunTokenVerifier,
} from "./modules/mcp/index.ts";
import { inboxRouter, notifyRouter } from "./modules/notify/index.ts";
import { type HubConfig, type Jobs, NotFoundError, type RequestContext, type Tx } from "./modules/platform/index.ts";
import {
  RunNotifier,
  type RunsEngine,
  runForUser,
  runStreamHandler,
  registerMcpTools as runsMcpTools,
  runsRouter,
} from "./modules/runs/index.ts";
import { sandboxRouter } from "./modules/sandbox/index.ts";
import { defaultProviderFactory, handleGitWebhook, type ProviderFactory, scmRouter } from "./modules/scm/index.ts";
import { reviewSpecFor, type SdlcDeps, registerMcpTools as sdlcMcpTools, sdlcRouter } from "./modules/sdlc/index.ts";
import { skillLearningRouter } from "./modules/skilllearn/index.ts";
import { DesktopReleaseCache, findDesktopUpdate, systemRouter } from "./modules/system/index.ts";
import { tasksRouter } from "./modules/tasks/index.ts";
import {
  allowWith,
  orgMiddlewares,
  requireOrgRole,
  rolesRouter,
  registerMcpTools as tenancyMcpTools,
  tenancyRouter,
} from "./modules/tenancy/index.ts";
import {
  chainVerifiers,
  createTerminalTokenVerifier,
  remotePolicyHook,
  remoteRouter,
  terminalRouter,
  terminalTokenKey,
} from "./modules/terminal/index.ts";
import { withPersonalTokens } from "./personal-token-auth.ts";
import { mapDomainErrors } from "./rpc-errors.ts";

export interface AppDeps {
  config: HubConfig;
  webDist?: string | undefined;
  /** Không có khi chạy test đơn vị không cần database. */
  auth?: Auth | undefined;
  /** Pool của role hive_app (HIVE_DATABASE_URL). Không có khi chạy test đơn vị không cần database. */
  pool?: pg.Pool | undefined;
  /** Kiểm run token cho /mcp; bỏ trống thì lấy từ lõi giao run, không có cả hai thì cổng chỉ nhận token OAuth. */
  runTokens?: RunTokenVerifier | undefined;
  /** Hàng đợi pg-boss; không có thì không tạo được dự án. */
  jobs?: Jobs | undefined;
  /** Thay GitHub/GitLab thật bằng provider giả khi test. */
  providerFactory?: ProviderFactory | undefined;
  /** Tạo embedding cho memory; không có thì chỉ tìm theo từ. */
  embedder?: Embedder | undefined;
  /** Lõi giao run; không có thì xem được run nhưng không giao hay huỷ được (thiếu HIVE_AUTH_SECRET). */
  runs?: RunsEngine | undefined;
  /** Kết nối LISTEN cho SSE của run; bỏ trống thì tự tạo từ pool. */
  runNotifier?: RunNotifier | undefined;
  /** DNS giả cho test xác minh tên miền SSO; bỏ trống thì tra DNS thật. */
  resolveTxt?: TxtResolver | undefined;
  /** Thay API Telegram/Slack thật bằng máy chủ giả khi test. */
  chatApis?: ChatApiDeps | undefined;
}

export function createApp({
  config,
  auth: baseAuth,
  pool,
  runTokens,
  jobs,
  providerFactory,
  embedder,
  runs,
  runNotifier,
  resolveTxt,
  chatApis,
  webDist = process.env.HIVE_WEB_DIST,
}: AppDeps) {
  const publicUrl = config.publicUrl ?? `http://localhost:${config.port}`;
  // Một cache cho cả route Hono (Tauri) và handler oRPC: manifest chỉ đọc một lần mỗi 5 phút.
  const desktopReleases = new DesktopReleaseCache(config.desktopReleases);
  const registry = new McpToolRegistry();
  tenancyMcpTools(registry);
  // Vai trò tự tạo có quyền tương ứng (vd. mcp.servers) được nhận thay vai trò quản trị tổ chức.
  registry.provideAuthorization(async (tx, userId, min, permission) =>
    permission
      ? ((await allowWith(tx, userId, permission, () => requireOrgRole(tx, userId, min))) ?? "member")
      : requireOrgRole(tx, userId, min),
  );
  registry.provideProjects(findProject);
  runsMcpTools(registry);
  knowledgeMcpTools(registry, { embedder, jobs, publicUrl });
  catalogMcpTools(registry);
  leaderMcpTools(registry, { runs });
  provideThreadHost(createThreadHost(runs));
  provideLinkTarget("chat_thread", createThreadLinkTarget());
  artifactsMcpTools(registry, { pool, jobs, publicUrl });
  sdlcMcpTools(registry);
  docsyncMcpTools(registry);
  const terminal = {
    enabled: config.remoteTerminal ?? false,
    publicUrl,
    tokenKey: config.authSecret ? terminalTokenKey(config.authSecret) : undefined,
  };
  // REST API của người dùng nhận cả token cá nhân (app desktop, spec 008 FR-026). Better Auth, cổng MCP và quản trị
  // token MCP giữ baseAuth: token cá nhân không được tự tạo, gia hạn hay thu hồi token.
  const auth = baseAuth && pool ? withPersonalTokens(baseAuth, pool, registry) : baseAuth;
  const shared = {
    auth,
    pool,
    masterKey: config.masterKey,
    providerFactory: providerFactory ?? defaultProviderFactory,
  };
  const frameKey = config.masterKey ? frameTicketKey(config.masterKey) : undefined;
  // Cổng tạo run bước và run đợt chỉ có khi có lõi giao run; thiếu thì hạng mục vẫn đi qua cổng duyệt.
  const sdlcDeps: SdlcDeps = runs?.sdlcDeps ?? {
    jobs,
    publicUrl,
    masterKey: config.masterKey,
    providerFactory: shared.providerFactory,
  };
  const auditMiddleware = orgMiddlewares({ auth, pool });
  const auditBase = implement(contract.audit)
    .$context<RequestContext>()
    .use(auditMiddleware.authed)
    .use(auditMiddleware.orgMember);
  const audit = {
    list: auditBase.list.handler(({ context, input }) =>
      withAuditAccess(
        context.pool,
        { userId: context.user.id, orgId: context.orgId },
        // Quản trị tổ chức, hoặc vai trò tự tạo có audit.read (vd. "Kiểm toán").
        (tx: Tx) => allowWith(tx, context.user.id, "audit.read", () => requireOrgRole(tx, context.user.id, "admin")),
        (tx) => queryAudit(tx, input),
      ),
    ),
    export: auditBase.export.handler(({ context, input }) =>
      withAuditAccess(
        context.pool,
        { userId: context.user.id, orgId: context.orgId },
        (tx: Tx) => allowWith(tx, context.user.id, "audit.export", () => requireOrgRole(tx, context.user.id, "admin")),
        (tx) => exportAudit(tx, input),
      ),
    ),
    retention: auditBase.retention.handler(({ context }) =>
      withAuditAccess(
        context.pool,
        { userId: context.user.id, orgId: context.orgId },
        (tx: Tx) => allowWith(tx, context.user.id, "audit.read", () => requireOrgRole(tx, context.user.id, "admin")),
        getAuditRetention,
      ),
    ),
    // Hạ thời hạn lưu làm mất nhật ký cũ, nên chỉ chủ sở hữu và quản trị tổ chức được đổi; vai trò tự tạo có audit.read
    // hay audit.export thì không.
    setRetention: auditBase.setRetention.handler(({ context, input }) =>
      withAuditAccess(
        context.pool,
        { userId: context.user.id, orgId: context.orgId },
        (tx: Tx) => requireOrgRole(tx, context.user.id, "admin"),
        (tx) => setAuditRetention(tx, input),
      ),
    ),
  };
  // Chạy thử quy trình code đọc run có sẵn; `codereview` không import `runs` nên cổng đọc cài vào ở đây. Không có lõi giao
  // run thì không có `diffStats`, quy tắc cần số liệu sẽ chờ người xem như khi worker cũ không báo.
  const codeRuns: CodeRunPort = {
    async load(tx, userId, runId) {
      const run = await runForUser(tx, userId, runId, "viewer");
      const project = await loadProject(tx, run.projectId);
      if (!project) throw new NotFoundError("RUN_NOT_FOUND", "Không tìm thấy run.");
      const evidence = await runs?.runEvidence(tx, run.id);
      const prNumber = run.prUrl?.match(/\/(?:pull|pull-requests|merge_requests)\/(\d+)/)?.[1];
      return {
        id: run.id,
        kind: run.kind,
        project: {
          id: project.id,
          key: project.key,
          name: project.name,
          teamId: project.teamId,
          defaultBranch: project.defaultBranch ?? "main",
        },
        taskType: evidence?.taskType ?? null,
        pr: run.prUrl && prNumber ? { number: Number(prNumber), url: run.prUrl } : null,
        baseBranch: project.defaultBranch ?? "main",
        stats: evidence?.stats ?? null,
      };
    },
  };
  const router = {
    audit,
    system: systemRouter(config, desktopReleases, wordImportHealth),
    me: meRouter(auth),
    ...tenancyRouter({ auth, pool, orgCreators: config.orgCreators, publicUrl: config.publicUrl, resolveTxt }),
    ...fleetRouter({
      auth,
      pool,
      publicUrl,
      workerReleases: new WorkerReleaseCache(config.workerReleases),
      issuePersonalToken: (tx, userId, purpose) => issueDesktopToken(tx, userId, registry, purpose),
    }),
    scmConnections: scmRouter(shared),
    notificationChannels: notifyRouter({ ...shared, allowPrivate: config.notifyAllowPrivate }),
    inbox: inboxRouter({ auth, pool, jobs }),
    chat: chatRouter({ ...shared, ...chatApis, publicUrl, telegramPollingBotIds: config.telegramPollingBotIds }),
    projects: catalogRouter({ ...shared, jobs, publicUrl }),
    projectMembers: projectMembersRouter({ ...shared, jobs, publicUrl }),
    ...knowledgeRouter({
      auth,
      pool,
      jobs,
      embedder,
      masterKey: config.masterKey,
      providerFactory: providerFactory ?? defaultProviderFactory,
      publicUrl,
      docAssist: runs?.docAssist,
      briefs: runs?.briefs,
    }),
    ...docsyncRouter({ auth, pool, jobs, masterKey: config.masterKey, publicUrl }),
    ...deliveryRouter({
      auth,
      pool,
      jobs,
      masterKey: config.masterKey,
      providerFactory: providerFactory ?? defaultProviderFactory,
      publicUrl,
    }),
    ...skillLearningRouter({ auth, pool, jobs }),
    tasks: tasksRouter({ auth, pool, cancelRuns: runs?.cancelRunsOfTask, plans: runs?.planActions }),
    runs: runsRouter({ auth, pool, engine: runs }),
    ...codeReviewsRouter({
      auth,
      pool,
      jobs,
      publicUrl,
      masterKey: config.masterKey,
      providerFactory: providerFactory ?? defaultProviderFactory,
      startReviewRuns: runs?.startReviewRuns,
      queueFixRun: runs?.queueFixRun,
      runEvidence: runs?.runEvidence,
      specContextFor: reviewSpecFor,
      runs: codeRuns,
    }),
    costs: costsRouter({ auth, pool }),
    sandbox: sandboxRouter({ auth, pool }),
    leader: leaderRouter({ auth, pool, runs, sdlc: sdlcDeps }),
    sdlc: sdlcRouter({ auth, pool, ...sdlcDeps }),
    mcpAdmin: mcpAdminRouter({ auth: baseAuth, pool, registry }),
    roles: rolesRouter({ auth, pool }),
    policies: policiesRouter({
      auth,
      pool,
      templates: templateService({ publicUrl, jobs }),
      remote: remotePolicyHook,
    }),
    terminal: terminalRouter({ auth, pool, terminal }),
    remote: remoteRouter({ auth, pool, remote: { enabled: terminal.enabled, publicUrl } }),
    artifacts: artifactsRouter({ auth, pool, jobs, publicUrl, frameKey }),
  };
  // RPC cho web (cùng kiểu dữ liệu TypeScript), OpenAPI cho worker Go và tích hợp ngoài. Cùng một router.
  const rpc = new RPCHandler(router, { clientInterceptors: [mapDomainErrors] });
  const openapi = new OpenAPIHandler(router, { clientInterceptors: [mapDomainErrors] });
  const app = new Hono();
  // Danh sách của trang chủ và bảng việc cỡ MB với vài nghìn task (JSON nén còn chừng một phần mười, ~6 ms mỗi MB).
  // Luồng SSE (text/event-stream) không bị nén vì phải tới từng sự kiện.
  app.use("/rpc/*", compress());
  app.use("/api/*", compress());
  // Better Auth giữ /api/auth/*; phải đăng ký trước handler OpenAPI vì cùng tiền tố /api.
  if (baseAuth) app.on(["GET", "POST"], "/api/auth/*", (c) => baseAuth.handler(c.req.raw));
  // SSE nằm ngoài oRPC (luồng dài, Last-Event-ID); cũng phải đứng trước handler OpenAPI.
  const notifier = runNotifier ?? (pool ? new RunNotifier(pool) : undefined);
  app.get("/api/v1/runs/:id/stream", runStreamHandler({ auth, pool, notifier }));
  app.get("/api/v1/deploys/:id/stream", deployStreamHandler({ auth, pool }));
  // Webhook đọc thân request dạng byte để kiểm HMAC, nên đi thẳng qua Hono, không qua oRPC.
  const hooks = {
    pool,
    jobs,
    resolveTarget: pool ? (id: string) => findWebhookTarget(pool, config.masterKey, id) : undefined,
  };
  const docSyncDeps = { pool, jobs, masterKey: config.masterKey, providerFactory, publicUrl, auth };
  app.post("/hooks/docs/:homeId", (c) => handleDocsWebhook(docSyncDeps, c.req.param("homeId"), c.req.raw));
  app.post("/api/v1/docs/assets", (c) => handleAssetUpload(docSyncDeps, c.req.raw));
  app.get("/api/v1/docs/assets", (c) => handleAssetDownload(docSyncDeps, c.req.raw));
  app.get("/api/v1/docs/assets/:id", (c, next) =>
    c.req.param("id") === "list" ? next() : handleAssetDownload(docSyncDeps, c.req.raw, c.req.param("id")),
  );
  // Nhập Word (spec 019): multipart và file nhị phân đi qua Hono như đính kèm; phần còn lại là oRPC `wordImports`.
  app.post(WORD_IMPORT_UPLOAD_PATH, (c) => handleWordUpload(docSyncDeps, c.req.raw));
  app.get(`${WORD_IMPORT_UPLOAD_PATH}/:importId/files/:fileId/media/:name`, (c) =>
    handleWordMedia(docSyncDeps, c.req.raw, {
      importId: c.req.param("importId"),
      fileId: c.req.param("fileId"),
      name: c.req.param("name"),
    }),
  );
  app.get(`${WORD_IMPORT_UPLOAD_PATH}/:importId/files/:fileId/original`, (c) =>
    handleWordOriginal(docSyncDeps, c.req.raw, {
      importId: c.req.param("importId"),
      fileId: c.req.param("fileId"),
    }),
  );
  app.post("/hooks/git/:projectId", (c) => handleGitWebhook(hooks, c.req.param("projectId"), c.req.raw));
  // Kho skill Git của tổ chức (ADR 0014); đường riêng vì /hooks/git/{projectId} coi mọi đoạn là id dự án.
  if (pool)
    app.post("/hooks/skills/:repoId", (c) =>
      handleSkillWebhook(
        { pool, masterKey: config.masterKey, providerFactory: providerFactory ?? defaultProviderFactory, jobs },
        c.req.param("repoId"),
        c.req.raw,
      ),
    );
  // Telegram và Slack gọi vào đây không có phiên người dùng; mỗi route tự kiểm secret/chữ ký của bot theo id trong URL.
  if (pool) {
    const chat = {
      pool,
      masterKey: config.masterKey,
      runs,
      jobs,
      publicUrl,
      ...chatApis,
      telegramPollingBotIds: config.telegramPollingBotIds,
      codeReviews: {
        ...shared,
        jobs,
        publicUrl,
        startReviewRuns: runs?.startReviewRuns,
        queueFixRun: runs?.queueFixRun,
        runEvidence: runs?.runEvidence,
        specContextFor: reviewSpecFor,
      },
    };
    app.post("/hooks/chat/telegram/:botId", (c) => handleTelegramWebhook(chat, c.req.param("botId"), c.req.raw));
    for (const route of ["events", "commands", "interact"] as const) {
      app.post(`/hooks/chat/slack/:botId/${route}`, (c) =>
        handleSlackWebhook(chat, c.req.param("botId"), route, c.req.raw),
      );
    }
  }
  // Worker lấy skill để chép vào worktree của run (knowledge/run-skills.ts); xác thực bằng run token như /mcp.
  const skillRunTokens = runTokens ?? runs?.mcpRunTokens;
  if (pool && skillRunTokens)
    app.post("/api/v1/run/skills", (c) => handleRunSkills({ pool, runTokens: skillRunTokens }, c.req.raw));
  // tauri-plugin-updater đòi 204 khi không có bản mới; handler oRPC cùng đường dẫn (để có trong OpenAPI) trả 200 với
  // null, nên route này phải đứng trước handler /api.
  app.get("/api/v1/desktop/updates/:os/:arch/:currentVersion", async (c) => {
    const result = await findDesktopUpdate(
      desktopReleases,
      c.req.param("os"),
      c.req.param("arch"),
      c.req.param("currentVersion"),
    );
    if (result.kind === "bad-request") return c.json({ message: "Tham số phiên bản hoặc nền tảng không hợp lệ." }, 400);
    if (result.kind === "none") return c.body(null, 204);
    return c.json(result.update, 200);
  });
  const mode = baseAuth && pool ? mcpMode(String(baseAuth.options.baseURL), config.mcpAllowHttp ?? false) : "off";
  if (baseAuth && pool && mode !== "off") {
    // Metadata OAuth (RFC 9728, RFC 8414) nằm ở /.well-known theo chuẩn, ngoài basePath của Better Auth; plugin mcp
    // tự trả các đường này khi request đi qua handler của Better Auth. Chế độ chỉ-run-token không có plugin mcp.
    if (mode === "full") {
      app.on(["GET", "HEAD"], "/.well-known/*", async (c) => {
        const res = await baseAuth.handler(c.req.raw);
        return res.status === 404 ? c.notFound() : res;
      });
    }
    const mcp = createMcpEndpoint({
      auth: baseAuth,
      pool,
      registry,
      version: config.version,
      // Token của phiên terminal Leader đi cùng đường run token (kể cả chế độ chỉ-run-token khi hub chạy http).
      runTokens: chainVerifiers(
        runTokens ?? runs?.mcpRunTokens,
        terminal.tokenKey ? createTerminalTokenVerifier({ pool, key: terminal.tokenKey, publicUrl }) : undefined,
      ),
      runTokensOnly: mode === "run",
    });
    // Đăng ký trước handler /api và SPA để /mcp không rơi vào index.html.
    app.all("/mcp", (c) => mcp(c.req.raw));
  }
  // Khung cách ly của artifact không dùng phiên người dùng (vé đã ký); đứng trước /rpc, /api và SPA để không đường nào
  // dưới /_artifact/ trả nội dung của web hay API (FR-073).
  app.route("/", frameRoutes({ pool, frameKey, publicUrl }));
  app.use("/rpc/*", async (c, next) => {
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: { headers: c.req.raw.headers },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  app.use("/api/*", async (c, next) => {
    const { matched, response } = await openapi.handle(c.req.raw, {
      prefix: "/api",
      context: { headers: c.req.raw.headers },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  if (webDist) {
    const root = resolve(webDist);
    const types: Record<string, string> = {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".ico": "image/x-icon",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
    };
    // Hub phục vụ web trực tiếp (Caddy là tuỳ chọn) nên tự nén: JS của trang đầu ~900 KB, nén còn chừng một phần ba.
    // File trong /assets/ có hash trong tên, không đổi trong suốt tiến trình, nên chỉ nén một lần rồi giữ bản nén.
    const compressible = new Set([".css", ".html", ".js", ".json", ".svg"]);
    const compressed = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
    const brotli = promisify(brotliCompress);
    const gz = promisify(gzip);
    const encode = (encoding: "br" | "gzip", body: Buffer) =>
      // Chép sang Uint8Array một lần lúc nén (bản giữ trong cache), vì Hono không nhận Buffer trên ArrayBufferLike.
      (encoding === "br"
        ? brotli(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } })
        : gz(body, { level: 9 })
      ).then((b) => new Uint8Array(b));
    app.get("*", async (c) => {
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(c.req.url).pathname);
      } catch {
        // Mã hoá % hỏng thì coi như đường dẫn không tồn tại, không để lỗi thành 500.
        return c.notFound();
      }
      const requested = resolve(root, `.${pathname}`);
      const safe = requested === root || requested.startsWith(`${root}${sep}`);
      if (safe) {
        try {
          const body = await readFile(requested);
          // File trong /assets/ có hash trong tên nên cache lâu được; index.html thì không.
          const immutable = pathname.startsWith("/assets/");
          const headers: Record<string, string> = {
            "Content-Type": types[extname(requested)] ?? "application/octet-stream",
            "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
          };
          if (!compressible.has(extname(requested)) || body.length < 1024) return c.body(body, 200, headers);
          headers.Vary = "Accept-Encoding";
          const accept = c.req.header("accept-encoding") ?? "";
          const encoding = /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null;
          if (!encoding) return c.body(body, 200, headers);
          let packed: Promise<Uint8Array<ArrayBuffer>>;
          if (immutable) {
            const key = `${encoding}:${requested}`;
            packed = compressed.get(key) ?? encode(encoding, body);
            if (!compressed.has(key)) {
              compressed.set(key, packed);
              packed.catch(() => compressed.delete(key));
            }
          } else packed = encode(encoding, body);
          return c.body(await packed, 200, { ...headers, "Content-Encoding": encoding });
        } catch {
          /* Đường dẫn SPA không phải file; trả entry point để client router xử lý. */
        }
      }
      // Endpoint MCP chỉ là đúng /mcp; /mcp/consent là trang web (trang đồng ý OAuth của Better Auth) nên phải ra SPA.
      const path = c.req.path;
      if (path === "/mcp" || ["/api/", "/rpc/", "/.well-known/"].some((p) => path.startsWith(p))) return c.notFound();
      try {
        return c.html(await readFile(resolve(root, "index.html"), "utf8"));
      } catch {
        return c.notFound();
      }
    });
  }
  return app;
}
