// window.XdevHive — @xdev-hive/ui-kit components (shadcn/ui on Radix, cosmic styling). Parts of compound
// components (CardHeader, DialogContent, SelectItem…) take the props of the Radix part or HTML element they wrap.
import type { ComponentProps, ReactNode } from "react";

type ButtonVariant = "solid" | "blue" | "glass" | "ghost" | "brand" | "default" | "destructive" | "outline" | "secondary" | "danger-outline" | "link";
type ButtonSize = "sm" | "md" | "lg" | "default" | "xs" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";
export interface ButtonProps extends ComponentProps<"button"> {
  /** solid = the one main action; glass = default secondary; brand = gradient border, max one per screen. */
  variant?: ButtonVariant;
  /** sm 34px, md 46px, lg 54px (cosmic); default 32px. */
  size?: ButtonSize;
  /** Render the styles onto the single child (a link). */
  asChild?: boolean;
}
export declare function Button(props: ButtonProps): JSX.Element;

export interface ToggleProps extends ComponentProps<"button"> {
  pressed?: boolean;
  defaultPressed?: boolean;
  onPressedChange?: (pressed: boolean) => void;
  variant?: "default" | "outline";
  size?: "sm" | "default" | "lg";
}
export declare function Toggle(props: ToggleProps): JSX.Element;

export interface ToggleGroupProps {
  type: "single" | "multiple";
  value?: string | string[];
  defaultValue?: string | string[];
  onValueChange?: (value: any) => void;
  variant?: "default" | "outline";
  size?: "sm" | "default" | "lg";
  children: ReactNode;
}
export declare function ToggleGroup(props: ToggleGroupProps): JSX.Element;
export declare function ToggleGroupItem(props: { value: string; children: ReactNode; disabled?: boolean }): JSX.Element;

export interface BadgeProps extends ComponentProps<"span"> {
  /** Colour of the glowing dot. Always keep the word. */
  tone?: "neutral" | "violet" | "blue" | "green" | "info" | "success" | "warning" | "danger";
  /** Show the dot (default true). */
  dot?: boolean;
  variant?: "default" | "secondary" | "destructive" | "outline" | "ghost" | "link";
  asChild?: boolean;
}
export declare function Badge(props: BadgeProps): JSX.Element;

export interface StatusBadgeProps {
  /** Tinted status fill; STATUS_TONE in common.tsx maps task/run/role states to a tone. */
  tone?: "ok" | "warn" | "info" | "running" | "danger" | "accent" | "neutral";
  className?: string;
  children: ReactNode;
}
export declare function StatusBadge(props: StatusBadgeProps): JSX.Element;

export interface StatusDotProps {
  tone?: "ok" | "running" | "info" | "warn" | "danger" | "neutral";
  className?: string;
}
export declare function StatusDot(props: StatusDotProps): JSX.Element;

export interface TagProps extends ComponentProps<"span"> {
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  active?: boolean;
}
export declare function Tag(props: TagProps): JSX.Element;

export interface NoticeProps extends Omit<ComponentProps<"div">, "title"> {
  tone?: "ok" | "info" | "warn" | "error";
  title?: ReactNode;
}
export declare function Notice(props: NoticeProps): JSX.Element;
export declare function ErrorNote(props: { error: string | null | undefined }): JSX.Element | null;

export interface AlertProps extends ComponentProps<"div"> {
  variant?: "default" | "destructive";
}
export declare function Alert(props: AlertProps): JSX.Element;
export declare function AlertTitle(props: ComponentProps<"div">): JSX.Element;
export declare function AlertDescription(props: ComponentProps<"div">): JSX.Element;

export interface SkeletonProps extends ComponentProps<"div"> {}
export declare function Skeleton(props: SkeletonProps): JSX.Element;

export interface InputProps extends ComponentProps<"input"> {
  /** sm 36px, md 44px (default), lg 52px. */
  controlSize?: "sm" | "md" | "lg";
  /** Leading icon; wraps the input in an input group. */
  icon?: ReactNode;
  /** Trailing content (button, hint). */
  trailing?: ReactNode;
}
export declare function Input(props: InputProps): JSX.Element;

export interface TextareaProps extends ComponentProps<"textarea"> {}
export declare function Textarea(props: TextareaProps): JSX.Element;
export declare function Label(props: ComponentProps<"label">): JSX.Element;

export interface CheckboxProps extends Omit<ComponentProps<"button">, "onChange"> {
  checked?: boolean | "indeterminate";
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean | "indeterminate") => void;
}
export declare function Checkbox(props: CheckboxProps): JSX.Element;

