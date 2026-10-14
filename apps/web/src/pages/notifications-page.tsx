import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Table, Td, Th } from "@xdev-hive/ui/table";
import { type FormEvent, useId, useState } from "react";
import { Icon } from "@/components/icons.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Field, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { EmptyState, LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { NOTIFICATION_EVENT_LABEL, NOTIFICATION_EVENTS, parseChannelForm } from "@/lib/notification-channels.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { ChatSection } from "@/pages/chat-channels.tsx";
import { Inbox } from "@/pages/notification-inbox.tsx";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

export function NotificationsPage() {
  const { org } = useOrg();
  return (
    <>
      <PageHeader title="Thông báo" />
      <PageBody>
        <Inbox key={org.id} />
        <section aria-label="Kênh nhận thông báo" className="grid min-w-0 gap-3">
          <h2 className="text-base font-semibold text-foreground">Kênh thông báo</h2>
          {isOrgAdmin(org.role) ? (
            <Channels key={org.id} />
          ) : (
            <Card className="p-4 text-muted-foreground">
              Chỉ chủ sở hữu và quản trị tổ chức có thể xem và cấu hình kênh nhận thông báo. Liên hệ quản trị để thay
              đổi nơi nhận.
            </Card>
          )}
        </section>
        <ChatSection key={`chat-${org.id}`} />
      </PageBody>
    </>
  );
}

type ChannelDialog = { kind: "create" } | { kind: "edit" | "remove"; channel: NotificationChannel };

