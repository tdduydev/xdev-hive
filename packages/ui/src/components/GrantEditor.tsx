// One space's grant (roadmap 25): a role, or the permissions picked one by one, for the Người dùng & quyền dialog and
// a project's Thành viên page. A lead edits members up to their own permissions; the rest stay greyed out.
import { useState } from "react";
import { cn } from "cn";
import { grantPermissions, grantRole, PERMISSIONS, PROJECT_ROLES, ROLE_PERMISSIONS, type Grant, type Permission, type ProjectRole } from "@xdev-hive/core";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Badge } from "#ui/components/common.tsx";
import { useT, type TFunction } from "#ui/i18n/index.tsx";

/** How the permissions sit on screen. */
export const PERMISSION_GROUPS: Array<{ id: "work" | "docs" | "memory" | "chat" | "project"; permissions: Permission[] }> = [
  { id: "work", permissions: ["view", "taskWork", "taskManage", "runDispatch", "qaVerify", "codeReview"] },
  { id: "docs", permissions: ["docPropose", "docEdit", "docApprove", "contextEdit"] },
  { id: "memory", permissions: ["memoryWrite", "memoryApprove"] },
  { id: "chat", permissions: ["chatUse", "chatApprove"] },
  { id: "project", permissions: ["projectSettings", "membersManage"] },
];

/** A set of permissions as the role it is, or as itself. */
export function grantOf(permissions: Iterable<Permission>): Grant | null {
  const set = new Set(permissions);
  if (!set.size) return null;
  // Every other permission needs the space to be visible.
  set.add("view");
  const role = PROJECT_ROLES.find((r) => ROLE_PERMISSIONS[r].length === set.size && ROLE_PERMISSIONS[r].every((p) => set.has(p)));
  return role ?? { permissions: PERMISSIONS.filter((p) => set.has(p)) };
}

/** "Reviewer", or "Tuỳ chỉnh · 6 quyền". */
export function grantLabel(t: TFunction, grant: Grant | null | undefined): string {
  const role = grantRole(grant);
  if (role === null) return t("projectRole.none");
  return role === "custom" ? `${t("projectRole.custom")} · ${grantPermissions(grant).size}` : t(`projectRole.${role}`);
}

export const ROLE_TONE: Record<ProjectRole | "custom", "neutral" | "info" | "accent" | "warn"> = { viewer: "neutral", member: "info", qa: "accent", reviewer: "warn", lead: "accent", custom: "info" };

export function GrantBadge({ grant, label, className }: { grant: Grant | null | undefined; label?: string; className?: string }) {
  const t = useT();
  const role = grantRole(grant);
  return (
    <Badge tone={role ? ROLE_TONE[role] : "neutral"} className={cn("h-auto max-w-full font-mono text-[11px] whitespace-normal wrap-anywhere", className)}>
      {label ? `${label} · ` : ""}
      {grantLabel(t, grant)}
    </Badge>
  );
}

const NONE = "__none";
const CUSTOM = "__custom";

export function GrantEditor({
  value,
  onChange,
  noneLabel,
  max,
  disabled,
  label,
}: {
  value: Grant | null;
  onChange: (grant: Grant | null) => void;
  /** What "no grant" means here (no access, or "from projects" for Chung). */
  noneLabel?: string;
  /** The permissions the person editing may give (a lead's own); the rest cannot be ticked. */
  max?: ReadonlySet<Permission>;
  disabled?: boolean;
  /** For screen readers: whose grant on which space. */
  label: string;
}) {
  const t = useT();
  const role = grantRole(value);
  const has = grantPermissions(value);
  const [open, setOpen] = useState(role === "custom");
  const allowed = (p: Permission) => !max || max.has(p);
  const roleOk = (r: ProjectRole) => ROLE_PERMISSIONS[r].every(allowed);
  const toggle = (p: Permission, on: boolean) => {
    const next = new Set(has);
    if (on) next.add(p);
    else next.delete(p);
    // Without seeing the space nothing else means anything.
    if (p === "view" && !on) next.clear();
    onChange(grantOf(next));
  };
  return (
    <div className="@container flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          size="sm"
          aria-label={label}
          disabled={disabled}
          value={role === null ? NONE : role === "custom" ? CUSTOM : role}
          onChange={(e) => {
            const v = e.target.value;
            if (v === CUSTOM) return setOpen(true);
            onChange(v === NONE ? null : (v as ProjectRole));
          }}
        >
          <NativeSelectOption value={NONE}>{noneLabel ?? t("projectRole.none")}</NativeSelectOption>
          {PROJECT_ROLES.map((r) => (
            <NativeSelectOption key={r} value={r} disabled={!roleOk(r)}>
              {t(`projectRole.${r}`)}
            </NativeSelectOption>
          ))}
          <NativeSelectOption value={CUSTOM}>{role === "custom" ? grantLabel(t, value) : t("projectRole.custom")}</NativeSelectOption>
        </NativeSelect>
        <button
          type="button"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          className="cursor-pointer text-xs text-fg-link underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-60"
        >
          {t("members.details")}
        </button>
      </div>
      {open ? (
        <div className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-md border border-line-subtle bg-subtle p-2.5 @md:grid-cols-2 @3xl:grid-cols-3">
          {PERMISSION_GROUPS.map((g) => (
            <fieldset key={g.id} className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
              <legend className="mb-0.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">{t(`permissionGroup.${g.id}`)}</legend>
              {g.permissions.map((p) => (
                <label key={p} className={cn("flex cursor-pointer items-start gap-2 text-xs", (!allowed(p) || disabled) && "cursor-default opacity-55")} title={t(`permissionHint.${p}`)}>
                  <Checkbox className="mt-px" checked={has.has(p)} disabled={disabled || !allowed(p)} onCheckedChange={(v) => toggle(p, v === true)} />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium text-fg-strong">{t(`permission.${p}`)}</span>
                    <span className="text-[11px]/4 text-fg-muted">{t(`permissionHint.${p}`)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** What each role holds, as a legend above a grants editor. */
export function RoleLegend() {
  const t = useT();
  return (
    <ul className="m-0 grid list-none gap-1 p-0 text-xs text-muted-foreground sm:grid-cols-2">
      {PROJECT_ROLES.map((r) => (
        <li key={r} className="rounded-md bg-muted px-2 py-1.5">
          <span className="font-semibold text-foreground">{t(`projectRole.${r}`)}</span>: {t(`projectRoleHint.${r}`)}
        </li>
      ))}
    </ul>
  );
}
