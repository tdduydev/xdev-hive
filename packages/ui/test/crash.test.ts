import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crashText } from "#ui/lib/crash.ts";

describe("crash report text", () => {
  it("names the error, the page and the first frames of both stacks", () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'tokens30')");
    error.stack = `TypeError: Cannot read properties of undefined (reading 'tokens30')\n${Array.from({ length: 30 }, (_, i) => `    at f${i} (app.js:${i}:1)`).join("\n")}`;
    const text = crashText(error, "\n    at CostsCell\n    at MachinesPage");
    assert.match(text, /^TypeError: Cannot read properties of undefined \(reading 'tokens30'\)\n/);
    assert.match(text, /page: /);
    assert.match(text, /at f10 /);
    assert.doesNotMatch(text, /at f11 /, "12 lines of the stack at most");
    assert.match(text, /components:\n    at CostsCell\n    at MachinesPage/);
  });

  it("takes something thrown that is not an Error", () => {
    assert.match(crashText("boom"), /^Error: boom/);
  });
});
