import { onlineManager, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PublicLinksTable } from "@xdev-hive/artifacts-ui";
import { type AgentPolicy, agentPolicyInput, DEFAULT_ORG_ARTIFACT_POLICY } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { useId, useState, useSyncExternalStore } from "react";
import { SwitchRow } from "@/components/page/settings.tsx";
import { UnsavedChangesGuard } from "@/components/page/unsaved-guard.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { usePermissions } from "@/lib/permissions.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { WebArtifacts } from "@/pages/artifacts/web-env.tsx";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text = {
  vi: {
    title: "Link công khai",
    lead: "Quản lý link artifact của tổ chức. Chỉ hiển thị thông tin link, không mở nội dung artifact cá nhân.",
    forbidden: "Chỉ quản trị tổ chức được quản lý link công khai.",
    enabled: "Cho phép link công khai",
    hint: "Tắt thì mọi link ngừng phục vụ ngay. Bật lại thì link chưa hết hạn và chưa thu hồi hoạt động trở lại.",
    disableTitle: "Tắt link công khai?",
    disableWarning: "Mọi link đang có sẽ ngừng phục vụ ngay. Bật lại chỉ khôi phục link chưa hết hạn và chưa thu hồi.",
    confirmDisable: "Tắt link công khai",
    cancel: "Thôi",
    maxDays: "Hạn tối đa (ngày)",
    invalid: "Nhập số nguyên từ 1 đến 30.",
    save: "Lưu chính sách",
    saving: "Đang lưu…",
    saved: "Đã lưu chính sách link công khai.",
    disabled: "Link công khai đang tắt. Bạn vẫn có thể thu hồi các link chưa hết hạn.",
    readOnly: "Cần quyền sửa chính sách agent để thay đổi cài đặt này.",
    offline: "Đang ngoại tuyến. Kết nối lại để lưu chính sách hoặc thu hồi link.",
    list: "Link chưa hết hạn và chưa thu hồi",
    empty: "Chưa có link công khai",
    more: "Tải thêm",
    reset: "Huỷ thay đổi",
  },
  en: {
    title: "Public links",
    lead: "Manage organization artifact links. Only link metadata is shown; private artifact content stays private.",
    forbidden: "Only organization administrators can manage public links.",
    enabled: "Allow public links",
    hint: "Disabling stops all links immediately. Enabling resumes links that have not expired or been revoked.",
    disableTitle: "Disable public links?",
    disableWarning: "All existing links stop working immediately. Re-enabling resumes only unexpired, unrevoked links.",
    confirmDisable: "Disable public links",
    cancel: "Cancel",
    maxDays: "Maximum expiry (days)",
    invalid: "Enter a whole number from 1 to 30.",
    save: "Save policy",
    saving: "Saving…",
    saved: "Public link policy saved.",
    disabled: "Public links are disabled. You can still revoke unexpired links.",
    readOnly: "Agent policy write permission is required to change these settings.",
    offline: "You are offline. Reconnect to save policy or revoke links.",
    list: "Unexpired, unrevoked links",
    empty: "No public links yet",
    more: "Load more",
    reset: "Discard changes",
  },
} satisfies Dict<Record<string, string>>;

export function PublicLinksPage() {
  const { org } = useOrg();
  const t = useT(text);
  return (
    <>
      <PageHeader title={t.title} description={t.lead} />
      <PageBody>
        {isOrgAdmin(org.role) ? (
          <WebArtifacts>
            <PublicLinksAdmin />
          </WebArtifacts>
        ) : (
          <Alert>{t.forbidden}</Alert>
        )}
      </PageBody>
    </>
  );
}

function PublicLinksAdmin() {
  const { api } = useOrg();
  const policy = useQuery(api.policies.get.queryOptions());
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {policy.isPending ? (
        <LoadingState />
      ) : policy.isError ? (
        <LoadFailure error={policy.error} retry={() => void policy.refetch()} />
      ) : (
        <LinkPolicy policy={policy.data} />
      )}
      <OrgLinks />
    </div>
  );
}

const subscribeOnline = (onChange: () => void) => onlineManager.subscribe(onChange);
const readOnline = () => onlineManager.isOnline();

