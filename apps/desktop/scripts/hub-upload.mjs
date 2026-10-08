// Uploads the desktop builds to the hub, which hands them to machines as updates (roadmap 22i). Used by release.mjs;
// kept apart so test/hub-upload.test.ts can run it against a fake hub.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** platform, arch and kind from electron-builder's file names (see artifactName in electron-builder.yml). */
export function describeBuild(name) {
  const m = /-(mac|win|linux)-(arm64|x64|x86_64|amd64)(?:-setup)?\.(dmg|zip|exe|AppImage|deb)$/.exec(name);
  return m ? { platform: m[1], arch: ["x86_64", "amd64"].includes(m[2]) ? "x64" : m[2], kind: m[3] } : null;
}

/** How many times one file goes before the release stops. */
export const ATTEMPTS = 3;

/** Whether an upload failure is worth sending the file again: the connection broke, the hub or tunnel failed, or the hub dropped the parts. */
export function retryable(err) {
  return err instanceof TypeError || err?.status >= 500 || err?.status === 409;
}

/** Uploads every build in `assets` the hub does not have yet, then the release notes. */
export async function uploadToHub({ hub, token, version, assets, notes, log = console.log, wait = (attempt) => new Promise((r) => setTimeout(r, 5000 * attempt)) }) {
  hub = hub.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${token}` };
  // A proxy in front of the hub may refuse big bodies (Cloudflare: 100 MB): bigger builds go in parts, which only a
  // hub that says how big a part may be takes (an older one would keep the first part as the whole build).
  const listed = await fetch(`${hub}/api/rpc`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ method: "releases.list" }) });
  if (!listed.ok) throw new Error(`hub releases.list: HTTP ${listed.status} ${await listed.text()}`);
  const list = (await listed.json()).result;
  const partBytes = list?.uploadPart ?? null;
  // A --hub-only run after a cut-off one sends only what the hub does not have yet (same name and bytes).
  const have = new Set((list?.releases ?? []).filter((r) => r.version === version).flatMap((r) => r.files ?? []).map((f) => `${f.name} ${f.sha256}`));
  const send = async (q, body, what) => {
    const res = await fetch(`${hub}/api/releases/upload?${q}`, { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body, duplex: "half" });
    if (!res.ok) throw Object.assign(new Error(`hub upload ${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`), { status: res.status });
  };
  const sendFile = async (file, name, size, q) => {
    if (!partBytes || size <= partBytes) return send(new URLSearchParams(q), createReadStream(file), name);
    const parts = Math.ceil(size / partBytes);
    const upload = randomBytes(16).toString("hex");
    for (let part = 0; part < parts; part++) {
      const start = part * partBytes;
      const body = createReadStream(file, { start, end: Math.min(size, start + partBytes) - 1 });
      await send(new URLSearchParams({ ...q, upload, part: String(part), parts: String(parts) }), body, `${name} part ${part + 1}/${parts}`);
    }
  };
  for (const file of assets) {
    const name = path.basename(file);
    const d = describeBuild(name);
    if (!d) continue;
    const size = statSync(file).size;
    const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    const q = { version, channel: "stable", name, sha256, ...d };
    if (have.has(`${name} ${sha256}`)) {
      log(`hub = ${name} (already there)`);
      continue;
    }
    // The tunnel in front of the hub sometimes cuts a body off (the hub logs "aborted"), and the hub then drops the
    // whole upload: the file goes again from its first part, twice at most.
    for (let attempt = 1; ; attempt++) {
      try {
        await sendFile(file, name, size, q);
        break;
      } catch (err) {
        if (!retryable(err)) throw err;
        // A broken connection only says "fetch failed": name the file, so the person knows what to send again.
        if (attempt === ATTEMPTS) throw new Error(`hub upload ${name}: failed ${ATTEMPTS} times (${err.cause?.code ?? err.message})`, { cause: err });
        log(`hub: ${name} cut off (${err.cause?.code ?? err.message}), sending it again (${attempt + 1}/${ATTEMPTS})`);
        await wait(attempt);
      }
    }
    log(`hub ← ${name}`);
  }
  const res = await fetch(`${hub}/api/rpc`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ method: "releases.notes", input: { version, notes } }) });
  if (!res.ok) throw new Error(`hub notes: HTTP ${res.status}`);
  log(`hub has ${version}: pick it on Phiên bản app to roll it out.`);
}

/**
 * Release settings kept out of the shell (and out of transcripts): KEY=VALUE lines in ~/.config/xdev-hive/release.env.
 * Variables already in the environment win. A file others can read is refused when it holds a token.
 */
export function readReleaseEnv(file = path.join(os.homedir(), ".config", "xdev-hive", "release.env"), env = process.env) {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  const values = Object.fromEntries(text.split("\n").map((l) => /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^(["'])(.*)\1$/, "$2")]));
  if (values.HIVE_RELEASE_TOKEN && (statSync(file).mode & 0o077)) throw new Error(`${file} holds a token and others can read it: chmod 600 ${file}`);
  const applied = {};
  for (const [k, v] of Object.entries(values)) if (env[k] === undefined) applied[k] = env[k] = v;
  return applied;
}

/**
 * Puts the builds on the hub through its host's SSH instead of the HTTP upload: SSH access to that host is the
 * authorization (as for deploy/update.sh), so no admin token lives here. One tar stream goes into the container's
 * /data (no copy on the host's disk), then apps/web/src/import-release.ts checks every build against SHA256SUMS.txt
 * and adds it. ssh: "hub-server" or "user@host"; container: the hub's container name.
 */
export async function importOverSsh({ ssh, container = "xdev-hive-hub-1", version, files, by, log = console.log, run = runPiped }) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw new Error(`Not a version: ${version}`);
  if (!/^[\w.@-]+$/.test(ssh) || !/^[\w.-]+$/.test(container)) throw new Error("HIVE_RELEASE_SSH / HIVE_RELEASE_SSH_CONTAINER: host and container names only.");
  const dir = `/data/incoming/${version}`;
  const base = path.dirname(files[0]);
  if (files.some((f) => path.dirname(f) !== base)) throw new Error("Release files must sit in one folder.");
  const names = files.map((f) => path.basename(f));
  log(`hub (ssh ${ssh}) ← ${names.length} files`);
  // COPYFILE_DISABLE: macOS tar would add ._* resource files that the import then reads as unknown builds.
  await run(
    ["tar", "-cf", "-", "-C", base, ...names],
    ["ssh", ssh, "docker", "exec", "-i", container, "sh", "-c", `'rm -rf ${dir} && mkdir -p ${dir} && tar -xf - -C ${dir}'`],
    { ...process.env, COPYFILE_DISABLE: "1" },
  );
  const notes = names.includes("NOTES.md") ? ["--notes", `${dir}/NOTES.md`] : [];
  await run(null, ["ssh", ssh, "docker", "exec", container, "node", "apps/web/src/import-release.ts", "--dir", dir, "--version", version, ...notes, "--by", `'${by.replace(/[^\w.@:-]/g, "")}'`], process.env, log);
}

/** Runs `to` (fed by `from`'s stdout when given); rejects with the command's stderr when either fails. */
function runPiped(from, to, env, log) {
  return new Promise((resolve, reject) => {
    const target = spawn(to[0], to.slice(1), { env, stdio: [from ? "pipe" : "ignore", "pipe", "pipe"] });
    const source = from ? spawn(from[0], from.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] }) : null;
    let err = "";
    target.stderr.on("data", (d) => { err += d; });
    source?.stderr.on("data", (d) => { err += d; });
    target.stdout.on("data", (d) => (log ? String(d).trimEnd().split("\n").forEach((l) => log(`hub: ${l}`)) : undefined));
    if (source) source.stdout.pipe(target.stdin);
    const done = new Map();
    const finish = (name, code) => {
      done.set(name, code);
      if (done.size < (source ? 2 : 1)) return;
      if ([...done.values()].every((c) => c === 0)) resolve();
      else reject(new Error(`${to.slice(0, 3).join(" ")}… failed: ${err.trim().slice(-500) || [...done.entries()].map(([n, c]) => `${n} exit ${c}`).join(", ")}`));
    };
    source?.on("error", reject).on("close", (c) => finish("source", c));
    target.on("error", reject).on("close", (c) => finish("target", c));
  });
}