export interface SwitchProps extends Omit<ComponentProps<"input">, "type"> {
  /** The label shown beside the switch. */
  children?: ReactNode;
}
export declare function Switch(props: SwitchProps): JSX.Element;

export interface NativeSelectProps extends ComponentProps<"select"> {}
export declare function NativeSelect(props: NativeSelectProps): JSX.Element;
export declare function NativeSelectOption(props: ComponentProps<"option">): JSX.Element;
export declare function NativeSelectOptGroup(props: ComponentProps<"optgroup">): JSX.Element;

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  disabled?: boolean;
  children: ReactNode;
}
export declare function Select(props: SelectProps): JSX.Element;
export declare function SelectTrigger(props: ComponentProps<"button"> & { size?: "sm" | "default" | "lg" }): JSX.Element;
export declare function SelectValue(props: { placeholder?: ReactNode }): JSX.Element;
export declare function SelectContent(props: { children: ReactNode; position?: "popper" | "item-aligned" }): JSX.Element;
export declare function SelectItem(props: { value: string; children: ReactNode; disabled?: boolean }): JSX.Element;
export declare function SelectGroup(props: { children: ReactNode }): JSX.Element;
export declare function SelectLabel(props: { children: ReactNode }): JSX.Element;
export declare function SelectSeparator(props: {}): JSX.Element;

export interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: "horizontal" | "vertical";
  children: ReactNode;
}
export declare function Tabs(props: TabsProps): JSX.Element;
export declare function TabsList(props: { variant?: "default" | "line"; children: ReactNode }): JSX.Element;
export declare function TabsTrigger(props: { value: string; children: ReactNode; disabled?: boolean }): JSX.Element;
export declare function TabsContent(props: ComponentProps<"div"> & { value: string }): JSX.Element;

export interface SegmentedTabsProps {
  /** Accessible name of the group. */
  label: string;
  items: { value: string; label: string; disabled?: boolean }[];
  value: string;
  onChange: (value: string) => void;
}
export declare function SegmentedTabs(props: SegmentedTabsProps): JSX.Element;

export interface PageTabsProps<T extends string = string> {
  /** Route the tabs link to: #/<page>?tab=<id>. */
  page: string;
  tabs: readonly T[];
  current: T;
  label: string;
  name: (tab: T) => string;
  children: ReactNode;
}
export declare function PageTabs<T extends string>(props: PageTabsProps<T>): JSX.Element;

export interface CardProps extends ComponentProps<"div"> {}
export declare function Card(props: CardProps): JSX.Element;
export declare function CardHeader(props: ComponentProps<"div">): JSX.Element;
export declare function CardTitle(props: ComponentProps<"div">): JSX.Element;
export declare function CardDescription(props: ComponentProps<"div">): JSX.Element;
export declare function CardAction(props: ComponentProps<"div">): JSX.Element;
export declare function CardContent(props: ComponentProps<"div">): JSX.Element;
export declare function CardFooter(props: ComponentProps<"div">): JSX.Element;

export interface StatTileProps {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}
export declare function StatTile(props: StatTileProps): JSX.Element;

export interface ListRowProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}
export declare function ListRow(props: ListRowProps): JSX.Element;

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}
export declare function EmptyState(props: EmptyStateProps): JSX.Element;
export declare function Empty(props: { children: ReactNode }): JSX.Element;

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}
export declare function PageHeader(props: PageHeaderProps): JSX.Element;

export interface TableProps extends ComponentProps<"table"> {}
export declare function Table(props: TableProps): JSX.Element;
export declare function TableHeader(props: ComponentProps<"thead">): JSX.Element;
export declare function TableBody(props: ComponentProps<"tbody">): JSX.Element;
export declare function TableFooter(props: ComponentProps<"tfoot">): JSX.Element;
export declare function TableRow(props: ComponentProps<"tr">): JSX.Element;
export declare function TableHead(props: ComponentProps<"th">): JSX.Element;
export declare function TableCell(props: ComponentProps<"td">): JSX.Element;
export declare function TableCaption(props: ComponentProps<"caption">): JSX.Element;

interface OverlayRoot {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}
export interface DialogProps extends OverlayRoot { modal?: boolean }
export declare function Dialog(props: DialogProps): JSX.Element;
export declare function DialogTrigger(props: ComponentProps<"button"> & { asChild?: boolean }): JSX.Element;
export declare function DialogContent(props: ComponentProps<"div"> & { showCloseButton?: boolean }): JSX.Element;
export declare function DialogHeader(props: ComponentProps<"div">): JSX.Element;
export declare function DialogFooter(props: ComponentProps<"div"> & { showCloseButton?: boolean }): JSX.Element;
export declare function DialogTitle(props: ComponentProps<"h2">): JSX.Element;
export declare function DialogDescription(props: ComponentProps<"p">): JSX.Element;
export declare function DialogClose(props: ComponentProps<"button"> & { asChild?: boolean }): JSX.Element;

