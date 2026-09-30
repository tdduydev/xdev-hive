import { useState } from "react";
import { Laptop } from "lucide-react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { ErrorNote, Notice, Page } from "#ui/components/common.tsx";
import { useAction, useHive } from "#ui/hooks.ts";
import { rich, useT } from "#ui/i18n/index.tsx";

/** What the desktop app put in the link: where it listens on this machine and its PKCE challenge. */
function readRequest(): { port: number; state: string; challenge: string; name: string } | null {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const port = Number(params.get("port"));
  const state = params.get("state") ?? "";
  const challenge = params.get("challenge") ?? "";
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[\w-]{16,128}$/.test(state) || !/^[\w-]{43}$/.test(challenge)) return null;
  return { port, state, challenge, name: (params.get("name") ?? "").replace(/[^\w.-]/g, "-").slice(0, 60) || "desktop" };
}

/** The desktop app sends people here to sign it in to the hub with their account (SSO or password). */
export function DevicePage() {
  const { client, me } = useHive();
  const t = useT();
  const [request] = useState(readRequest);
  const [done, setDone] = useState<"allowed" | "denied" | null>(null);
  const action = useAction();

  if (!request || !client.device) {
    return (
      <Page>
        <Notice tone="warn">{t("device.badLink")}</Notice>
      </Page>
    );
  }
  const back = (params: Record<string, string>) =>
    window.location.assign(`http://127.0.0.1:${request.port}/callback?${new URLSearchParams(params).toString()}`);

  return (
    <Page>
      <Card className="mx-auto w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Laptop className="size-5" />
            {t("device.title")}
          </CardTitle>
          <CardDescription>
            {rich(t("device.question"), {
              machine: <code className="rounded bg-muted px-1 font-mono text-xs">{request.name}</code>,
              account: <b className="text-foreground">@{me.user?.username ?? me.name}</b>,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p>{t("device.explain")}</p>
          {done === "allowed" ? <Notice tone="ok">{t("device.allowed")}</Notice> : null}
          {done === "denied" ? <Notice tone="info">{t("device.denied")}</Notice> : null}
          <ErrorNote error={action.error} />
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button
            disabled={action.busy || done !== null}
            onClick={() =>
              void action.run(async () => {
                const { url } = await client.device!.authorize(request);
                setDone("allowed");
                window.location.assign(url);
              })
            }
          >
            {t("device.allow")}
          </Button>
          <Button
            variant="outline"
            disabled={action.busy || done !== null}
            onClick={() => {
              setDone("denied");
              back({ error: "denied", state: request.state });
            }}
          >
            {t("device.deny")}
          </Button>
        </CardFooter>
      </Card>
    </Page>
  );
}
