# 0013. Rebuild the web UI with shadcn/ui on Base UI, designed with UI UX Pro Max

- Status: Accepted
- Date: 2026-10-12
- Deciders: maintainers

## Context

The web app uses 16 hand-written components on Tailwind 4 and Base UI. Layout and visual consistency depend on each
screen's own classes, which makes redesigns slow and regressions likely.

## Decision

Redesign the whole interface with the `ui-ux-pro-max` skill (design system: style, palette, typography, spacing,
accessibility rules), express it as design tokens in CSS variables, and build screens from shadcn/ui components using
the Base UI primitives (`shadcn init --base base`) through the shadcn MCP server configured in `.mcp.json`. Screens
move one at a time; Playwright tests keep roles and accessible names stable and check 360 px width and dark mode.

## Consequences

- Good: a consistent, accessible component set owned in the repository; agents can add components through MCP.
- Bad: a large migration across every screen; mixed styles until it is finished.

## Alternatives considered

- Keep the hand-written components: no shared design language for new screens.
- Radix primitives: the app already depends on Base UI; shadcn supports both.

## Links

- https://ui.shadcn.com/docs/mcp, https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
