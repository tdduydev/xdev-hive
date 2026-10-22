import type { JenkinsParam } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { type FormEvent, useState } from "react";
import { Field, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";

export type ParamValues = Record<string, string | boolean>;

const text: Dict<{
  none: string;
  other: (rawType: string) => string;
  submit: string;
  submitting: string;
  cancel: string;
}> = {
  vi: {
    none: "Job này không khai tham số. Build chạy với cấu hình mặc định.",
    other: (raw) => `Kiểu ${raw}: nhập dạng chữ.`,
    submit: "Build",
    submitting: "Đang gửi…",
    cancel: "Huỷ",
  },
  en: {
    none: "This job declares no parameters. The build runs with its defaults.",
    other: (raw) => `Type ${raw}: enter as text.`,
    submit: "Build",
    submitting: "Sending…",
    cancel: "Cancel",
  },
};

/** Giá trị ban đầu theo mặc định khai báo; mật khẩu để trống vì hub không trả giá trị mặc định. */
export function initialParamValues(params: readonly JenkinsParam[]): ParamValues {
  const values: ParamValues = {};
  for (const p of params) {
    if (p.type === "boolean") values[p.name] = p.default ?? false;
    else if (p.type === "password") values[p.name] = "";
    else if (p.type === "choice") values[p.name] = p.default ?? p.choices[0] ?? "";
    else values[p.name] = p.default ?? "";
  }
  return values;
}

/**
 * Form "Build with Parameters" sinh từ `parameterDefinitions` của job. Mật khẩu để trống thì không gửi, để Jenkins dùng
 * giá trị đã khai ở job.
 */
export function JenkinsParamsForm({
  params,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  params: readonly JenkinsParam[];
  pending: boolean;
  error: string | null;
  onSubmit: (values: ParamValues) => void;
  onCancel: () => void;
}) {
  const t = useT(text);
  const [values, setValues] = useState<ParamValues>(() => initialParamValues(params));
  const set = (name: string, value: string | boolean) => setValues((prev) => ({ ...prev, [name]: value }));

  function submit(event: FormEvent) {
    event.preventDefault();
    const out: ParamValues = {};
    for (const p of params) {
      const v = values[p.name];
      if (v === undefined) continue;
      if (p.type === "password" && v === "") continue;
      out[p.name] = v;
    }
    onSubmit(out);
  }

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      {params.length === 0 && <p className="text-sm text-muted-foreground">{t.none}</p>}
      {params.map((p) => (
        <ParamField
          key={p.name}
          param={p}
          value={values[p.name]}
          onChange={(v) => set(p.name, v)}
          otherHint={t.other}
        />
      ))}
      {error && <Alert variant="destructive">{error}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t.cancel}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? t.submitting : t.submit}
        </Button>
      </div>
    </form>
  );
}

function ParamField({
  param,
  value,
  onChange,
  otherHint,
}: {
  param: JenkinsParam;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
  otherHint: (rawType: string) => string;
}) {
  const description = param.description ?? undefined;
  const str = typeof value === "string" ? value : "";
  if (param.type === "boolean") {
    return (
      <Field>
        <label className="flex min-h-8 items-center gap-2 text-sm font-medium text-foreground">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {param.name}
        </label>
        {description && <FieldHint>{description}</FieldHint>}
      </Field>
    );
  }
  return (
    <Field>
      <FieldLabel>{param.name}</FieldLabel>
      {param.type === "choice" ? (
        <NativeSelect aria-label={param.name} value={str} onChange={(e) => onChange(e.target.value)}>
          {param.choices.map((c) => (
            <NativeSelectOption key={c} value={c}>
              {c}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : param.type === "text" ? (
        <Textarea aria-label={param.name} rows={4} value={str} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input
          type={param.type === "password" ? "password" : "text"}
          autoComplete={param.type === "password" ? "new-password" : "off"}
          value={str}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {description && <FieldHint>{description}</FieldHint>}
      {param.type === "other" && <FieldHint>{otherHint(param.rawType)}</FieldHint>}
    </Field>
  );
}
