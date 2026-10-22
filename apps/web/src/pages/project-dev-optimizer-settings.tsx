import { NativeSelect } from "@xdev-hive/ui/native-select";
import { useId } from "react";
import { type SectionSave, SettingsSection, SwitchRow } from "@/components/page/settings.tsx";
import { UnitField } from "@/components/page/unit-field.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import type { FieldErrors, SettingsForm } from "@/lib/project-settings.ts";

const text: Dict<{
  title: string;
  hint: string;
  readOnly: string;
  on: string;
  onHint: string;
  level: string;
  levelHint: string;
  off: string;
  balanced: string;
  aggressive: string;
  rtk: string;
  rtkHint: string;
  codegraph: string;
  codegraphHint: string;
  window: string;
  windowHint: string;
  windowPlaceholder: string;
  budget: string;
  budgetHint: string;
  memorySync: string;
  memorySyncHint: string;
  minutes: string;
  minutesHint: string;
  minutesSuffix: string;
}> = {
  vi: {
    title: "Tối ưu máy dev",
    hint: "Chính sách này chỉ áp cho máy dev (mục Tối ưu của app desktop), không đổi run chạy trên hub. Run hub dùng mục Tiết kiệm token ở trên. Máy dev vẫn tự xem trước và chọn áp dụng; mức tích cực luôn cần chọn tay.",
    readOnly: "Chỉ quản trị đội hoặc tổ chức đổi được chính sách này.",
    on: "Đặt chính sách cho dự án",
    onHint: "Tắt thì không có chính sách: mỗi máy dev tự chọn như trước.",
    level: "Mức tối ưu",
    levelHint: "Mức mà máy dev nên dùng cho dự án này.",
    off: "Tắt",
    balanced: "Cân bằng",
    aggressive: "Tích cực",
    rtk: "Dùng RTK trên máy dev",
    rtkHint: "Khuyến nghị bật RTK trên máy dev của dự án này.",
    codegraph: "Dùng CodeGraph trên máy dev",
    codegraphHint: "Khuyến nghị gắn CodeGraph khi máy dev có codegraph.",
    window: "Cửa sổ ngữ cảnh trước khi nén",
    windowHint: "Số token ngữ cảnh trước khi Claude Code nén. Để trống là không ép.",
    windowPlaceholder: "Không ép",
    budget: "Ngân sách ngữ cảnh từ hub",
    budgetHint: "Số token tối đa cho phần ngữ cảnh hub đưa vào máy dev.",
    memorySync: "Tự đồng bộ memory từ hub",
    memorySyncHint: "Máy dev kéo memory đã duyệt của dự án về theo chu kỳ.",
    minutes: "Chu kỳ đồng bộ memory",
    minutesHint: "Từ 15 đến 1.440 phút.",
    minutesSuffix: "phút",
  },
  en: {
    title: "Dev machine optimizer",
    hint: "This policy applies to dev machines only (the Optimize screen of the desktop app) and does not change runs on the hub. Hub runs use the Token saving section above. Dev machines still preview and choose to apply; the aggressive level always needs a manual pick.",
    readOnly: "Only team or organization admins can change this policy.",
    on: "Set a policy for the project",
    onHint: "When off there is no policy: each dev machine chooses by itself, as before.",
    level: "Optimization level",
    levelHint: "The level dev machines should use for this project.",
    off: "Off",
    balanced: "Balanced",
    aggressive: "Aggressive",
    rtk: "Use RTK on dev machines",
    rtkHint: "Recommend RTK on this project's dev machines.",
    codegraph: "Use CodeGraph on dev machines",
    codegraphHint: "Recommend CodeGraph when the dev machine has codegraph.",
    window: "Context window before compaction",
    windowHint: "Context tokens before Claude Code compacts. Leave empty to not enforce.",
    windowPlaceholder: "Not enforced",
    budget: "Context budget from the hub",
    budgetHint: "Maximum tokens of hub context placed on the dev machine.",
    memorySync: "Sync memory from the hub automatically",
    memorySyncHint: "Dev machines pull the project's approved memory on a schedule.",
    minutes: "Memory sync interval",
    minutesHint: "From 15 to 1,440 minutes.",
    minutesSuffix: "min",
  },
};

/** Tiêu đề mục, dùng cho cả mục lục bên trái của trang cài đặt. */
export function useDevOptimizerTitle(): string {
  return useT(text).title;
}

/** Mục "Tối ưu máy dev" của cài đặt dự án (spec 029): chính sách `devOptimizer`, tách khỏi `tokenSaving` của run hub. */
export function ProjectDevOptimizerSettings({
  form,
  set,
  errors,
  canEdit,
  disabled,
  save,
}: {
  form: SettingsForm;
  set: <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => void;
  errors: FieldErrors;
  canEdit: boolean;
  disabled: boolean;
  save: SectionSave | undefined;
}) {
  const t = useT(text);
  const levelId = useId();
  const off = disabled || !form.devOptimizer;
  return (
    <SettingsSection id="devOptimizer" save={save} title={t.title} description={t.hint}>
      {!canEdit && <p className="text-xs text-muted-foreground">{t.readOnly}</p>}
      <SwitchRow
        label={t.on}
        hint={t.onHint}
        checked={form.devOptimizer}
        onChange={(v) => set("devOptimizer", v)}
        disabled={disabled}
      />
      <Field invalid={errors.devLevel !== undefined}>
        <FieldLabel htmlFor={levelId}>{t.level}</FieldLabel>
        <NativeSelect
          id={levelId}
          value={form.devLevel}
          onChange={(e) => set("devLevel", e.currentTarget.value as SettingsForm["devLevel"])}
          disabled={off}
        >
          <option value="off">{t.off}</option>
          <option value="balanced">{t.balanced}</option>
          <option value="aggressive">{t.aggressive}</option>
        </NativeSelect>
        {errors.devLevel ? <FieldError>{errors.devLevel}</FieldError> : <FieldHint>{t.levelHint}</FieldHint>}
      </Field>
      <SwitchRow
        label={t.rtk}
        hint={t.rtkHint}
        checked={form.devRtk}
        onChange={(v) => set("devRtk", v)}
        disabled={off}
      />
      <SwitchRow
        label={t.codegraph}
        hint={t.codegraphHint}
        checked={form.devCodegraph}
        onChange={(v) => set("devCodegraph", v)}
        disabled={off}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <UnitField
          label={t.window}
          hint={t.windowHint}
          error={errors.devCompactWindow}
          value={form.devCompactWindow}
          onChange={(v) => set("devCompactWindow", v)}
          disabled={off}
          inputMode="numeric"
          placeholder={t.windowPlaceholder}
          suffix="token"
        />
        <UnitField
          label={t.budget}
          hint={t.budgetHint}
          error={errors.devContextBudget}
          value={form.devContextBudget}
          onChange={(v) => set("devContextBudget", v)}
          disabled={off}
          inputMode="numeric"
          suffix="token"
        />
      </div>
      <SwitchRow
        label={t.memorySync}
        hint={t.memorySyncHint}
        checked={form.devMemoryAutoSync}
        onChange={(v) => set("devMemoryAutoSync", v)}
        disabled={off}
      />
      <UnitField
        label={t.minutes}
        hint={t.minutesHint}
        error={errors.devMemorySyncMinutes}
        value={form.devMemorySyncMinutes}
        onChange={(v) => set("devMemorySyncMinutes", v)}
        disabled={off || !form.devMemoryAutoSync}
        inputMode="numeric"
        suffix={t.minutesSuffix}
      />
    </SettingsSection>
  );
}
