import { useState } from "react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { ErrorNote, HiveLogo } from "./components/common.tsx";
import { useSystemTheme } from "./lib/theme.ts";

export function Login({ onSubmit, error }: { onSubmit: (token: string) => void; error?: string | null }) {
  useSystemTheme();
  const [token, setToken] = useState("");
  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) onSubmit(token.trim());
          }}
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <HiveLogo size={26} />
              xDev Hive
            </CardTitle>
            <CardDescription>Quản trị tài liệu, memory và task dùng chung cho các coding agent.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Label htmlFor="token">Token truy cập</Label>
            <Input
              id="token"
              className="font-mono"
              type="password"
              autoComplete="off"
              placeholder="hive_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoFocus
            />
            <ErrorNote error={error} />
          </CardContent>
          <CardFooter className="flex flex-col items-stretch gap-3">
            <Button type="submit" disabled={!token.trim()}>
              Vào
            </Button>
            <p className="text-xs text-muted-foreground">Lần chạy đầu, hub in token admin ra console. Admin tạo thêm token ở trang Token.</p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
