import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import type { HostKey } from "../schema.ts";

// `sshd` thật (OpenSSH trên Ubuntu) trong container, cho test cách triển khai ssh-script chạy run.sh thật: `setsid`,
// `timeout`, `kill` nhóm tiến trình, SFTP. Máy chủ giả trong tiến trình (fake-ssh.ts) không chạy được shell.
// Container chỉ nghe 127.0.0.1 cổng ngẫu nhiên; trong đó `docker` là script giả (sshd/fake-docker.sh), không có Docker.

/** Image gốc; Docker Hub giới hạn lượt tải thì trỏ tới mirror, vd. public.ecr.aws/docker/library/ubuntu:24.04. */
export const SSHD_BASE_IMAGE = process.env.HIVE_TEST_SSHD_BASE_IMAGE ?? "ubuntu:24.04";
const IMAGE_NAME = "xdev-hive-test-sshd:local";
const CONTEXT = fileURLToPath(new URL("./sshd/", import.meta.url));
const USER = "deploy";
const HOME = `/home/${USER}`;
/** Thư mục trạng thái của `docker` giả (cờ, project compose, lệnh đã gọi). */
export const FAKE_DOCKER_DIR = `${HOME}/.fake-docker`;

/** Cờ của `docker` giả, xem sshd/fake-docker.sh. */
export interface FakeDockerFlags {
  log?: string;
  sleepSec?: number;
  sleepOn?: string;
  fail?: string;
  exitCode?: number;
}

export interface ExecOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TestSshd {
  host: string;
  port: number;
  user: string;
  /** `{algorithm, fingerprint}` đúng dạng hub lưu (`ssh-keygen -lf`), đọc từ host key của container này. */
  hostKeys: HostKey[];
  /** Thêm khoá công khai vào `authorized_keys` của user. */
  authorize(publicKey: string): Promise<void>;
  /** Chạy lệnh `sh -c` trong container, mặc định bằng root. */
  exec(command: string, options?: { user?: string }): Promise<ExecOutput>;
  writeFile(path: string, content: string, options?: { user?: string }): Promise<void>;
  readFile(path: string): Promise<string>;
  /** Ghi cờ cho `docker` giả; gọi lại thì thay cả bộ cờ. */
  fakeDocker(flags: FakeDockerFlags): Promise<void>;
  /** Project compose "đang chạy" mà `docker compose ls` giả trả về: tên → file compose. */
  composeProjects(projects: Record<string, string>): Promise<void>;
  /** Các lần gọi `docker` (đối số), theo thứ tự. */
  dockerCalls(): Promise<string[]>;
  stop(): Promise<void>;
}

// `withExposedPorts` mặc định mở cổng trên mọi địa chỉ của máy; ép về 127.0.0.1. `Init`: có tiến trình init dọn
// tiến trình mồ côi như máy thật, để `kill -0` trên PID của run.sh đã xong không thấy tiến trình zombie.
class LoopbackContainer extends GenericContainer {
  constructor(image: string) {
    super(image);
    this.withExposedPorts(22);
    this.hostConfig.PortBindings = { "22/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] };
    this.hostConfig.Init = true;
  }
}

let built: Promise<void> | undefined;

function buildImage(): Promise<void> {
  built ??= GenericContainer.fromDockerfile(CONTEXT, "Dockerfile")
    .withBuildArgs({ BASE_IMAGE: SSHD_BASE_IMAGE })
    .build(IMAGE_NAME, { deleteOnExit: false })
    .then(() => undefined);
  return built;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function parseHostKeys(text: string): HostKey[] {
  const keys: HostKey[] = [];
  for (const line of text.split("\n")) {
    const [algorithm, blob] = line.trim().split(/\s+/);
    if (!algorithm || !blob) continue;
    const digest = createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "");
    keys.push({ algorithm, fingerprint: `SHA256:${digest}` });
  }
  return keys;
}

export async function startSshd(): Promise<TestSshd> {
  await buildImage();
  const container: StartedTestContainer = await new LoopbackContainer(IMAGE_NAME)
    .withWaitStrategy(Wait.forLogMessage(/Server listening/))
    .start();

  const exec = async (command: string, options: { user?: string } = {}): Promise<ExecOutput> => {
    const result = await container.exec(["sh", "-c", command], { user: options.user ?? "root" });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
  const must = async (command: string, options: { user?: string } = {}): Promise<string> => {
    const result = await exec(command, options);
    if (result.exitCode !== 0) {
      throw new Error(`Lệnh trong container sshd lỗi (${result.exitCode}): ${command}\n${result.stderr}`);
    }
    return result.stdout;
  };
  const writeFile = async (path: string, content: string, options: { user?: string } = {}): Promise<void> => {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    await must(`mkdir -p "$(dirname ${quote(path)})" && printf %s ${quote(b64)} | base64 -d > ${quote(path)}`, options);
  };

  const hostKeys = parseHostKeys(await must("cat /etc/ssh/ssh_host_*_key.pub"));
  if (hostKeys.length === 0) throw new Error("Container sshd không có host key.");

  return {
    // Docker trả "localhost"; ssh2 có thể thử ::1 trước trong khi cổng chỉ mở trên 127.0.0.1.
    host: "127.0.0.1",
    port: container.getMappedPort(22),
    user: USER,
    hostKeys,
    authorize: async (publicKey) => {
      await must(`printf '%s\\n' ${quote(publicKey.trim())} >> ${HOME}/.ssh/authorized_keys`, { user: USER });
    },
    exec,
    writeFile,
    readFile: (path) => must(`cat ${quote(path)}`),
    fakeDocker: async (flags) => {
      const lines = [
        flags.log !== undefined ? `FAKE_DOCKER_LOG=${quote(flags.log)}` : "",
        flags.sleepSec !== undefined ? `FAKE_DOCKER_SLEEP=${flags.sleepSec}` : "",
        flags.sleepOn !== undefined ? `FAKE_DOCKER_SLEEP_ON=${quote(flags.sleepOn)}` : "",
        flags.fail !== undefined ? `FAKE_DOCKER_FAIL=${quote(flags.fail)}` : "",
        flags.exitCode !== undefined ? `FAKE_DOCKER_EXIT=${flags.exitCode}` : "",
      ].filter(Boolean);
      await writeFile(`${FAKE_DOCKER_DIR}/env`, lines.map((l) => `${l}\n`).join(""), { user: USER });
    },
    composeProjects: async (projects) => {
      const text = Object.entries(projects)
        .map(([name, files]) => `${name} ${files}\n`)
        .join("");
      await writeFile(`${FAKE_DOCKER_DIR}/projects`, text, { user: USER });
    },
    dockerCalls: async () => {
      const out = await must(`cat ${FAKE_DOCKER_DIR}/calls 2>/dev/null || true`);
      return out.split("\n").filter((l) => l.length > 0);
    },
    stop: async () => {
      await container.stop();
    },
  };
}
