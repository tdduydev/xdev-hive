import { Meter as BaseMeter } from "@base-ui/react/meter";

/** Thanh mức dùng (vd. chi phí so với trần). `label` đọc cho trình đọc màn hình, không hiện ra. */
export function Meter({ value, label }: { value: number; label: string }) {
  return (
    <BaseMeter.Root value={value} aria-label={label}>
      <BaseMeter.Track className="block h-2 overflow-hidden rounded-full bg-muted">
        <BaseMeter.Indicator className="block h-full bg-primary" />
      </BaseMeter.Track>
    </BaseMeter.Root>
  );
}
