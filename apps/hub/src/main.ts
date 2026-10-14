import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { auditRetentionQueue, registerAuditRetentionWorker } from "./modules/audit/index.ts";
import {
  mergeQueue,
  provisionQueue,
  registerMergeWorker,
  registerProvisionWorker,
  registerTemplateSyncWorker,
  templateSyncQueue,
} from "./modules/catalog/index.ts";
import { chatQueue, installChatHooks, registerChatWorker } from "./modules/chat/index.ts";
import {
  codeReviewQueue,
  codeReviewSlaQueue,
  registerCodeReviewScm,
  registerCodeReviewSla,
  registerCodeReviewWorker,
  reviewGate,
} from "./modules/codereview/index.ts";
import {
  attachWorkerGateway,
  fleetOfflineQueue,
  registerFleetOfflineWorker,
  registerRunHandlers,
  registerTerminalHandlers,
} from "./modules/fleet/index.ts";
import { createAuth, mcpMode } from "./modules/identity/index.ts";
import {
  createOpenAIEmbedder,
  embedQueue,
  registerEmbedWorker,
  registerReviewWorker,
  registerSkillGitWorker,
  reviewQueue,
  skillGitQueue,
} from "./modules/knowledge/index.ts";
import { appendLeaderSystemMessage, queuedLeaderPrompt } from "./modules/leader/index.ts";
import {
  inboxCleanupQueue,
  notify,
  notifyQueue,
  registerInboxCleanupWorker,
  registerNotifyWorker,
} from "./modules/notify/index.ts";
import { createJobs, createPool, loadConfig } from "./modules/platform/index.ts";
import {
  createRunsEngine,
  registerRunLogRetentionWorker,
  runLogRetentionQueue,
  runsTimerQueue,
} from "./modules/runs/index.ts";
import {
  auditScmEvent,
  defaultProviderFactory,
  onScmEvent,
  registerScmEventWorker,
  scmEventQueue,
  scmEvents,
} from "./modules/scm/index.ts";
import { registerSkillLearningWorker, skillLearningPrQueue, skillLearningQueue } from "./modules/skilllearn/index.ts";
import { authHooks, orphanUsersQueue, registerOrphanUsersWorker } from "./modules/tenancy/index.ts";
import { attachTerminalGateway, createTerminalHandlers } from "./modules/terminal/index.ts";

const config = loadConfig();
const roles = config.roles ?? ["api", "jobs"];
const pool = config.databaseUrl ? createPool(config.databaseUrl) : undefined;
if (!pool) console.warn("Chưa cấu hình HIVE_DATABASE_URL: API tổ chức, máy và cổng worker không dùng được.");
let jobs: ReturnType<typeof createJobs> | undefined;
const auth =
  config.authDatabaseUrl && config.authSecret
    ? createAuth({
        pool: createPool(config.authDatabaseUrl),
        baseURL: config.publicUrl ?? `http://localhost:${config.port}`,
        secret: config.authSecret,
        trustedOrigins: config.publicUrl ? [config.publicUrl] : [],
        github: config.github,
        gitlab: config.gitlab,
        allowEmailSignUp: config.allowEmailSignUp ?? false,
        orgCreators: config.orgCreators,
        hooks: pool
          ? authHooks(pool, {
              onMemberPending: (tx, member) =>
                notify(
                  tx,
                  {
                    orgId: member.orgId,
                    event: "member.pending",
                    eventKey: member.userId,
                    title: `${member.email} chờ duyệt vào tổ chức`,
                    body: `${member.name} (${member.email}) vừa đăng nhập bằng SSO. Hãy xem và duyệt thành viên đang chờ.`,
                    link: `${config.publicUrl ?? `http://localhost:${config.port}`}/admin/members`,
                  },
                  { jobs },
                ),
            })
          : undefined,
      })
    : undefined;