export interface AlertDialogProps extends OverlayRoot {}
export declare function AlertDialog(props: AlertDialogProps): JSX.Element;
export declare function AlertDialogTrigger(props: ComponentProps<"button"> & { asChild?: boolean }): JSX.Element;
export declare function AlertDialogContent(props: ComponentProps<"div"> & { size?: "default" | "sm" }): JSX.Element;
export declare function AlertDialogHeader(props: ComponentProps<"div">): JSX.Element;
export declare function AlertDialogFooter(props: ComponentProps<"div">): JSX.Element;
export declare function AlertDialogTitle(props: ComponentProps<"h2">): JSX.Element;
export declare function AlertDialogDescription(props: ComponentProps<"p">): JSX.Element;
export declare function AlertDialogAction(props: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }): JSX.Element;
export declare function AlertDialogCancel(props: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }): JSX.Element;

export interface PopoverProps extends OverlayRoot { modal?: boolean }
export declare function Popover(props: PopoverProps): JSX.Element;
export declare function PopoverTrigger(props: ComponentProps<"button"> & { asChild?: boolean }): JSX.Element;
export declare function PopoverContent(props: ComponentProps<"div"> & { align?: "start" | "center" | "end"; side?: "top" | "right" | "bottom" | "left"; sideOffset?: number }): JSX.Element;
export declare function PopoverHeader(props: ComponentProps<"div">): JSX.Element;
export declare function PopoverTitle(props: ComponentProps<"h2">): JSX.Element;
export declare function PopoverDescription(props: ComponentProps<"p">): JSX.Element;

export interface DropdownMenuProps extends OverlayRoot { modal?: boolean }
export declare function DropdownMenu(props: DropdownMenuProps): JSX.Element;
export declare function DropdownMenuTrigger(props: ComponentProps<"button"> & { asChild?: boolean }): JSX.Element;
export declare function DropdownMenuContent(props: ComponentProps<"div"> & { align?: "start" | "center" | "end"; sideOffset?: number }): JSX.Element;
export declare function DropdownMenuItem(props: ComponentProps<"div"> & { variant?: "default" | "destructive"; inset?: boolean; onSelect?: (e: Event) => void }): JSX.Element;
export declare function DropdownMenuLabel(props: ComponentProps<"div"> & { inset?: boolean }): JSX.Element;
export declare function DropdownMenuSeparator(props: ComponentProps<"div">): JSX.Element;
export declare function DropdownMenuShortcut(props: ComponentProps<"span">): JSX.Element;

export interface TooltipProps extends OverlayRoot { delayDuration?: number }
/** Needs a TooltipProvider above it (mount one near the app root). */
export declare function Tooltip(props: TooltipProps): JSX.Element;
export declare function TooltipProvider(props: { delayDuration?: number; children: ReactNode }): JSX.Element;
export declare function TooltipTrigger(props: ComponentProps<"button"> & { asChild?: boolean }): JSX.Element;
export declare function TooltipContent(props: ComponentProps<"div"> & { side?: "top" | "right" | "bottom" | "left"; sideOffset?: number }): JSX.Element;

export interface SheetProps extends OverlayRoot {}
export declare function Sheet(props: SheetProps): JSX.Element;
export declare function SheetTrigger(props: ComponentProps<"button"> & { asChild?: boolean }): JSX.Element;
export declare function SheetContent(props: ComponentProps<"div"> & { side?: "top" | "right" | "bottom" | "left"; showCloseButton?: boolean }): JSX.Element;
export declare function SheetHeader(props: ComponentProps<"div">): JSX.Element;
export declare function SheetFooter(props: ComponentProps<"div">): JSX.Element;
export declare function SheetTitle(props: ComponentProps<"h2">): JSX.Element;
export declare function SheetDescription(props: ComponentProps<"p">): JSX.Element;

/** Wraps the app so useT() follows the chosen locale (vi default, en). Components work without it. */
export declare function I18nProvider(props: { children: ReactNode; onChange?: (locale: "vi" | "en") => void }): JSX.Element;

/** A few Lucide icons the previews use; in the app import from lucide-react directly. */
export declare const Icons: Record<"Plus" | "Play" | "Search" | "Trash2" | "Check" | "ChevronDown" | "Settings" | "Bot" | "GitBranch" | "MoreHorizontal" | "Filter" | "Bold" | "Italic" | "Underline" | "Inbox" | "X" | "CircleCheck" | "Info", (props: ComponentProps<"svg"> & { size?: number; strokeWidth?: number }) => JSX.Element>;
