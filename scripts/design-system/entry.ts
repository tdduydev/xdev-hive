// What window.XdevHive exposes. Names stay unique across files: common.tsx's Badge becomes StatusBadge, and the
// cosmic Switch of primitives.tsx stands in for the Radix one (the cosmic pages use it).
export { Button } from "@xdev-hive/ui-kit/components/ui/button";
export { Toggle } from "@xdev-hive/ui-kit/components/ui/toggle";
export { ToggleGroup, ToggleGroupItem } from "@xdev-hive/ui-kit/components/ui/toggle-group";
export { Badge } from "@xdev-hive/ui-kit/components/ui/badge";
export { Badge as StatusBadge, StatusDot, Notice, ErrorNote, Empty, PageHeader } from "@xdev-hive/ui-kit/components/common";
export { Tag, Switch, SegmentedTabs, StatTile, ListRow, EmptyState } from "@xdev-hive/ui-kit/components/ui/primitives";
export { Alert, AlertTitle, AlertDescription } from "@xdev-hive/ui-kit/components/ui/alert";
export { Skeleton } from "@xdev-hive/ui-kit/components/ui/skeleton";
export { Input } from "@xdev-hive/ui-kit/components/ui/input";
export { Textarea } from "@xdev-hive/ui-kit/components/ui/textarea";
export { Label } from "@xdev-hive/ui-kit/components/ui/label";
export { Checkbox } from "@xdev-hive/ui-kit/components/ui/checkbox";
export * from "@xdev-hive/ui-kit/components/ui/native-select";
export * from "@xdev-hive/ui-kit/components/ui/select";
export * from "@xdev-hive/ui-kit/components/ui/tabs";
export { PageTabs } from "@xdev-hive/ui-kit/components/PageTabs";
export * from "@xdev-hive/ui-kit/components/ui/card";
export { Separator } from "@xdev-hive/ui-kit/components/ui/separator";
export * from "@xdev-hive/ui-kit/components/ui/table";
export * from "@xdev-hive/ui-kit/components/ui/dialog";
export * from "@xdev-hive/ui-kit/components/ui/alert-dialog";
export * from "@xdev-hive/ui-kit/components/ui/popover";
export * from "@xdev-hive/ui-kit/components/ui/dropdown-menu";
export * from "@xdev-hive/ui-kit/components/ui/tooltip";
export * from "@xdev-hive/ui-kit/components/ui/sheet";
export { I18nProvider } from "@xdev-hive/ui-kit/i18n/index.tsx";
// The previews need a few icons; the app imports lucide-react itself.
export * as Icons from "./icons.ts";