function LinkPolicy({ policy }: { policy: AgentPolicy }) {
  const { api } = useOrg();
  const t = useT(text);
  const can = usePermissions();
  const queryClient = useQueryClient();
  const id = useId();
  const online = useSyncExternalStore(subscribeOnline, readOnline);
  const artifacts = policy.artifacts ?? DEFAULT_ORG_ARTIFACT_POLICY;
  const [enabled, setEnabled] = useState(artifacts.publicLinks.enabled);
  const [days, setDays] = useState(String(artifacts.publicLinks.maxDays));
  const [saved, setSaved] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const valid = /^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 30;
  const dirty = enabled !== artifacts.publicLinks.enabled || Number(days) !== artifacts.publicLinks.maxDays;
  const save = useMutation({
    mutationFn: async () => {
      // Lấy chính sách mới nhất để không ghi đè mục khác mà quản trị vừa lưu ở trang khác.
      const latest = await api.policies.get.call({});
      return api.policies.update.call(
        agentPolicyInput.parse({
          ...latest,
          artifacts: {
            ...(latest.artifacts ?? DEFAULT_ORG_ARTIFACT_POLICY),
            publicLinks: { enabled, maxDays: Number(days) },
          },
        }),
      );
    },
    onSuccess: (next) => {
      queryClient.setQueryData(api.policies.get.queryKey(), next);
      void queryClient.invalidateQueries({ queryKey: api.artifacts.settings.queryKey() });
      setSaved(true);
    },
  });
  const blocked = !online || !can("policies.write") || save.isPending;
  return (
    <form
      className="flex min-w-0 max-w-2xl flex-col gap-4 rounded-xl border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked || !valid || !dirty) return;
        if (artifacts.publicLinks.enabled && !enabled) setConfirmDisable(true);
        else save.mutate();
      }}
    >
      <UnsavedChangesGuard when={dirty && !save.isPending} />
      {!online && <Alert>{t.offline}</Alert>}
      {!can("policies.write") && <Alert>{t.readOnly}</Alert>}
      {!artifacts.publicLinks.enabled && <Alert>{t.disabled}</Alert>}
      <SwitchRow
        label={t.enabled}
        hint={t.hint}
        checked={enabled}
        disabled={blocked}
        onChange={(value) => {
          setEnabled(value);
          setSaved(false);
        }}
      />
      <div className="grid gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {t.maxDays}
        </label>
        <Input
          id={id}
          type="number"
          min={1}
          max={30}
          step={1}
          value={days}
          disabled={blocked}
          aria-invalid={!valid}
          aria-describedby={!valid ? `${id}-error` : undefined}
          className="max-w-32"
          onChange={(event) => {
            setDays(event.target.value);
            setSaved(false);
          }}
        />
        {!valid && (
          <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
            {t.invalid}
          </p>
        )}
      </div>
      {save.isError && <Alert variant="destructive">{apiErrorMessage(save.error)}</Alert>}
      {saved && (
        <p role="status" className="text-sm">
          {t.saved}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={blocked || !valid || !dirty}>
          {save.isPending ? t.saving : t.save}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={blocked || !dirty}
          onClick={() => {
            setEnabled(artifacts.publicLinks.enabled);
            setDays(String(artifacts.publicLinks.maxDays));
            setSaved(false);
            save.reset();
          }}
        >
          {t.reset}
        </Button>
      </div>
      <Dialog open={confirmDisable} onOpenChange={setConfirmDisable}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.disableTitle}</DialogTitle>
            <DialogDescription>{t.disableWarning}</DialogDescription>
          </DialogHeader>
          <DialogActions>
            <Button type="button" variant="outline" onClick={() => setConfirmDisable(false)}>
              {t.cancel}
            </Button>
            <Button
              type="button"
              variant="destructive-solid"
              disabled={blocked}
              onClick={() => {
                setConfirmDisable(false);
                save.mutate();
              }}
            >
              {t.confirmDisable}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </form>
  );
}

function OrgLinks() {
  const { api } = useOrg();
  const t = useT(text);
  const online = useSyncExternalStore(subscribeOnline, readOnline);
  const queryClient = useQueryClient();
  const links = useInfiniteQuery(
    api.artifacts.publicLinks.orgList.infiniteOptions({
      input: (cursor: string | undefined) => ({ ...(cursor ? { cursor } : {}), limit: 50 }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
  );
  const revoke = useMutation(
    api.artifacts.publicLinks.revoke.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: api.artifacts.publicLinks.key() });
      },
    }),
  );
  const items = links.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section aria-label={t.list} className="flex min-w-0 flex-col gap-3">
      <h2 className="text-base font-semibold">{t.list}</h2>
      {revoke.isError && <Alert variant="destructive">{apiErrorMessage(revoke.error)}</Alert>}
      {links.isPending ? (
        <LoadingState />
      ) : links.isError ? (
        <LoadFailure error={links.error} retry={() => void links.refetch()} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.empty}</p>
      ) : (
        <PublicLinksTable
          items={items}
          disabled={!online || revoke.isPending}
          onRevoke={(linkId) => revoke.mutate({ linkId })}
        />
      )}
      {links.hasNextPage && (
        <Button
          variant="outline"
          disabled={!online || links.isFetchingNextPage}
          onClick={() => void links.fetchNextPage()}
        >
          {t.more}
        </Button>
      )}
    </section>
  );
}
