The full Lucide set the app's `lucide-react` ships, as one data file: `lucide.json`. Browse and copy icons on the Icons page under Foundations.

- `icons` maps each name (kebab case, as in `lucide-react`'s file names) to the SVG body: the shapes inside `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`.
- `aliases` maps an older name to the current one (`activity-square` → `square-activity`). Use the current name in new code.
- `version` is the `lucide-react` version the set came from; `license` is Lucide's (ISC).

In the app, import the component from `lucide-react` (`import { Plus } from "lucide-react"`); use this file only where React is not available. Icons follow `currentColor`, so set the colour on the parent: `text-secondary` beside a label, a `status-*-fg` for a status icon.
