// Fixture tự chứa vì fake-hub nạp các fixture này; import ngược sẽ tạo vòng phụ thuộc.
export type DeliveryServersHandler = (input: unknown) => { status: number; json: unknown };

const ok = (value: unknown) => ({ status: 200, json: { json: value } });
const fail = (code: string, status: number, message: string, data?: unknown) => ({
  status,
  json: { json: { defined: true, code, status, message, ...(data === undefined ? {} : { data }) } },
});

/** Mặc định rỗng: fake-hub nạp hàm này vào mọi spec, nên trang không liên quan không bị ảnh hưởng. */
export function deliveryServersDefaults(): Record<string, DeliveryServersHandler> {
  return {};
}

const NOW = "2026-10-15T03:00:00.000Z";
export const SERVERS_TEAM_ID = "5a5a5a5a-0000-4000-8000-000000000001";
export const SERVERS_TEAM2_ID = "5a5a5a5a-0000-4000-8000-000000000002";
export const SERVERS_SYSTEM_ID = "5e5e5e5e-0000-4000-8000-000000000001";
export const SERVER_STAGING_ID = "71717171-0000-4000-8000-000000000001";
export const SERVER_PROD_ID = "71717171-0000-4000-8000-000000000002";
export const ENV_DEV_ID = "72727272-0000-4000-8000-000000000001";
export const ENV_PROD_ID = "72727272-0000-4000-8000-000000000002";
export const PROJECT_WEB_ID = "73737373-0000-4000-8000-000000000001";
export const PROJECT_API_ID = "73737373-0000-4000-8000-000000000002";
export const TARGET_WEB_DEV_ID = "74747474-0000-4000-8000-000000000001";
export const JENKINS_ID = "30303030-0000-4000-8000-000000000001";
export const FINGERPRINT = "SHA256:fakeFingerprintForTestsOnly0123456789abcdefghi";
/** Chuỗi giả để test chắc giá trị biến bí mật không hiện lại. */
export const FAKE_SECRET = "fake-secret-value-never-real-0123";

const fakeKey = (n: number) => `ssh-ed25519 AAAAC3NzaFAKEKEY${n}FAKEKEY hive-fake-${n}`;
const install = (key: string) => `mkdir -p ~/.ssh && echo "${key}" >> ~/.ssh/authorized_keys`;

