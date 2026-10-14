import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ChatBot,
  type ChatBotKind,
  type ChatLink,
  type ChatSettings,
  chatBotCreateInput,
} from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { type FormEvent, useId, useState } from "react";
import { Card } from "@/components/ui/card.tsx";
import { Field, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { EmptyState, LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { NOTIFICATION_EVENT_LABEL, NOTIFICATION_EVENTS } from "@/lib/notification-channels.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { useOrg } from "@/shell/org-context.ts";

const KIND_LABEL: Record<ChatBotKind, string> = { telegram: "Telegram", slack: "Slack" };

/** Mục "Chat (Telegram, Slack)": quản trị thấy bot và cài đặt; mọi thành viên thấy liên kết của mình. */
export function ChatSection() {
  const { org } = useOrg();
  return (
    <section aria-label="Chat Telegram và Slack" className="grid min-w-0 gap-3">
      <h2 className="text-base font-semibold text-foreground">Chat (Telegram, Slack)</h2>
      <MyLinks key={`links-${org.id}`} />
      {isOrgAdmin(org.role) && (
        <>
          <Bots key={`bots-${org.id}`} />
          <Settings key={`settings-${org.id}`} />
        </>
      )}
    </section>
  );
}

function MyLinks() {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const links = useQuery(api.chat.links.list.queryOptions());
  const available = useQuery(api.chat.links.available.queryOptions());
  const [botId, setBotId] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.chat.links.list.key() });
  const selected = botId || available.data?.[0]?.id || "";
  const code = useMutation({ mutationFn: () => api.chat.links.createCode.call({ botId: selected }) });
  const botSelectId = useId();
  return (
    <Card className="grid min-w-0 gap-3 p-4">
      <h3 className="text-sm font-semibold text-foreground">Tài khoản chat của tôi</h3>
      <p className="text-muted-foreground">
        Liên kết Telegram hoặc Slack để nhận thông báo cần xử lý và trò chuyện với Leader. Lệnh và nút bấm không tốn
        lượt Leader.
      </p>
      {links.isPending ? (
        <LoadingState label="Đang tải liên kết chat…" />
      ) : links.isError ? (
        <LoadFailure error={links.error} retry={links.refetch} />
      ) : links.data.length === 0 ? (
        <EmptyState title="Chưa liên kết chat" description="Tạo mã một lần rồi gửi cho bot để liên kết." />
      ) : (
        <ul aria-label="Liên kết chat" className="grid gap-3">
          {links.data.map((link) => (
            <LinkRow key={link.id} link={link} refresh={refresh} />
          ))}
        </ul>
      )}
      {available.isSuccess &&
        (available.data.length === 0 ? (
          <p className="text-muted-foreground">Tổ chức chưa bật bot chat nào. Liên hệ quản trị để cấu hình.</p>
        ) : (
          <div className="grid gap-2">
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1.5">
                <label htmlFor={botSelectId} className="text-sm font-medium text-foreground">
                  Bot cần liên kết
                </label>
                <NativeSelect id={botSelectId} value={selected} onChange={(event) => setBotId(event.target.value)}>
                  {available.data.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {KIND_LABEL[bot.kind]} · {bot.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <Button variant="default" disabled={code.isPending || !selected} onClick={() => code.mutate()}>
                {code.isPending ? "Đang tạo…" : "Tạo mã liên kết"}
              </Button>
            </div>
            {code.isError && <Alert variant="destructive">{apiErrorMessage(code.error)}</Alert>}
            {code.data && (
              <div role="status" className="grid gap-1 rounded-lg border border-border p-3">
                <p>
                  Gửi lệnh này cho bot trong chat riêng:{" "}
                  <code className="break-all font-mono">{code.data.command}</code>
                </p>
                <p className="text-xs text-muted-foreground">
                  Mã dùng một lần, hết hạn lúc {new Date(code.data.expiresAt).toLocaleString("vi-VN")}.
                </p>
              </div>
            )}
          </div>
        ))}
    </Card>
  );
}

function LinkRow({ link, refresh }: { link: ChatLink; refresh: () => Promise<unknown> }) {
  const { api } = useOrg();
  const [events, setEvents] = useState<string[]>(link.events);
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({
    mutationFn: () => api.chat.links.update.call({ id: link.id, events: events as ChatLink["events"] }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.chat.links.remove.call({ id: link.id }),
    onSuccess: async () => {
      setConfirming(false);
      await refresh();
    },
  });
  const toggle = (event: string, on: boolean) =>
    setEvents((current) => (on ? [...current, event] : current.filter((item) => item !== event)));
  return (
    <li className="grid min-w-0 gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="break-all font-semibold text-foreground">
          {KIND_LABEL[link.kind]} · {link.botName}{" "}
          <span className="font-normal text-muted-foreground">({link.label})</span>
        </p>
        <Button variant="destructive" size="sm" onClick={() => setConfirming(true)} aria-label={`Tách ${link.label}`}>
          Tách liên kết
        </Button>
      </div>
      <fieldset className="grid gap-1.5" aria-label={`Sự kiện nhận qua ${link.label}`}>
        <legend className="text-sm font-medium text-foreground">Sự kiện nhận</legend>
        {NOTIFICATION_EVENTS.map((event) => (
          <label key={event} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={events.includes(event)}
              onChange={(change) => toggle(event, change.target.checked)}
            />
            {NOTIFICATION_EVENT_LABEL[event]}
          </label>
        ))}
      </fieldset>
      {save.isError && <Alert variant="destructive">{apiErrorMessage(save.error)}</Alert>}
      <div>
        <Button variant="outline" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Đang lưu…" : "Lưu sự kiện"}
        </Button>
      </div>
      <Dialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <DialogContent>
          <DialogTitle>Tách tài khoản chat?</DialogTitle>
          <DialogDescription>
            Bạn sẽ ngừng nhận thông báo và không dùng được lệnh qua “{link.label}”. Muốn dùng lại phải liên kết bằng mã
            mới.
          </DialogDescription>
          {remove.isError && <Alert variant="destructive">{apiErrorMessage(remove.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={remove.isPending}>
              Huỷ
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? "Đang tách…" : "Tách liên kết"}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </li>
  );
}

function Bots() {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const bots = useQuery(api.chat.bots.list.queryOptions());
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ChatBot | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.chat.bots.list.key() });
  return (
    <Card className="grid min-w-0 gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">Bot chat của tổ chức</h3>
        <Button variant="default" onClick={() => setAdding(true)}>
          Thêm bot
        </Button>
      </div>
      {bots.isPending ? (
        <LoadingState label="Đang tải bot chat…" />
      ) : bots.isError ? (
        <LoadFailure error={bots.error} retry={bots.refetch} />
      ) : bots.data.length === 0 ? (
        <EmptyState
          title="Chưa có bot chat"
          description="Thêm bot Telegram hoặc Slack app để thành viên nhận thông báo và gọi Leader qua chat."
        />
      ) : (
        <ul aria-label="Bot chat" className="grid gap-3">
          {bots.data.map((bot) => (
            <BotRow key={bot.id} bot={bot} refresh={refresh} onRemove={() => setRemoving(bot)} />
          ))}
        </ul>
      )}
      <Dialog open={adding} onOpenChange={(open) => !open && setAdding(false)}>
        <DialogContent>
          {adding && (
            <BotForm
              onCancel={() => setAdding(false)}
              onDone={async () => {
                setAdding(false);
                await refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          {removing && (
            <RemoveBot
              bot={removing}
              onCancel={() => setRemoving(null)}
              onDone={async () => {
                setRemoving(null);
                await refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function BotRow({ bot, refresh, onRemove }: { bot: ChatBot; refresh: () => Promise<unknown>; onRemove: () => void }) {
  const { api } = useOrg();
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const toggle = useMutation({
    mutationFn: () => api.chat.bots.update.call({ id: bot.id, enabled: !bot.enabled }),
    onSuccess: refresh,
  });
  const test = useMutation({ mutationFn: () => api.chat.bots.test.call({ id: bot.id }), onSuccess: setNotice });
  const busy = toggle.isPending || test.isPending;
  return (
    <li className="grid min-w-0 gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="break-all font-semibold text-foreground">
            {KIND_LABEL[bot.kind]} · {bot.name}
          </p>
          <p className="break-all text-xs text-muted-foreground">{bot.target}</p>
        </div>
        <Pill tone={bot.enabled ? "ok" : "neutral"}>{bot.enabled ? "Đang bật" : "Đã tắt"}</Pill>
      </div>
      {bot.webhooks.length > 0 && (
        <dl className="grid gap-1 text-xs">
          {bot.webhooks.map((hook) => (
            <div key={hook.label} className="grid gap-0.5">
              <dt className="text-muted-foreground">{hook.label}</dt>
              <dd className="break-all font-mono">{hook.url}</dd>
            </div>
          ))}
        </dl>
      )}
      {notice &&
        (notice.ok ? (
          <p role="status" className="break-words text-success">
            {notice.message}
          </p>
        ) : (
          <Alert variant="destructive">{notice.message}</Alert>
        ))}
      {(toggle.isError || test.isError) && (
        <Alert variant="destructive">{apiErrorMessage(toggle.error ?? test.error)}</Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          aria-label={`${bot.enabled ? "Tắt" : "Bật"} bot ${bot.name}`}
          onClick={() => {
            setNotice(null);
            toggle.mutate();
          }}
        >
          {bot.enabled ? "Tắt" : "Bật"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          aria-label={`Kiểm tra bot ${bot.name}`}
          onClick={() => {
            setNotice(null);
            test.mutate();
          }}
        >
          {test.isPending ? "Đang kiểm tra…" : "Kiểm tra kết nối"}
        </Button>
        <Button variant="destructive" size="sm" disabled={busy} aria-label={`Xoá bot ${bot.name}`} onClick={onRemove}>
          Xoá
        </Button>
      </div>
    </li>
  );
}

function BotForm({ onDone, onCancel }: { onDone: () => Promise<unknown>; onCancel: () => void }) {
  const { api } = useOrg();
  const [kind, setKind] = useState<ChatBotKind>("telegram");
  const [failure, setFailure] = useState<string | null>(null);
  const kindId = useId();
  const mutation = useMutation({
    mutationFn: (input: ReturnType<typeof chatBotCreateInput.parse>) => api.chat.bots.create.call(input),
    onSuccess: onDone,
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    mutation.reset();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? "");
    const parsed = chatBotCreateInput.safeParse({
      name: value("name"),
      enabled: form.has("enabled"),
      config:
        kind === "telegram"
          ? { kind, botToken: value("botToken") }
          : { kind, botToken: value("botToken"), signingSecret: value("signingSecret") },
    });
    if (!parsed.success) {
      setFailure(parsed.error.issues[0]?.message ?? "Kiểm tra lại các trường đã nhập.");
      return;
    }
    mutation.mutate(parsed.data);
  }
  return (
    <form noValidate className="grid min-w-0 gap-3.5" onSubmit={submit}>
      <DialogTitle>Thêm bot chat</DialogTitle>
      <DialogDescription>
        Token được mã hoá khi lưu và không hiển thị lại. Với Slack, dán URL webhook mà hub hiện sau khi lưu vào Slack
        app.
      </DialogDescription>
      <fieldset disabled={mutation.isPending} className="grid min-w-0 gap-3.5">
        <Field>
          <FieldLabel>Tên bot</FieldLabel>
          <Input name="name" maxLength={80} autoFocus />
        </Field>
        <div className="grid gap-1.5">
          <label htmlFor={kindId} className="text-sm font-medium text-foreground">
            Loại bot
          </label>
          <NativeSelect id={kindId} value={kind} onChange={(event) => setKind(event.target.value as ChatBotKind)}>
            <option value="telegram">Telegram</option>
            <option value="slack">Slack</option>
          </NativeSelect>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="enabled" defaultChecked />
          Bật bot
        </label>
        <div key={kind} className="grid min-w-0 gap-3.5">
          <Field>
            <FieldLabel>{kind === "telegram" ? "Token bot Telegram" : "Bot token Slack"}</FieldLabel>
            <Input name="botToken" type="password" autoComplete="new-password" />
            <FieldHint>
              {kind === "telegram" ? "Lấy từ BotFather." : "Bot User OAuth Token, bắt đầu bằng xoxb-."}
            </FieldHint>
          </Field>
          {kind === "slack" && (
            <Field>
              <FieldLabel>Signing secret Slack</FieldLabel>
              <Input name="signingSecret" type="password" autoComplete="new-password" />
              <FieldHint>Ở Basic Information của Slack app; hub dùng để kiểm chữ ký mọi request.</FieldHint>
            </Field>
          )}
        </div>
      </fieldset>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      {mutation.isError && <Alert variant="destructive">{apiErrorMessage(mutation.error)}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onCancel} disabled={mutation.isPending}>
          Huỷ
        </Button>
        <Button type="submit" variant="default" disabled={mutation.isPending}>
          {mutation.isPending ? "Đang lưu…" : "Lưu bot"}
        </Button>
      </DialogActions>
    </form>
  );
}

function RemoveBot({ bot, onDone, onCancel }: { bot: ChatBot; onDone: () => Promise<unknown>; onCancel: () => void }) {
  const { api } = useOrg();
  const mutation = useMutation({ mutationFn: () => api.chat.bots.remove.call({ id: bot.id }), onSuccess: onDone });
  return (
    <>
      <DialogTitle>Xoá bot chat?</DialogTitle>
      <DialogDescription>
        Bot “{bot.name}” sẽ ngừng hoạt động, token bị xoá và mọi tài khoản đã liên kết với bot này bị tách.
      </DialogDescription>
      {mutation.isError && <Alert variant="destructive">{apiErrorMessage(mutation.error)}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onCancel} disabled={mutation.isPending}>
          Huỷ
        </Button>
        <Button variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? "Đang xoá…" : "Xoá bot"}
        </Button>
      </DialogActions>
    </>
  );
}

function Settings() {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const settings = useQuery(api.chat.settings.get.queryOptions());
  const key = api.chat.settings.get.key();
  const save = useMutation({
    mutationFn: (patch: Partial<ChatSettings>) => api.chat.settings.update.call(patch),
    onSuccess: (data) => queryClient.setQueryData(key, data),
  });
  const [notice, setNotice] = useState(false);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(false);
    const form = new FormData(event.currentTarget);
    const model = String(form.get("leaderModel") ?? "").trim();
    save.mutate(
      {
        allowGroups: form.has("allowGroups"),
        userDailyLimit: Number(form.get("userDailyLimit")),
        orgDailyLimit: Number(form.get("orgDailyLimit")),
        leaderModel: model === "" ? null : model,
      },
      { onSuccess: () => setNotice(true) },
    );
  }
  return (
    <Card className="grid min-w-0 gap-3 p-4">
      <h3 className="text-sm font-semibold text-foreground">Cài đặt chat</h3>
      {settings.isPending ? (
        <LoadingState label="Đang tải cài đặt chat…" />
      ) : settings.isError ? (
        <LoadFailure error={settings.error} retry={settings.refetch} />
      ) : (
        <form
          // Đổi giá trị từ hub thì dựng lại form để defaultValue theo bản mới.
          key={JSON.stringify(settings.data)}
          noValidate
          className="grid max-w-md gap-3.5"
          onSubmit={submit}
          aria-label="Cài đặt chat"
        >
          <label className="flex items-center gap-2">
            <input type="checkbox" name="allowGroups" defaultChecked={settings.data.allowGroups} />
            Cho bot nhận lệnh trong nhóm
          </label>
          <p className="-mt-2 text-xs text-muted-foreground">Tin tự do cho Leader chỉ nhận trong chat riêng.</p>
          <Field>
            <FieldLabel>Số tin Leader mỗi người mỗi ngày</FieldLabel>
            <Input name="userDailyLimit" type="number" min={0} max={1000} defaultValue={settings.data.userDailyLimit} />
            <FieldHint>0 là không cho gọi Leader qua chat.</FieldHint>
          </Field>
          <Field>
            <FieldLabel>Số tin Leader mỗi tổ chức mỗi ngày</FieldLabel>
            <Input name="orgDailyLimit" type="number" min={0} max={100000} defaultValue={settings.data.orgDailyLimit} />
          </Field>
          <Field>
            <FieldLabel>Model Leader qua chat</FieldLabel>
            <Input name="leaderModel" defaultValue={settings.data.leaderModel ?? ""} maxLength={100} />
            <FieldHint>Để trống thì theo cấu hình dự án. Mặc định sonnet để tiết kiệm token.</FieldHint>
          </Field>
          {save.isError && <Alert variant="destructive">{apiErrorMessage(save.error)}</Alert>}
          {notice && (
            <p role="status" className="text-success">
              Đã lưu cài đặt chat.
            </p>
          )}
          <div>
            <Button type="submit" variant="default" disabled={save.isPending}>
              {save.isPending ? "Đang lưu…" : "Lưu cài đặt"}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
