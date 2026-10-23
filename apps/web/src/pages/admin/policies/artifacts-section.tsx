import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type AgentPolicy,
  ARTIFACT_LIMITS,
  ARTIFACT_TYPES,
  type ArtifactScope,
  type ArtifactType,
  agentPolicyInput,
  artifactScope,
  DEFAULT_ORG_ARTIFACT_POLICY,
  type OrgArtifactPolicy,
} from "@xdev-hive/contracts";
import { Input } from "@xdev-hive/ui/input";
import { Fragment, useId, useState } from "react";
import { FormRow, SettingsSection, SwitchRow } from "@/components/page/settings.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { useOrg } from "@/shell/org-context.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const text: Dict<{
  title: string;
  hint: string;
  enabled: string;
  enabledHint: string;
  types: string;
  typesHint: string;
  typesEmpty: string;
  scopes: string;
  scopesHint: string;
  versionSize: string;
  blobSize: string;
  maxVersions: string;
  runArtifacts: string;
  runVersions: string;
  quota: string;
  quotaHint: string;
  mib: string;
  gib: string;
  count: string;
  range: (min: number, max: number) => string;
  links: string;
  linksHint: string;
  linksGo: string;
  usage: string;
  usageGo: string;
  type: Record<ArtifactType, string>;
  scope: Record<ArtifactScope, string>;
}> = {
  vi: {
    title: "Artifact",
    hint: "Loại, phạm vi và giới hạn artifact của tổ chức. Hub hạ tiếp các số về trần của người vận hành khi đọc.",
    enabled: "Cho phép artifact",
    enabledHint: "Tắt thì không tạo được artifact mới; artifact đã có vẫn đọc được.",
    types: "Loại được tạo",
    typesHint: "Ảnh và PDF mặc định tắt vì là tệp nhị phân, không xem được ngoại tuyến trên máy.",
    typesEmpty: "Chưa chọn loại nào: không ai tạo được artifact.",
    scopes: "Phạm vi được chọn",
    scopesHint: "Phạm vi rộng hơn cho nhiều người đọc hơn. Cá nhân luôn dùng được.",
    versionSize: "Cỡ tối đa một phiên bản (chữ)",
    blobSize: "Cỡ tối đa một tệp (ảnh, PDF)",
    maxVersions: "Số phiên bản tối đa mỗi artifact",
    runArtifacts: "Artifact tối đa mỗi run",
    runVersions: "Phiên bản tối đa mỗi run",
    quota: "Hạn mức dung lượng của tổ chức",
    quotaHint: "Dùng đến 80% thì hub báo quản trị một lần mỗi ngày; hết thì chặn ghi mới.",
    mib: "MiB",
    gib: "GiB",
    count: "cái",
    range: (min, max) => `Nhập số từ ${min} đến ${max}.`,
    links: "Link công khai",
    linksHint: "Bật tắt và hạn tối đa của link công khai nằm ở trang riêng.",
    linksGo: "Mở trang Link công khai",
    usage: "Dung lượng đang dùng",
    usageGo: "Xem dung lượng theo dự án và người",
    type: {
      markdown: "Markdown",
      code: "Mã nguồn",
      html: "HTML",
      react: "React",
      svg: "SVG",
      mermaid: "Mermaid",
      csv: "CSV",
      json: "JSON",
      image: "Ảnh",
      pdf: "PDF",
    },
    scope: { private: "Cá nhân", project: "Dự án", team: "Đội", org: "Tổ chức" },
  },
  en: {
    title: "Artifacts",
    hint: "Types, scopes and limits for organization artifacts. The hub lowers numbers further to the operator ceilings when reading.",
    enabled: "Allow artifacts",
    enabledHint: "Off: no new artifacts can be created; existing ones stay readable.",
    types: "Types that can be created",
    typesHint: "Images and PDF are off by default: they are binary files and cannot be viewed offline on the desktop.",
    typesEmpty: "No type selected: nobody can create artifacts.",
    scopes: "Selectable scopes",
    scopesHint: "Wider scopes reach more readers. Private is always available.",
    versionSize: "Max size of one text version",
    blobSize: "Max size of one file (image, PDF)",
    maxVersions: "Max versions per artifact",
    runArtifacts: "Max artifacts per run",
    runVersions: "Max versions per run",
    quota: "Organization storage quota",
    quotaHint: "At 80% the hub notifies admins once a day; when full, new writes are blocked.",
    mib: "MiB",
    gib: "GiB",
    count: "items",
    range: (min, max) => `Enter a number from ${min} to ${max}.`,
    links: "Public links",
    linksHint: "The switch and the maximum expiry for public links live on their own page.",
    linksGo: "Open Public links",
    usage: "Storage in use",
    usageGo: "See usage by project and person",
    type: {
      markdown: "Markdown",
      code: "Code",
      html: "HTML",
      react: "React",
      svg: "SVG",
      mermaid: "Mermaid",
      csv: "CSV",
      json: "JSON",
      image: "Image",
      pdf: "PDF",
    },
    scope: { private: "Private", project: "Project", team: "Team", org: "Organization" },
  },
};

