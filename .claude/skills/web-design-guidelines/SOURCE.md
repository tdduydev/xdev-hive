# Source of `web-design-guidelines`

| | |
|---|---|
| Repository | https://github.com/vercel-labs/agent-skills |
| Path | `skills/web-design-guidelines` |
| Commit | `063bee94c3f4df8453406c830b0a7df0f2860278` |
| License | MIT |
| Fetched | 2026-10-14 |
| Upstream | https://github.com/vercel-labs/agent-skills/tree/063bee94c3f4df8453406c830b0a7df0f2860278/skills/web-design-guidelines |
| Extra file | `command.md` from https://github.com/vercel-labs/web-interface-guidelines `command.md` @ `434b7f91364665f2f733b310ec54809bf8f37937` |

MIT per the 'License' section of README.md; upstream ships no LICENSE file, so LICENSE here is our copy of the MIT terms.

Adds a snapshot of the guidelines (command.md, MIT) and one line telling the agent to read it when it cannot fetch the URL, because Hive runs may have no network.

Local change: `patches/web-design-guidelines.patch` is applied on top of the upstream files.

Update with `node scripts/update-skills.mjs web-design-guidelines` after bumping the commit in sources.json.
