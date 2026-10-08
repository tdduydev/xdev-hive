import type { ComponentProps, ReactNode } from "react";
import { cn } from "cn";
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";
export function Tag({ tone = "neutral", className, ...props }: ComponentProps<"span"> & { tone?: Tone }) {
  return <span className={cn("cosmic-tag cosmic-tone", className)} data-tone={tone} {...props} />;
}
/** A native checkbox provides switch keyboard and form behavior without duplicating state. */
export function Switch({ children, ...props }: Omit<ComponentProps<"input">, "type">) {
  return <label className="cosmic-switch"><input {...props} type="checkbox" role="switch" /><span>{children}</span></label>;
}
/** Filter tabs use pressed buttons: no tabpanel contract is imposed on consumers. */
export function SegmentedTabs({ label, items, value, onChange }: { label: string; items: { value: string; label: string; disabled?: boolean }[]; value: string; onChange: (value: string) => void }) {
  return <div className="cosmic-segments" role="group" aria-label={label}>{items.map(item => <button key={item.value} type="button" disabled={item.disabled} aria-pressed={value === item.value} onClick={() => onChange(item.value)}>{item.label}</button>)}</div>;
}
export function StatTile({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return <div className="cosmic-stat"><span>{label}</span><strong>{value}</strong>{detail && <span>{detail}</span>}</div>;
}
export function ListRow({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return <div className="cosmic-row"><div><strong>{title}</strong>{description && <p>{description}</p>}</div>{action}</div>;
}
export function EmptyState({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return <div className="cosmic-empty"><strong>{title}</strong>{description && <p>{description}</p>}{action}</div>;
}
// Keep the existing Radix pressed-button Toggle API in ui/toggle; cosmic Toggle is a form switch.
export { Switch as Toggle };
