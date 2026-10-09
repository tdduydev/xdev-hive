import { Skeleton } from "@xdev-hive/ui";

// Holds the place of a machine card while the hub answers.
export function MachineCardLoading() {
  return (
    <div className="p-4">
      <div role="status" aria-label="Đang tải" className="flex max-w-sm flex-col gap-4 rounded-lg border border-line-default bg-surface p-4">
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-28" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}

// The run table's body while loading: same row height, column widths kept.
export function TableRowsLoading() {
  return (
    <div className="p-4">
      <div role="status" aria-label="Đang tải lượt chạy" className="flex max-w-2xl flex-col rounded-lg border border-line-default bg-surface">
        <div className="flex items-center gap-4 border-b border-line-subtle bg-sunken px-3 py-2.5 type-caption text-fg-muted">
          <span className="w-16">Lượt</span>
          <span className="flex-1">Task</span>
          <span className="w-24">Gói</span>
          <span className="w-20 text-right">Thời gian</span>
        </div>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-4 border-b border-line-subtle px-3 py-3 last:border-b-0">
            <Skeleton className="h-3.5 w-16" />
            <div className="flex-1"><Skeleton className="h-3.5 w-2/3" /></div>
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3.5 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function Block() {
  return (
    <div className="flex max-w-xl flex-col gap-3 p-4">
      <Skeleton role="status" aria-label="Đang tải quota" className="h-48 rounded-lg" />
      <div className="grid grid-cols-3 gap-3">
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
      </div>
    </div>
  );
}
