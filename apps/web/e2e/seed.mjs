// What the e2e pages start from: people with their roles, pages to edit and draw, and work waiting for approval.
const PASSWORD = "blue-comb-2026!";

/** A credential's headers: the admin's page session ("hive_session=…", spec 79a) or a bearer token. */
export const authHeaders = (credential) =>
  credential.startsWith("hive_session=") ? { cookie: credential, "x-hive-csrf": "1" } : { authorization: `Bearer ${credential}` };

/**
 * adminPassword: the temporary password the hub printed for HIVE_ADMIN_USER. Since spec 79a no token administers the
 * hub, so the seed signs the admin in like a person and hands the session on as `admin`; `machine` is that admin's
 * desktop sign-in, for the calls a runner makes.
 */
export async function seed(base, bootstrap, adminPassword) {
  const rpc = async (token, method, input = {}) => {
    const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(token) }, body: JSON.stringify({ method, input }) });
    const j = await r.json();
    if (j.error) throw new Error(`seed ${method}: ${j.error.message}`);
    return j.result;
  };
  const post = (url, body, headers = {}) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json", "x-hive-csrf": "1", ...headers }, body: JSON.stringify(body) });
  const firstLogin = await post("/api/login", { username: "duy", password: adminPassword });
  if (!firstLogin.ok) throw new Error(`seed admin sign-in: ${firstLogin.status}`);
  const adminChanged = await post("/api/password", { current: adminPassword, next: PASSWORD }, { cookie: firstLogin.headers.get("set-cookie").split(";")[0] });
  if (!adminChanged.ok) throw new Error(`seed admin password: ${adminChanged.status}`);
  const admin = adminChanged.headers.get("set-cookie").split(";")[0];
  const machine = (await (await post("/api/device-token", { username: "duy", password: PASSWORD, name: "duy-e2e" })).json()).result.token;
  if (!bootstrap) throw new Error("seed: the hub's bootstrap token is missing");

  const page = (key, title, content) => rpc(admin, "docs.save", { key, title, content, baseVersion: 0 });
  await page("project/demo/huong-dan", "Hướng dẫn", "# Hướng dẫn\n\nCài đặt bằng npm ci.\n");
  await page("project/demo/so-do", "Sơ đồ", "# Sơ đồ\n\n```mermaid\nflowchart LR\n  A[Yêu cầu] --> B{Máy rảnh?}\n  B -- có --> C[Chạy agent]\n```\n");
  await page("project/demo/so-do-loi", "Sơ đồ lỗi", "# Sơ đồ lỗi\n\n```mermaid\nflowchart LR\n  A[Mở --> \n```\n");
  await page("project/demo/cai-dat", "Cài đặt", "# Cài đặt\n\nnpm ci\n");
  await page("project/demo/phat-hanh", "Phát hành", "# Phát hành\n\nnpm run release\n");
  await page("project/payment/agents", "Quy ước payment", "# Cổng thanh toán\n\nChạy npm test trước khi commit.\n");
  await page("project/payment/huong-dan", "Hướng dẫn", "# Hướng dẫn\n\nCài đặt.\n");
  await rpc(admin, "tasks.create", { id: "PAY-1", project: "payment", title: "Việc đầu tiên của payment" });
  await rpc(admin, "tasks.create", { id: "DEMO-1", project: "demo", title: "Việc đầu tiên của demo" });
  await rpc(admin, "tasks.create", { id: "LEDGER-1", project: "ledger", title: "Việc đầu tiên của ledger" });
  // Existing flows in this fixture test the human baseline; newly created real projects start more automatic.
  for (const project of ["payment", "demo", "ledger"]) await rpc(admin, "sdlc.setProject", { project, settings: null });
  await rpc(admin, "systems.save", { name: "ban-hang", projects: ["payment", "demo", "ledger"] });

  // A first sign-in asks for a new password: done here, so the page test signs in with the final one.
  const people = {};
  for (const [username, displayName] of [["lan", "Lan Nguyễn"], ["hoa", "Hoa Trần"], ["minh", "Minh Lê"]]) {
    const created = await rpc(admin, "users.create", { username, displayName });
    const login = await post("/api/login", { username, password: created.password });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const changed = await post("/api/password", { current: created.password, next: PASSWORD }, { cookie });
    if (!changed.ok) throw new Error(`seed password of ${username}: ${changed.status}`);
    const device = await (await post("/api/device-token", { username, password: PASSWORD, name: `${username}-e2e` })).json();
    people[username] = { id: created.user.id, displayName, password: PASSWORD, token: device.result.token };
  }
  await rpc(admin, "users.setGrants", { id: people.lan.id, grants: { payment: "lead", demo: "member" } });
  await rpc(admin, "users.setGrants", { id: people.hoa.id, grants: { payment: "reviewer" } });
  await rpc(admin, "users.setGrants", { id: people.minh.id, grants: { payment: "member", demo: "member" } });

  // Minh proposes; Hoa (reviewer) may approve the guide but not the agents' context, the admin approves the rest at once.
  const propose = (docKey, content, reason) => rpc(people.minh.token, "proposals.create", { docKey, baseVersion: 1, content, reason });
  const proposals = {
    payGuide: (await propose("project/payment/huong-dan", "# Hướng dẫn\n\nCài đặt, rồi chạy npm ci.\n", "Thêm bước cài")).id,
    payAgents: (await propose("project/payment/agents", "# Cổng thanh toán\n\nChạy npm run typecheck && npm test.\n", "Thêm typecheck")).id,
    demoSetup: (await propose("project/demo/cai-dat", "# Cài đặt\n\nnpm ci && npm test\n", "Chạy test")).id,
    demoRelease: (await propose("project/demo/phat-hanh", "# Phát hành\n\nnpm run release -w @xdev-hive/desktop\n", "Đúng lệnh")).id,
  };
  const memory = [];
  for (const content of ["Sandbox ngân hàng hết hạn token sau 15 phút.", "Cổng thanh toán trả 409 khi gửi lại cùng mã đơn."])
    memory.push((await rpc(people.minh.token, "memory.write", { project: "payment", kind: "gotcha", content, files: [] })).id);
  // As claude-1 would write it through the MCP shim in run R-e2e01 on Minh's token: the audit log names all three (27c).
  const asAgent = await fetch(`${base}/api/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${people.minh.token}`,
      "x-hive-agent": "claude-1",
      "x-hive-source": JSON.stringify({ via: "mcp", run: "R-e2e01" }),
      "x-hive-run": "R-e2e01",
    },
    body: JSON.stringify({ method: "memory.write", input: { project: "demo", kind: "convention", content: "Chạy npm ci trước khi test.", files: [] } }),
  });
  if (!asAgent.ok) throw new Error(`seed agent memory: ${asAgent.status}`);
  await rpc(admin, "memory.setCleanup", { project: "payment", enabled: true });
  return { admin, adminPassword: PASSWORD, machine, people, proposals, memory };
}
