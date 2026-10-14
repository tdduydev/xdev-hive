import { Tabs } from "@base-ui/react/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type {
  NotificationChannel,
  NotificationChannelCreateInput,
  NotificationChannelKind,
  NotificationChannelUpdateInput,
} from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { EllipsisIcon, PlusIcon, SendIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { DataTable } from "@/components/data-table/data-table.tsx";
import { PageSection } from "@/components/page/page-section.tsx";
import { SwitchRow } from "@/components/page/settings.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Field, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { EmptyState, LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { NOTIFICATION_EVENT_LABEL, NOTIFICATION_EVENTS, parseChannelForm } from "@/lib/notification-channels.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { ChatSection } from "@/pages/chat-channels.tsx";
import { Inbox } from "@/pages/notification-inbox.tsx";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader, PageTab, PageTabList } from "@/shell/page-header.tsx";

const text: Dict<{
  title: string;
  description: string;
  tabs: string;
  inboxTab: string;
  channelsTab: string;
  channelsTitle: string;
  channelsLead: string;
  add: string;
  search: string;
  loading: string;
  emptyTitle: string;
  emptyHint: string;
  colChannel: string;
  colEvents: string;
  colStatus: string;
  actions: string;
  actionsFor: (name: string) => string;
  on: string;
  off: string;
  test: string;
  testing: string;
  testVia: (name: string) => string;
  edit: string;
  enable: string;
  disable: string;
  remove: string;
  enabledNotice: string;
  disabledNotice: string;
  formCreate: string;
  formEdit: string;
  formLead: string;
  name: string;
  kind: string;
  enabledLabel: string;
  enabledHint: string;
  events: string;
  eventsHint: string;
  currentTarget: (target: string) => string;
  replaceConfig: string;
  replaceWarning: string;
  botToken: string;
  botTokenHint: string;
  chatId: string;
  chatIdHint: string;
  checkInput: string;
  cancel: string;
  save: string;
  saving: string;
  smtpHost: string;
  smtpPort: string;
  smtpTls: string;
  smtpTlsStart: string;
  smtpTlsImplicit: string;
  smtpTlsNone: string;
  smtpUser: string;
  smtpPassword: string;
  from: string;
  to: string;
  toHint: string;
  removeTitle: string;
  removeBody: (name: string) => string;
  removeConfirm: string;
  removing: string;
  more: (n: number) => string;
}> = {
  vi: {
    title: "Thông báo",
    description: "Hộp thư của bạn và nơi hub gửi thông báo của tổ chức.",
    tabs: "Phần của trang Thông báo",
    inboxTab: "Hộp thư",
    channelsTab: "Kênh gửi đi",
    channelsTitle: "Kênh thông báo",
    channelsLead: "Gửi các sự kiện bạn chọn tới Telegram hoặc email qua SMTP.",
    add: "Thêm kênh",
    search: "Tìm tên kênh, nơi nhận…",
    loading: "Đang tải kênh thông báo…",
    emptyTitle: "Chưa có kênh thông báo",
    emptyHint: "Thêm kênh đầu tiên để nhận thông báo về run, merge và hoạt động của tổ chức.",
    colChannel: "Kênh",
    colEvents: "Sự kiện",
    colStatus: "Trạng thái",
    actions: "Thao tác",
    actionsFor: (name) => `Thao tác với kênh ${name}`,
    on: "Đang bật",
    off: "Đã tắt",
    test: "Gửi thử",
    testing: "Đang gửi…",
    testVia: (name) => `Gửi thử qua ${name}`,
    edit: "Sửa kênh",
    enable: "Bật kênh",
    disable: "Tắt kênh",
    remove: "Xoá kênh",
    enabledNotice: "Đã bật kênh.",
    disabledNotice: "Đã tắt kênh.",
    formCreate: "Thêm kênh thông báo",
    formEdit: "Sửa kênh thông báo",
    formLead: "Chọn nơi nhận và các sự kiện gửi cho nhóm quản trị.",
    name: "Tên kênh",
    kind: "Loại kênh",
    enabledLabel: "Bật kênh nhận thông báo",
    enabledHint: "Tắt thì hub giữ cấu hình nhưng không gửi gì.",
    events: "Sự kiện nhận",
    eventsHint: "Kênh chỉ nhận các sự kiện được chọn.",
    currentTarget: (target) => `Nơi nhận hiện tại: ${target}`,
    replaceConfig: "Thay cấu hình kết nối",
    replaceWarning:
      "Nhập lại toàn bộ cấu hình kết nối, kể cả secret. Mật khẩu SMTP để trống nghĩa là cấu hình mới không dùng mật khẩu.",
    botToken: "Token bot Telegram",
    botTokenHint: "Lấy từ BotFather. Token đã lưu không được hiển thị lại.",
    chatId: "Chat ID",
    chatIdHint: "ID nhóm hoặc cuộc trò chuyện, hoặc @tên_kênh.",
    checkInput: "Kiểm tra lại các trường đã nhập.",
    cancel: "Huỷ",
    save: "Lưu kênh",
    saving: "Đang lưu…",
    smtpHost: "Máy chủ SMTP",
    smtpPort: "Cổng SMTP",
    smtpTls: "Bảo mật kết nối",
    smtpTlsStart: "STARTTLS (thường cổng 587)",
    smtpTlsImplicit: "TLS (thường cổng 465)",
    smtpTlsNone: "Không dùng TLS",
    smtpUser: "Tài khoản SMTP (tuỳ chọn)",
    smtpPassword: "Mật khẩu SMTP (tuỳ chọn)",
    from: "Email gửi",
    to: "Email nhận",
    toHint: "Ngăn cách nhiều địa chỉ bằng dấu phẩy, tối đa 20 địa chỉ.",
    removeTitle: "Xoá kênh thông báo?",
    removeBody: (name) => `Kênh “${name}” sẽ ngừng nhận thông báo và cấu hình kết nối sẽ bị xoá.`,
    removeConfirm: "Xoá kênh",
    removing: "Đang xoá…",
    more: (n) => `+${n}`,
  },
  en: {
    title: "Notifications",
    description: "Your inbox and where the hub sends organization notifications.",
    tabs: "Sections of the Notifications page",
    inboxTab: "Inbox",
    channelsTab: "Outgoing channels",
    channelsTitle: "Notification channels",
    channelsLead: "Send the events you choose to Telegram or to email over SMTP.",
    add: "Add channel",
    search: "Search channel name, recipient…",
    loading: "Loading notification channels…",
    emptyTitle: "No notification channels yet",
    emptyHint: "Add the first channel to get notified about runs, merges and organization activity.",
    colChannel: "Channel",
    colEvents: "Events",
    colStatus: "Status",
    actions: "Actions",
    actionsFor: (name) => `Actions for channel ${name}`,
    on: "On",
    off: "Off",
    test: "Send test",
    testing: "Sending…",
    testVia: (name) => `Send a test through ${name}`,
    edit: "Edit channel",
    enable: "Turn channel on",
    disable: "Turn channel off",
    remove: "Delete channel",
    enabledNotice: "Channel turned on.",
    disabledNotice: "Channel turned off.",
    formCreate: "Add notification channel",
    formEdit: "Edit notification channel",
    formLead: "Choose the recipient and the events sent to the admin team.",
    name: "Channel name",
    kind: "Channel type",
    enabledLabel: "Channel is on",
    enabledHint: "When off, the hub keeps the settings but sends nothing.",
    events: "Events to receive",
    eventsHint: "The channel only receives the events you tick.",
    currentTarget: (target) => `Current recipient: ${target}`,
    replaceConfig: "Replace connection settings",
    replaceWarning:
      "Enter the whole connection setup again, secrets included. An empty SMTP password means the new setup uses no password.",
    botToken: "Telegram bot token",
    botTokenHint: "Get it from BotFather. A saved token is never shown again.",
    chatId: "Chat ID",
    chatIdHint: "Group or chat ID, or @channel_name.",
    checkInput: "Check the fields you entered.",
    cancel: "Cancel",
    save: "Save channel",
    saving: "Saving…",
    smtpHost: "SMTP server",
    smtpPort: "SMTP port",
    smtpTls: "Connection security",
    smtpTlsStart: "STARTTLS (usually port 587)",
    smtpTlsImplicit: "TLS (usually port 465)",
    smtpTlsNone: "No TLS",
    smtpUser: "SMTP user (optional)",
    smtpPassword: "SMTP password (optional)",
    from: "From address",
    to: "To addresses",
    toHint: "Separate several addresses with commas, up to 20.",
    removeTitle: "Delete notification channel?",
    removeBody: (name) =>
      `Channel “${name}” will stop receiving notifications and its connection settings are deleted.`,
    removeConfirm: "Delete channel",
    removing: "Deleting…",
    more: (n) => `+${n}`,
  },
};

