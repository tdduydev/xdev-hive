// What the e2e pages start from: people with their roles, pages to edit and draw, and work waiting for approval.
const PASSWORD = "blue-comb-2026!";

export async function seed(base, admin) {
  const rpc = async (token, method, input = {}) => {
    const r = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ method, input }) });
    const j = await r.json();
    if (j.error) throw new Error(`seed ${method}: ${j.error.message}`);
    return j.result;
  };
  const post = (url, body, headers = {}) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json", "x-hive-csrf": "1", ...headers }, body: JSON.stringify(body) });

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
  return { people, proposals, memory };
}
