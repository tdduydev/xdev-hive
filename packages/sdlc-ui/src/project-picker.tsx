import { type Project, SDLC_MAX_PROJECTS } from "@xdev-hive/contracts";
import { Label } from "@xdev-hive/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { useId } from "react";
import { useText } from "./env.tsx";

export interface ProjectPickerValue {
  primary: string;
  participants: string[];
}

export interface ProjectPickerProps {
  /** Dự án người xem có `sdlc.write`; app chủ hoặc màn tạo đã lọc theo quyền. */
  projects: Project[];
  value: ProjectPickerValue;
  onChange: (value: ProjectPickerValue) => void;
  /** Tên đội để người chọn biết dự án tham gia cần đội nào duyệt (D21). */
  teamName?: ((teamId: string) => string | undefined) | undefined;
  disabled?: boolean | undefined;
}

const enabled = (p: Project) => !!p.settings.sdlc?.enabled;

/**
 * Chọn dự án chính và dự án tham gia (D19). Dự án chưa bật AI SDLC hiện nhưng khoá, để người dùng biết vì sao không chọn
 * được thay vì tưởng mình thiếu quyền.
 */
export function ProjectPicker({ projects, value, onChange, teamName, disabled = false }: ProjectPickerProps) {
  const t = useText().newItem;
  const ids = useId();
  const full = value.participants.length >= SDLC_MAX_PROJECTS - 1;
  const others = projects.filter((p) => p.id !== value.primary);

  const setPrimary = (primary: string) =>
    onChange({ primary, participants: value.participants.filter((id) => id !== primary) });
  const toggle = (id: string, on: boolean) =>
    onChange({
      ...value,
      participants: on ? [...value.participants, id] : value.participants.filter((p) => p !== id),
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${ids}-primary`}>{t.primaryLabel}</Label>
        <NativeSelect
          id={`${ids}-primary`}
          value={value.primary}
          disabled={disabled}
          onChange={(e) => setPrimary(e.target.value)}
          aria-describedby={`${ids}-primary-hint`}
        >
          <NativeSelectOption value="">{t.pickProject}</NativeSelectOption>
          {projects.map((p) => (
            <NativeSelectOption key={p.id} value={p.id} disabled={!enabled(p)}>
              {enabled(p) ? p.key : `${p.key} (${t.notEnabled})`}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <p id={`${ids}-primary-hint`} className="text-xs text-muted-foreground">
          {t.primaryHint}
        </p>
      </div>
      <fieldset className="flex flex-col gap-1" disabled={disabled || !value.primary}>
        <legend className="mb-1 text-sm font-medium">{t.partsLabel}</legend>
        <ul className="flex flex-col gap-1">
          {others.map((p) => {
            const on = value.participants.includes(p.id);
            const locked = !enabled(p) || (!on && full);
            const team = teamName?.(p.teamId);
            return (
              <li key={p.id}>
                <label className="flex min-h-9 items-center gap-2 rounded-md px-2 text-sm has-disabled:opacity-60 hover:bg-muted">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={locked}
                    onChange={(e) => toggle(p.id, e.target.checked)}
                  />
                  <span className="font-mono">{p.key}</span>
                  {team && <span className="text-xs text-muted-foreground">{team}</span>}
                  {!enabled(p) && <span className="ml-auto text-xs text-muted-foreground">{t.notEnabled}</span>}
                </label>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted-foreground">{t.partsHint(SDLC_MAX_PROJECTS)}</p>
      </fieldset>
    </div>
  );
}
