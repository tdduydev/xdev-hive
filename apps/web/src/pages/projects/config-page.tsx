import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { EffectiveSetting, OrgEntry } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { useState } from "react";
import { LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { formError } from "@/lib/api-errors.ts";
import { usePermissions, useTeamPermissions } from "@/lib/permissions.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

export function formatValue(value: unknown, notSet: string): string {
  if (value === null || value === undefined) return notSet;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function parseInput(raw: string): { value: unknown } | null {
  if (!raw.trim()) return null;
  try {
    return { value: JSON.parse(raw.trim()) };
  } catch {
    return { value: raw.trim() };
  }
}

const labels: Record<string, string> = {
  "agent.permissionMode": "Quyền CLI",
  "limits.perRunUsd": "Ngân sách mỗi lượt chạy (USD)",
  "merge.mode": "Chế độ gộp mã",
  "merge.requireCi": "Bắt buộc CI đạt",
};

const choices: Record<string, { value: string; label: string }[]> = {
  "agent.permissionMode": [
    { value: "workspace", label: "Trong thư mục làm việc" },
    { value: "full", label: "Toàn quyền" },
  ],
  "merge.mode": [
    { value: "review", label: "Cần người duyệt" },
    { value: "auto", label: "Tự động" },
  ],
  "merge.requireCi": [
    { value: "true", label: "Có" },
    { value: "false", label: "Không" },
  ],
};

function displayValue(key: string, value: unknown) {
  return choices[key]?.find((choice) => choice.value === String(value))?.label ?? formatValue(value, "Không giới hạn");
}

function ConfigValueInput({
  settingKey,
  raw,
  onChange,
  disabled,
  allowDefault = false,
}: {
  settingKey: string;
  raw: string;
  onChange: (value: string) => void;
  disabled: boolean;
  allowDefault?: boolean;
}) {
  const options = choices[settingKey];
  const props = { "aria-label": `Giá trị: ${settingKey}`, value: raw, disabled };
  return options ? (
    <NativeSelect {...props} onChange={(e) => onChange(e.target.value)}>
      {allowDefault && <option value="">Dùng mặc định</option>}
      {options.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </NativeSelect>
  ) : (
    <Input {...props} type="number" min="0.01" max="100000" step="any" onChange={(e) => onChange(e.target.value)} />
  );
}

export function OrgConfigPage() {
  const { api } = useOrg();
  const can = usePermissions();
  const entries = useQuery(api.layeredConfig.orgGet.queryOptions({ input: {} }));
  return (
    <>
      <PageHeader
        title="Cấu hình tổ chức"
        description="Giá trị dùng chung cho mọi dự án. Bật khoá để dự án không ghi đè cài đặt đó."
      />
      <PageBody>
        <Link to="/admin/policies" className="text-primary text-sm">
          Chính sách agent
        </Link>
        {entries.isError ? (
          <LoadFailure error={entries.error} retry={() => entries.refetch()} />
        ) : !entries.data ? (
          <TableSkeleton rows={4} columns={2} />
        ) : (
          <div className="mt-4 grid gap-3">
            {entries.data.entries.map((entry) => (
              <OrgRow key={`${entry.key}:${entry.version}`} entry={entry} canEdit={can("policies.write")} />
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}

function OrgRow({ entry, canEdit }: { entry: OrgEntry; canEdit: boolean }) {
  const { api } = useOrg();
  const client = useQueryClient();
  const [raw, setRaw] = useState(formatValue(entry.value, ""));
  const [locked, setLocked] = useState(entry.locked);
  const save = useMutation({
    mutationFn: () =>
      api.layeredConfig.orgSet.call({
        key: entry.key,
        value: parseInput(raw)?.value ?? null,
        locked,
        expectedVersion: entry.version,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: api.layeredConfig.key() });
      await client.invalidateQueries({ queryKey: api.policies.key() });
    },
  });
  return (
    <section aria-label={labels[entry.key]} className="grid gap-3 rounded-lg border border-border bg-card p-4">
      <h2 className="font-semibold">{labels[entry.key]}</h2>
      {entry.key === "limits.perRunUsd" && (
        <p className="text-muted-foreground text-sm">Số USD dương; để trống để không giới hạn.</p>
      )}
      <ConfigValueInput
        settingKey={entry.key}
        raw={raw}
        onChange={setRaw}
        disabled={!canEdit || save.isPending}
        allowDefault
      />
      {entry.key === "agent.permissionMode" && raw === "full" && (
        <Alert>
          Toàn quyền cho phép CLI truy cập ngoài thư mục làm việc. Chỉ người có quyền cấp toàn quyền được lưu.
        </Alert>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          role="switch"
          aria-checked={locked}
          aria-label={`Khoá: ${entry.key}`}
          checked={locked}
          onChange={(e) => setLocked(e.target.checked)}
          disabled={!canEdit || save.isPending}
        />
        Khoá với dự án
      </label>
      {canEdit && (
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          Lưu
        </Button>
      )}
      {save.isError && <Alert variant="destructive">{formError(save.error).message}</Alert>}
    </section>
  );
}

export function ProjectConfigPage() {
  const { api } = useOrg();
  const { key } = useParams({ from: "/session/app/in-org/projects/$key/config" });
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const project = projects.data?.find((p) => p.key === key);
  return (
    <>
      <PageHeader title="Cấu hình dự án" description="Giá trị kế thừa từ tổ chức và giá trị riêng của dự án." />
      <PageBody>
        <Link to="/projects/$key/settings" params={{ key }} className="text-primary text-sm">
          Cài đặt dự án
        </Link>
        {projects.isError ? (
          <LoadFailure error={projects.error} retry={() => projects.refetch()} />
        ) : project ? (
          <ProjectConfigSection projectId={project.id} teamId={project.teamId} />
        ) : projects.isPending ? (
          <TableSkeleton rows={4} columns={2} />
        ) : (
          <p>Không tìm thấy dự án.</p>
        )}
      </PageBody>
    </>
  );
}

export function ProjectConfigSection({
  projectId,
  teamId,
  canEdit: allowed,
}: {
  projectId: string;
  teamId: string;
  canEdit?: boolean;
}) {
  const { api, org } = useOrg();
  const can = useTeamPermissions(teamId);
  const effective = useQuery(api.layeredConfig.effective.queryOptions({ input: { projectId } }));
  const canEdit = allowed ?? (org.role === "owner" || org.role === "admin" || can("projects.settings"));
  return (
    <section aria-label="Kế thừa cấu hình" className="grid gap-3">
      <h2 className="font-semibold">Cấu hình tổ chức và dự án</h2>
      <p className="text-muted-foreground text-sm">
        Dự án ghi đè giá trị tổ chức khi chưa bị khoá. Giá trị riêng đã lưu được giữ lại khi tổ chức khoá và áp dụng lại
        khi mở khoá.
      </p>
      {effective.isError ? (
        <LoadFailure error={effective.error} retry={() => effective.refetch()} />
      ) : !effective.data ? (
        <TableSkeleton rows={4} columns={2} />
      ) : (
        effective.data.settings.map((setting) => (
          <ProjectRow
            key={`${setting.key}:${effective.data.configVersion}`}
            projectId={projectId}
            setting={setting}
            canEdit={canEdit}
          />
        ))
      )}
    </section>
  );
}

function ProjectRow({
  projectId,
  setting,
  canEdit,
}: {
  projectId: string;
  setting: EffectiveSetting;
  canEdit: boolean;
}) {
  const { api } = useOrg();
  const client = useQueryClient();
  const own = setting.chain.find((s) => s.layer === "project");
  const [raw, setRaw] = useState(formatValue(own?.value ?? setting.value, ""));
  const save = useMutation({
    mutationFn: (value: unknown) => api.layeredConfig.projectSet.call({ projectId, key: setting.key, value }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: api.layeredConfig.key() });
      await client.invalidateQueries({ queryKey: api.projects.key() });
    },
  });
  const disabled = !canEdit || setting.locked || save.isPending;
  return (
    <section aria-label={labels[setting.key]} className="grid gap-3 rounded-lg border border-border bg-card p-4">
      <h3 className="font-semibold">{labels[setting.key]}</h3>
      <div className="flex flex-wrap gap-2">
        <Pill tone={setting.locked ? "warn" : "neutral"}>
          {setting.locked
            ? "Bị tổ chức khoá"
            : setting.source?.layer === "project"
              ? "Được ghi đè"
              : setting.source?.layer === "org"
                ? "Kế thừa tổ chức"
                : "Mặc định"}
        </Pill>
        <span className="text-sm">Hiệu lực: {displayValue(setting.key, setting.value)}</span>
      </div>
      {own && setting.locked && (
        <p className="text-muted-foreground text-sm">
          Giá trị riêng đang tạm ngưng: {displayValue(setting.key, own.value)}
        </p>
      )}
      <ConfigValueInput settingKey={setting.key} raw={raw} onChange={setRaw} disabled={disabled} />
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={disabled || !parseInput(raw) || parseInput(raw)?.value === null}
            onClick={() => save.mutate(parseInput(raw)?.value)}
          >
            Lưu giá trị riêng
          </Button>
          <Button variant="outline" disabled={disabled || !own} onClick={() => save.mutate(null)}>
            Dùng giá trị kế thừa
          </Button>
        </div>
      )}
      {save.isError && <Alert variant="destructive">{formError(save.error).message}</Alert>}
    </section>
  );
}
