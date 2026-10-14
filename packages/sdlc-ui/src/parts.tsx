import type { ReactNode } from "react";

/** Trạng thái rỗng chung của các màn AI SDLC: tiêu đề, một câu giải thích, thao tác kế tiếp nếu có. */
export function EmptyState({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border p-8 text-center">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="max-w-prose text-sm text-muted-foreground">{text}</p>
      {children}
    </div>
  );
}
