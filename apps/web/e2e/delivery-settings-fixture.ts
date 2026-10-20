import {
  type ConnectionTestResult,
  type InfraConnection,
  infraConnectionCreateInput,
  type JenkinsConnection,
  type JenkinsTokenItem,
  jenkinsConnection,
  jenkinsTokenItem,
} from "@xdev-hive/contracts";
// Fixture tự chứa vì fake-hub nạp các fixture này; import ngược sẽ tạo vòng phụ thuộc.
export type DeliverySettingsHandler = (input: unknown) => { status: number; json: unknown };
const ok = (value: unknown) => ({ status: 200, json: { json: value } });
const fail = (code: string, status: number, message: string, data?: unknown) => ({
  status,
  json: { json: { defined: true, code, status, message, ...(data === undefined ? {} : { data }) } },
});

const NOW = "2026-10-15T03:00:00.000Z";
export const JENKINS_MAIN_ID = "30303030-0000-4000-8000-000000000001";
export const JENKINS_OLD_ID = "30303030-0000-4000-8000-000000000002";
export const ARGO_ID = "30303030-0000-4000-8000-000000000011";
export const KUBE_ID = "30303030-0000-4000-8000-000000000012";
/** Chuỗi giả, chỉ để test chắc chắn token không bao giờ hiện lại ở giao diện. */
export const FAKE_TOKEN = "fake-api-token-never-real-0123";

const duy = { userId: "u1", name: "Trần Đức Duy" };

/**
 * Hub giả cho Kết nối CI và Token Jenkins. `state` để test đọc lại thứ đã gửi; `scenario` chọn dữ liệu ban đầu:
 * `empty` chưa có kết nối nào, `default` có hai Jenkins (một cái người theo dõi mất token, một cái lỗi đọc), một Argo CD
 * và một Kubernetes.
 */
