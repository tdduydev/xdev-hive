import { afterEach, describe, expect, it } from "vitest";
import { runHealthCheck } from "../deploys/health.ts";
import { createArgoCdClient } from "./argocd.ts";
import { createJenkinsClient, type FetchLike } from "./jenkins.ts";
import { createKubeClient } from "./kube.ts";
import { OUTBOUND_DISABLED, setDeliveryOutbound } from "./outbound.ts";
import { probeHostKeys } from "./ssh.ts";

afterEach(() => setDeliveryOutbound(true));

describe("tắt kết nối ra của CI/CD", () => {
  it("không client nào mở kết nối, và lỗi nói rõ vì sao", async () => {
    setDeliveryOutbound(false);
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return new Response("{}");
    };

    const jenkins = createJenkinsClient({ baseUrl: "https://jenkins.example.com", user: "u", token: "t", fetch });
    await expect(jenkins.me()).rejects.toMatchObject({ name: "JenkinsError", message: OUTBOUND_DISABLED });
    const argo = createArgoCdClient({ baseUrl: "https://argocd.example.com", token: "t", fetch });
    await expect(argo.version()).rejects.toMatchObject({ name: "ArgoCdError", message: OUTBOUND_DISABLED });
    // 192.0.2.1 (TEST-NET-1) không bao giờ trả lời: nếu lỡ mở socket thì test này treo tới hết giờ thay vì đạt.
    const kube = createKubeClient({ baseUrl: "https://192.0.2.1:6443", token: "t", timeoutMs: 200 });
    await expect(kube.version()).rejects.toMatchObject({ name: "KubeError", message: OUTBOUND_DISABLED });
    await expect(probeHostKeys({ host: "192.0.2.1", port: 22 }, { readyTimeoutMs: 200 })).rejects.toMatchObject({
      name: "SshError",
      message: OUTBOUND_DISABLED,
    });
    const health = await runHealthCheck(
      { url: "https://app.example.com/health", expectStatus: 200, match: null, timeoutSec: 10, intervalSec: 1 },
      { version: { commit: "abc", tag: null }, fetch },
    );
    expect(health).toMatchObject({ ok: false, message: OUTBOUND_DISABLED });
    expect(calls).toBe(0);
  });
});
