import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeRollout, createKubeClient, KubeError, type KubeErrorCode } from "./kube.ts";

const TOKEN = "kube-sa-token-abcdef123456";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/kube/${name}`, import.meta.url), "utf8"));
}

// --- Chứng chỉ tự sinh -------------------------------------------------------------------------------------------
// Node không có API tạo X.509 và dự án không thêm phụ thuộc chỉ để test, nên dựng DER tối thiểu bằng tay: một chứng chỉ
// tự ký (CA:TRUE) có SAN 127.0.0.1, vừa làm CA vừa làm chứng chỉ máy chủ.

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const len = body.length;
  const header =
    len < 0x80
      ? Buffer.from([tag, len])
      : len < 0x100
        ? Buffer.from([tag, 0x81, len])
        : Buffer.from([tag, 0x82, len >> 8, len & 0xff]);
  return Buffer.concat([header, body]);
}
const seq = (...p: Buffer[]) => der(0x30, ...p);
const oid = (bytes: number[]) => der(0x06, Buffer.from(bytes));
const utf8 = (s: string) => der(0x0c, Buffer.from(s, "utf8"));
const utcTime = (d: Date) => der(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, "")}Z`, "ascii"));

interface TestCert {
  certPem: string;
  keyPem: string;
}

function selfSignedCert(commonName: string): TestCert {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ecdsaSha256 = seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
  const name = seq(der(0x31, seq(oid([0x55, 0x04, 0x03]), utf8(commonName))));
  const now = Date.now();
  const validity = seq(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000)));
  const san = seq(der(0x82, Buffer.from("localhost")), der(0x87, Buffer.from([127, 0, 0, 1])));
  const extensions = der(
    0xa3,
    seq(
      seq(oid([0x55, 0x1d, 0x13]), der(0x01, Buffer.from([0xff])), der(0x04, seq(der(0x01, Buffer.from([0xff]))))),
      seq(oid([0x55, 0x1d, 0x11]), der(0x04, san)),
    ),
  );
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([0x01, ...Buffer.from(String(now & 0xffff))])),
    ecdsaSha256,
    name,
    validity,
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", tbs, privateKey);
  const cert = seq(tbs, ecdsaSha256, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const b64 = cert.toString("base64").replace(/(.{64})/g, "$1\n");
  return {
    certPem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

// --- Máy chủ Kubernetes giả (HTTPS) ------------------------------------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
interface Reply {
  status?: number;
  json?: unknown;
  body?: string;
  delayMs?: number;
}
type Handler = Reply | ((req: Recorded) => Reply);

interface FakeKube {
  baseUrl: string;
  ca: string;
  requests: Recorded[];
  route(key: string, handler: Handler): void;
  close(): Promise<void>;
}

async function startFakeKube(cert: TestCert): Promise<FakeKube> {
  const routes = new Map<string, Handler>();
  const requests: Recorded[] = [];
  const server: Server = createServer({ cert: cert.certPem, key: cert.keyPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const recorded: Recorded = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      const h = routes.get(`${recorded.method} ${recorded.path}`);
      const reply: Reply =
        h === undefined
          ? { status: 404, json: fixture("status-not-found.json") }
          : typeof h === "function"
            ? h(recorded)
            : h;
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
        res.end(reply.json === undefined ? (reply.body ?? "") : JSON.stringify(reply.json));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `https://127.0.0.1:${port}`,
    ca: cert.certPem,
    requests,
    route: (k, h) => void routes.set(k, h),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function errorOf(p: Promise<unknown>): Promise<KubeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KubeError);
    return e as KubeError;
  }
  throw new Error("đáng lẽ phải ném KubeError");
}
async function codeOf(p: Promise<unknown>): Promise<KubeErrorCode> {
  return (await errorOf(p)).code;
}

const DEPLOY_PATH = "/apis/apps/v1/namespaces/his-portal/deployments/his-portal";

describe("computeRollout", () => {
  it("Deployment xong", () => {
    expect(computeRollout("Deployment", fixture("deployment-complete.json"))).toMatchObject({
      state: "complete",
      replicas: 3,
      updatedReplicas: 3,
      availableReplicas: 3,
      generation: 7,
      observedGeneration: 7,
    });
  });

  it("Deployment còn bản sao cũ: đang chạy", () => {
    const r = computeRollout("Deployment", fixture("deployment-progressing.json"));
    expect(r.state).toBe("progressing");
    expect(r.message).toBe("Đã cập nhật 1/3 bản sao");
  });

  it("Deployment: controller chưa thấy cấu hình mới (observedGeneration cũ) thì chưa xong dù số bản sao đủ", () => {
    const r = computeRollout("Deployment", fixture("deployment-stale-generation.json"));
    expect(r.state).toBe("progressing");
    expect(r.message).toContain("nhận cấu hình mới");
  });

  it("Deployment: ProgressDeadlineExceeded là thất bại", () => {
    const r = computeRollout("Deployment", fixture("deployment-deadline-exceeded.json"));
    expect(r).toMatchObject({ state: "failed", deadlineExceeded: true });
  });

  it("Deployment: đã đủ bản mới nhưng còn bản cũ chờ tắt hoặc chưa sẵn sàng thì chưa xong", () => {
    const base = fixture("deployment-complete.json") as { status: Record<string, unknown> };
    const waitingOld = { ...base, status: { ...base.status, replicas: 4 } };
    expect(computeRollout("Deployment", waitingOld)).toMatchObject({
      state: "progressing",
      message: "Đang chờ 1 bản sao cũ tắt",
    });
    const notAvailable = { ...base, status: { ...base.status, availableReplicas: 2 } };
    expect(computeRollout("Deployment", notAvailable)).toMatchObject({
      state: "progressing",
      message: "2/3 bản sao sẵn sàng",
    });
  });

  it("Deployment: không có spec.replicas thì coi là 1, thiếu status không làm hỏng", () => {
    expect(computeRollout("Deployment", {}).state).toBe("progressing");
    const one = {
      metadata: { generation: 1 },
      status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1 },
    };
    expect(computeRollout("Deployment", one).state).toBe("complete");
  });

  it("StatefulSet: xong, và đang chuyển revision", () => {
    expect(computeRollout("StatefulSet", fixture("statefulset-complete.json")).state).toBe("complete");
    const r = computeRollout("StatefulSet", fixture("statefulset-rolling.json"));
    expect(r.state).toBe("progressing");
    expect(r.message).toContain("revision mới");
  });

  it("DaemonSet: đếm theo máy", () => {
    const r = computeRollout("DaemonSet", fixture("daemonset-rolling.json"));
    expect(r).toMatchObject({ state: "progressing", message: "Đã cập nhật 2/4 máy", replicas: 4, updatedReplicas: 2 });
    const done = {
      ...(fixture("daemonset-rolling.json") as object),
      status: { observedGeneration: 2, desiredNumberScheduled: 4, updatedNumberScheduled: 4, numberAvailable: 4 },
    };
    expect(computeRollout("DaemonSet", done).state).toBe("complete");
  });
});

describe("KubeClient (HTTPS với CA riêng)", () => {
  let cert: TestCert;
  let fake: FakeKube;
  let client: ReturnType<typeof createKubeClient>;

  beforeEach(async () => {
    cert = selfSignedCert("fake-kube-ca");
    fake = await startFakeKube(cert);
    client = createKubeClient({ baseUrl: fake.baseUrl, token: TOKEN, ca: fake.ca });
  });
  afterEach(async () => {
    await fake.close();
  });

  describe("kết nối và TLS", () => {
    it("tin CA của kết nối, gửi Bearer token", async () => {
      fake.route("GET /version", { json: fixture("version.json") });
      await expect(client.version()).resolves.toEqual({
        gitVersion: "v1.31.4+rke2r1",
        major: "1",
        minor: "31",
        platform: "linux/amd64",
      });
      expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(fake.requests[0]?.headers.accept).toBe("application/json");
    });

    it("CA khác (không ký chứng chỉ máy chủ) → TLS_ERROR, không gửi token đi", async () => {
      const other = selfSignedCert("another-ca");
      const c = createKubeClient({ baseUrl: fake.baseUrl, token: TOKEN, ca: other.certPem });
      const err = await errorOf(c.version());
      expect(err.code).toBe("TLS_ERROR");
      expect(err.retryable).toBe(false);
      expect(fake.requests).toHaveLength(0);
    });

    it("không khai CA thì không tin chứng chỉ tự ký (không có chế độ bỏ qua kiểm chứng)", async () => {
      const c = createKubeClient({ baseUrl: fake.baseUrl, token: TOKEN });
      expect(await codeOf(c.version())).toBe("TLS_ERROR");
      expect(fake.requests).toHaveLength(0);
    });

    it("chỉ nhận https", () => {
      expect(() => createKubeClient({ baseUrl: "http://127.0.0.1:6443", token: TOKEN })).toThrow(TypeError);
      expect(() => createKubeClient({ baseUrl: "không phải url", token: TOKEN })).toThrow(TypeError);
    });

    it("giữ đường dẫn gốc khi đi qua proxy, bỏ dấu / cuối", async () => {
      fake.route("GET /k8s/version", { json: fixture("version.json") });
      const c = createKubeClient({ baseUrl: `${fake.baseUrl}/k8s/`, token: TOKEN, ca: fake.ca });
      await expect(c.version()).resolves.toMatchObject({ major: "1" });
    });
  });

  describe("getWorkload", () => {
    it("đọc container, generation và trạng thái triển khai", async () => {
      fake.route(`GET ${DEPLOY_PATH}`, { json: fixture("deployment-complete.json") });
      const w = await client.getWorkload("his-portal", "Deployment", "his-portal");
      expect(w).toMatchObject({
        kind: "Deployment",
        namespace: "his-portal",
        name: "his-portal",
        generation: 7,
        containers: [
          { name: "portal", image: "registry.example.invalid/his/portal:1.8.3" },
          { name: "sidecar", image: "registry.example.invalid/his/sidecar:0.4.1" },
        ],
        rollout: { state: "complete" },
      });
    });

    it("StatefulSet và DaemonSet đi đúng đường dẫn", async () => {
      fake.route("GET /apis/apps/v1/namespaces/his-data/statefulsets/his-db", {
        json: fixture("statefulset-complete.json"),
      });
      fake.route("GET /apis/apps/v1/namespaces/his-system/daemonsets/his-agent", {
        json: fixture("daemonset-rolling.json"),
      });
      await expect(client.getWorkload("his-data", "StatefulSet", "his-db")).resolves.toMatchObject({
        kind: "StatefulSet",
      });
      await expect(client.getWorkload("his-system", "DaemonSet", "his-agent")).resolves.toMatchObject({
        kind: "DaemonSet",
      });
    });

    it("chặn namespace, tên, loại làm hỏng đường dẫn (lỗi của người gọi, không gửi đi)", async () => {
      await expect(client.getWorkload("../kube-system", "Deployment", "x")).rejects.toThrow(TypeError);
      await expect(client.getWorkload("ns", "Deployment", "x/../../y")).rejects.toThrow(TypeError);
      await expect(client.getWorkload("ns", "Deployment", "")).rejects.toThrow(TypeError);
      await expect(client.getWorkload("Ns", "Deployment", "x")).rejects.toThrow(TypeError);
      await expect(client.getWorkload("ns", "Pod" as never, "x")).rejects.toThrow(TypeError);
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe("patchImage", () => {
    it("PATCH strategic-merge chỉ gồm tên và image của container, trả image cũ", async () => {
      fake.route(`GET ${DEPLOY_PATH}`, { json: fixture("deployment-complete.json") });
      fake.route(`PATCH ${DEPLOY_PATH}`, { json: fixture("deployment-progressing.json") });
      const r = await client.patchImage(
        "his-portal",
        "Deployment",
        "his-portal",
        "portal",
        "registry.example.invalid/his/portal:1.9.0",
      );

      expect(r.previousImage).toBe("registry.example.invalid/his/portal:1.8.3");
      expect(r.workload.rollout.state).toBe("progressing");
      const patch = fake.requests.find((q) => q.method === "PATCH");
      expect(patch?.headers["content-type"]).toBe("application/strategic-merge-patch+json");
      expect(JSON.parse(patch?.body ?? "")).toEqual({
        spec: {
          template: { spec: { containers: [{ name: "portal", image: "registry.example.invalid/his/portal:1.9.0" }] } },
        },
      });
    });

    it("container không có trong workload → BAD_REQUEST và không PATCH (tránh patch thêm container thiếu trường)", async () => {
      fake.route(`GET ${DEPLOY_PATH}`, { json: fixture("deployment-complete.json") });
      const err = await errorOf(client.patchImage("his-portal", "Deployment", "his-portal", "khong-co", "img:1"));
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("portal, sidecar");
      expect(fake.requests.filter((q) => q.method === "PATCH")).toHaveLength(0);
    });

    it("thiếu quyền patch (get được): FORBIDDEN", async () => {
      fake.route(`GET ${DEPLOY_PATH}`, { json: fixture("deployment-complete.json") });
      fake.route(`PATCH ${DEPLOY_PATH}`, { status: 403, json: fixture("status-forbidden.json") });
      const err = await errorOf(client.patchImage("his-portal", "Deployment", "his-portal", "portal", "img:2"));
      expect(err.code).toBe("FORBIDDEN");
      // Lời nhắn của API server nêu tên ServiceAccount: không đưa vào lỗi hiển thị cho người dùng.
      expect(err.message).not.toContain("jenkins-deployer");
    });

    it("API server từ chối dữ liệu (422): BAD_REQUEST kèm lời nhắn", async () => {
      fake.route(`GET ${DEPLOY_PATH}`, { json: fixture("deployment-complete.json") });
      fake.route(`PATCH ${DEPLOY_PATH}`, { status: 422, json: fixture("status-invalid.json") });
      const err = await errorOf(client.patchImage("his-portal", "Deployment", "his-portal", "portal", "img:2"));
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("Required value");
    });

    it("image hoặc container sai là lỗi của người gọi", async () => {
      await expect(client.patchImage("his-portal", "Deployment", "his-portal", "portal", "")).rejects.toThrow(
        TypeError,
      );
      await expect(client.patchImage("his-portal", "Deployment", "his-portal", "portal", "a b")).rejects.toThrow(
        TypeError,
      );
      await expect(client.patchImage("his-portal", "Deployment", "his-portal", "", "img:1")).rejects.toThrow(TypeError);
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe("rolloutStatus", () => {
    it("đi từ đang chạy tới xong theo từng lần hỏi", async () => {
      const answers = [
        fixture("deployment-stale-generation.json"),
        fixture("deployment-progressing.json"),
        fixture("deployment-complete.json"),
      ];
      let n = 0;
      fake.route(`GET ${DEPLOY_PATH}`, () => ({ json: answers[Math.min(n++, answers.length - 1)] }));
      const states: string[] = [];
      for (let i = 0; i < 3; i++)
        states.push((await client.rolloutStatus("his-portal", "Deployment", "his-portal")).state);
      expect(states).toEqual(["progressing", "progressing", "complete"]);
    });

    it("ProgressDeadlineExceeded → failed", async () => {
      fake.route(`GET ${DEPLOY_PATH}`, { json: fixture("deployment-deadline-exceeded.json") });
      await expect(client.rolloutStatus("his-portal", "Deployment", "his-portal")).resolves.toMatchObject({
        state: "failed",
        deadlineExceeded: true,
      });
    });
  });

  describe("lỗi", () => {
    it("401 → UNAUTHORIZED", async () => {
      fake.route(`GET ${DEPLOY_PATH}`, { status: 401, json: { kind: "Status", code: 401, message: "Unauthorized" } });
      expect(await codeOf(client.getWorkload("his-portal", "Deployment", "his-portal"))).toBe("UNAUTHORIZED");
    });

    it("403 → FORBIDDEN", async () => {
      fake.route(`GET ${DEPLOY_PATH}`, { status: 403, json: fixture("status-forbidden.json") });
      expect(await codeOf(client.getWorkload("his-portal", "Deployment", "his-portal"))).toBe("FORBIDDEN");
    });

    it("404 → NOT_FOUND", async () => {
      fake.route(`GET ${DEPLOY_PATH}`, { status: 404, json: fixture("status-not-found.json") });
      expect(await codeOf(client.getWorkload("his-portal", "Deployment", "his-portal"))).toBe("NOT_FOUND");
    });

    it.each([500, 503, 429])("%i → UNAVAILABLE, thử lại được", async (status) => {
      fake.route(`GET ${DEPLOY_PATH}`, { status, body: "x" });
      const err = await errorOf(client.getWorkload("his-portal", "Deployment", "his-portal"));
      expect(err.code).toBe("UNAVAILABLE");
      expect(err.retryable).toBe(true);
    });

    it("phản hồi không phải JSON (proxy) → UNAVAILABLE", async () => {
      fake.route("GET /version", { body: "<html>502</html>" });
      expect(await codeOf(client.version())).toBe("UNAVAILABLE");
    });

    it("hết giờ → UNAVAILABLE", async () => {
      fake.route("GET /version", { json: fixture("version.json"), delayMs: 400 });
      const c = createKubeClient({ baseUrl: fake.baseUrl, token: TOKEN, ca: fake.ca, timeoutMs: 50 });
      const err = await errorOf(c.version());
      expect(err.code).toBe("UNAVAILABLE");
      expect(err.message).toContain("không trả lời");
    });

    it("không nối được → UNAVAILABLE", async () => {
      const c = createKubeClient({ baseUrl: "https://127.0.0.1:1", token: TOKEN, ca: fake.ca, timeoutMs: 2000 });
      expect(await codeOf(c.version())).toBe("UNAVAILABLE");
    });

    it("API server lặp lại token trong lời nhắn thì token bị che", async () => {
      fake.route(`GET ${DEPLOY_PATH}`, { status: 400, json: { message: `bad token ${TOKEN}` } });
      const err = await errorOf(client.getWorkload("his-portal", "Deployment", "his-portal"));
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("***");
      expect(err.message).not.toContain(TOKEN);
    });

    it("lỗi không chứa token", async () => {
      for (const status of [401, 403, 404, 500, 400]) {
        fake.route(`GET ${DEPLOY_PATH}`, { status, body: "" });
        const err = await errorOf(client.getWorkload("his-portal", "Deployment", "his-portal"));
        expect(`${err.message} ${String(err.cause ?? "")}`).not.toContain(TOKEN);
      }
    });
  });
});