export function deliverySettingsFixture(options: { scenario?: "default" | "empty"; testOk?: boolean } = {}) {
  const empty = options.scenario === "empty";
  const jenkins: JenkinsConnection[] = empty
    ? []
    : [
        jenkinsConnection.parse({
          id: JENKINS_MAIN_ID,
          name: "Jenkins công ty",
          url: "https://jenkins.example.com",
          watcher: duy,
          watcherHasToken: true,
          lastPollAt: NOW,
          lastError: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
        jenkinsConnection.parse({
          id: JENKINS_OLD_ID,
          name: "Jenkins cũ",
          url: "https://old-jenkins.example.com",
          watcher: { userId: "u-lan", name: "Trần Lan" },
          watcherHasToken: false,
          lastPollAt: null,
          lastError: "Jenkins không nhận token của người theo dõi.",
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ];
  const infra: InfraConnection[] = empty
    ? []
    : [
        {
          id: ARGO_ID,
          kind: "argocd",
          name: "Argo CD dev",
          url: "https://argocd.example.com",
          caPem: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: KUBE_ID,
          kind: "kubernetes",
          name: "K8s dev",
          url: "https://k8s.example.com:6443",
          caPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ];
  const tokens = new Map<string, NonNullable<JenkinsTokenItem["token"]>>();
  if (!empty)
    tokens.set(JENKINS_MAIN_ID, { jenkinsUser: "duy", updatedAt: NOW, lastCheckedAt: null, lastCheckOk: null });
  const state = {
    jenkins,
    infra,
    tokens,
    /** Thân yêu cầu hub nhận được, theo thủ tục, để test kiểm token không bị gửi đi lẫn lộn. */
    calls: [] as { path: string; input: unknown }[],
  };
  const record = (path: string, input: unknown) => state.calls.push({ path, input });
  const result = (good: ConnectionTestResult, bad: ConnectionTestResult) => (options.testOk === false ? bad : good);
  const items = (): JenkinsTokenItem[] =>
    state.jenkins.map((c) =>
      jenkinsTokenItem.parse({
        connectionId: c.id,
        connectionName: c.name,
        url: c.url,
        token: state.tokens.get(c.id) ?? null,
      }),
    );
  let next = 100;
  const newId = () => `30303030-0000-4000-8000-${String(++next).padStart(12, "0")}`;

  const rpc: Record<string, DeliverySettingsHandler> = {
    "ciConnections/list": () => ok(state.jenkins),
    "ciConnections/create": (input) => {
      record("ciConnections/create", input);
      const { name, url } = input as { name: string; url: string };
      if (state.jenkins.some((c) => c.name === name))
        return fail("CONFLICT", 409, "Tên kết nối đã có.", { code: "CI_CONNECTION_NAME_TAKEN" });
      const created = jenkinsConnection.parse({
        id: newId(),
        name,
        url,
        watcher: duy,
        watcherHasToken: false,
        lastPollAt: null,
        lastError: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      state.jenkins.push(created);
      return ok(created);
    },
    "ciConnections/update": (input) => {
      record("ciConnections/update", input);
      const { id, name, url } = input as { id: string; name?: string; url?: string };
      const found = state.jenkins.find((c) => c.id === id);
      if (!found) return fail("NOT_FOUND", 404, "Không tìm thấy kết nối.");
      Object.assign(found, { ...(name ? { name } : {}), ...(url ? { url } : {}) });
      return ok(found);
    },
    "ciConnections/remove": (input) => {
      record("ciConnections/remove", input);
      const { id } = input as { id: string };
      state.jenkins = state.jenkins.filter((c) => c.id !== id);
      state.tokens.delete(id);
      return ok({ id });
    },
    "ciConnections/test": (input) => {
      record("ciConnections/test", input);
      return ok(
        result(
          { ok: true, message: "Đọc được Jenkins.", version: "2.462.3" },
          { ok: false, message: "Jenkins không nhận token.", version: null },
        ),
      );
    },
    "ciConnections/setWatcher": (input) => {
      record("ciConnections/setWatcher", input);
      const { id, userId } = input as { id: string; userId: string };
      const found = state.jenkins.find((c) => c.id === id);
      if (!found) return fail("NOT_FOUND", 404, "Không tìm thấy kết nối.");
      // Chỉ Phạm Hà có token; chọn người khác thì hub từ chối đúng như hợp đồng.
      if (userId !== "u-ha")
        return fail("BAD_REQUEST", 400, "Người này chưa có token Jenkins cho kết nối.", { code: "JENKINS_NO_TOKEN" });
      found.watcher = { userId: "u-ha", name: "Phạm Hà" };
      found.watcherHasToken = true;
      return ok(found);
    },
    "ciTokens/list": () => ok(items()),
    "ciTokens/upsert": (input) => {
      record("ciTokens/upsert", input);
      const { connectionId, jenkinsUser } = input as { connectionId: string; jenkinsUser: string };
      state.tokens.set(connectionId, { jenkinsUser, updatedAt: NOW, lastCheckedAt: null, lastCheckOk: null });
      const found = state.jenkins.find((c) => c.id === connectionId);
      return ok(items().find((i) => i.connectionId === found?.id));
    },
    "ciTokens/test": (input) => {
      record("ciTokens/test", input);
      const { connectionId } = input as { connectionId: string };
      const token = state.tokens.get(connectionId);
      if (!token)
        return fail("CONFLICT", 409, "Bạn chưa có token Jenkins cho kết nối này.", {
          code: "JENKINS_NO_TOKEN",
          connectionId,
        });
      const good = options.testOk !== false;
      state.tokens.set(connectionId, { ...token, lastCheckedAt: NOW, lastCheckOk: good });
      return ok(
        result(
          { ok: true, message: "Token dùng được.", version: "2.462.3", user: token.jenkinsUser },
          { ok: false, message: "Jenkins từ chối token (401).", version: null, user: null },
        ),
      );
    },
    "ciTokens/remove": (input) => {
      record("ciTokens/remove", input);
      state.tokens.delete((input as { connectionId: string }).connectionId);
      return ok({ ok: true });
    },
    "infraConnections/list": () => ok(state.infra),
    "infraConnections/create": (input) => {
      record("infraConnections/create", input);
      const parsed = infraConnectionCreateInput.parse(input);
      const created: InfraConnection = {
        id: newId(),
        kind: parsed.kind,
        name: parsed.name,
        url: parsed.url,
        caPem: parsed.kind === "kubernetes" ? (parsed.caPem ?? null) : null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      state.infra.push(created);
      return ok(created);
    },
    "infraConnections/update": (input) => {
      record("infraConnections/update", input);
      const { id, name, url, caPem } = input as { id: string; name?: string; url?: string; caPem?: string | null };
      const found = state.infra.find((c) => c.id === id);
      if (!found) return fail("NOT_FOUND", 404, "Không tìm thấy kết nối.");
      Object.assign(found, { ...(name ? { name } : {}), ...(url ? { url } : {}) });
      if (caPem !== undefined) found.caPem = caPem;
      return ok(found);
    },
    "infraConnections/remove": (input) => {
      record("infraConnections/remove", input);
      const { id } = input as { id: string };
      state.infra = state.infra.filter((c) => c.id !== id);
      return ok({ id });
    },
    "infraConnections/test": (input) => {
      record("infraConnections/test", input);
      const found = state.infra.find((c) => c.id === (input as { id: string }).id);
      return ok(
        result(
          { ok: true, message: "Đọc được.", version: found?.kind === "kubernetes" ? "v1.31.2" : "v2.13.0" },
          { ok: false, message: "Không kết nối được tới địa chỉ này.", version: null },
        ),
      );
    },
  };
  return { rpc, state };
}
