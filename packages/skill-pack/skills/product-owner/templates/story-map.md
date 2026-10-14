# Story map: <feature name>

## Backbone (user journey, left to right)
| 1. <step, e.g. Find> | 2. <e.g. Create> | 3. <e.g. Review> | 4. <e.g. Approve> |
|---|---|---|---|

## Releases
Most essential story on top of each column. The MVP line must cross every step.

| Release | 1. <step> | 2. <step> | 3. <step> | 4. <step> |
|---|---|---|---|---|
| **MVP** | S1 | S2 | S3 | S4 |
| **Next** | S5 | | S6 | |
| **Later** | | S7 | | |

## Stories

### S1: <short title> (MVP)
As a <role>, I want <capability>, so that <outcome>.

INVEST check: Independent ☐ Negotiable ☐ Valuable ☐ Estimable ☐ Small ☐ Testable ☐

Acceptance criteria
1. **Main path**
   - Given <context>
   - When <action>
   - Then <observable result, e.g. toast "Đã gửi duyệt">
2. **Empty or error case**
   - Given <context>
   - When <action>
   - Then <message the user can act on, e.g. "Chưa chọn dự án">
3. **Permission case**
   - Given <role without permission>
   - When <action>
   - Then <what they see>

### S2: <short title> (MVP)
...
