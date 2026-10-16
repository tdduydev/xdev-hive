import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
let directory;
let key;
let cert;

before(async () => {
  directory = await mkdtemp(join(import.meta.dirname, "../.env.ca-test."));
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    // Node chỉ so tên máy với subjectAltName, nên phép kiểm tên miền cần SAN.
    "-addext",
    "subjectAltName=DNS:localhost",
  ]);
  [key, cert] = await Promise.all([
    readFile(join(directory, "key.pem")),
    readFile(join(directory, "cert.pem"), "utf8"),
  ]);
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function check(
  t,
  handler,
  success,
  { host = "127.0.0.1", path = "/ca.crt", env = {}, stderr = /sau \d+ lần thử/ } = {},
) {
  let requests = 0;
  const server = createServer({ key, cert }, (request, response) => {
    assert.equal(request.url, path);
    handler(response, ++requests);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const args = [
    // localhost có thể phân giải ra ::1 trước; server chỉ nghe IPv4.
    "--dns-result-order=ipv4first",
    join(import.meta.dirname, "check-ca.mjs"),
    // Phải kiểm đường dẫn gốc ngay cả khi URL đầu vào có path.
    `https://${host}:${server.address().port}/prefix`,
    "10",
  ];
  const options = { env: { ...process.env, ...env } };
  if (success) {
    const { stdout } = await exec(process.execPath, args, options);
    assert.match(stdout, /^Đạt: /);
  } else {
    await assert.rejects(exec(process.execPath, args, options), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, stderr);
      return true;
    });
  }
  return requests;
}

// Tên miền: kiểm /api/v1/health bằng CA hệ thống; NODE_EXTRA_CA_CERTS đóng vai CA công khai.
function checkDomain(t, handler, success, { trust = true, stderr } = {}) {
  const env = trust ? { NODE_EXTRA_CA_CERTS: join(directory, "cert.pem") } : {};
  return check(t, handler, success, { host: "localhost", path: "/api/v1/health", env, stderr });
}

test("chấp nhận chứng chỉ PEM qua TLS với CA chưa tin", async (t) => {
  assert.equal(await check(t, (response) => response.end(cert), true), 1);
});

test("từ chối HTML từ route fallback", async (t) => {
  assert.equal(await check(t, (response) => response.end("<html>Hive</html>"), false), 3);
});

test("từ chối PEM có marker nhưng dữ liệu chứng chỉ hỏng", async (t) => {
  await check(t, (response) => response.end("-----BEGIN CERTIFICATE-----\nhong\n-----END CERTIFICATE-----"), false);
});

test("từ chối HTTP lỗi dù body chứa chứng chỉ", async (t) => {
  await check(t, (response) => response.writeHead(404).end(cert), false);
});

test("từ chối redirect thay vì đi theo trang đăng nhập", async (t) => {
  await check(t, (response) => response.writeHead(302, { Location: "/login" }).end(), false);
});

test("thử lại khi Caddy chưa sẵn sàng", async (t) => {
  const requests = await check(
    t,
    (response, attempt) => {
      response.writeHead(attempt === 1 ? 503 : 200).end(cert);
    },
    true,
  );
  assert.equal(requests, 2);
});

test("giới hạn kích thước phản hồi", async (t) => {
  await check(t, (response) => response.end("x".repeat(70_000)), false);
});

test("tên miền: chấp nhận chứng chỉ CA hệ thống tin, không cần /ca.crt", async (t) => {
  assert.equal(await checkDomain(t, (response) => response.end("{}"), true), 1);
});

test("tên miền: từ chối chứng chỉ CA hệ thống không tin", async (t) => {
  const stderr = /chưa được CA hệ thống tin sau 24 lần thử: .*self-signed certificate/;
  assert.equal(await checkDomain(t, (response) => response.end("{}"), false, { trust: false, stderr }), 0);
});

test("tên miền: thử lại khi chứng chỉ chưa cấp xong hoặc hub chưa sẵn sàng", async (t) => {
  const requests = await checkDomain(t, (response, attempt) => response.writeHead(attempt < 3 ? 502 : 200).end(), true);
  assert.equal(requests, 3);
});

test("tên miền: từ chối redirect", async (t) => {
  const stderr = /sau 24 lần thử: HTTP 302/;
  assert.equal(
    await checkDomain(t, (response) => response.writeHead(302, { Location: "/login" }).end(), false, { stderr }),
    24,
  );
});
