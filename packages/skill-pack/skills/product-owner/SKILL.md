---
name: product-owner
description: Act as product owner and design a feature before any code is written — one-page PRD, user story map with MVP cut, RICE/MoSCoW prioritization, user-side acceptance (UAT) review and competitor comparison. Use when a request is a product idea or a vague feature ("add X", "improve Y"), when scope or priority is unclear, or before running speckit-specify; asks the person in chat or, in an unattended run, records [Giả định] assumptions.
---

# Product owner

You decide **what** to build and **why**, in what order, and how a user will know it works. You do not decide how
it is built: no tech stack, schema or file names here. That starts at `speckit-plan`.

Skip this skill when the request is already specific and small (a bug fix, a label change, one clear behaviour).
Say so in one line and go straight to the normal workflow.

## 0. Pick the mode

| Mode | When | Rule |
|---|---|---|
| **Ask** | A person is in the chat and can answer now. | At most **5 questions**, each with your recommended answer. One message, then continue with their answers. |
| **Unattended** | A Hive run, a scheduled job, or nobody answers. | Never block. Choose the most reasonable answer, write it in the PRD as `[Giả định] …` with a one-line reason, and list it again under "Assumptions to confirm". |

Ask only what changes the design: who the user is, the problem's cost, the success number, the hard constraint
(deadline, platform, legacy data), what is out. Anything you can read from the repo, README, existing screens or
`docs/` is not a question. Question format:

```
1. Who files these requests today: team leads or every member?
   Recommend: team leads only, because the approval step already exists for them.
```

If the idea is still shapeless (no clear user or problem), run `brainstorming` first in Ask mode, then come back
here with its result. Do not use `brainstorming` in an unattended run. Write the assumption and go on.

## 1. Gather context (a quick read, not an audit)

- Read the request, the project README and any existing spec or `docs/` page on the area.
- Find the **existing behaviour**: the current screen, flow or old app this replaces or touches. Note what users already
  rely on, so the new design does not break it.
- If a competitor or the old app is known, fill the comparison (section 6). Otherwise skip it.

## 2. Write the PRD (one page)

Copy `templates/prd.md` and fill it. Required parts, in this order:

1. **Problem**: who hurts, when, how much. One concrete moment beats a paragraph.
2. **Target users**: one primary, at most two secondary. A role and a situation, not "everyone".
3. **Success metrics**: each has a baseline, a target and a date or window, and says how it is measured
   ("tasks created via templates: 0 → 30% of new tasks within 4 weeks, from the task log"). If there is no baseline,
   say `[Giả định]` or plan to measure first.
4. **Scope / Out of scope**: out of scope is as important as scope; list what people will ask for next and you refuse
   now.
5. **Risks and assumptions**: each risk has a mitigation or a test; each assumption says what happens if it is wrong.
6. **Open questions**: only those that block a decision.

Write behaviour in user terms. Keep UI text examples in the product's language (Vietnamese for xDev Hive), for example
the button "Gửi duyệt", the error "Chưa chọn dự án".

## 3. Story map and release cut

Copy `templates/story-map.md`.

1. Lay the user's journey as steps left to right (the backbone), for example *find → create → review → approve*.
2. Under each step list stories, most essential on top.
3. Draw the cut: **MVP** = the thinnest slice that lets the primary user finish the whole journey once and move the
   success metric. Everything else goes to **Next** or **Later**. A step with no story in the MVP means the MVP is
   broken.
4. Write each story to pass **INVEST**: Independent, Negotiable, Valuable, Estimable, Small (fits one iteration),
   Testable. Split by user-visible slice (one rule, one role, one path), not by layer (UI / API / DB).
5. Format: `As a <role>, I want <capability>, so that <outcome>.` Then acceptance criteria, each as
   **Given / When / Then**, observable from outside, one behaviour per scenario. Cover the main path, one empty or
   error case and one permission case:

   ```
   Given a member without the "approve" permission is on a pending request
   When they open the request page
   Then the "Duyệt" button is not shown
   ```

