---
category: Navigation
---
# PageTabs

The tab bar of one menu entry (Cài đặt dự án, Máy & agent, Quản trị). Each tab is a link to `#/<page>?tab=<id>`, so a tab has an address to share and Back returns to the previous tab. With a single tab the bar is hidden.

**Key props**: `page` (the route), `tabs` (ids), `current`, `name(tab)` (its label), `label` (the nav's accessible name), `children` (the current tab's content).

```tsx
<PageTabs page="settings" tabs={["general", "agents", "members"]} current="agents" label="Cài đặt dự án"
  name={(t) => ({ general: "Chung", agents: "Agent", members: "Thành viên" })[t]}>
  <Page>…</Page>
</PageTabs>
```
