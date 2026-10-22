import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import type { DeployStep, DeployVersion, TargetUpsertInput } from "@xdev-hive/contracts";
import pg from "pg";
import { Header } from "tar";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, encryptSecret, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import type { GitProvider } from "../scm/index.ts";
import { generateServerKey } from "./clients/ssh.ts";
import type { DeployProgress, DeployRun } from "./deploys/method.ts";
import { type SshScriptRemote, sshScript } from "./deploys/ssh-script.ts";
import type { DeliveryDeps } from "./deps.ts";
import { createEnvironment } from "./environments.ts";
import { serverKeyContext } from "./servers.ts";
import { upsertTarget } from "./targets.ts";
import { startSshd, type TestSshd } from "./testing/sshd.ts";

// Cách ssh-script chạy thật trên OpenSSH trong container (testing/sshd.ts): run.sh, setsid, status.json, đọc log
// theo byte, health. Ca khó (huỷ, hub khởi động lại, mất kết nối, hết giờ) ở T026.

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));

const COMMIT = "4f1c2d3e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d";
const SECRET = "mat-khau-bi-mat-0123456789";
const WORKDIR = "/opt/billing";

let sshd: TestSshd;
let org: Awaited<ReturnType<typeof seedOrg>>;
let projectId: string;
let serverId: string;
let envCount = 0;
const archives: string[] = [];
const healthCalls: string[] = [];

const uid = (name: string) => org.user(name);
const as = <T>(run: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId, userId: uid("tadmin") }, run);

/** tar.gz như GitLab trả: mọi file nằm dưới một thư mục `<repo>-<sha>/`. */
function sourceTarball(commit: string): Buffer {
  const top = `repo-billing-${commit}`;
  const entries = [
    { path: `${top}/`, type: "Directory", body: "" },
    { path: `${top}/VERSION`, type: "File", body: `${commit}\n` },
    { path: `${top}/compose.yaml`, type: "File", body: "services:\n  app:\n    image: billing:dev\n" },
  ];
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body);
    const h = new Header({
      path: e.path,
      size: body.length,
      type: e.type as never,
      mode: e.type === "Directory" ? 0o755 : 0o644,
      mtime: new Date(0),
    });
    h.encode();
    blocks.push(h.block as Buffer, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const deps: DeliveryDeps = {
  pool: app,
  masterKey,
  providerFactory: () =>
    ({
      archive: async (_ref: unknown, sha: string) => {
        archives.push(sha);
        return new Blob([new Uint8Array(sourceTarball(sha))]).stream();
      },
    }) as unknown as GitProvider,
  fetch: async (input) => {
    healthCalls.push(String(input));
    return Response.json({ version: COMMIT.slice(0, 8) });
  },
};

type SshConfigInput = Extract<TargetUpsertInput["config"], { method: "ssh-script" }>;

const config = (over: Partial<SshConfigInput> = {}): SshConfigInput =>
  ({
    method: "ssh-script",
    schemaVersion: 1,
    serverId,
    workdir: WORKDIR,
    composeProject: "billing",
    steps: {
      precheck: { script: "docker compose config -q", timeoutSec: 30 },
      backup: {
        script: 'mkdir -p backup\necho "sao lưu cho $APP_ENV" > "backup/$HIVE_DEPLOY_ID.txt"\necho "đã sao lưu"',
        timeoutSec: 30,
      },
      upload: { mode: "git-archive" },
      deploy: {
        script: [
          "rm -rf src && mv src.new src",
          'echo "phiên bản $(cat src/VERSION)"',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: lệnh của sh, `${#…}` là độ dài biến shell.
          'echo "độ dài mật khẩu ${#DB_PASSWORD}"',
          "docker compose -p billing up -d --build",
        ].join("\n"),
        timeoutSec: 30,
      },
    },
    health: {
      url: "https://billing.example.invalid/version",
      expectStatus: 200,
      match: { path: "version", equals: "{{commit8}}" },
      timeoutSec: 10,
      intervalSec: 1,
    },
    variables: [
      { name: "APP_ENV", secret: false, value: "staging" },
      { name: "DB_PASSWORD", secret: true, value: SECRET },
    ],
    ...over,
  }) as SshConfigInput;

/** Mỗi ca một môi trường, một đích: không vướng khoá "một lần đang chạy mỗi đích". */
async function newTarget(input: SshConfigInput) {
  envCount += 1;
  return as(async (tx) => {
    const env = await createEnvironment(tx, uid("tadmin"), {
      systemId: org.systemId,
      name: `ssh-${envCount}`,
      policy: { deployRoles: [], approveRoles: [], approvals: 0, approvalTtlHours: 24 },
    });
    return upsertTarget(tx, { masterKey }, uid("tadmin"), {
      projectId,
      environmentId: env.id,
      expectedConfigVersion: null,
      config: input,
    });
  });
}

interface Followed {
  run: DeployRun;
  remote: SshScriptRemote;
  progress: DeployProgress;
  log: string;
  polls: number;
}

/** Tạo lần triển khai, `start`, rồi `poll` như job theo dõi tới khi xong. */
async function deploy(
  input: SshConfigInput,
  commit: string | null = COMMIT,
): Promise<Followed & { startSteps: DeployStep[] }> {
  const target = await newTarget(input);
  const version: DeployVersion = { commit, tag: "v1.4.0", jenkinsBuild: null, image: null, images: [], revision: null };
  const deployId = randomUUID();
  await admin.query(
    `insert into hive.deploys (id, org_id, target_id, method, origin, state, version, requested_by, config_version)
     values ($1, $2, $3, 'ssh-script', 'hive', 'running', $4, $5, $6)`,
    [deployId, org.orgId, target.id, JSON.stringify(version), uid("tadmin"), target.configVersion],
  );
  const run: DeployRun = {
    orgId: org.orgId,
    deployId,
    targetId: target.id,
    config: target.config,
    version,
    requestedBy: uid("tadmin"),
    remote: null,
    external: null,
    signal: new AbortController().signal,
  };
  const started = await as((tx) => sshScript.start({ tx, deps }, run));
  let remote = started.remote as unknown as SshScriptRemote;
  let log = "";
  let progress: DeployProgress | undefined;
  let polls = 0;
  for (; polls < 120; polls++) {
    const current = { ...run, remote: { ...remote } };
    progress = await as((tx) => sshScript.poll({ tx, deps }, current));
    log += progress.log ?? "";
    remote = progress.remote as unknown as SshScriptRemote;
    if (progress.state !== "running") break;
    await sleep(250);
  }
  if (!progress) throw new Error("Không đọc được tiến độ.");
  // Lần triển khai xong: ghi như orchestrator để `version` thấy.
  await admin.query("update hive.deploys set state = $2, finished_at = now() where id = $1", [
    deployId,
    progress.state,
  ]);
  return { run, remote, progress, log, polls, startSteps: started.steps };
}

const stepStates = (steps: DeployStep[]) => steps.map((s) => [s.key, s.state]);

beforeAll(async () => {
  sshd = await startSshd();
  const key = generateServerKey();
  await sshd.authorize(key.publicKey);
  await sshd.exec(
    [
      `mkdir -p ${WORKDIR}`,
      `printf 'APP_ENV=staging\\n' > ${WORKDIR}/.env`,
      `printf 'services: {}\\n' > ${WORKDIR}/compose.yaml`,
      `chown -R deploy:deploy ${WORKDIR}`,
    ].join(" && "),
  );
  await sshd.composeProjects({ billing: `${WORKDIR}/compose.yaml` });

  org = await seedOrg(admin, `delivery-ssh-${randomUUID().slice(0, 8)}`);
  ({ projectId } = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: uid("admin"),
    masterKey,
    key: "billing",
  }));
  serverId = randomUUID();
  await admin.query(
    `insert into hive.deploy_servers (id, org_id, team_id, name, host, port, ssh_user, private_key_enc, public_key,
       host_keys, created_by)
     values ($1, $2, $3, 'web-1', $4, $5, $6, $7, $8, $9, $10)`,
    [
      serverId,
      org.orgId,
      org.teamId,
      sshd.host,
      sshd.port,
      sshd.user,
      encryptSecret(masterKey, key.privateKey, serverKeyContext(serverId)),
      key.publicKey,
      JSON.stringify(sshd.hostKeys),
      uid("tadmin"),
    ],
  );
}, 600_000);

