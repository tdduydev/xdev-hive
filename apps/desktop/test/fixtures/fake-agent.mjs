// Stand-in for claude / codex / gemini / copilot in tests. Behaviour comes from FAKE_MODE.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Native Vibe 2.26.0 history contract: camelCase completed entries, metadata usage separately.
if (process.env.FAKE_MODE?.startsWith("vibe")) {
  const args = process.argv.slice(2);
  const prompt = args[args.indexOf("--prompt") + 1];
  const resumed = args.includes("--resume");
  const mcp = JSON.parse(process.env.VIBE_MCP_SERVERS)[0];
  if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ agent: process.env.HIVE_AGENT, prompt, cwd: process.cwd(), args, mcp, key: process.env.MISTRAL_API_KEY ? "set" : null, readOnly: process.env.HIVE_READONLY ?? null }) + "\n");
  const entry = (id, text) => ({ type: "message", id, sessionId: "fake-vibe-session", generationStatus: "completed", role: "assistant", content: [{ type: "text", text }] });
  const rows = [entry("progress", "working on task")];
  const output = args[args.indexOf("--output") + 1];
  if (output === "streaming") console.log(JSON.stringify(rows[0]));
  if (process.env.FAKE_MODE === "vibe-steer") await new Promise((r) => setTimeout(r, 400));
  if (resumed) writeFileSync("work-vibe.txt", readFileSync(".xdev-hive/steer.md", "utf8"));
  else writeFileSync("work-vibe.txt", "implemented\n");
  rows.push(entry(resumed ? "final-resume" : "final", resumed ? "Applied additional instructions" : "Implemented T-1."));
  if (process.env.FAKE_MODE === "vibe-error") rows.push({ type: "notice", id: "error", generationStatus: "completed", level: "error", message: "authentication required" });
  if (process.env.FAKE_MODE === "vibe-limit") rows.push({ type: "notice", id: "error", generationStatus: "completed", level: "error", message: "429 quota exceeded" });
  if (output === "json") console.log(JSON.stringify(rows));
  else for (const row of rows.slice(1)) console.log(JSON.stringify(row));
  if (process.env.FAKE_MODE !== "vibe-no-stats") {
    const dir = join(process.env.VIBE_SESSION_LOGGING__SAVE_DIR, "session_fake");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ session_id: "fake-vibe-session", environment: { working_directory: process.cwd() }, stats: { session_prompt_tokens: resumed ? 200 : 100, session_cached_tokens: resumed ? 60 : 30, session_completion_tokens: resumed ? 24 : 12 } }));
  }
  if (process.env.FAKE_VIBE_STAGE === "1") execFileSync("git", ["add", "--", process.env.VIBE_SESSION_LOGGING__SAVE_DIR], { stdio: "ignore" });
  process.exit(0);
}

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

if (process.env.FAKE_MODE === "copilot-ok" || process.env.FAKE_MODE === "copilot-event-error") {
  const args = process.argv.slice(2);
  if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ agent: process.env.HIVE_AGENT, prompt: args[args.indexOf("-p") + 1], cwd: process.cwd(), args }) + "\n");
  console.log(JSON.stringify({ type: "session.start", sessionId: "fake-copilot-session", data: {} }));
  console.log(JSON.stringify({ type: "tool.execution_start", data: { toolName: "write" } }));
  if (process.env.FAKE_MODE === "copilot-ok") writeFileSync("work-copilot.txt", "copilot fixture\n");
  console.log(JSON.stringify({ type: "assistant.message", data: { messageId: "m1", content: "Copilot fixture complete" } }));
  console.log(JSON.stringify({ type: "assistant.usage", data: { model: "auto", inputTokens: 25, cacheReadTokens: 5, cacheWriteTokens: 2, outputTokens: 7, cost: 1 } }));
  if (process.env.FAKE_MODE === "copilot-event-error") console.log(JSON.stringify({ type: "session.error", data: { errorType: "authentication", message: "fixture authentication failed" } }));
  process.exit(0);
}

if (process.argv.includes("--help")) {
  console.log("--output-format text|json|stream-json --resume SESSION_ID");
  process.exit(0);
}

