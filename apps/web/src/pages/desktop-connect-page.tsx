import { useMutation, useQuery } from "@tanstack/react-query";
import { connectState, loopbackPort, pkceChallenge } from "@xdev-hive/contracts";
import { machineId } from "@xdev-hive/contracts/worker-protocol";
import { useId, useState } from "react";
import { Brand } from "@/components/icons.tsx";
import { OutsideLayout } from "@/components/outside/outside-layout.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { NativeSelect } from "@/components/ui/native-select.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { orgStore, pickOrg } from "@/lib/org-store.ts";
import { orgsMineQuery } from "@/lib/orgs.ts";
import { orgApi } from "@/lib/rpc.ts";

const text: Dict<{
  title: string;
  body: (machine: string) => string;
  bullets: [string, string];
  org: string;
  team: string;
  noTeam: string;
  noOrg: string;
  bad: string;
  deny: string;
  allow: string;
  allowing: string;
  denied: string;
  done: string;
}> = {
  vi: {
    title: "Kết nối app xDev Hive trên máy này?",
    body: (machine) =>
      `App desktop trên máy ${machine} sẽ được đăng ký vào đội bạn chọn và đăng nhập bằng tài khoản của bạn.`,
    bullets: [
      "Worker trên máy nhận việc của đội và chạy bằng CLI đã đăng nhập sẵn trên máy.",
      "App gọi hub thay bạn bằng token cá nhân (hạn 90 ngày, thu hồi được ở MCP và công cụ → Token MCP).",
    ],
    org: "Tổ chức",
    team: "Đội",
    noTeam: "Bạn chưa là quản trị đội nào trong tổ chức này nên chưa đăng ký máy được. Nhờ quản trị đội cấp quyền.",
    noOrg: "Bạn chưa thuộc tổ chức nào. Nhận lời mời vào tổ chức trước rồi đăng nhập lại từ app.",
    bad: "Liên kết đăng nhập không hợp lệ. Mở lại app xDev Hive rồi bấm Đăng nhập bằng trình duyệt.",
    deny: "Từ chối",
    allow: "Cho phép",
    allowing: "Đang cho phép…",
    denied: "Đã từ chối. Bạn có thể đóng tab này.",
    done: "Đã cho phép. Quay lại app xDev Hive để hoàn tất.",
  },
  en: {
    title: "Connect the xDev Hive app on this machine?",
    body: (machine) => `The desktop app on ${machine} will be registered to the team you pick and signed in as you.`,
    bullets: [
      "The worker on this machine takes the team's tasks and runs them with the CLIs already signed in there.",
      "The app calls the hub as you with a personal token (90 days, revocable under MCP & tools → MCP tokens).",
    ],
    org: "Organization",
    team: "Team",
    noTeam: "You are not a team admin in this organization, so you cannot register machines yet. Ask a team admin.",
    noOrg: "You are not in any organization yet. Accept an invitation first, then sign in again from the app.",
    bad: "This sign-in link is not valid. Open the xDev Hive app again and press Sign in with browser.",
    deny: "Deny",
    allow: "Allow",
    allowing: "Allowing…",
    denied: "Denied. You can close this tab.",
    done: "Allowed. Go back to the xDev Hive app to finish.",
  },
};

/** Tham số app gửi kèm; sai bất cứ cái nào thì không cho phép, vì chuyển về địa chỉ khác là lộ mã. */
function readParams() {
  const q = new URLSearchParams(window.location.search);
  const port = loopbackPort.safeParse(q.get("port"));
  const state = connectState.safeParse(q.get("state"));
  const challenge = pkceChallenge.safeParse(q.get("challenge"));
  const machine = machineId.safeParse(q.get("machine"));
  if (!port.success || !state.success || !challenge.success || !machine.success) return null;
  return { port: port.data, state: state.data, challenge: challenge.data, machine: machine.data };
}

/**
 * Trang đồng ý của đăng nhập app desktop bằng trình duyệt (contracts/desktop-connect.ts). Người dùng đã đăng nhập
 * (router đưa qua /login nếu chưa), chọn đội rồi bấm Cho phép; hub trả địa chỉ 127.0.0.1 của app kèm mã đổi.
 */
