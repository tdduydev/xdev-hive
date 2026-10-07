// Stand-in for claude / codex / gemini in tests. Behaviour comes from FAKE_MODE.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Combine a rejected startup with the existing steering and planning protocols.
if (process.env.FAKE_REJECT_MODEL === "1" && !process.argv.includes("--help") &&
    process.argv.some((a) => a === "-m" || a === "--model" || a.startsWith("--model="))) {
  if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ agent: process.env.HIVE_AGENT, prompt: process.argv.at(-1), cwd: process.cwd(), args: process.argv.slice(2), readOnly: process.env.HIVE_READONLY ?? null, runToken: process.env.HIVE_RUN_TOKEN ?? null }) + "\n");
  console.error("unknown model: requested");
  process.exit(1);
}

// Bidirectional Claude fixture: one result for each user turn, staying open until the runner sends EOF.
if (process.env.FAKE_MODE === "steer-stream") {
  if (process.argv.includes("--help")) { console.log("--input-format text|stream-json"); process.exit(0); }
  const { createInterface } = await import("node:readline");
  let work = Promise.resolve();
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    const user = JSON.parse(line);
    work = work.then(async () => {
      if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ agent: process.env.HIVE_AGENT, prompt: user.message.content, cwd: process.cwd(), args: process.argv.slice(2) }) + "\n");
      console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working on " + user.message.content }] } }));
      await new Promise((r) => setTimeout(r, 400));
      console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done", total_cost_usd: 0.01, usage: { input_tokens: 2, output_tokens: 3 } }));
    });
  }
  await work;
  process.exit(0);
}

if (process.env.FAKE_MODE === "steer-resume") {
  if (process.argv.includes("--help")) { console.log("Usage: codex exec resume [SESSION_ID] [PROMPT]"); process.exit(0); }
  const args = process.argv.slice(2);
  const resume = args.includes("resume");
  const prompt = args.at(-1);
  if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ agent: process.env.HIVE_AGENT, prompt, cwd: process.cwd(), args }) + "\n");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread-57a" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "working on task" } }));
  await new Promise((r) => setTimeout(r, 400));
  if (resume) writeFileSync("work-steered.txt", readFileSync(".xdev-hive/steer.md", "utf8"));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: resume ? "Applied additional instructions" : "First turn done" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } }));
  process.exit(0);
}

if (process.argv.includes("--help")) {
  console.log("--output-format text|json|stream-json");
  process.exit(0);
}

// Sign-in checks (claude auth status, codex login status). FAKE_LOGIN=out plays a signed-out CLI.
const [first, second] = process.argv.slice(2);
if ((first === "auth" || first === "login") && second === "status") {
  const out = process.env.FAKE_LOGIN === "out";
  if (first === "auth") console.log(JSON.stringify({ loggedIn: !out, authMethod: out ? "none" : "claude.ai", subscriptionType: out ? undefined : "max" }));
  else console.log(out ? "Not logged in" : "Logged in using ChatGPT");
  process.exit(out && first === "login" ? 1 : 0);
}

if (first === "models") { console.log('["gemini-3.8-pro"]'); process.exit(0); }