/** Các trường mục này sở hữu; `publicLinks` thuộc trang Link công khai nên mục này không đụng tới. */
const FIELDS = [
  "enabled",
  "types",
  "scopes",
  "maxVersionBytes",
  "maxBlobBytes",
  "maxVersions",
  "runLimits",
  "orgQuotaBytes",
] as const;
type Owned = Pick<OrgArtifactPolicy, (typeof FIELDS)[number]>;

const ownedOf = (p: OrgArtifactPolicy): Owned => ({
  enabled: p.enabled,
  types: [...p.types],
  scopes: [...p.scopes],
  maxVersionBytes: p.maxVersionBytes,
  maxBlobBytes: p.maxBlobBytes,
  maxVersions: p.maxVersions,
  runLimits: { ...p.runLimits },
  orgQuotaBytes: p.orgQuotaBytes,
});

/** Bật rồi tắt một loại đổi thứ tự mảng nhưng không đổi tập; so theo tập để không báo "có thay đổi" oan. */
const comparable = (o: Owned) => JSON.stringify({ ...o, types: [...o.types].sort(), scopes: [...o.scopes].sort() });

/** Giữ thứ tự cố định của enum để bật tắt rồi lưu không làm mảng đổi chỗ, tránh báo "có thay đổi" oan. */
const ordered = <T extends string>(all: readonly T[], on: readonly T[]) => all.filter((v) => on.includes(v));

function CheckRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2 text-sm">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

function NumberRow({
  label,
  unit,
  value,
  min,
  max,
  step = 1,
  disabled,
  onChange,
  message,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled: boolean;
  onChange: (value: number) => void;
  message: string;
}) {
  const id = useId();
  // Ô giữ chữ đang gõ; chỉ khi hợp lệ mới đẩy số lên mục, nên gõ dở không làm mục "có thay đổi" sai.
  const [draft, setDraft] = useState(String(value));
  const parsed = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(parsed) && parsed >= min && parsed <= max;
  return (
    <FormRow label={label} htmlFor={id} hint={!valid ? <span className="text-destructive">{message}</span> : undefined}>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={draft}
          disabled={disabled}
          aria-invalid={!valid}
          className="max-w-36"
          onChange={(event) => {
            setDraft(event.target.value);
            const next = Number(event.target.value);
            if (event.target.value.trim() !== "" && Number.isFinite(next) && next >= min && next <= max) onChange(next);
          }}
        />
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
    </FormRow>
  );
}

/**
 * Mục Artifact của trang chính sách (specs/012 T067, FR-122). Tự giữ bản nháp và tự lưu: trang chính sách chỉ đặt mục
 * này vào danh sách, nên hai nhánh cùng sửa trang đó không đụng nhau. Lưu lấy chính sách mới nhất rồi chỉ thay các
 * trường của artifact, để không ghi đè mục khác mà người khác vừa lưu.
 */
