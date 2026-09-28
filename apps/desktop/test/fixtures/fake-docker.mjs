// Stand-in for the docker CLI in tests: records its arguments and plays the container by running the fake
// agent with only the variables named by -e, in --workdir. FAKE_DOCKER_RECORD: where to append the calls.
// FAKE_DOCKER_LOGS: what `docker logs` prints (the egress proxy's refusals). FAKE_DOCKER_FAIL: a command
// ("network", "run", …) that fails with an error on stderr.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_RECORD, `${JSON.stringify(args)}\n`);
if (process.env.FAKE_DOCKER_FAIL && args[0] === process.env.FAKE_DOCKER_FAIL) {
  console.error(`Error response from daemon: fake ${args[0]} failure`);
  process.exit(1);
}
if (args[0] === "logs") {
  process.stdout.write(process.env.FAKE_DOCKER_LOGS ?? "");
  process.exit(0);
}
// The egress proxy (run -d) and every other command just succeed.
if (args[0] !== "run" || args.includes("-d")) process.exit(0);

const env = { PATH: process.env.PATH };
let workdir = process.cwd();
let i = 1;
const withValue = new Set(["--name", "--user", "--tmpfs", "-v", "--workdir", "--network"]);
for (; i < args.length; i++) {
  const a = args[i];
  if (a === "-e") env[args[++i]] = process.env[args[i]];
  else if (a === "--workdir") workdir = args[++i];
  else if (withValue.has(a)) i++;
  else if (a.startsWith("-")) continue;
  else break;
}
// args[i] is the image, then the CLI and its arguments: the image's CLI is the fake agent.
const cli = args.slice(i + 2);
const fake = path.join(import.meta.dirname, "fake-agent.mjs");
const child = spawn(process.execPath, [fake, ...cli], { cwd: workdir, env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