if (!auth) console.warn("Chưa cấu hình HIVE_DATABASE_AUTH_URL: hub chạy không có đăng nhập.");
else {
  const mode = mcpMode(config.publicUrl ?? "", config.mcpAllowHttp ?? false);
  if (mode === "run") console.warn("MCP qua http chỉ cho agent trong run, chỉ dùng trong mạng tin cậy.");
  else if (mode === "off")
    console.warn(
      "HIVE_PUBLIC_URL không phải HTTPS: tắt cổng /mcp (bật HIVE_MCP_ALLOW_HTTP=1 để cho agent trong run dùng qua http).",
    );
}

jobs = config.jobsDatabaseUrl
  ? createJobs({
      connectionString: config.jobsDatabaseUrl,
      queues: [
        provisionQueue,
        mergeQueue,
        runsTimerQueue,
        scmEventQueue,
        embedQueue,
        notifyQueue,
        chatQueue,
        inboxCleanupQueue,
        fleetOfflineQueue,
        orphanUsersQueue,
        runLogRetentionQueue,
        skillGitQueue,
        skillLearningQueue,
        skillLearningPrQueue,
        reviewQueue,
        auditRetentionQueue,
        templateSyncQueue,
        codeReviewQueue,
        codeReviewSlaQueue,
      ],
      // Giám sát và lịch nền của pg-boss chỉ cần chạy ở tiến trình xử lý job.
      maintenance: roles.includes("jobs"),
    })
  : undefined;
if (!jobs) console.warn("Chưa cấu hình HIVE_DATABASE_JOBS_URL: hub chạy không có hàng đợi, không tạo được dự án.");
await jobs?.start();

// Gateway và lõi giao run chạy cùng tiến trình: gói job_offer, lease chỉ gửi được qua kết nối WSS mà tiến trình này
// giữ. Chạy nhiều tiến trình api thì cần chuyển gói qua NOTIFY (chưa làm).
const runs =
  pool && config.authSecret
    ? createRunsEngine({
        pool,
        publicUrl: config.publicUrl ?? `http://localhost:${config.port}`,
        authSecret: config.authSecret,
        masterKey: config.masterKey,
        providerFactory: defaultProviderFactory,
        jobs,
        leaderMessage: appendLeaderSystemMessage,
        leaderQueuedPrompt: queuedLeaderPrompt,
      })
    : undefined;
if (!runs) console.warn("Chưa cấu hình HIVE_AUTH_SECRET: chưa ký được run token, không giao được run.");
if (runs) registerRunHandlers(runs.handlers);

// Thông báo và câu trả lời của leader đi tới chat qua hai hook mà notify và leader để ngỏ (không import chat được vì vòng
// phụ thuộc). Cài ở mọi vai trò: notify() chạy cả trong tiến trình api lẫn jobs.
installChatHooks(pool ? { jobs, publicUrl: config.publicUrl ?? `http://localhost:${config.port}` } : undefined);