## 4. Prioritize

Copy `templates/prioritization.md`. Use the cheapest method that settles the question.

- **MoSCoW** for a release scope: Must (the release fails without it), Should, Could, Won't (this time). Keep Must at
  or under about 60% of the effort, or the plan has no slack. Every Must traces to the success metric.
- **RICE** to order competing items: `score = (Reach × Impact × Confidence) ÷ Effort`.
  - Reach: users or events per period (a number, state the period).
  - Impact: 3 massive, 2 high, 1 medium, 0.5 low, 0.25 minimal.
  - Confidence: 100% evidence, 80% some data, 50% a guess. Below 50% do not score; research first.
  - Effort: person-weeks (or points), a rough team estimate. If you cannot estimate, use S/M/L = 1/3/8 and say so.
- **Value vs effort** (2×2) as a sanity check: high value / low effort first, high value / high effort next if it
  moves the metric, low value / high effort never.

When scores disagree with intuition, show the numbers, and change a score only with a stated reason.

## 5. UAT / acceptance review (before accepting the feature)

Run this when the feature is built and about to be accepted, from the user's seat, not the code's. Copy
`templates/uat-checklist.md`.

1. Take the PRD's primary user and the MVP stories. Walk each acceptance criterion in the real app (or the preview),
   as that role, with realistic data. Do not reread the code to decide that it passes.
2. Mark each: **Pass**, **Fail** (does not meet the criterion) or **Gap** (criterion is silent but a user would be
   stuck: missing empty state, unclear message, no way back).
3. Check the cross-cutting items: wording (does the screen speak the user's language?), errors people can act on,
   permissions, empty/loading states, data that existed before the feature, mobile or narrow width if relevant,
   and that nothing the old behaviour offered was lost.
4. Decide: **Accept** (no Fail, no must-fix Gap), **Accept with follow-ups** (each follow-up logged with an owner), or
   **Reject** (list what must change). A Fail on a Must story is always Reject.
5. Success metrics are checked after release, not now. Write down when and where they will be read.

## 6. Competitor / previous app comparison (only when one exists)

A table, not an essay. One row per capability that matters to the primary user, columns for us / old app / each
competitor (max 3): has it, how well, and the note that decides something. End with 3 lines: what we copy, what we
deliberately do differently and why, what we skip. Cite only what you actually saw (screens, docs, the old app's code or
data); mark the rest `[Giả định]`. Never copy proprietary text or assets.

## 7. Hand off to the Spec Kit chain

The PRD answers what and why; Spec Kit turns it into a spec and code.

1. Save the files where the project keeps docs, or `docs/product/<feature-name>/` if it has no rule. Put the PRD
   path in your final message.
2. Call `speckit-specify` with the **Problem, Users, MVP stories and acceptance criteria, Out of scope** pasted in as
   the feature description (one MVP slice per spec; make a separate spec for each later slice). Do not paste
   technology. Carry the `[Giả định]` list into the spec's Assumptions.
3. `speckit-clarify` closes what the spec still leaves open (it asks up to 5 questions). In Ask mode you may already
   have answered them; do not ask the person twice.
4. `speckit-plan` → `speckit-tasks` → `speckit-implement`, as the project's workflow says. Use `speckit-analyze`
   to check that spec, plan and tasks still match the PRD's scope.
5. When the build is done, return to section 5 for acceptance. Use `speckit-checklist` if you want the criteria as a
   generated requirements checklist.

If the project has no `.specify/` folder, skip the `speckit-*` steps. Hand the PRD and story map to
`writing-plans` instead.

## Rules

- One page for the PRD, one table for the map. If it grows, cut scope rather than add sections.
- Every number is either measured, sourced or tagged `[Giả định]`. No invented statistics.
- Never put implementation choices in these documents; if one is forced by a constraint, state the constraint.
- In an unattended run, finish the whole output in one pass and end with the list of assumptions a person should
  confirm, most expensive-if-wrong first.
- Do not change code, specs or `.specify/` files from this skill. It only writes the product documents.
