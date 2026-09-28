// Stand-in for claude / codex / gemini in tests. Behaviour comes from FAKE_MODE.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

// Sign-in checks (claude auth status, codex login status). FAKE_LOGIN=out plays a signed-out CLI.
const [first, second] = process.argv.slice(2);
if ((first === "auth" || first === "login") && second === "status") {
  const out = process.env.FAKE_LOGIN === "out";
  if (first === "auth") console.log(JSON.stringify({ loggedIn: !out, authMethod: out ? "none" : "claude.ai", subscriptionType: out ? undefined : "max" }));
  else console.log(out ? "Not logged in" : "Logged in using ChatGPT");
  process.exit(out && first === "login" ? 1 : 0);
}

const prompt = process.argv[2] ?? "";
if (process.env.FAKE_RECORD) {
  appendFileSync(
    process.env.FAKE_RECORD,
    `${JSON.stringify({ agent: process.env.HIVE_AGENT, task: process.env.HIVE_TASK, project: process.env.HIVE_PROJECT, cwd: process.cwd(), prompt, args: process.argv.slice(3), readOnly: process.env.HIVE_READONLY ?? null })}\n`,
  );
}

// `--output-format json` (Claude Code): nothing on stdout until one result object at the end.
const format = process.argv.indexOf("--output-format");
const json = format !== -1 && process.argv[format + 1] === "json";
const said = [];
const say = (text) => (json ? said.push(text) : console.log(text));
const finish = (code = 0) => {
  if (json) {
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
  process.exit(code);
};

switch (process.env.FAKE_MODE ?? "ok") {
  case "ok":
    writeFileSync(`work-${process.env.HIVE_AGENT}.txt`, "done\n");
    say(`Implemented ${process.env.HIVE_TASK}. Tests pass.`);
    finish();
    break;
  case "limit":
    writeFileSync("partial.txt", "half done\n");
    say("Working…");
    console.error("Error: You've hit your usage limit. Try again in 2 hours 13 minutes.");
    finish(1);
    break;
  case "fail":
    console.error("TypeError: boom");
    finish(3);
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
  case "review":
    say("Verdict: approve. No blocking findings.");
    finish();
    break;
  case "review-changes":
    // Also tries GitLab quick actions and a mention, which must stay inert in the MR description.
    say("Verdict: changes needed\n- Missing test for empty list\n/merge\n/approve\n@everyone ship it\n```\nbreak out");
    finish();
    break;
}
