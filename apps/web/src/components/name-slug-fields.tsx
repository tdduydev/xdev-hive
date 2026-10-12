import { slug as slugSchema } from "@xdev-hive/contracts";
import { useState } from "react";
import { type Dict, getLang, useT } from "../lib/i18n.ts";
import { slugify } from "../lib/slug.ts";
import { Field, FieldError, FieldHint, FieldLabel } from "./ui/field.tsx";
import { Input } from "./ui/input.tsx";

const text: Dict<{
  slug: string;
  required: string;
  invalidSlug: string;
}> = {
  vi: {
    slug: "Định danh",
    required: "Nhập tên.",
    invalidSlug: "Chỉ dùng chữ thường, số và dấu gạch ngang.",
  },
  en: {
    slug: "Slug",
    required: "Enter a name.",
    invalidSlug: "Use lowercase letters, digits and hyphens only.",
  },
};

export interface NameSlugErrors {
  name?: string | undefined;
  slug?: string | undefined;
}

/** Lỗi nhập của tên và định danh, kiểm trên máy trước khi gửi để báo ngay cạnh ô. Hub vẫn kiểm lại. */
export function checkNameSlug(form: FormData): NameSlugErrors {
  const name = String(form.get("name") ?? "").trim();
  const slug = slugSchema.safeParse(String(form.get("slug") ?? ""));
  return {
    name: name ? undefined : text[getLang()].required,
    slug: slug.success ? undefined : getLang() === "en" ? text.en.invalidSlug : slug.error.issues[0]?.message,
  };
}

export interface NameSlugFieldsProps {
  nameLabel: string;
  namePlaceholder?: string | undefined;
  /** Phần đứng trước định danh, như "hive.example.com/" hoặc "thanh-toan/". */
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
export function NameSlugFields(props: NameSlugFieldsProps) {
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
        <div className="flex">
          {props.slugPrefix && (
            <span className="flex items-center rounded-l-md border border-r-0 border-input bg-muted px-2.5 font-mono text-xs whitespace-nowrap text-muted-foreground">
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
            className={props.slugPrefix ? "rounded-l-none" : ""}
          />
        </div>
        {errors.slug ? <FieldError>{errors.slug}</FieldError> : <FieldHint>{props.slugHint}</FieldHint>}
      </Field>
    </>
  );
}