type NotificationsTab = "hop-thu" | "kenh";

/**
 * /notifications: hộp thư của người dùng (ai cũng có) và kênh gửi đi của tổ chức (chỉ quản trị). Hai phần tách bằng
 * tab có URL; người không phải quản trị chỉ có hộp thư nên không thấy tab nào.
 */
export function NotificationsPage() {
  const t = useT(text);
  const { org, api } = useOrg();
  const navigate = useNavigate();
  const admin = isOrgAdmin(org.role);
  // TODO(admin-layout): route /notifications chưa có validateSearch trong router.tsx (file dùng chung); đọc `tab` thô
  // ở đây cho tới khi người điều phối thêm `validateNotificationsSearch` vào lib/route-search.ts.
  const { tab: rawTab } = useSearch({ strict: false }) as { tab?: unknown };
  const tab: NotificationsTab = admin && rawTab === "kenh" ? "kenh" : "hop-thu";
  const unread = useQuery(api.inbox.unreadCount.queryOptions({ refetchInterval: 30_000 }));

  const inbox = (
    <>
      <Inbox key={org.id} />
      <ChatSection key={`chat-${org.id}`} />
    </>
  );
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      {admin ? (
        <Tabs.Root
          value={tab}
          onValueChange={(value: NotificationsTab) =>
            navigate({
              to: "/notifications",
              search: (value === "hop-thu" ? {} : { tab: value }) as Record<string, never>,
              replace: true,
            })
          }
        >
          <PageTabList label={t.tabs}>
            <PageTab value="hop-thu" count={unread.data?.count} tone="warning">
              {t.inboxTab}
            </PageTab>
            <PageTab value="kenh">{t.channelsTab}</PageTab>
          </PageTabList>
          <Tabs.Panel value="hop-thu">
            <PageBody>{inbox}</PageBody>
          </Tabs.Panel>
          <Tabs.Panel value="kenh">
            <PageBody>
              <Channels key={org.id} />
            </PageBody>
          </Tabs.Panel>
        </Tabs.Root>
      ) : (
        <PageBody>{inbox}</PageBody>
      )}
    </>
  );
}