// Claude Code's /usage (plan usage). FAKE_USAGE="<session>,<week>" percentages; unset: an API key, no limits.
// FAKE_USAGE_RESETS="<session reset>|<week reset>" in /usage's own form: fixed texts go stale once their day is past,
// so the smoke passes times from its own clock (roadmap 52 counts down to them).
if (first === "-p" && second === "/usage") {
  if (process.env.FAKE_AGY === "1") {
    if (process.env.FAKE_LOGIN === "out") { console.error('AGY_ERROR: {"message":"authentication required"}'); process.exit(3); }
    const [session, week] = (process.env.FAKE_AGY_USAGE ?? "23,46").split(",").map(Number);
    const group = (name, prefix, session, week) => ({ name, buckets: [
      { id: prefix + "-5h", window: "5h", remaining_fraction: 1 - session / 100 },
      { id: prefix + "-weekly", window: "weekly", remaining_fraction: 1 - week / 100 },
    ] });
    console.log(JSON.stringify({ command: { name: "usage", data: { groups: [
      group("Gemini Models", "gemini", session, week), group("Claude and GPT models", "3p", 37, 62),
    ] } } }));
    process.exit(0);
  }
  const [session, week] = (process.env.FAKE_USAGE ?? "").split(",");
  const [sessionResets, weekResets] = (process.env.FAKE_USAGE_RESETS ?? "6:20pm (Asia/Saigon)|Oct 1 at 6pm (Asia/Saigon)").split("|");
  const result = process.env.FAKE_USAGE
    ? `You are currently using your subscription to power your Claude Code usage\n\nCurrent session: ${session}% used · resets ${sessionResets}\nCurrent week (all models): ${week}% used · resets ${weekResets}\n`
    : "You are currently using an API key.";
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, result, total_cost_usd: 0 }));
  process.exit(0);
}

// `<cli> --version` (Setup, the Agents page's check) comes with the app's cwd and no FAKE_MODE: falling through to
// "ok" wrote work-undefined.txt there, i.e. into apps/desktop when the smoke's fake CLIs were first on PATH.
if (first === "--version") {
  console.log(process.env.FAKE_AGY_VERSION ?? "2.1.0 (fake agent)");
  process.exit(0);
}

const prompt = process.argv[2] ?? "";
if (process.env.FAKE_RECORD) {
  appendFileSync(
    process.env.FAKE_RECORD,
    `${JSON.stringify({ agent: process.env.HIVE_AGENT, task: process.env.HIVE_TASK, project: process.env.HIVE_PROJECT, cwd: process.cwd(), prompt, args: process.argv.slice(3), readOnly: process.env.HIVE_READONLY ?? null, runToken: process.env.HIVE_RUN_TOKEN ?? null, hostOnly: process.env.HIVE_TEST_HOST_ONLY ?? null, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN ? "set" : null, hubToken: process.env.HIVE_HUB_TOKEN ? "set" : null, proxy: process.env.HTTPS_PROXY ?? null })}\n`,
  );
}

if (process.env.FAKE_MODE?.startsWith("unsupported")) {
  const hasModel = process.argv.some((a) => a === "-m" || a === "--model" || a.startsWith("--model="));
  if (hasModel || process.env.FAKE_MODE === "unsupported-always") {
    console.error("The 'requested' model is not supported when using this account.");
    process.exit(1);
  }
  process.env.FAKE_MODE = "ok";
}