afterAll(async () => {
  await Promise.all([admin.end(), app.end(), sshd?.stop()]);
});

describe("ssh-script trên sshd thật", () => {
  it("chạy đủ bước, đọc log theo byte, health đạt; bắt đầu lại không chạy lại run.sh", async () => {
    await sshd.exec("rm -f /home/deploy/.fake-docker/calls");
    healthCalls.length = 0;
    const done = await deploy(config());

    expect(stepStates(done.startSteps)).toEqual([
      ["precheck", "pending"],
      ["backup", "pending"],
      ["upload", "pending"],
      ["deploy", "pending"],
      ["health", "pending"],
    ]);
    expect(done.progress.state).toBe("succeeded");
    expect(stepStates(done.progress.steps)).toEqual([
      ["precheck", "succeeded"],
      ["backup", "succeeded"],
      ["upload", "succeeded"],
      ["deploy", "succeeded"],
      ["health", "succeeded"],
    ]);
    expect(done.progress.health?.ok).toBe(true);
    expect(healthCalls).toEqual(["https://billing.example.invalid/version"]);
    expect(archives).toContain(COMMIT);

    // Log đọc tiếp qua nhiều lần poll ghép lại đúng file log trên máy chủ, vị trí đọc tính theo byte.
    const serverLog = await sshd.readFile(`${done.remote.dir}/log`);
    expect(done.log).toBe(serverLog);
    expect(done.remote.offset).toBe(Buffer.byteLength(serverLog));
    expect(done.log).toContain("Thư mục, .env và compose project billing khớp cấu hình.");
    expect(done.log).toContain("đã sao lưu");
    expect(done.log).toContain(`Đã giải nén mã của commit ${COMMIT}`);
    expect(done.log).toContain(`phiên bản ${COMMIT}`);
    expect(done.log).toContain(`độ dài mật khẩu ${SECRET.length}`);
    expect(done.log).toContain("Container billing-app-1  Started");
    expect(done.log).toContain("Kết thúc: các bước đều xong.");
    expect(done.log).not.toContain(SECRET);

    // Thư mục lần triển khai nằm trong ~/.hive-deploy, file biến và tarball đã xoá, run.sh tách khỏi phiên SSH.
    expect(done.remote.dir).toBe(`/home/deploy/.hive-deploy/${done.run.deployId}`);
    const leftovers = await sshd.exec(
      `cd ${done.remote.dir} && ls -A && stat -c '%a %n' run.sh steps/deploy.sh && cat pid && ` +
        `ls -A ${WORKDIR} && cat ${WORKDIR}/backup/${done.run.deployId}.txt`,
    );
    expect(leftovers.stdout).not.toMatch(/^vars$/m);
    expect(leftovers.stdout).not.toContain("src.new.tar.gz");
    expect(leftovers.stdout).toContain("600 run.sh");
    expect(leftovers.stdout).toMatch(new RegExp(`^${done.remote.pid}$`, "m"));
    expect(leftovers.stdout).toMatch(/^src$/m);
    expect(leftovers.stdout).not.toMatch(/^src\.new$/m);
    expect(leftovers.stdout).toContain("sao lưu cho staging");
    expect(await sshd.dockerCalls()).toEqual([
      "compose ls -a --format json",
      "compose config -q",
      "compose -p billing up -d --build",
    ]);

    // Orchestrator gọi start lại (hub chết ngay sau khi chạy run.sh): giữ lần đang có, không gửi mã, không chạy lại.
    const archived = archives.length;
    const again = await as((tx) => sshScript.start({ tx, deps }, done.run));
    expect(again.remote).toMatchObject({ dir: done.remote.dir, pid: done.remote.pid, offset: 0 });
    expect(archives.length).toBe(archived);
    expect((await sshd.dockerCalls()).length).toBe(3);

    const version = await as((tx) =>
      sshScript.version({ tx, deps }, { targetId: done.run.targetId, config: done.run.config }),
    );
    expect(version).toMatchObject({ commit: COMMIT, tag: "v1.4.0" });
  }, 90_000);

  it("bước lỗi dừng chuỗi: bước sau bỏ qua, không triển khai, không gọi health", async () => {
    await sshd.exec("rm -f /home/deploy/.fake-docker/calls");
    await sshd.fakeDocker({ fail: "pg_dump", exitCode: 3, log: "fake: đang kết nối database" });
    healthCalls.length = 0;
    try {
      const done = await deploy(
        config({
          steps: {
            precheck: { script: "true", timeoutSec: 30 },
            backup: {
              script: "docker compose -p billing exec -T db pg_dump -Fc -f /backup/billing.dump billing",
              timeoutSec: 30,
            },
            upload: { mode: "none" },
            deploy: { script: "docker compose -p billing up -d", timeoutSec: 30 },
          },
        }),
      );

      expect(done.progress.state).toBe("failed");
      expect(done.progress.steps.map((s) => [s.key, s.state, s.exitCode, s.message])).toEqual([
        ["precheck", "succeeded", 0, null],
        ["backup", "failed", 3, "Thoát với mã 3."],
        ["upload", "skipped", null, "Đích không gửi mã nguồn; bước triển khai tự lấy mã."],
        ["deploy", "skipped", null, "Bỏ qua vì bước trước lỗi."],
        ["health", "skipped", null, "Bỏ qua vì bước trước lỗi."],
      ]);
      expect(done.log).toContain("fake: đang kết nối database");
      expect(done.log).toContain('fake docker: lỗi giả ở "pg_dump"');
      expect(done.log).toContain("Kết thúc: lỗi ở bước backup.");
      expect(healthCalls).toEqual([]);
      const calls = await sshd.dockerCalls();
      expect(calls.some((c) => c.includes(" up"))).toBe(false);
    } finally {
      await sshd.fakeDocker({});
    }
  }, 90_000);

  it("kiểm trước: compose project chạy từ thư mục khác thì dừng, nói rõ lệch", async () => {
    await sshd.composeProjects({ billing: "/opt/xdev-hive/compose.yaml" });
    await sshd.exec("rm -f /home/deploy/.fake-docker/calls");
    try {
      const done = await deploy(config());

      expect(done.progress.state).toBe("failed");
      const [precheck, ...rest] = done.progress.steps;
      expect(precheck).toMatchObject({
        key: "precheck",
        state: "failed",
        exitCode: 2,
        message: `Compose project billing không chạy từ thư mục ${WORKDIR}. Kiểm lại cấu hình đích trước khi triển khai.`,
      });
      expect(rest.map((s) => s.state)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
      expect(done.log).toContain("Compose project billing chạy từ /opt/xdev-hive/compose.yaml");
      expect(await sshd.dockerCalls()).toEqual(["compose ls -a --format json"]);
    } finally {
      await sshd.composeProjects({ billing: `${WORKDIR}/compose.yaml` });
    }
  }, 90_000);
});
