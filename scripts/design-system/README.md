# Design system artifact

Builds the files of the xDev Hive design system (a claude.ai Design System artifact) from `packages/ui-kit`:
tokens, brand book, and the 31 components with live previews.

```bash
npm run design-system -- <out>
```

`<out>/project/` then holds:

| Path | From |
|---|---|
| `tokens.json` | `packages/ui-kit/src/tokens/*.css`, applied in `globals.css` import order (what the app renders); usage notes in `usage.mjs` |
| `README.md`, `assets/*/README.md`, `components/Cover/preview.html`, `components/index.d.ts` | `system/`, copied as they are |
| `components/<Name>/preview.html`, `README.md` | `components.mjs` |
| `components/bundle.js` | `entry.ts`, built by esbuild as one classic script that sets `window.XdevHive` and reads React from `window.React` |
| `components/lib/*.js` | React and ReactDOM from `node_modules` as classic scripts (React 19 has no UMD build) |
| `components/bundle.css` | Tailwind v4 over `ui-kit` with the `globals.css` theme mappings, minus every custom property `tokens.json` declares (the page's `tokens.css` declares them, so edits on the page reach the previews) |

Not built here: the artifact's index `project/design-system.json` (it records the uploaded logos and planets by their
asset ids) and those uploads. Keep the ones the artifact has.

## Publish

From Claude Code with the Artifact tool, to the existing design system:

1. `read` the artifact's `project/design-system.json`, keep it, and set `lastChange` (and `libraries` if the React
   version changed; the build prints the line).
2. One `publish` to the artifact's url with `root` = `<out>`, `file_path` = the index, and `files` = every path the
   build wrote. `components/index.d.ts` needs `contentType: "text/plain"` (`.ts` is not a served type).

## When the code changes

- A new token: add its usage to `usage.mjs` (the build warns about tokens without one).
- A new or renamed component: export it in `entry.ts` and add a card to `components.mjs`.
- `globals.css` restructured: `buildStylesheet` takes the part from `@custom-variant dark` up to the Docs prose comment.