// Kilo's native JSON parts are a separate protocol from Claude and Codex.
if (process.env.FAKE_MODE?.startsWith("kilo-") && process.argv[2] === "run") {
  const mode = process.env.FAKE_MODE;
  const cfg = JSON.parse(process.env.KILO_CONFIG_CONTENT ?? "{}");
  if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, JSON.stringify({
    agent: process.env.HIVE_AGENT, prompt: process.argv.at(-1), cwd: process.cwd(), args: process.argv.slice(2),
    kilo: { smallModel: cfg.small_model, model: cfg.model, mcp: cfg.mcp, permission: JSON.parse(process.env.KILO_PERMISSION ?? "{}"), xdgConfig: process.env.XDG_CONFIG_HOME },
  }) + "\n");
  const event = (type, data) => console.log(JSON.stringify({ type, sessionID: "kilo-session", ...data }));
  event("step_start", { part: { id: "s1", type: "step-start" } });
  if (mode === "kilo-error" || mode === "kilo-limit" || mode === "kilo-unsupported") {
    event("error", { error: { name: "APIError", data: { message: mode === "kilo-limit" ? "429 rate limit exceeded" : mode === "kilo-unsupported" ? "unknown model: kilo/kilo-auto/free" : "authentication required" } } });
    console.log("x".repeat(35_000));
    process.exit(0);
  }
  if (mode === "kilo-timeout") {
    event("text", { part: { id: "t0", text: "Checking Kilo timeout work" } });
    writeFileSync("kilo-timeout.txt", "unfinished work\n");
    setTimeout(() => {}, 120_000);
  } else {
    event("tool_use", { part: { id: "tool", tool: "edit", state: { status: "completed", input: { filePath: "kilo-work.txt" }, title: "Edit kilo-work.txt" } } });
    writeFileSync("kilo-work.txt", "done\n");
    event("step_finish", { part: { id: "f1", reason: "stop", cost: 0.01, tokens: { input: 100, output: 20, cache: { read: 50, write: 10 } } } });
    event("text", { part: { id: "t1", text: "Implemented Kilo task. Tests pass." } });
    process.exit(0);
  }
}

// Sign-in checks (claude auth status, codex login status). FAKE_LOGIN=out plays a signed-out CLI.
const [first, second] = process.argv.slice(2);
if ((first === "auth" || first === "login") && second === "status") {
  const out = process.env.FAKE_LOGIN === "out";
  if (first === "auth") console.log(JSON.stringify({ loggedIn: !out, authMethod: out ? "none" : "claude.ai", subscriptionType: out ? undefined : "max" }));
  else console.log(out ? "Not logged in" : "Logged in using ChatGPT");
  process.exit(out && first === "login" ? 1 : 0);
}

if (first === "models" && process.env.FAKE_MODE?.startsWith("opencode")) { console.log("test/model\ntest/small\nother/paid"); process.exit(0); }
if (process.env.FAKE_MODE?.startsWith("opencode")) {
  const event = (type, part) => console.log(JSON.stringify({ type, sessionID: "ses_fake_opencode", part }));
  if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ agent: process.env.HIVE_AGENT, prompt: process.argv.at(-1), cwd: process.cwd(), args: process.argv.slice(2), readOnly: process.env.HIVE_READONLY ?? null, config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT), dirs: ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"].map((key) => process.env[key]) }) + "\n");
  event("step_start", { id: "start", type: "step-start" });
  event("tool_use", { id: "call", type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "work.txt" }, output: "Done" } });
  event("text", { id: "text", type: "text", text: "Implemented OpenCode task. Tests pass." });
  event("step_finish", { id: "finish", type: "step-finish", reason: "stop", cost: 0.002, tokens: { input: 12, output: 5, reasoning: 0, cache: { read: 30, write: 8 } } });
  if (process.env.FAKE_MODE === "opencode-no-newline-error") { process.stdout.write(JSON.stringify({ type: "error", sessionID: "ses_fake_opencode", error: { data: { message: "Invalid API key", statusCode: 401 } } })); process.exit(0); }
  if (process.env.FAKE_MODE === "opencode-zero-error" || process.env.FAKE_MODE === "opencode-limit") {
    console.log(JSON.stringify({ type: "error", sessionID: "ses_fake_opencode", error: { name: "APIError", data: { message: process.env.FAKE_MODE === "opencode-limit" ? "Too Many Requests" : "Invalid API key", statusCode: process.env.FAKE_MODE === "opencode-limit" ? 429 : 401 } } }));
    console.log("x".repeat(30000));
  } else appendFileSync(`work-${process.env.HIVE_AGENT}.txt`, "done\n");
  process.exit(0);
}
if (first === "models") { console.log('["gemini-3.8-pro"]'); process.exit(0); }