function Channels() {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const channels = useQuery(api.notificationChannels.list.queryOptions());
  const [dialog, setDialog] = useState<ChannelDialog | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.notificationChannels.list.key() });
  const done = async () => {
    setDialog(null);
    await refresh();
  };
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground">Gửi các sự kiện bạn chọn tới Telegram hoặc email qua SMTP.</p>
        <Button variant="default" onClick={() => setDialog({ kind: "create" })}>
          <Icon name="plus" />
          Thêm kênh
        </Button>
      </div>
      <div className="flex min-w-0 flex-wrap items-start gap-5">
        <div className="min-w-0 flex-[3_1_560px]">
          {channels.isPending ? (
            <LoadingState label="Đang tải kênh thông báo…" />
          ) : channels.isError ? (
            <LoadFailure error={channels.error} retry={channels.refetch} />
          ) : channels.data.length === 0 ? (
            <EmptyState
              title="Chưa có kênh thông báo"
              description="Thêm kênh đầu tiên để nhận thông báo về run, merge và hoạt động của tổ chức."
            />
          ) : (
            <Card className="overflow-hidden">
              <Table aria-label="Kênh thông báo">
                <thead className="bg-muted">
                  <tr>
                    <Th>Kênh</Th>
                    <Th>Sự kiện</Th>
                    <Th>Bật</Th>
                    <Th>Thao tác</Th>
                  </tr>
                </thead>
                <tbody>
                  {channels.data.map((channel) => (
                    <ChannelRow
                      key={channel.id}
                      channel={channel}
                      selected={dialog?.kind === "edit" && dialog.channel.id === channel.id}
                      onEdit={() => setDialog({ kind: "edit", channel })}
                      onRemove={() => setDialog({ kind: "remove", channel })}
                      refresh={refresh}
                    />
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </div>
        {dialog && dialog.kind !== "remove" && (
          <Card className="min-w-0 flex-[2_1_360px] p-5">
            <section aria-label="Sửa kênh">
              <ChannelForm
                key={dialog.kind === "edit" ? dialog.channel.id : "create"}
                channel={dialog.kind === "edit" ? dialog.channel : undefined}
                onDone={done}
                onCancel={() => setDialog(null)}
              />
            </section>
          </Card>
        )}
      </div>
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
    </>
  );
}

function ChannelRow({
  channel,
  onEdit,
  onRemove,
  refresh,
  selected,
}: {
  channel: NotificationChannel;
  selected: boolean;
  onEdit: () => void;
  onRemove: () => void;
  refresh: () => Promise<unknown>;
}) {
  const { api } = useOrg();
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const toggle = useMutation({
    mutationFn: () => api.notificationChannels.update.call({ id: channel.id, enabled: !channel.enabled }),
    onSuccess: async () => {
      setNotice({ ok: true, message: channel.enabled ? "Đã tắt kênh." : "Đã bật kênh." });
      await refresh();
    },
  });
  const test = useMutation({
    mutationFn: () => api.notificationChannels.test.call({ id: channel.id }),
    onSuccess: setNotice,
  });
  const busy = toggle.isPending || test.isPending;
  return (
    <tr className={selected ? "bg-accent" : "hover:bg-muted"}>
      <Td className="min-w-55 max-w-80">
        <button
          type="button"
          onClick={onEdit}
          className="cursor-pointer break-all text-left font-semibold text-foreground"
        >
          {channel.name}
        </button>
        <p className="break-all text-xs text-muted-foreground">{channel.target}</p>
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
      </Td>
      <Td>
        <ul aria-label={`Sự kiện của ${channel.name}`} className="flex flex-wrap gap-1.5">
          {channel.events.map((event) => (
            <li key={event}>
              <Pill>{NOTIFICATION_EVENT_LABEL[event]}</Pill>
            </li>
          ))}
        </ul>
      </Td>
      <Td>
        <Pill tone={channel.enabled ? "ok" : "neutral"}>{channel.enabled ? "Đang bật" : "Đã tắt"}</Pill>
      </Td>
      <Td>
        <div className="flex flex-wrap items-start gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setNotice(null);
              test.reset();
              toggle.mutate();
            }}
            aria-label={`${channel.enabled ? "Tắt" : "Bật"} kênh ${channel.name}`}
          >
            {channel.enabled ? "Tắt" : "Bật"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setNotice(null);
              toggle.reset();
              test.mutate();
            }}
            aria-label={`Gửi thử qua ${channel.name}`}
          >
            {test.isPending ? "Đang gửi…" : "Gửi thử"}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={onEdit} aria-label={`Sửa kênh ${channel.name}`}>
            Sửa
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={onRemove}
            aria-label={`Xoá kênh ${channel.name}`}
          >
            Xoá
          </Button>
        </div>
      </Td>
    </tr>
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
  const { api } = useOrg();
  const [kind, setKind] = useState<NotificationChannelKind>(channel?.kind ?? "telegram");
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
    const parsed = parseChannelForm(new FormData(event.currentTarget), kind, channel?.id);
    if (!parsed.success) {
      setFailure(parsed.error.issues[0]?.message ?? "Kiểm tra lại các trường đã nhập.");
      return;
    }
    mutation.mutate(parsed.data);
  }
  return (
    <form noValidate className="grid min-w-0 gap-3.5" onSubmit={submit}>
      <h3 className="text-lg font-semibold text-foreground">
        {channel ? "Sửa kênh thông báo" : "Thêm kênh thông báo"}
      </h3>
      <p className="text-muted-foreground">Chọn nơi nhận và các sự kiện gửi cho nhóm quản trị.</p>
      <fieldset disabled={busy} className="grid min-w-0 gap-3.5">
        <Field>
          <FieldLabel>Tên kênh</FieldLabel>
          <Input name="name" defaultValue={channel?.name ?? ""} maxLength={80} autoFocus />
        </Field>
        <div className="grid gap-1.5">
          <label htmlFor={kindId} className="text-sm font-medium text-foreground">
            Loại kênh
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
        <label className="flex items-center gap-2">
          <input type="checkbox" name="enabled" defaultChecked={channel?.enabled ?? true} />
          Bật kênh nhận thông báo
        </label>
        <fieldset className="grid gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium text-foreground">Sự kiện nhận</legend>
          {NOTIFICATION_EVENTS.map((event) => (
            <label key={event} className="flex items-center gap-2">
              <input
                type="checkbox"
                name="events"
                value={event}
                defaultChecked={channel ? channel.events.includes(event) : false}
              />
              {NOTIFICATION_EVENT_LABEL[event]}
            </label>
          ))}
        </fieldset>
        {channel && (
          <>
            <p className="break-all text-xs text-muted-foreground">Nơi nhận hiện tại: {channel.target}</p>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="replaceConfig"
                checked={replaceConfig}
                onChange={(event) => setReplaceConfig(event.target.checked)}
              />
              Thay cấu hình kết nối
            </label>
          </>
        )}
        {(!channel || replaceConfig) && (
          <div key={kind} className="grid min-w-0 gap-3.5">
            {channel && (
              <p className="text-xs text-warning">
                Nhập lại toàn bộ cấu hình kết nối, kể cả secret. Mật khẩu SMTP để trống nghĩa là cấu hình mới không dùng
                mật khẩu.
              </p>
            )}
            {kind === "telegram" ? (
              <>
                <Field>
                  <FieldLabel>Token bot Telegram</FieldLabel>
                  <Input name="botToken" type="password" autoComplete="new-password" />
                  <FieldHint>Lấy từ BotFather. Token đã lưu không được hiển thị lại.</FieldHint>
                </Field>
                <Field>
                  <FieldLabel>Chat ID</FieldLabel>
                  <Input name="chatId" />
                  <FieldHint>ID nhóm hoặc cuộc trò chuyện, hoặc @tên_kênh.</FieldHint>
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
          Huỷ
        </Button>
        <Button type="submit" variant="default" disabled={busy}>
          {busy ? "Đang lưu…" : "Lưu kênh"}
        </Button>
      </DialogActions>
    </form>
  );
}

function SmtpFields() {
  const tlsId = useId();
  return (
    <>
      <Field>
        <FieldLabel>Máy chủ SMTP</FieldLabel>
        <Input name="host" autoComplete="off" />
      </Field>
      <Field>
        <FieldLabel>Cổng SMTP</FieldLabel>
        <Input name="port" type="number" min={1} max={65535} defaultValue="587" />
      </Field>
      <div className="grid gap-1.5">
        <label htmlFor={tlsId} className="text-sm font-medium text-foreground">
          Bảo mật kết nối
        </label>
        <NativeSelect id={tlsId} name="tls" defaultValue="starttls">
          <option value="starttls">STARTTLS (thường cổng 587)</option>
          <option value="implicit">TLS (thường cổng 465)</option>
          <option value="none">Không dùng TLS</option>
        </NativeSelect>
      </div>
      <Field>
        <FieldLabel>Tài khoản SMTP (tuỳ chọn)</FieldLabel>
        <Input name="user" autoComplete="off" maxLength={200} />
      </Field>
      <Field>
        <FieldLabel>Mật khẩu SMTP (tuỳ chọn)</FieldLabel>
        <Input name="password" type="password" autoComplete="new-password" maxLength={500} />
      </Field>
      <Field>
        <FieldLabel>Email gửi</FieldLabel>
        <Input name="from" type="email" />
      </Field>
      <Field>
        <FieldLabel>Email nhận</FieldLabel>
        <Input name="to" />
        <FieldHint>Ngăn cách nhiều địa chỉ bằng dấu phẩy, tối đa 20 địa chỉ.</FieldHint>
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
  const { api } = useOrg();
  const mutation = useMutation({
    mutationFn: () => api.notificationChannels.remove.call({ id: channel.id }),
    onSuccess: onDone,
  });
  return (
    <>
      <DialogTitle>Xoá kênh thông báo?</DialogTitle>
      <DialogDescription>
        Kênh “{channel.name}” sẽ ngừng nhận thông báo và cấu hình kết nối sẽ bị xoá.
      </DialogDescription>
      {mutation.isError && <Alert variant="destructive">{apiErrorMessage(mutation.error)}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onCancel} disabled={mutation.isPending}>
          Huỷ
        </Button>
        <Button variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? "Đang xoá…" : "Xoá kênh"}
        </Button>
      </DialogActions>
    </>
  );
}