// `--output-format json` (Claude Code): nothing on stdout until one result object at the end.
// `--output-format stream-json` (with --verbose): one event per line while it works, as Claude Code 2.1 prints them.
const format = process.argv.indexOf("--output-format");
const json = format !== -1 && process.argv[format + 1] === "json";
const stream = format !== -1 && process.argv[format + 1] === "stream-json";
const event = (e) => console.log(JSON.stringify(e));
// `codex exec --json` (roadmap 28c): thread, a command, the agent's message at the end, then the turn's tokens.
const codexJson = process.argv[2] === "exec" && process.argv.includes("--json");
if (process.env.FAKE_MODE === "codex-rtk") {
  const command = "git status";
  const output = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" });
  writeFileSync("rtk-output.txt", output);
}
if (codexJson) {
  event({ type: "thread.started", thread_id: "fake-thread" });
  event({ type: "turn.started" });
  event({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "bash -lc 'npm test'", aggregated_output: "", exit_code: null, status: "in_progress" } });
  event({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "bash -lc 'npm test'", aggregated_output: "ok 1 - adds\nok 2 - subtracts", exit_code: 0, status: "completed" } });
}
if (stream) {
  event({ type: "system", subtype: "init", session_id: "fake-session", model: "fake-model", claude_code_version: "2.1.0", tools: ["Bash"] });
  event({ type: "system", subtype: "task_summary", detail: "Running the tests", session_id: "fake-session" });
  event({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test", description: "Run tests" } }] } });
  event({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok 1 - adds\nok 2 - subtracts", is_error: false }] } });
}
if (process.env.FAKE_SKILLS) {
  if (stream) {
    event({ type: "assistant", message: { content: [{ type: "tool_use", id: "skill", name: "mcp__xdev_hive__skill_get", input: { name: "review-pr" } }] } });
    event({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "skill", content: "skill instructions" }] } });
  }
  if (codexJson) event({ type: "item.completed", item: { type: "mcp_tool_call", tool: "skill_get", arguments: { name: "review-pr" }, status: "completed", result: { content: [] } } });
}
const said = [];
const say = (text) => {
  if (codexJson) return said.push(text);
  if (stream) event({ type: "assistant", message: { content: [{ type: "text", text }] } });
  if (json || stream || codexJson) said.push(text);
  else console.log(text);
};
const finish = (code = 0) => {
  if (codexJson) {
    if (said.length) event({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: said.join("\n") } });
    event({ type: "turn.completed", usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300 } });
  }
  if (json || stream) {
    console.log(
      JSON.stringify({
        type: "result",
        subtype: code ? "error_during_execution" : "success",
        is_error: code !== 0,
        result: said.join("\n"),
        total_cost_usd: Number(process.env.FAKE_COST ?? 0.0425),
        usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 4500, output_tokens: 850 },
      }),
    );
  }
  // Claude Code prints more events after the result.
  if (stream) event({ type: "system", subtype: "task_summary", detail: "Done", session_id: "fake-session" });
  process.exit(code);
};

