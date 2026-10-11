import { spawn } from "node:child_process";
import { access, copyFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const isWindows = process.platform === "win32";
const command = (name: string, args: string[], stdio: "inherit" | "pipe" = "inherit") =>
  spawn(name, args, { stdio, shell: isWindows });

async function run(args: string[]) {
  const child = command(isWindows ? "docker.exe" : "docker", args);
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

try {
  const envPath = "apps/hub/.env";
  try {
    await access(envPath);
  } catch {
    await copyFile("apps/hub/.env.example", envPath);
    console.log("Đã tạo apps/hub/.env từ mẫu. Hãy đổi secret dev trước khi dùng lâu dài.");
  }
  const up = await run(["compose", "-f", "deploy/dev/compose.yaml", "up", "-d"]);
  if (up !== 0) throw new Error("Không khởi động được Docker Compose.");
  console.log("Đang đợi Postgres khỏe mạnh...");
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    const child = command(
      isWindows ? "docker.exe" : "docker",
      ["compose", "-f", "deploy/dev/compose.yaml", "ps", "--format", "json", "postgres"],
      "pipe",
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    const code = await new Promise<number>((resolve) => child.once("exit", (value) => resolve(value ?? 1)));
    if (code === 0 && output.includes("healthy")) {
      healthy = true;
      break;
    }
    await delay(1000);
  }
  if (!healthy) throw new Error("Postgres chưa healthy sau 60 giây.");
  const pnpm = isWindows ? "pnpm.cmd" : "pnpm";
  const setupChild = command(pnpm, ["--filter", "@xdev-hive/hub", "db:setup"]);
  const setup = await new Promise<number>((resolve, reject) => {
    setupChild.once("error", reject);
    setupChild.once("exit", (code) => resolve(code ?? 1));
  });
  if (setup !== 0) throw new Error("db:setup thất bại.");
  const hub = spawn(pnpm, ["--filter", "@xdev-hive/hub", "dev"], { stdio: "inherit", shell: isWindows });
  const web = spawn(pnpm, ["--filter", "@xdev-hive/web", "dev", "--", "--host", "0.0.0.0"], {
    stdio: "inherit",
    shell: isWindows,
  });
  const stop = () => {
    hub.kill();
    web.kill();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const code = await Promise.race([
    new Promise<number>((resolve) => hub.once("exit", (value) => resolve(value ?? 1))),
    new Promise<number>((resolve) => web.once("exit", (value) => resolve(value ?? 1))),
  ]);
  stop();
  process.exitCode = code;
} catch (error) {
  console.error(`Không thể chạy môi trường dev: ${error instanceof Error ? error.message : String(error)}`);
  console.error(
    "Cần Docker Desktop hoặc Docker Engine đang chạy, cùng Docker Compose v2. Khởi động Docker rồi chạy lại pnpm dev.",
  );
  process.exitCode = 1;
}
