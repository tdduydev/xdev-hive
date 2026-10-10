import { Card, CardDescription, CardHeader, CardTitle, HiveWordmark } from "@xdev-hive/ui";

// 24 is the minimum the component allows (below that use XMark); 30 is the sidebar, 48 a sign-in screen.
export function Sizes() {
  return (
    <div className="flex items-end gap-6 p-4">
      {[24, 30, 48].map((h) => (
        <div key={h} className="flex flex-col items-start gap-2">
          <HiveWordmark height={h} />
          <span className="font-mono text-xs text-fg-muted">height={h}</span>
        </div>
      ))}
    </div>
  );
}

// Ported from Login.tsx: the wordmark is the card title.
export function SignInHeader() {
  return (
    <div className="max-w-sm p-4">
      <Card>
        <CardHeader>
          <CardTitle><HiveWordmark height={44} /></CardTitle>
          <CardDescription>Tài liệu, memory và task dùng chung cho các coding agent của team.</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