switch (process.env.FAKE_MODE ?? "ok") {
  case "plan-approval":
    if (process.env.HIVE_READONLY === "1") say("## Work\nImplement settings.\n## Files\napp.ts\n## Verification\nnpm test\n## Risks\nNone. " + "Keep scope focused. ".repeat(110));
    else { appendFileSync(`work-${process.env.HIVE_AGENT}.txt`, "implemented after approval\n"); say("Implemented the approved plan."); }
    finish();
    break;
  case "codex-rtk":
  case "ok":
    // Appends, so a second run on the same branch (a CI fix) has something to commit too.
    appendFileSync(`work-${process.env.HIVE_AGENT}.txt`, "done\n");
    say(`Implemented ${process.env.HIVE_TASK}. Tests pass.`);
    finish();
    break;
  case "limit":
    writeFileSync("partial.txt", "half done\n");
    say("Working…");
    console.error("Error: You've hit your usage limit. Try again in 2 hours 13 minutes.");
    finish(1);
    break;
  case "agy-error-overflow":
  case "agy-error-zero":
    console.error('AGY_ERROR: {"message":"authentication required"}');
    if (process.env.FAKE_MODE === "agy-error-overflow") console.log("x".repeat(30_000));
    finish(0);
    break;
  case "agy-limit":
    console.error('AGY_ERROR: {"message":"QUOTA_EXHAUSTED"}');
    finish(3);
    break;
  case "fail":
    console.error("TypeError: boom");
    finish(3);
    break;
  case "codex-config-error":
    console.error("Error loading config.toml: invalid transport in `mcp_servers.xdev-hive`");
    finish(1);
    break;
  case "timeout-wip":
    writeFileSync("timeout-work.txt", "unfinished work\n");
    console.log("Checking timeout work");
    setTimeout(() => {}, 120_000);
    break;
  case "sleep":
    // Streams even in JSON mode, so tests can wait for it.
    console.log("thinking…");
    setTimeout(() => {}, 120_000);
    break;
  case "plant":
    // Leaves a git hook and an edited AGENTS.md behind; the runner's own commit must run neither.
    mkdirSync(".githooks", { recursive: true });
    writeFileSync(".githooks/pre-commit", `#!/bin/sh\ntouch '${process.env.FAKE_MARK}'\n`, { mode: 0o755 });
    writeFileSync("AGENTS.md", "# demo\nEdited by the agent.\n");
    writeFileSync("work.txt", "done\n");
    finish();
    break;
  case "artifacts":
    // Leaves files for the hub (roadmap 41c): one it keeps, one over 5 MB and one of a kind it does not take.
    appendFileSync(`work-${process.env.HIVE_AGENT}.txt`, "done\n");
    mkdirSync(".xdev-hive/artifacts/shots", { recursive: true });
    writeFileSync(".xdev-hive/artifacts/report.md", `# ${process.env.HIVE_TASK}\nĐo xong.\n`);
    writeFileSync(".xdev-hive/artifacts/shots/board.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    writeFileSync(".xdev-hive/artifacts/huge.log", Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    writeFileSync(".xdev-hive/artifacts/bundle.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]));
    say(`Implemented ${process.env.HIVE_TASK}.`);
    finish();
    break;
  case "leak":
    // Prints something that looks like a token: the log on this machine keeps it, what goes to the hub must not.
    appendFileSync(`work-${process.env.HIVE_AGENT}.txt`, "done\n");
    say(`Deploying with GITLAB_TOKEN=glpat-${"x".repeat(24)}`);
    say(`Implemented ${process.env.HIVE_TASK}.`);
    finish();
    break;
  case "review":
    // Asked to judge best-of-n candidates: keeps FAKE_PICK (default c2); FAKE_PICK=none names no winner.
    if (prompt.includes("Judge the candidates")) {
      const pick = process.env.FAKE_PICK ?? "2";
      say(pick === "none" ? "Both look fine." : `c${pick} has the tests.\n\n**Winner:** c${pick}\n**Reason:** it tests the empty list.`);
    } else say("Verdict: approve. No blocking findings.");
    finish();
    break;
  case "chat": {
    // The web chat's leader (roadmap 17): the message comes on stdin; "slow" keeps it writing until it is stopped.
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      const file = process.argv[process.argv.indexOf("--mcp-config") + 1];
      // The files it was given to read, as it finds them while it runs.
      const at = process.argv.indexOf("--add-dir");
      const dir = at >= 0 ? process.argv[at + 1] : null;
      const files = dir && existsSync(dir) ? Object.fromEntries(readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => [entry.name, readFileSync(join(dir, entry.name), "utf8")])) : null;
      if (process.env.FAKE_RECORD) {
        appendFileSync(
          process.env.FAKE_RECORD,
          `${JSON.stringify({ chat: input, agent: process.env.HIVE_AGENT, project: process.env.HIVE_PROJECT, cwd: process.cwd(), args: process.argv.slice(2), mcp: file && existsSync(file) ? readFileSync(file, "utf8") : null, files })}\n`,
        );
      }
      if (input.includes("slow")) {
        say("Looking at the tasks…");
        setTimeout(() => {}, 120_000);
        return;
      }
      say(`Answer: ${input.trim()}`);
      finish();
    });
    break;
  }
  case "assist": {
    // The Docs writing assistant (roadmap 22k): the ask on stdin; it adds a section to the page it was given.
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      if (process.env.FAKE_RECORD) {
        appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify({ assist: input, cwd: process.cwd(), args: process.argv.slice(2), project: process.env.HIVE_PROJECT ?? null })}\n`);
      }
      if (input.includes("slow")) {
        say("Reading the sources…");
        setTimeout(() => {}, 120_000);
        return;
      }
      const page = /<page>\n([\s\S]*?)\n<\/page>/.exec(input)?.[1] ?? "";
      say(input.includes("nothing to change") ? "<reply>Không có mâu thuẫn.</reply>\n<markdown></markdown>" : `<reply>Thêm mục Khi lỗi từ memory.</reply>\n<markdown>\n${page}\n## Khi lỗi\n- Chạy lại update.sh\n</markdown>`);
      finish();
    });
    break;
  }
  case "review-changes":
    // Also tries GitLab quick actions and a mention, which must stay inert in the MR description.
    say("Verdict: changes needed\n- Missing test for empty list\n/merge\n/approve\n@everyone ship it\n```\nbreak out");
    finish();
    break;
}