type Server = Record<string, unknown> & { id: string; teamId: string; hostKeyFingerprints: string[] };
type Env = {
  id: string;
  systemId: string;
  name: string;
  position: number;
  policy: unknown;
  lock: null;
  runner: unknown;
  createdAt: string;
  updatedAt: string;
};
type Target = {
  id: string;
  projectId: string;
  environmentId: string;
  method: string;
  config: Record<string, unknown>;
  configVersion: number;
  updatedBy: null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Hub giả cho Máy chủ, Môi trường và Đích triển khai (T022). `state.nextTest` cho test chọn kết quả của lần Kiểm kế
 * tiếp; không đặt thì máy chủ chưa xác nhận dấu vân tay trả `hostkey_unconfirmed`, máy chủ đã xác nhận trả `ok`.
 * `state.conflictNext` làm lần lưu đích kế tiếp gặp TARGET_VERSION_CONFLICT (người khác vừa sửa, lên phiên bản 5).
 */
export function deliveryServersFixture() {
  const servers: Server[] = [
    {
      id: SERVER_STAGING_ID,
      teamId: SERVERS_TEAM_ID,
      name: "app-staging",
      host: "staging.example.com",
      port: 22,
      user: "deploy",
      labels: ["staging"],
      publicKey: fakeKey(1),
      installCommand: install(fakeKey(1)),
      hostKeyFingerprints: [],
      pendingKey: null,
      lastTest: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: SERVER_PROD_ID,
      teamId: SERVERS_TEAM_ID,
      name: "app-prod",
      host: "prod.example.com",
      port: 2222,
      user: "deploy",
      labels: [],
      publicKey: fakeKey(2),
      installCommand: install(fakeKey(2)),
      hostKeyFingerprints: [FINGERPRINT],
      pendingKey: null,
      lastTest: { at: NOW, ok: true, message: "ok" },
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  const envs: Env[] = [
    {
      id: ENV_DEV_ID,
      systemId: SERVERS_SYSTEM_ID,
      name: "dev",
      position: 0,
      policy: { deployRoles: [], approveRoles: [], approvals: 0, approvalTtlHours: 24 },
      lock: null,
      runner: { mode: "worker", machines: [], requireLabel: false },
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: ENV_PROD_ID,
      systemId: SERVERS_SYSTEM_ID,
      name: "prod",
      position: 1,
      policy: { deployRoles: ["admin"], approveRoles: ["admin"], approvals: 1, approvalTtlHours: 48 },
      lock: null,
      runner: { mode: "worker", machines: [], requireLabel: false },
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  const targets: Target[] = [
    {
      id: TARGET_WEB_DEV_ID,
      projectId: PROJECT_WEB_ID,
      environmentId: ENV_DEV_ID,
      method: "gitlab-manual",
      config: { schemaVersion: 1, method: "gitlab-manual", health: null, jobName: "deploy-dev", branch: null },
      configVersion: 3,
      updatedBy: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  const state = {
    servers,
    envs,
    targets,
    calls: [] as { path: string; input: unknown }[],
    nextTest: null as unknown,
    conflictNext: false,
  };
  const record = (path: string, input: unknown) => state.calls.push({ path, input });
  let next = 100;
  const newId = (prefix: string) => `${prefix}-0000-4000-8000-${String(++next).padStart(12, "0")}`;
  const server = (id: unknown) => servers.find((s) => s.id === id);
  const notFound = () => fail("NOT_FOUND", 404, "Không tìm thấy.");

  const rpc: Record<string, DeliveryServersHandler> = {
    "teams/list": () =>
      ok([
        {
          id: SERVERS_TEAM_ID,
          slug: "pay",
          name: "Thanh toán",
          color: null,
          createdAt: NOW,
          systemCount: 1,
          memberCount: 2,
        },
        {
          id: SERVERS_TEAM2_ID,
          slug: "infra",
          name: "Hạ tầng",
          color: null,
          createdAt: NOW,
          systemCount: 0,
          memberCount: 1,
        },
      ]),
    "systems/list": () =>
      ok([
        {
          id: SERVERS_SYSTEM_ID,
          teamId: SERVERS_TEAM_ID,
          slug: "cong",
          name: "Cổng thanh toán",
          description: "",
          createdAt: NOW,
        },
      ]),
    "projects/list": () =>
      ok(
        [
          { id: PROJECT_WEB_ID, key: "web", name: "Web" },
          { id: PROJECT_API_ID, key: "api", name: "Api" },
        ].map((p) => ({
          ...p,
          systemId: SERVERS_SYSTEM_ID,
          teamId: SERVERS_TEAM_ID,
          state: "active",
          createdAt: NOW,
        })),
      ),
    "ciConnections/list": () =>
      ok([
        {
          id: JENKINS_ID,
          name: "Jenkins công ty",
          url: "https://jenkins.example.com",
          watcher: null,
          watcherHasToken: false,
          lastPollAt: null,
          lastError: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]),
    "infraConnections/list": () => ok([]),

    "servers/list": (input) => {
      const teamId = (input as { teamId?: string } | undefined)?.teamId;
      return ok(servers.filter((s) => !teamId || s.teamId === teamId));
    },
    "servers/create": (input) => {
      record("servers/create", input);
      const v = input as { teamId: string; name: string; host: string; port: number; user: string; labels: string[] };
      const n = servers.length + 1;
      const created: Server = {
        id: newId("71717171"),
        ...v,
        publicKey: fakeKey(n),
        installCommand: install(fakeKey(n)),
        hostKeyFingerprints: [],
        pendingKey: null,
        lastTest: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      servers.push(created);
      return ok(created);
    },
    "servers/update": (input) => {
      record("servers/update", input);
      const { id, ...patch } = input as { id: string };
      const found = server(id);
      if (!found) return notFound();
      Object.assign(found, patch);
      return ok(found);
    },
    "servers/remove": (input) => {
      record("servers/remove", input);
      const i = servers.findIndex((s) => s.id === (input as { id: string }).id);
      if (i >= 0) servers.splice(i, 1);
      return ok({ ok: true });
    },
    "servers/test": (input) => {
      record("servers/test", input);
      const found = server((input as { id: string }).id);
      if (!found) return notFound();
      const planned = state.nextTest;
      state.nextTest = null;
      const result =
        planned ??
        (found.hostKeyFingerprints.length === 0
          ? { result: "hostkey_unconfirmed", fingerprints: [FINGERPRINT] }
          : {
              result: "ok",
              fingerprint: found.hostKeyFingerprints[0],
              key: "current",
              os: "Ubuntu 24.04",
              docker: "27.3.1",
              compose: "2.29.7",
              diskFreeBytes: 42 * 1024 ** 3,
            });
      return ok(result);
    },
    "servers/confirmHostKey": (input) => {
      record("servers/confirmHostKey", input);
      const { id, fingerprint } = input as { id: string; fingerprint: string };
      const found = server(id);
      if (!found) return notFound();
      found.hostKeyFingerprints = [fingerprint];
      return ok(found);
    },
    "servers/rotateKey": (input) => {
      record("servers/rotateKey", input);
      const found = server((input as { id: string }).id);
      if (!found) return notFound();
      const key = fakeKey(90);
      found.pendingKey = { publicKey: key, installCommand: install(key), createdAt: NOW };
      return ok(found);
    },
    "servers/confirmRotation": (input) => {
      record("servers/confirmRotation", input);
      const found = server((input as { id: string }).id);
      if (!found) return notFound();
      const pending = found.pendingKey as { publicKey: string; installCommand: string } | null;
      if (!pending) return fail("CONFLICT", 409, "Máy chủ không có khoá mới đang chờ.");
      found.publicKey = pending.publicKey;
      found.installCommand = pending.installCommand;
      found.pendingKey = null;
      return ok(found);
    },

    "environments/list": () => ok([...envs].sort((a, b) => a.position - b.position)),
    "environments/create": (input) => {
      record("environments/create", input);
      const v = input as { systemId: string; name: string; policy: unknown };
      const created: Env = {
        id: newId("72727272"),
        systemId: v.systemId,
        name: v.name,
        position: envs.length,
        policy: v.policy,
        lock: null,
        runner: { mode: "worker", machines: [], requireLabel: false },
        createdAt: NOW,
        updatedAt: NOW,
      };
      envs.push(created);
      return ok(created);
    },
    "environments/update": (input) => {
      record("environments/update", input);
      const v = input as { id: string; name?: string; policy?: unknown };
      const found = envs.find((e) => e.id === v.id);
      if (!found) return notFound();
      if (v.name !== undefined) found.name = v.name;
      if (v.policy !== undefined) found.policy = v.policy;
      return ok(found);
    },
    "environments/reorder": (input) => {
      record("environments/reorder", input);
      const { ids } = input as { ids: string[] };
      ids.forEach((id, position) => {
        const found = envs.find((e) => e.id === id);
        if (found) found.position = position;
      });
      return ok([...envs].sort((a, b) => a.position - b.position));
    },

    "deployTargets/list": () => ok(targets),
    "deployTargets/get": (input) => {
      const found = targets.find((t) => t.id === (input as { id: string }).id);
      return found ? ok(found) : notFound();
    },
    "deployTargets/upsert": (input) => {
      record("deployTargets/upsert", input);
      const v = input as {
        projectId: string;
        environmentId: string;
        config: Record<string, unknown> & { method: string; variables?: Record<string, unknown>[] };
        expectedConfigVersion: number | null;
      };
      const existing = targets.find((t) => t.projectId === v.projectId && t.environmentId === v.environmentId);
      if (state.conflictNext && existing) {
        state.conflictNext = false;
        existing.configVersion = 5;
        existing.config = { ...existing.config, jobName: "deploy-dev-by-lan" };
        return fail("CONFLICT", 409, "Đích vừa được người khác sửa.", {
          code: "TARGET_VERSION_CONFLICT",
          configVersion: 5,
        });
      }
      if ((existing?.configVersion ?? null) !== v.expectedConfigVersion)
        return fail("CONFLICT", 409, "Đích vừa được người khác sửa.", {
          code: "TARGET_VERSION_CONFLICT",
          configVersion: existing?.configVersion ?? 0,
        });
      // Hub không bao giờ trả giá trị biến bí mật, chỉ báo đã có giá trị hay chưa.
      const config = {
        ...v.config,
        ...(v.config.variables
          ? {
              variables: v.config.variables.map((x) =>
                x.secret ? { name: x.name, secret: true, set: x.value !== undefined || existing !== undefined } : x,
              ),
            }
          : {}),
      };
      if (existing) {
        existing.config = config;
        existing.method = v.config.method;
        existing.configVersion += 1;
        return ok(existing);
      }
      const created: Target = {
        id: newId("74747474"),
        projectId: v.projectId,
        environmentId: v.environmentId,
        method: v.config.method,
        config,
        configVersion: 1,
        updatedBy: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      targets.push(created);
      return ok(created);
    },
  };
  return { rpc, state };
}
