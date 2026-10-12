import { slug as slugSchema } from "@xdev-hive/contracts";
import { Input } from "@xdev-hive/ui/input";
import { useState } from "react";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { type Dict, getLang, useT } from "@/lib/i18n.ts";
import { slugify } from "@/lib/slug.ts";

const text: Dict<{ slug: string; nameRequired: string; invalidSlug: string }> = {
  vi: { slug: "Định danh", nameRequired: "Nhập tên.", invalidSlug: "Chỉ dùng chữ thường, số và dấu gạch ngang." },
  en: { slug: "Slug", nameRequired: "Enter a name.", invalidSlug: "Use lowercase letters, digits and hyphens only." },
};

export interface NameSlugErrors {
  name?: string | undefined;
  slug?: string | undefined;
}

/** Lỗi nhập của tên và định danh, kiểm trên máy trước khi gửi để báo ngay cạnh ô. Hub vẫn kiểm lại. */
export function checkNameSlug(form: FormData): NameSlugErrors {
  const t = text[getLang()];
  const name = String(form.get("name") ?? "").trim();
  const slug = slugSchema.safeParse(String(form.get("slug") ?? ""));
  return {
    name: name ? undefined : t.nameRequired,
    slug: slug.success ? undefined : getLang() === "vi" ? slug.error.issues[0]?.message : t.invalidSlug,
  };
}

export interface OnboardingNameFieldsProps {
  nameLabel: string;
  namePlaceholder?: string | undefined;
  /** Phần đứng trước định danh, như "hive.xdev.asia/" hoặc "thanh-toan/". */
  slugPrefix?: string | undefined;
  slugPlaceholder?: string | undefined;
  slugHint: string;
  errors: NameSlugErrors;
  disabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
}

/**
 * Hai ô Tên và Định danh. Định danh tự điền theo tên cho tới khi người dùng sửa tay, vì phần lớn người dùng chỉ
 * muốn bản không dấu của tên. Giá trị đọc bằng FormData qua `name="name"` và `name="slug"`.
 */
export function OnboardingNameFields(props: OnboardingNameFieldsProps) {
  const t = useT(text);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  const { errors } = props;
  return (
    <>
      <Field invalid={errors.name !== undefined}>
        <FieldLabel>{props.nameLabel}</FieldLabel>
        <Input
          name="name"
          value={name}
          onValueChange={setName}
          placeholder={props.namePlaceholder}
          disabled={props.disabled}
          autoFocus={props.autoFocus}
          autoComplete="off"
        />
        {errors.name && <FieldError>{errors.name}</FieldError>}
      </Field>
      <Field invalid={errors.slug !== undefined}>
        <FieldLabel>{t.slug}</FieldLabel>
        <div className="flex min-w-0">
          {props.slugPrefix && (
            <span className="flex max-w-32 items-center truncate rounded-l-md border border-r-0 border-input bg-muted px-2.5 font-mono text-xs whitespace-nowrap text-muted-foreground">
              {props.slugPrefix}
            </span>
          )}
          <Input
            name="slug"
            value={slug ?? slugify(name)}
            onValueChange={setSlug}
            placeholder={props.slugPlaceholder}
            disabled={props.disabled}
            autoComplete="off"
            spellCheck={false}
            className={props.slugPrefix ? "min-w-0 rounded-l-none font-mono" : "font-mono"}
          />
        </div>
        {errors.slug ? <FieldError>{errors.slug}</FieldError> : <FieldHint>{props.slugHint}</FieldHint>}
      </Field>
    </>
  );
}
