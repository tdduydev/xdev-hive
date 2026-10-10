import { Button, Card, CardContent, CardHeader, CardTitle, ErrorNote, Input, Label } from "@xdev-hive/ui";

export function ActionFailed() {
  return (
    <div className="max-w-xl p-4">
      <ErrorNote error="Không giao được task: máy linux-runner đang hết quota." />
    </div>
  );
}

// whitespace-pre-wrap keeps the line breaks of a raw error.
export function MultiLine() {
  return (
    <div className="max-w-xl p-4">
      <ErrorNote
        error={"git push origin ai/R-73a thất bại:\n ! [rejected]  ai/R-73a -> ai/R-73a (non-fast-forward)\nerror: failed to push some refs\nhint: Updates were rejected because the tip of your current branch is behind"}
      />
    </div>
  );
}

// It renders nothing for an empty error, so it can sit above a form's fields permanently.
export function AboveForm() {
  return (
    <div className="max-w-sm p-4">
      <Card>
        <CardHeader>
          <CardTitle>Kết nối hub</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ErrorNote error="fetch failed: connect ECONNREFUSED 192.0.2.52:7780" />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="en-hub">Địa chỉ hub</Label>
            <Input id="en-hub" defaultValue="http://192.0.2.52:7780" />
          </div>
          <Button variant="solid" size="sm">Thử lại</Button>
        </CardContent>
      </Card>
    </div>
  );
}
