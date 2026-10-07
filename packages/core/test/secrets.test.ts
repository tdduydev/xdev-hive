import assert from "node:assert/strict";
import { it } from "node:test";
import { assertNoSecret, findSecret, redactLines } from "#core/secrets.ts";

it("recognizes the short-lived chat credential as well as the machine credential", () => {
  for (const prefix of ["hive_", "hivechat_"]) {
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
