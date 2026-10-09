import { Badge, Button, Card, CardContent, CardHeader, Collapsible, CollapsibleContent, CollapsibleTrigger, Input, Label } from "@xdev-hive/ui";
import { ChevronRight } from "lucide-react";

// Ported from pages/Projects.tsx FoldCard: the trigger is the card heading, the chevron turns when open.
function FoldCard({ title, configured, open }: { title: string; configured: boolean; open: boolean }) {
  return (
    <Card>
      <Collapsible defaultOpen={open} className="flex flex-col gap-3">
        <CardHeader>
          <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
            <span className="min-w-0 flex-1 type-heading-sm text-fg-strong">{title}</span>
            <Badge tone={configured ? "green" : "warning"}>{configured ? "Đã cấu hình" : "Chưa cấu hình"}</Badge>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`cl-url-${title}`}>URL GitLab</Label>
              <Input id={`cl-url-${title}`} defaultValue="https://gitlab.com" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`cl-proj-${title}`}>GitLab project của customer-ai</Label>
              <Input id={`cl-proj-${title}`} placeholder="Tự đọc từ remote (hoặc group/project)" />
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

export function FoldCardOpen() {
  return (
    <div className="max-w-xl p-4">
      <FoldCard title="GitLab" configured open />
    </div>
  );
}

// Closed, the heading alone still says what is left to do.
export function FoldCardClosed() {
  return (
    <div className="flex max-w-xl flex-col gap-3 p-4">
      <FoldCard title="GitHub" configured={false} open={false} />
      <FoldCard title="Jira" configured={false} open={false} />
    </div>
  );
}

// A run's raw log folded under a ghost button (asChild keeps the Button styles).
export function RunLog() {
  return (
    <div className="max-w-xl p-4">
      <Collapsible defaultOpen className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="type-body-sm text-fg-secondary">R-73a · claude-1 · xong sau 18 phút</span>
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="xs" className="group">
              <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />Log thô
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <pre className="m-0 overflow-x-auto rounded-md border border-line-subtle bg-surface p-3 font-mono text-xs text-fg-secondary">
{`$ npm run typecheck
> tsc -b packages/core packages/mcp packages/ui
$ npm test
 ✓ packages/core (412 tests) 8.4s
 ✓ packages/ui (186 tests) 5.1s
git push origin ai/R-73a → 3f9c2e1`}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// The light disclosure inside a form, for options most people do not need.
export function Disclosure() {
  return (
    <div className="flex max-w-sm flex-col gap-3 p-4">
      <Button variant="solid" size="sm">Đăng nhập SSO (OpenID Connect)</Button>
      <Collapsible defaultOpen className="flex flex-col gap-3">
        <CollapsibleTrigger className="group flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
          Cách khác
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cl-token">Token truy cập</Label>
            <Input id="cl-token" type="password" placeholder="hive_…" />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
