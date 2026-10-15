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
  ]);
  [key, cert] = await Promise.all([
    readFile(join(directory, "key.pem")),
    readFile(join(directory, "cert.pem"), "utf8"),
  ]);
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function check(t, handler, success) {
  let requests = 0;
  const server = createServer({ key, cert }, (request, response) => {
    assert.equal(request.url, "/ca.crt");
    handler(response, ++requests);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const args = [
    join(import.meta.dirname, "check-ca.mjs"),
    // Phải kiểm đường dẫn gốc ngay cả khi URL đầu vào có path.
    `https://127.0.0.1:${server.address().port}/prefix`,
  ];
  if (success) {
    const { stdout } = await exec(process.execPath, args);
    assert.match(stdout, /PEM hợp lệ/);
  } else {
    await assert.rejects(exec(process.execPath, args), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /sau 3 lần thử/);
      return true;
    });
  }
  return requests;
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