type ChannelDialog = { kind: "create" } | { kind: "edit" | "remove"; channel: NotificationChannel };
type Notice = { ok: boolean; message: string };

function Channels() {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const channels = useQuery(api.notificationChannels.list.queryOptions());
  const [dialog, setDialog] = useState<ChannelDialog | null>(null);
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.notificationChannels.list.key() });
  const done = async () => {
    setDialog(null);
    await refresh();
  };
  const note = (id: string, notice: Notice | null) =>
    setNotices((prev) => {
      const { [id]: _dropped, ...rest } = prev;
      return notice ? { ...rest, [id]: notice } : rest;
    });
  const toggle = useMutation({
    mutationFn: (channel: NotificationChannel) =>
      api.notificationChannels.update.call({ id: channel.id, enabled: !channel.enabled }),
    onMutate: (channel) => note(channel.id, null),
    onSuccess: async (_, channel) => {
      note(channel.id, { ok: true, message: channel.enabled ? t.disabledNotice : t.enabledNotice });
      await refresh();
    },
    onError: (error, channel) => note(channel.id, { ok: false, message: apiErrorMessage(error) }),
  });
  const test = useMutation({
    mutationFn: (channel: NotificationChannel) => api.notificationChannels.test.call({ id: channel.id }),
    onMutate: (channel) => note(channel.id, null),
    onSuccess: (result, channel) => note(channel.id, result),
    onError: (error, channel) => note(channel.id, { ok: false, message: apiErrorMessage(error) }),
  });
  const busy = toggle.isPending || test.isPending;

  let body: React.ReactNode;
  if (channels.isPending) body = <TableSkeleton label={t.loading} columns={4} />;
  else if (channels.isError) body = <LoadFailure error={channels.error} retry={channels.refetch} />;
  else if (channels.data.length === 0)
    body = (
      <EmptyState
        icon={SendIcon}
        title={t.emptyTitle}
        description={t.emptyHint}
        action={
          <Button variant="default" onClick={() => setDialog({ kind: "create" })}>
            <PlusIcon aria-hidden="true" />
            {t.add}
          </Button>
        }
      />
    );
  else
    body = (
      <DataTable
        rows={channels.data}
        rowLabel={(channel) => channel.name}
        caption={t.channelsTitle}
        placeholder={t.search}
        minWidth={620}
        onRowClick={(channel) => setDialog({ kind: "edit", channel })}
        {...(dialog?.kind === "edit" ? { activeId: dialog.channel.id } : {})}
        columns={[
          {
            key: "channel",
            label: t.colChannel,
            value: (channel) => `${channel.name} ${channel.target}`,
            sortable: true,
            hideable: false,
            pin: "start",
            cell: (channel) => {
              const notice = notices[channel.id];
              return (
                <div className="grid min-w-0 max-w-72 gap-0.5 whitespace-normal">
                  <span className="break-all font-medium text-foreground">{channel.name}</span>
                  <span className="break-all text-xs text-muted-foreground">{channel.target}</span>
                  {notice &&
                    (notice.ok ? (
                      <p role="status" className="break-words text-xs text-success">
                        {notice.message}
                      </p>
                    ) : (
                      <Alert variant="destructive" className="mt-1">
                        {notice.message}
                      </Alert>
                    ))}
                </div>
              );
            },
          },
          {
            key: "events",
            label: t.colEvents,
            value: (channel) => channel.events.map((event) => NOTIFICATION_EVENT_LABEL[event]).join(" "),
            cell: (channel) => (
              <ul
                aria-label={`${t.colEvents} · ${channel.name}`}
                className="flex max-w-64 flex-wrap gap-1.5 whitespace-normal"
              >
                {channel.events.slice(0, 2).map((event) => (
                  <li key={event}>
                    <Pill>{NOTIFICATION_EVENT_LABEL[event]}</Pill>
                  </li>
                ))}
                {channel.events.length > 2 && (
                  <li>
                    <Pill
                      title={channel.events
                        .slice(2)
                        .map((event) => NOTIFICATION_EVENT_LABEL[event])
                        .join(", ")}
                    >
                      {t.more(channel.events.length - 2)}
                    </Pill>
                  </li>
                )}
              </ul>
            ),
          },
          {
            key: "status",
            label: t.colStatus,
            value: (channel) => (channel.enabled ? t.on : t.off),
            sortable: true,
            cell: (channel) => (
              <Pill tone={channel.enabled ? "ok" : "neutral"} dot>
                {channel.enabled ? t.on : t.off}
              </Pill>
            ),
          },
          {
            key: "actions",
            label: t.actions,
            value: () => null,
            hideable: false,
            align: "end",
            pin: "end",
            cell: (channel) => (
              <span className="inline-flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => test.mutate(channel)}
                  aria-label={t.testVia(channel.name)}
                >
                  {test.isPending && test.variables?.id === channel.id ? t.testing : t.test}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="icon-sm" aria-label={t.actionsFor(channel.name)} />}
                  >
                    <EllipsisIcon aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-44">
                    <DropdownMenuItem onClick={() => setDialog({ kind: "edit", channel })}>{t.edit}</DropdownMenuItem>
                    <DropdownMenuItem disabled={busy} onClick={() => toggle.mutate(channel)}>
                      {channel.enabled ? t.disable : t.enable}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => setDialog({ kind: "remove", channel })}>
                      {t.remove}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            ),
          },
        ]}
      />
    );

  return (
    <PageSection
      title={t.channelsTitle}
      description={t.channelsLead}
      actions={
        channels.data &&
        channels.data.length > 0 && (
          <Button variant="default" onClick={() => setDialog({ kind: "create" })}>
            <PlusIcon aria-hidden="true" />
            {t.add}
          </Button>
        )
      }
    >
      {body}
      <Dialog
        open={dialog?.kind === "create" || dialog?.kind === "edit"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          {dialog && dialog.kind !== "remove" && (
            <ChannelForm
              key={dialog.kind === "edit" ? dialog.channel.id : "create"}
              channel={dialog.kind === "edit" ? dialog.channel : undefined}
              onDone={done}
              onCancel={() => setDialog(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={dialog?.kind === "remove"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent>
          {dialog?.kind === "remove" && (
            <RemoveChannel channel={dialog.channel} onDone={done} onCancel={() => setDialog(null)} />
          )}
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}

function ChannelForm({
  channel,
  onDone,
  onCancel,
}: {
  channel: NotificationChannel | undefined;
  onDone: () => Promise<unknown>;
  onCancel: () => void;
}) {
  const t = useT(text);
  const { api } = useOrg();
  const [kind, setKind] = useState<NotificationChannelKind>(channel?.kind ?? "telegram");
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [events, setEvents] = useState<ReadonlySet<string>>(new Set(channel?.events ?? []));
  const [replaceConfig, setReplaceConfig] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const kindId = useId();
  const mutation = useMutation({
    mutationFn: (input: NotificationChannelCreateInput | NotificationChannelUpdateInput) =>
      "id" in input ? api.notificationChannels.update.call(input) : api.notificationChannels.create.call(input),
    onSuccess: onDone,
  });
  const busy = mutation.isPending;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    mutation.reset();
    // Công tắc và ô chọn sự kiện là component điều khiển, không tự vào FormData: ghép lại đúng dạng parseChannelForm đọc.
    const form = new FormData(event.currentTarget);
    form.delete("enabled");
    form.delete("events");
    form.delete("replaceConfig");
    if (enabled) form.set("enabled", "on");
    for (const name of NOTIFICATION_EVENTS) if (events.has(name)) form.append("events", name);
    if (replaceConfig) form.set("replaceConfig", "on");
    const parsed = parseChannelForm(form, kind, channel?.id);
    if (!parsed.success) {
      setFailure(parsed.error.issues[0]?.message ?? t.checkInput);
      return;
    }
    mutation.mutate(parsed.data);
  }
  return (
    <form noValidate className="grid min-w-0 gap-4" onSubmit={submit}>
      <div className="grid gap-1.5">
        <DialogTitle>{channel ? t.formEdit : t.formCreate}</DialogTitle>
        <DialogDescription>{t.formLead}</DialogDescription>
      </div>
      <fieldset
        disabled={busy}
        className="grid max-h-[60dvh] min-w-0 gap-3.5 overflow-y-auto overscroll-contain px-1 py-1 -mx-1"
      >
        <Field>
          <FieldLabel>{t.name}</FieldLabel>
          <Input name="name" defaultValue={channel?.name ?? ""} maxLength={80} autoFocus />
        </Field>
        <div className="grid gap-1.5">
          <label htmlFor={kindId} className="text-sm font-medium text-foreground">
            {t.kind}
          </label>
          <NativeSelect
            id={kindId}
            value={kind}
            disabled={Boolean(channel) || busy}
            onChange={(event) => setKind(event.target.value as NotificationChannelKind)}
          >
            <option value="telegram">Telegram</option>
            <option value="email">Email / SMTP</option>
          </NativeSelect>
        </div>
        <SwitchRow label={t.enabledLabel} hint={t.enabledHint} checked={enabled} onChange={setEnabled} />
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium text-foreground">{t.events}</legend>
          <p className="text-xs text-muted-foreground">{t.eventsHint}</p>
          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {NOTIFICATION_EVENTS.map((name) => (
              <CheckRow
                key={name}
                label={NOTIFICATION_EVENT_LABEL[name]}
                checked={events.has(name)}
                onChange={(checked) =>
                  setEvents((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(name);
                    else next.delete(name);
                    return next;
                  })
                }
              />
            ))}
          </div>
        </fieldset>
        {channel && (
          <>
            <p className="break-all text-xs text-muted-foreground">{t.currentTarget(channel.target)}</p>
            <CheckRow label={t.replaceConfig} checked={replaceConfig} onChange={setReplaceConfig} />
          </>
        )}
        {(!channel || replaceConfig) && (
          <div key={kind} className="grid min-w-0 gap-3.5">
            {channel && <p className="text-xs text-warning">{t.replaceWarning}</p>}
            {kind === "telegram" ? (
              <>
                <Field>
                  <FieldLabel>{t.botToken}</FieldLabel>
                  <Input name="botToken" type="password" autoComplete="new-password" />
                  <FieldHint>{t.botTokenHint}</FieldHint>
                </Field>
                <Field>
                  <FieldLabel>{t.chatId}</FieldLabel>
                  <Input name="chatId" />
                  <FieldHint>{t.chatIdHint}</FieldHint>
                </Field>
              </>
            ) : (
              <SmtpFields />
            )}
          </div>
        )}
      </fieldset>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      {mutation.isError && <Alert variant="destructive">{apiErrorMessage(mutation.error)}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="default" disabled={busy}>
          {busy ? t.saving : t.save}
        </Button>
      </DialogActions>
    </form>
  );
}

function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} />
      <label htmlFor={id} className="cursor-pointer">
        {label}
      </label>
    </div>
  );
}

function SmtpFields() {
  const t = useT(text);
  const tlsId = useId();
  return (
    <>
      <div className="grid gap-3.5 sm:grid-cols-[minmax(0,1fr)_8rem]">
        <Field>
          <FieldLabel>{t.smtpHost}</FieldLabel>
          <Input name="host" autoComplete="off" />
        </Field>
        <Field>
          <FieldLabel>{t.smtpPort}</FieldLabel>
          <Input name="port" type="number" min={1} max={65535} defaultValue="587" />
        </Field>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={tlsId} className="text-sm font-medium text-foreground">
          {t.smtpTls}
        </label>
        <NativeSelect id={tlsId} name="tls" defaultValue="starttls">
          <option value="starttls">{t.smtpTlsStart}</option>
          <option value="implicit">{t.smtpTlsImplicit}</option>
          <option value="none">{t.smtpTlsNone}</option>
        </NativeSelect>
      </div>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field>
          <FieldLabel>{t.smtpUser}</FieldLabel>
          <Input name="user" autoComplete="off" maxLength={200} />
        </Field>
        <Field>
          <FieldLabel>{t.smtpPassword}</FieldLabel>
          <Input name="password" type="password" autoComplete="new-password" maxLength={500} />
        </Field>
      </div>
      <Field>
        <FieldLabel>{t.from}</FieldLabel>
        <Input name="from" type="email" />
      </Field>
      <Field>
        <FieldLabel>{t.to}</FieldLabel>
        <Input name="to" />
        <FieldHint>{t.toHint}</FieldHint>
      </Field>
    </>
  );
}

function RemoveChannel({
  channel,
  onDone,
  onCancel,
}: {
  channel: NotificationChannel;
  onDone: () => Promise<unknown>;
  onCancel: () => void;
}) {
  const t = useT(text);
  const { api } = useOrg();
  const mutation = useMutation({
    mutationFn: () => api.notificationChannels.remove.call({ id: channel.id }),
    onSuccess: onDone,
  });
  return (
    <>
      <DialogTitle>{t.removeTitle}</DialogTitle>
      <DialogDescription>{t.removeBody(channel.name)}</DialogDescription>
      {mutation.isError && <Alert variant="destructive">{apiErrorMessage(mutation.error)}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onCancel} disabled={mutation.isPending}>
          {t.cancel}
        </Button>
        <Button variant="destructive-solid" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? t.removing : t.removeConfirm}
        </Button>
      </DialogActions>
    </>
  );
}
