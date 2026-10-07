import assert from "node:assert/strict";
import { it } from "node:test";
import { assertNoSecret, findSecret, redactLines } from "#core/secrets.ts";

it("recognizes the short-lived chat credential as well as the machine credential", () => {
  for (const prefix of ["hive_", "hivechat_", "hiverun_", "hivemcp_"]) {
    const synthetic = prefix + "a".repeat(43);
    assert.equal(findSecret(synthetic), "xDev Hive token");
    assert.throws(() => assertNoSecret(synthetic, "test"));
    assert.ok(!redactLines(`before\n${synthetic}\nafter`).includes(synthetic));
  }
});

it("hides the entire multiline private key, including a truncated block", () => {
  for (const kind of ["", "RSA ", "OPENSSH "]) {
    const begin = `-----BEGIN ${kind}PRIVATE KEY-----`;
    const end = `-----END ${kind}PRIVATE KEY-----`;
    const body = "synthetic-private-material";
    assert.equal(redactLines(`before\n${begin}\n${body}\n${end}\nafter`), "before\n(line hidden: it looked like a private key)\n(line hidden: it looked like a private key)\n(line hidden: it looked like a private key)\nafter");
    assert.ok(!redactLines(`${begin}\n${body}`).includes(body));
  }
  assert.equal(redactLines("normal\ntext"), "normal\ntext");
});

it("redacts tokens and PEM blocks across every possible chunk boundary", async () => {
  const { SecretRedactor } = await import("#core/secrets.ts");
  const text = `before\nhive_${"a".repeat(43)}\n-----BEGIN RSA PRIVATE KEY-----\nsynthetic material\n-----END RSA PRIVATE KEY-----\nafter`;
  for (let i = 0; i <= text.length; i++) {
    const stream = new SecretRedactor();
    assert.equal(stream.write(text.slice(0, i)) + stream.write(text.slice(i)) + stream.end(), redactLines(text));
  }
});


it("withholds an unfinished line until it can be safely classified", async () => {
  const { SecretRedactor } = await import("#core/secrets.ts");
  const stream = new SecretRedactor();
  assert.equal(stream.write("hive_" + "a".repeat(15)), "");
  assert.equal(stream.write("a".repeat(28)), "");
  assert.equal(stream.end(), "(line hidden: it looked like a xDev Hive token)");
});
