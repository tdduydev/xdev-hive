import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { buildFrameDocument, type FrameMessage, parseLibManifest } from "@xdev-hive/artifacts-runtime";
import { loadLibraries } from "@/artifacts/libraries.ts";
import { openArtifactPanel } from "@/artifacts/panel.ts";

export async function run(): Promise<void> {
  const root = process.env.HIVE_ARTIFACT_TEST_ROOT;
  assert.ok(root);
  const lib = resolve(root, "../../packages/artifacts-runtime/dist/lib");
  const manifest = parseLibManifest(JSON.parse(await readFile(join(lib, "lib-manifest.json"), "utf8")));
  let leaked = 0;
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/_artifact/lib/")) {
      leaked++;
      res.end("blocked");
      return;
    }
    try {
      res.end(await readFile(join(lib, req.url.slice("/_artifact/lib/".length))));
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const hub = `http://127.0.0.1:${address.port}`;
  try {
    const dir = await loadLibraries(join(root, "../../.e2e/vscode-artifacts/artifact-lib"), hub);
    for (const type of ["html", "react", "mermaid"] as const) {
      let finish: (() => void) | undefined;
      let fail: ((error: Error) => void) | undefined;
      const completed = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      const marker = `rendered-${type}`;
      const content =
        type === "html"
          ? `<h1>Kiểm artifact</h1><script>fetch("${hub}/exfil").then(()=>console.error("network leaked"),()=>console.warn("${marker}"));</script>`
          : "graph TD; A-->B";
      let html = buildFrameDocument({
        type,
        content,
        compiled: `import React from "react"; export default function Demo(){console.warn("${marker}");return React.createElement("h1",null,"React");}`,
        theme: "light",
        manifest,
        libBase: "hive-artifact://localhost/lib/",
      });
      if (type === "mermaid")
        html = html.replace(
          "</body>",
          `<script>const probe=setInterval(()=>{if(document.querySelector("#out svg")){clearInterval(probe);console.warn("${marker}");}},50);</script></body>`,
        );
      html = html.replace(
        "<head>",
        `<head><script>window.addEventListener("securitypolicyviolation",e=>console.warn("CSP "+e.effectiveDirective+" "+e.blockedURI));</script>`,
      );
      const timer = setTimeout(() => fail?.(new Error(`Không dựng được ${type}`)), 30_000);
      const panel = openArtifactPanel(html, dir, (message: FrameMessage) => {
        if (message.type === "console" && message.message.includes(marker)) finish?.();
        if (message.type === "error") fail?.(new Error(message.message));
      });
      try {
        await completed;
        console.log(`T017 Electron: ${type} rendered with local verified libraries`);
      } finally {
        clearTimeout(timer);
        panel.dispose();
      }
    }
    assert.equal(leaked, 0);
    console.log("T017 Electron: HTTP hub supported; artifact network exfiltration blocked");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
