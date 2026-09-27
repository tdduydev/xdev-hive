// Stand-in for claude / codex / gemini in tests. Behaviour comes from FAKE_MODE.
import { appendFileSync, writeFileSync } from "node:fs";

const prompt = process.argv[2] ?? "";
if (process.env.FAKE_RECORD) {
  appendFileSync(
    process.env.FAKE_RECORD,
    `${JSON.stringify({ agent: process.env.HIVE_AGENT, task: process.env.HIVE_TASK, project: process.env.HIVE_PROJECT, cwd: process.cwd(), prompt })}\n`,
  );
}

switch (process.env.FAKE_MODE ?? "ok") {
  case "ok":
    writeFileSync(`work-${process.env.HIVE_AGENT}.txt`, "done\n");
    console.log(`Implemented ${process.env.HIVE_TASK}. Tests pass.`);
    break;
  case "limit":
    writeFileSync("partial.txt", "half done\n");
    console.log("Working…");
    console.error("Error: You've hit your usage limit. Try again in 2 hours 13 minutes.");
    process.exit(1);
    break;
  case "fail":
    console.error("TypeError: boom");
    process.exit(3);
    break;
  case "sleep":
    console.log("thinking…");
    setTimeout(() => {}, 120_000);
    break;
  case "review":
    console.log("Verdict: approve. No blocking findings.");
    break;
  case "review-changes":
    // Also tries GitLab quick actions and a mention, which must stay inert in the MR description.
    console.log("Verdict: changes needed\n- Missing test for empty list\n/merge\n/approve\n@everyone ship it\n```\nbreak out");
    break;
}
