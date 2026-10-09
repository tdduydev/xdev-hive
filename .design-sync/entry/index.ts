// What claude.ai/design gets from @xdev-hive/ui: the reusable components that render without hub data or a
// HiveClient. The package itself ships source only, so .design-sync/build.mjs builds this file into .design-sync/dist/.
// Where two files export the same name, the shadcn one in components/ui keeps it and the other is aliased (NOTES.md).

// shadcn/ui primitives (components/ui), every export.
export * from "@xdev-hive/ui/components/ui/alert-dialog";
export * from "@xdev-hive/ui/components/ui/alert";
export * from "@xdev-hive/ui/components/ui/badge";
export * from "@xdev-hive/ui/components/ui/button";
export * from "@xdev-hive/ui/components/ui/card";
export * from "@xdev-hive/ui/components/ui/checkbox";
export * from "@xdev-hive/ui/components/ui/collapsible";
export * from "@xdev-hive/ui/components/ui/dialog";
export * from "@xdev-hive/ui/components/ui/dropdown-menu";
export * from "@xdev-hive/ui/components/ui/input";
export * from "@xdev-hive/ui/components/ui/label";
export * from "@xdev-hive/ui/components/ui/native-select";
export * from "@xdev-hive/ui/components/ui/popover";
export * from "@xdev-hive/ui/components/ui/scroll-area";
export * from "@xdev-hive/ui/components/ui/select";
export * from "@xdev-hive/ui/components/ui/separator";
export * from "@xdev-hive/ui/components/ui/sheet";
export * from "@xdev-hive/ui/components/ui/sidebar";
export * from "@xdev-hive/ui/components/ui/skeleton";
export * from "@xdev-hive/ui/components/ui/switch";
export * from "@xdev-hive/ui/components/ui/table";
export * from "@xdev-hive/ui/components/ui/tabs";
export * from "@xdev-hive/ui/components/ui/textarea";
export * from "@xdev-hive/ui/components/ui/toggle-group";
export * from "@xdev-hive/ui/components/ui/toggle";
export * from "@xdev-hive/ui/components/ui/tooltip";

// Cosmic primitives (roadmap 72). Their Switch collides with ui/switch; their Toggle is the same function as that
// Switch, so it is left out rather than shipped twice.
export {
  Tag,
  Switch as PrimitiveSwitch,
  SegmentedTabs,
  StatTile,
  ListRow,
  EmptyState,
  type Tone,
} from "@xdev-hive/ui/components/ui/primitives";

// Page building blocks (components/common.tsx). Its Badge collides with ui/badge.
export {
  Badge as CommonBadge,
  ErrorNote,
  OwnerBadge,
  Notice,
  StatusDot,
  Empty,
  PageIntro,
  PageHeader,
  Page,
  STATUS_TONE,
} from "@xdev-hive/ui/components/common";

export { PageTabs } from "@xdev-hive/ui/components/PageTabs";
export {
  DataTable,
  type Column as DataTableColumn,
  type Filter as DataTableFilter,
  type Bulk as DataTableBulk,
} from "@xdev-hive/ui/components/DataTable";
export {
  ResponsiveTable,
  ResponsiveTableRow,
  ResponsiveTableFrame,
  ResponsiveCellLabel,
  ResponsiveGridRow,
} from "@xdev-hive/ui/components/ResponsiveTable";
export { SummaryStrip, type SummaryItem } from "@xdev-hive/ui/components/SummaryStrip";
export { HiveWordmark, XMark } from "@xdev-hive/ui/components/Brand";

// The preview/design theme root (cfg.provider).
export { HiveTheme, type HiveThemeName, type HiveThemeProps } from "./HiveTheme.tsx";
