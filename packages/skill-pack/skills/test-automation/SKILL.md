---
name: test-automation
description: Use when automating a written test case (TC-XXX-NNN) as a Playwright or other end-to-end test, linking automated test results to xDev Hive test cases, or when Hive does not match a CI test result to its test case.
---

# Automating test cases for xDev Hive

Hive reads CI test reports and matches each result to a test case **by the code in square brackets in the test
title**. A test without `[TC-…]` in its title is invisible to Hive.

## 1. Read the test case

Get the TC with `qa_get_case` if the hive MCP server exposes it, otherwise from `docs/test-cases/<khu>.md`. Automate
what the TC says. If a step is unclear or has no expected result, ask the author or fix the TC with
`test-case-writing` first. Do not invent behaviour.

## 2. Name the test

```ts
test("[TC-DANGNHAP-002] Báo lỗi khi sai mật khẩu", async ({ page }) => {
```

- Title starts with the TC code **in square brackets**, then the TC name. `TC-DANGNHAP-002 Báo lỗi…` without brackets
  does not match.
- One test per TC. A test that covers two TCs carries both codes: `[TC-DANGNHAP-001] [TC-DANGNHAP-004] …`.
- `describe` names and file names do not matter to Hive; the code must be in the test title itself.

## 3. Write the steps

- One `test.step` per TC step, named with the step number, so a failure points at the same step a manual tester uses:
  `await test.step("Bước 2: Bấm Đăng nhập", async () => { … })`.
- Each "Kết quả mong đợi" becomes at least one assertion. Use the exact Vietnamese text from the TC.
- Prefer role and label locators (`getByRole("button", { name: "Đăng nhập" })`) over CSS.
- Wait on conditions (`await expect(...).toBeVisible()`), never on fixed sleeps.

## 4. Test data and secrets

- Credentials come from environment variables or the CI secret store: `process.env.TEST_USER_EMAIL`. Never commit
  them, and never put a real person's account or real patient data in fixtures.
- Use the TC's `Dữ liệu test` code to pick the fixture. Use codes that cannot exist (`999999.99999999`) for "not
  found" cases.

## 5. Report format

Hive reads Playwright JSON or JUnit XML. Configure one in `playwright.config.ts` and keep the HTML report if you want
it:

```ts
reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
// or: ["junit", { outputFile: "test-results/junit.xml" }]
```

The CI job must keep that file as an artifact. Retries are fine: a test that passes after a retry shows as
"Chập chờn" (flaky) in Hive, so do not hide flakiness by raising timeouts.

## 6. Never loosen a test to make it green

If the app does not do what the TC expects, the test should fail. Do not delete the assertion, weaken it, or add
`test.skip` / `test.fixme` to pass CI. Report the bug with `bug-report` and leave the failure visible. Use
`test.fixme` only with the bug link in a comment and only if the team agrees.

## 7. Update the test case

Change the TC only after the test passes in CI:

- `- Loại: tự động`
- `- Script: <path of the spec file from the test repo root>`, e.g. `e2e/dang-nhap.spec.ts`. No `..`, ≤ 255 chars.

Until then keep `- Loại: dự kiến tự động`. A TC marked `tự động` without Script is a format error that makes Hive skip
the whole file.

## Before you finish

- [ ] Every test title has `[TC-KHU-NNN]` with brackets.
- [ ] Every expected result has an assertion; no sleeps.
- [ ] No credentials or real personal data in code or fixtures.
- [ ] JSON or JUnit reporter configured and kept by CI.
- [ ] TC updated to `tự động` + Script only after CI passes.