if (process.env.FAKE_MODE?.startsWith("codex-chat")) {
  process.on('uncaughtException', e => { console.error('Fake Codex: ' + e.message); process.exit(1); });
  const args = process.argv.slice(2);
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const config = args.find(a => a.startsWith('mcp_servers='));
  const value = key => JSON.parse(config.match(new RegExp(JSON.stringify(key) + '=("(?:\\\\.|[^"\\\\])*")'))[1]);
  if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ args, prompt, cwd: process.cwd(), agent: process.env.HIVE_AGENT }) + '\n');
  const event = e => console.log(JSON.stringify(e));
  event({ type: 'thread.started', thread_id: 'fake-chat-thread' });
  event({ type: 'item.updated', item: { type: 'agent_message', text: 'Reading Hive…' } });
  await new Promise(r => setTimeout(r, 100));
  if (process.env.FAKE_MODE === 'codex-chat-slow') await new Promise(r => setTimeout(r, 120000));
  if (process.env.FAKE_MODE === 'codex-chat-failed') {
    event({ type: 'turn.failed', error: { message: 'failed turn' } }); process.exit(0);
  }
  if (process.env.FAKE_PROPOSE === '1') {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'fake-codex', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(value('url')), { requestInit: { headers: { authorization: 'Bearer ' + process.env.HIVE_CHAT_TOKEN, 'x-hive-agent': value('x-hive-agent'), 'x-hive-project': value('x-hive-project'), 'x-hive-run': value('x-hive-run') } } }));
    const names = (await client.listTools()).tools.map(t => t.name);
    if (!names.includes('propose_task') || names.includes('task_claim') || names.includes('memory_write')) throw new Error('Invalid leader tools');
    const result = await client.callTool({ name: 'propose_task', arguments: { project: process.env.HIVE_PROJECT, id: 'CHAT-62a', title: 'Task from Codex', reason: 'Requested in chat' } });
    if (result.isError) throw new Error(JSON.stringify(result));
    event({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'xdev-hive', tool: 'propose_task', status: 'completed' } });
    await client.close();
  }
  event({ type: 'item.completed', item: { type: 'agent_message', text: 'Answer: ' + prompt.trim() } });
  event({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 } });
  process.exit(0);
}

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
  console.log(process.env.FAKE_GEMINI === "1" ? "0.63.0" : process.env.FAKE_AGY_VERSION ?? "2.1.0 (fake agent)");
  process.exit(0);
}

const gemini = process.env.FAKE_GEMINI === "1" || /^gemini/.test(process.env.HIVE_AGENT ?? "");
let prompt = process.argv[2] ?? "";
if (gemini && process.env.FAKE_GEMINI === "1") {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (input) prompt = input;
}
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
if (stream && !gemini) {
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
if (stream && gemini) {
  event({ type: "init", session_id: "aabbccdd-0000-4000-8000-000000000001", model: "flash" });
  event({ type: "tool_use", tool_name: "run_shell_command", tool_id: "g1", parameters: { command: "npm test" } });
  event({ type: "tool_result", tool_id: "g1", status: "success", output: "tests pass" });
}
if (process.env.FAKE_MODE === "gemini-steer" && !process.argv.includes("--resume")) {
  while (!existsSync(".xdev-hive/steer.md") || !readFileSync(".xdev-hive/steer.md", "utf8").includes("new instruction")) await new Promise((r) => setTimeout(r, 30));
}
const said = [];
const say = (text) => {
  if (codexJson) return said.push(text);
  if (stream) event(gemini ? { type: "message", role: "assistant", content: text, delta: true } : { type: "assistant", message: { content: [{ type: "text", text }] } });
  if (json || stream || codexJson) said.push(text);
  else console.log(text);
};
const finish = (code = 0) => {
  if (codexJson) {
    if (said.length) event({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: said.join("\n") } });
    event({ type: "turn.completed", usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300 } });
  }
  if ((json || stream) && gemini) {
    const failure = process.env.FAKE_MODE === "gemini-error-zero";
    const stats = { input_tokens: 5000, cached: 4000, input: 1000, output_tokens: 300, models: { flash: { input_tokens: 5000, cached: 4000, output_tokens: 300 } } };
    event(stream ? { type: "result", status: failure || code ? "error" : "success", stats, ...(failure ? { error: { message: "QUOTA_EXHAUSTED" } } : {}) } : { response: said.join("\n"), stats });
  }
  if ((json || stream) && !gemini) {
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
  if (stream && !gemini) event({ type: "system", subtype: "task_summary", detail: "Done", session_id: "fake-session" });
  process.exit(code);
};

switch (process.env.FAKE_MODE ?? "ok") {
  case "research":
    say(JSON.stringify({ report: "# Storage options\nUse SQLite; repo-only evidence.", sources: ["README.md"], recommendations: "Storage task: acceptance includes migration and rollback tests." }));
    finish();
    break;
  case "research-bad":
    say("No structured report");
    finish();
    break;
  case "plan-approval":
    if (process.env.HIVE_READONLY === "1") say("## Work\nImplement settings.\n## Files\napp.ts\n## Verification\nnpm test\n## Risks\nNone. " + "Keep scope focused. ".repeat(110));
    else { appendFileSync(`work-${process.env.HIVE_AGENT}.txt`, "implemented after approval\n"); say("Implemented the approved plan."); }
    finish();
    break;
  case "gemini-steer":
  case "gemini-error-zero":
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
      if (process.env.FAKE_CHAT_QUOTA === "1") {
        say("Partial Claude reply");
        console.error("Usage limit reached; try again in 1 hour");
        process.exit(1);
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