export function DesktopConnectPage() {
  const t = useT(text);
  const fieldId = useId();
  const [params] = useState(readParams);
  const mine = useQuery(orgsMineQuery);
  const orgs = mine.data?.orgs ?? [];
  const [orgId, setOrgId] = useState<string | null>(null);
  const org = orgs.find((o) => o.id === orgId) ?? pickOrg(orgs, orgStore.get());
  return (
    <OutsideLayout>
      <Card className="grid w-full max-w-110 gap-5 p-6 shadow-lg sm:p-8">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="grid size-11 place-items-center rounded-lg border border-border text-xl">
            ⌘
          </span>
          <span aria-hidden="true" className="w-8 border-t border-dashed border-muted-foreground" />
          <Brand />
        </div>
        <h1 className="mt-1 font-heading text-xl font-semibold text-foreground">{t.title}</h1>
        {!params && <Alert variant="destructive">{t.bad}</Alert>}
        {params && (
          <>
            <p className="text-muted-foreground">{t.body(params.machine)}</p>
            <ul className="grid divide-y divide-border overflow-hidden rounded-lg border border-border">
              {t.bullets.map((b) => (
                <li key={b} className="flex items-start gap-2.5 px-3 py-2.5">
                  <span
                    aria-hidden="true"
                    className="grid size-5 shrink-0 place-items-center rounded-full bg-success-soft text-success"
                  >
                    ✓
                  </span>
                  <span className="min-w-0 break-words">{b}</span>
                </li>
              ))}
            </ul>
            {mine.data && orgs.length === 0 && <Alert>{t.noOrg}</Alert>}
            {orgs.length > 1 && (
              <label htmlFor={`${fieldId}-org`} className="grid gap-1.5 text-sm font-medium">
                {t.org}
                <NativeSelect
                  id={`${fieldId}-org`}
                  value={org?.id ?? ""}
                  onChange={(e) => setOrgId(e.currentTarget.value)}
                >
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            )}
            {org && <Consent key={org.id} orgId={org.id} params={params} />}
          </>
        )}
      </Card>
    </OutsideLayout>
  );
}

function Consent({ orgId, params }: { orgId: string; params: NonNullable<ReturnType<typeof readParams>> }) {
  const t = useT(text);
  const fieldId = useId();
  const api = orgApi(orgId);
  const options = useQuery(api.desktopConnect.options.queryOptions());
  const teams = options.data?.teams ?? [];
  const [teamId, setTeamId] = useState<string | null>(null);
  const team = teams.find((x) => x.id === teamId) ?? teams[0];
  const [answer, setAnswer] = useState<"allowed" | "denied" | null>(null);
  const approve = useMutation({
    mutationFn: (id: string) => api.desktopConnect.approve.call({ teamId: id, ...params }),
    onSuccess: ({ redirectUrl }) => {
      setAnswer("allowed");
      window.location.assign(redirectUrl);
    },
  });

  function deny() {
    setAnswer("denied");
    // Báo app để nó thôi chờ; chỉ có error và state, không có mã.
    const url = new URL(`http://127.0.0.1:${params.port}/callback`);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("state", params.state);
    window.location.assign(url.toString());
  }

  return (
    <>
      {options.isError && <Alert variant="destructive">{apiErrorMessage(options.error)}</Alert>}
      {options.data && teams.length === 0 && <Alert>{t.noTeam}</Alert>}
      {teams.length > 0 && (
        <label htmlFor={`${fieldId}-team`} className="grid gap-1.5 text-sm font-medium">
          {t.team}
          <NativeSelect
            id={`${fieldId}-team`}
            value={team?.id ?? ""}
            onChange={(e) => setTeamId(e.currentTarget.value)}
          >
            {teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </NativeSelect>
        </label>
      )}
      {approve.isError && <Alert variant="destructive">{apiErrorMessage(approve.error)}</Alert>}
      {answer && (
        <p role="status" className="text-sm text-muted-foreground">
          {answer === "allowed" ? t.done : t.denied}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" disabled={approve.isPending || answer !== null} onClick={deny}>
          {t.deny}
        </Button>
        <Button
          disabled={!team || approve.isPending || answer !== null}
          onClick={() => team && approve.mutate(team.id)}
        >
          {approve.isPending ? t.allowing : t.allow}
        </Button>
      </div>
    </>
  );
}