export function ArtifactsPolicySection({ policy, canWrite }: { policy: AgentPolicy; canWrite: boolean }) {
  const { api } = useOrg();
  const t = useT(text);
  const queryClient = useQueryClient();
  const saved = ownedOf(policy.artifacts ?? DEFAULT_ORG_ARTIFACT_POLICY);
  const [form, setForm] = useState<Owned>(saved);
  const [epoch, setEpoch] = useState(0);
  const [done, setDone] = useState(false);
  const dirty = comparable(form) !== comparable(saved);

  const save = useMutation({
    mutationFn: async () => {
      const latest = await api.policies.get.call({});
      return api.policies.update.call(
        agentPolicyInput.parse({
          ...latest,
          artifacts: { ...(latest.artifacts ?? DEFAULT_ORG_ARTIFACT_POLICY), ...form },
        }),
      );
    },
    onSuccess: (next) => {
      queryClient.setQueryData(api.policies.get.queryKey(), next);
      void queryClient.invalidateQueries({ queryKey: api.artifacts.settings.queryKey() });
      setForm(ownedOf(next.artifacts ?? DEFAULT_ORG_ARTIFACT_POLICY));
      setDone(true);
    },
  });
  const change = (patch: Partial<Owned>) => {
    setDone(false);
    save.reset();
    setForm((f) => ({ ...f, ...patch }));
  };
  const disabled = !canWrite || save.isPending;
  const toggle = <T extends string>(all: readonly T[], on: readonly T[], value: T, checked: boolean) =>
    ordered(all, checked ? [...on, value] : on.filter((v) => v !== value));

  return (
    <SettingsSection
      id="artifacts"
      title={t.title}
      description={t.hint}
      save={
        canWrite
          ? {
              dirty,
              saving: save.isPending,
              saved: done,
              error: save.isError ? apiErrorMessage(save.error) : undefined,
              onSave: () => save.mutate(),
              onDiscard: () => {
                setForm(saved);
                setEpoch((e) => e + 1);
                setDone(false);
                save.reset();
              },
            }
          : undefined
      }
    >
      <SwitchRow
        label={t.enabled}
        hint={t.enabledHint}
        checked={form.enabled}
        disabled={disabled}
        onChange={(enabled) => change({ enabled })}
      />
      <FormRow label={t.types} hint={form.types.length === 0 ? t.typesEmpty : t.typesHint}>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {ARTIFACT_TYPES.map((type) => (
            <CheckRow
              key={type}
              label={t.type[type]}
              checked={form.types.includes(type)}
              disabled={disabled}
              onChange={(checked) => change({ types: toggle(ARTIFACT_TYPES, form.types, type, checked) })}
            />
          ))}
        </div>
      </FormRow>
      <FormRow label={t.scopes} hint={t.scopesHint}>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {artifactScope.options.map((scope) => (
            <CheckRow
              key={scope}
              label={t.scope[scope]}
              checked={scope === "private" || form.scopes.includes(scope)}
              // Cá nhân là phạm vi gốc của mọi artifact mới nên không bỏ được.
              disabled={disabled || scope === "private"}
              onChange={(checked) => change({ scopes: toggle(artifactScope.options, form.scopes, scope, checked) })}
            />
          ))}
        </div>
      </FormRow>
      <Fragment key={epoch}>
        <NumberRow
          label={t.versionSize}
          unit={t.mib}
          value={form.maxVersionBytes / MIB}
          min={0.001}
          max={ARTIFACT_LIMITS.versionBytesCeiling / MIB}
          step={0.5}
          disabled={disabled}
          message={t.range(0.001, ARTIFACT_LIMITS.versionBytesCeiling / MIB)}
          onChange={(v) => change({ maxVersionBytes: Math.max(1024, Math.round(v * MIB)) })}
        />
        <NumberRow
          label={t.blobSize}
          unit={t.mib}
          value={form.maxBlobBytes / MIB}
          min={0.001}
          max={ARTIFACT_LIMITS.blobBytesCeiling / MIB}
          disabled={disabled}
          message={t.range(0.001, ARTIFACT_LIMITS.blobBytesCeiling / MIB)}
          onChange={(v) => change({ maxBlobBytes: Math.max(1024, Math.round(v * MIB)) })}
        />
        <NumberRow
          label={t.maxVersions}
          unit={t.count}
          value={form.maxVersions}
          min={1}
          max={ARTIFACT_LIMITS.maxVersionsCeiling}
          disabled={disabled}
          message={t.range(1, ARTIFACT_LIMITS.maxVersionsCeiling)}
          onChange={(v) => change({ maxVersions: Math.round(v) })}
        />
        <NumberRow
          label={t.runArtifacts}
          unit={t.count}
          value={form.runLimits.artifacts}
          min={0}
          max={1000}
          disabled={disabled}
          message={t.range(0, 1000)}
          onChange={(v) => change({ runLimits: { ...form.runLimits, artifacts: Math.round(v) } })}
        />
        <NumberRow
          label={t.runVersions}
          unit={t.count}
          value={form.runLimits.versions}
          min={0}
          max={10_000}
          disabled={disabled}
          message={t.range(0, 10_000)}
          onChange={(v) => change({ runLimits: { ...form.runLimits, versions: Math.round(v) } })}
        />
        <NumberRow
          label={t.quota}
          unit={t.gib}
          value={form.orgQuotaBytes / GIB}
          min={0.001}
          max={ARTIFACT_LIMITS.orgQuotaBytesCeiling / GIB}
          disabled={disabled}
          message={t.range(0.001, ARTIFACT_LIMITS.orgQuotaBytesCeiling / GIB)}
          onChange={(v) => change({ orgQuotaBytes: Math.max(MIB, Math.round(v * GIB)) })}
        />
      </Fragment>
      <FormRow label={t.links} hint={t.linksHint}>
        <Link to="/admin/public-links" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          {t.linksGo}
        </Link>
      </FormRow>
      <FormRow label={t.usage} hint={t.quotaHint}>
        <Link
          to="/admin/artifact-usage"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {t.usageGo}
        </Link>
      </FormRow>
    </SettingsSection>
  );
}
