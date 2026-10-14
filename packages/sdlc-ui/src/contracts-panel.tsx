import { useMutation, useQueryClient } from "@tanstack/react-query";
import { contractFormat, type SdlcArtifactView, type SdlcItemDetail, sdlcSlugId } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { Label } from "@xdev-hive/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { useId, useState } from "react";
import { useSdlcEnv, useText } from "./env.tsx";
import { EmptyState } from "./parts.tsx";
import { SyncStatus } from "./sync-status.tsx";

type Format = SdlcArtifactView["contractFormat"] & string;

/**
 * Contract liên repo (D23): bản nguồn ở bên cung cấp, bản sao ở bên dùng, mỗi đội một checkpoint. Contract luôn cần người
 * duyệt nên ở đây không có nhãn tự duyệt.
 */
export function ContractsPanel({ item }: { item: SdlcItemDetail }) {
  const { link } = useSdlcEnv();
  const t = useText().detail;
  const keyOf = (id: string) => item.projectsDetail.find((p) => p.id === id)?.key ?? id;
  const contracts = item.artifacts.filter((a) => a.scope === "contract");
  const canAdd = item.can.write && item.projectsDetail.length > 1 && item.status === "active";

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{t.ctRule}</p>
      {contracts.length === 0 ? (
        <EmptyState title={t.ctEmptyTitle} text={t.ctEmptyText} />
      ) : (
        <ul className="flex flex-col gap-2">
          {contracts.map((c) => (
            <li key={c.id} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-medium">{c.instance}</span>
                {c.contractFormat && <Pill small>{c.contractFormat}</Pill>}
                <Pill tone={c.baselineVersion !== null ? "ok" : "warn"} small dot>
                  {c.baselineVersion !== null ? t.baseline(c.baselineVersion) : t.approval[c.approval]}
                </Pill>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">{t.provider}</dt>
                <dd className="font-mono">{keyOf(c.projectId)}</dd>
                <dt className="text-muted-foreground">{t.consumers}</dt>
                <dd className="font-mono">{c.consumerProjectIds.map(keyOf).join(", ")}</dd>
              </dl>
              <div className="flex flex-wrap gap-3 text-xs">
                {link({ to: { kind: "doc", key: c.docKey }, className: "underline", children: t.openDoc })}
                {c.reviewId &&
                  link({ to: { kind: "review", id: c.reviewId }, className: "underline", children: t.openContract })}
              </div>
              <SyncStatus itemId={item.id} syncs={c.syncs} canManage={item.can.manage} />
            </li>
          ))}
        </ul>
      )}
      {canAdd && <AddContract item={item} />}
    </div>
  );
}

function AddContract({ item }: { item: SdlcItemDetail }) {
  const { api, errorMessage } = useSdlcEnv();
  const t = useText().detail;
  const ids = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [format, setFormat] = useState<Format>("openapi");
  const [provider, setProvider] = useState(item.projectsDetail[0]?.id ?? "");
  const [consumers, setConsumers] = useState<string[]>([]);
  const create = useMutation(
    api.sdlc.contracts.create.mutationOptions({
      onSuccess: () => {
        setName("");
        setConsumers([]);
        void queryClient.invalidateQueries({ queryKey: api.sdlc.key() });
      },
    }),
  );
  const nameOk = sdlcSlugId.safeParse(name).success;
  const picked = consumers.filter((id) => id !== provider);

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (nameOk && picked.length)
          create.mutate({ itemId: item.id, name, format, providerProjectId: provider, consumerProjectIds: picked });
      }}
    >
      <h3 className="text-sm font-semibold">{t.addContract}</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-name`}>{t.ctName}</Label>
          <Input
            id={`${ids}-name`}
            value={name}
            placeholder="refund-api"
            aria-invalid={!!name && !nameOk}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t.ctNameHint}</p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-format`}>{t.format}</Label>
          <NativeSelect id={`${ids}-format`} value={format} onChange={(e) => setFormat(e.target.value as Format)}>
            {contractFormat.options.map((f) => (
              <NativeSelectOption key={f} value={f}>
                {f}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-provider`}>{t.provider}</Label>
          <NativeSelect id={`${ids}-provider`} value={provider} onChange={(e) => setProvider(e.target.value)}>
            {item.projectsDetail.map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {p.key}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="mb-1 text-sm font-medium">{t.consumers}</legend>
        {item.projectsDetail
          .filter((p) => p.id !== provider)
          .map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={consumers.includes(p.id)}
                onChange={(e) =>
                  setConsumers(e.target.checked ? [...consumers, p.id] : consumers.filter((id) => id !== p.id))
                }
              />
              <span className="font-mono">{p.key}</span>
            </label>
          ))}
      </fieldset>
      {create.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(create.error)}
        </p>
      )}
      <Button type="submit" className="self-start" disabled={!nameOk || !picked.length || create.isPending}>
        {t.addContract}
      </Button>
    </form>
  );
}
