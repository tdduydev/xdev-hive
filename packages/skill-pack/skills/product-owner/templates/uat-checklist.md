# UAT checklist: <feature name>

Tester role: <primary user role> · Build / preview: <link or commit> · Date: <YYYY-MM-DD>
Data used: <realistic data, including data that existed before the feature>

## Acceptance criteria
| Story | Criterion (Given / When / Then) | Result | Note |
|---|---|---|---|
| S1 | <main path> | Pass / Fail / Gap | |
| S1 | <empty or error case> | | |
| S1 | <permission case> | | |

Result: **Pass** meets the criterion · **Fail** does not · **Gap** criterion is silent but a user would be stuck.

## Cross-cutting
- [ ] Wording is in the user's language and says what the thing does (buttons, titles, empty states).
- [ ] Every error says what happened and what to do next ("Chưa chọn dự án. Chọn dự án rồi thử lại.").
- [ ] Each role sees only what it may use; forbidden actions are hidden or explained.
- [ ] Empty, loading and failure states exist and look intended.
- [ ] Data created before the feature still opens and works.
- [ ] Narrow width or mobile works, if users use it.
- [ ] Nothing the old behaviour or app offered is lost (or the loss is listed in the PRD).
- [ ] User can go back or undo from every step.

## Decision
- [ ] **Accept**: no Fail, no must-fix Gap.
- [ ] **Accept with follow-ups**: each below has an owner.
- [ ] **Reject**: must change before acceptance.

| Item | Type (Fail / Gap / follow-up) | Owner | Must fix? |
|---|---|---|---|
| | | | |

## Metrics to read after release
| Metric (from PRD) | Where to read it | When |
|---|---|---|
| | | |