if (roles.includes("jobs") && jobs) {
  if (runs) await runs.registerJobs(jobs);
  if (!pool || !config.masterKey) {
    console.warn("Vai trò jobs cần HIVE_DATABASE_URL và HIVE_MASTER_KEY; bỏ qua saga khởi tạo dự án và hàng merge.");
  } else {
    const catalogDeps = {
      pool,
      masterKey: config.masterKey,
      providerFactory: defaultProviderFactory,
      publicUrl: config.publicUrl ?? `http://localhost:${config.port}`,
      jobs,
    };
    await registerProvisionWorker(jobs, catalogDeps);
    // `catalog` không import `codereview` (vòng phụ thuộc), nên cổng chờ phiên review được tiêm ở đây.
    await registerMergeWorker(jobs, { ...catalogDeps, reviewGate });
    await registerTemplateSyncWorker(jobs, catalogDeps);
    await registerReviewWorker(jobs, {
      pool,
      masterKey: config.masterKey,
      providerFactory: defaultProviderFactory,
      publicUrl: catalogDeps.publicUrl,
      startDocCheck: runs?.startDocCheck,
    });
    await registerSkillGitWorker(jobs, {
      pool,
      masterKey: config.masterKey,
      providerFactory: defaultProviderFactory,
      publicUrl: catalogDeps.publicUrl,
      jobs,
    });
    // Chạy cùng tiến trình với lõi giao run (runs cài cổng tạo run đề xuất skill); không có runs thì chỉ mở PR.
    await registerSkillLearningWorker(jobs, {
      pool,
      masterKey: config.masterKey,
      providerFactory: defaultProviderFactory,
      publicUrl: catalogDeps.publicUrl,
      runs: runs?.skillLearning,
      logger: console,
    });
  }
  if (pool) {
    await registerFleetOfflineWorker(jobs, {
      pool,
      publicUrl: config.publicUrl ?? `http://localhost:${config.port}`,
      notifyAfterSec: config.machineOfflineNotifySec,
    });
    // Mọi sự kiện Git vào audit; module runs xử lý PR merge/đóng, issue có nhãn và bình luận nhắc bot.
    onScmEvent("*", auditScmEvent);
    runs?.registerScmHandlers();
    // `runs` import `codereview` (mở phiên khi run kết thúc), nên các cổng tạo run, đọc bằng chứng cài vào từ đây.
    // Thiếu khoá chủ thì phiên vẫn chạy, chỉ không đọc được diff và không đăng bình luận lên PR.
    const codeReviewDeps = {
      pool,
      masterKey: config.masterKey,
      providerFactory: defaultProviderFactory,
      publicUrl: config.publicUrl ?? `http://localhost:${config.port}`,
      startReviewRuns: runs?.startReviewRuns,
      queueFixRun: runs?.queueFixRun,
      runEvidence: runs?.runEvidence,
    };
    await registerCodeReviewWorker(jobs, codeReviewDeps);
    await registerCodeReviewSla(jobs, { pool, publicUrl: codeReviewDeps.publicUrl });
    registerCodeReviewScm(scmEvents, { ...codeReviewDeps, jobs });
    await registerScmEventWorker(jobs, { pool });
    // Thiếu khoá chủ thì job vẫn chạy để đánh dấu thông báo failed kèm lý do, không để nằm queued mãi.
    await registerNotifyWorker(jobs, { pool, masterKey: config.masterKey, allowPrivate: config.notifyAllowPrivate });
    await registerChatWorker(jobs, {
      pool,
      masterKey: config.masterKey,
      publicUrl: config.publicUrl ?? `http://localhost:${config.port}`,
    });
    await registerOrphanUsersWorker(jobs, { pool, keepEmails: config.orgCreators });
    await registerRunLogRetentionWorker(jobs, pool);
    await registerInboxCleanupWorker(jobs, pool);
    await registerAuditRetentionWorker(jobs, { pool });
  }
}

const embedder = config.embeddings ? createOpenAIEmbedder(config.embeddings) : undefined;
if (roles.includes("jobs") && jobs && pool && embedder) await registerEmbedWorker(jobs, { pool, embedder });

if (roles.includes("api")) {
  const server = serve(
    { fetch: createApp({ config, auth, pool, jobs, runs, embedder }).fetch, port: config.port },
    (info) => {
      console.log(`xDev Hive hub ${config.version} lắng nghe ở :${info.port}`);
    },
  );
  // serve() tạo server HTTP/1.1 khi không cấu hình http2; WebSocket chỉ nâng cấp được trên HTTP/1.1.
  if (pool) {
    attachWorkerGateway(server as Server, {
      pool,
      jobs,
      publicUrl: config.publicUrl,
      offlineNotifySec: config.machineOfflineNotifySec,
    });
    // Terminal Leader chạy cùng tiến trình với cổng worker: gói term_* chỉ đi được qua kết nối WSS tiến trình này giữ.
    registerTerminalHandlers(createTerminalHandlers(pool));
    attachTerminalGateway(server as Server, { pool, publicUrl: config.publicUrl });
  }
}

// pg-boss nhả job đang giữ khi dừng êm, để tiến trình khác nhận lại ngay thay vì chờ hết hạn.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    runs?.stop();
    void (jobs?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
  });
}
