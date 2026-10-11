import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { Brand } from "../components/icons.tsx";
import { InviteForm } from "../components/invite-form.tsx";
import { checkNameSlug, type NameSlugErrors, NameSlugFields } from "../components/name-slug-fields.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Button, buttonClass } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import { formError } from "../lib/api-errors.ts";
import { cx } from "../lib/cx.ts";
import { canInvite } from "../lib/invites.ts";
import { orgStore } from "../lib/org-store.ts";
import { orgsMineQuery } from "../lib/orgs.ts";
import { client } from "../lib/rpc.ts";
import { nextTeamColor } from "../lib/teams.ts";
import { useMe } from "../shell/me-context.ts";
import { type CurrentOrg, useOrgs } from "../shell/org-context.ts";
import { SignOutButton } from "../shell/sign-out-button.tsx";

export interface OnboardingSearch {
  /** Bước 2 (tạo đội) và 3 (mời người); không có là bước 1 (tạo tổ chức). */
  buoc?: "doi" | "moi";
  /** Đội vừa tạo ở bước 2, để bước 3 mở thẳng đội đó. */
  doi?: string;
}

export function validateOnboardingSearch(search: Record<string, unknown>): OnboardingSearch {
  return {
    ...(search.buoc === "doi" || search.buoc === "moi" ? { buoc: search.buoc } : {}),
    ...(typeof search.doi === "string" ? { doi: search.doi } : {}),
  };
}

const STEPS = ["Tổ chức", "Đội đầu tiên", "Mời người"];

function Steps({ current }: { current: number }) {
  return (
    <ol aria-label="Các bước" className="flex flex-wrap items-center gap-2 text-sm text-muted">
      {STEPS.map((label, i) => (
        <li key={label} aria-current={i === current ? "step" : undefined} className="flex items-center gap-1.5">
          {i > 0 && (
            <span aria-hidden="true" className="mr-0.5">
              ·
            </span>
          )}
          <span
            className={cx(
              "grid size-5.5 place-items-center rounded-full border text-2xs font-semibold",
              i === current && "border-accent bg-accent text-on-accent",
              i < current && "border-transparent bg-ok-bg text-ok",
              i > current && "border-line-strong",
            )}
          >
            {i + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

function Heading({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div>
      <h1 className="flex items-center gap-2 font-display text-4xl font-semibold text-ink">{title}</h1>
      <p className="mt-1 text-muted">{children}</p>
    </div>
  );
}

/** Màn 2 của mockup: tạo tổ chức, rồi đội đầu tiên, rồi mời người. Mỗi bước là một trang, tải lại vẫn ở đúng bước. */
export function OnboardingPage() {
  const { buoc, doi } = useSearch({ from: "/session/tao-to-chuc" });
  const { current } = useOrgs();
  const step = buoc === "moi" ? 2 : buoc === "doi" ? 1 : 0;
  return (
    <main className="grid min-h-dvh content-start gap-6 px-4 py-6">
      <div className="mx-auto flex w-full max-w-140 items-center">
        <Brand />
        <span className="ml-auto">
          <SignOutButton />
        </span>
      </div>
      <Card className="mx-auto grid w-full max-w-140 gap-4.5 p-7">
        <Steps current={step} />
        {step === 0 && <OrgStep />}
        {/* Ngay sau khi tạo tổ chức, danh sách tổ chức có thể chưa kịp cập nhật vào trang: chờ thay vì báo lỗi. */}
        {step === 1 &&
          (current ? (
            <TeamStep current={current} />
          ) : (
            <p aria-busy="true" className="text-muted">
              Đang tải…
            </p>
          ))}
        {step === 2 && <InviteStep teamId={doi} />}
      </Card>
    </main>
  );
}

type OrgErrors = NameSlugErrors & { emailDomain?: string | undefined };

function OrgStep() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { orgs } = useOrgs();
  const [errors, setErrors] = useState<OrgErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (input: { name: string; slug: string; emailDomain?: string }) => client.orgs.create(input),
    onSuccess: async (org) => {
      orgStore.set(org.id);
      // Bước sau chỉ mở khi đã thuộc tổ chức, và route kiểm điều đó trên cache: tải lại cache trước khi chuyển bước.
      await queryClient.fetchQuery({ ...orgsMineQuery, staleTime: 0 });
      await navigate({ to: "/tao-to-chuc", search: { buoc: "doi" } });
    },
    onError: (error) => {
      const { field, message } = formError(error);
      if (field === "name" || field === "slug" || field === "emailDomain") setErrors({ [field]: message });
      else setFailure(message);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const local = checkNameSlug(form);
    setErrors(local);
    setFailure(null);
    if (local.name || local.slug) return;
    const emailDomain = String(form.get("emailDomain") ?? "").trim();
    create.mutate({
      name: String(form.get("name")).trim(),
      slug: String(form.get("slug")),
      ...(emailDomain ? { emailDomain } : {}),
    });
  }

  const busy = create.isPending || create.isSuccess;
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-4.5">
      <Heading title="Tạo tổ chức">Tổ chức chứa các đội, hệ thống và dự án. Bạn là chủ sở hữu.</Heading>
      <NameSlugFields
        nameLabel="Tên tổ chức"
        namePlaceholder="Ví dụ: FPT Software xDev"
        slugPrefix={`${window.location.host}/`}
        slugHint="Dùng trong đường dẫn và trong lệnh của agent."
        errors={errors}
        disabled={busy}
        autoFocus
      />
      <Field invalid={errors.emailDomain !== undefined}>
        <FieldLabel>Tên miền email (không bắt buộc)</FieldLabel>
        <Input name="emailDomain" placeholder="congty.vn" disabled={busy} autoComplete="off" spellCheck={false} />
        {errors.emailDomain ? (
          <FieldError>{errors.emailDomain}</FieldError>
        ) : (
          <FieldHint>
            Người có email tên miền này thấy tổ chức khi đăng nhập SSO. Họ vẫn cần được duyệt hoặc mời.
          </FieldHint>
        )}
      </Field>
      {failure && <Alert>{failure}</Alert>}
      <div className="flex justify-end gap-2">
        {orgs.length > 0 && (
          <Link to="/" className={buttonClass({ variant: "ghost" })}>
            Huỷ
          </Link>
        )}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Đang tạo tổ chức…" : "Tiếp: tạo đội"}
        </Button>
      </div>
    </form>
  );
}

function TeamStep({ current: { org, api } }: { current: CurrentOrg }) {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<NameSlugErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const create = useMutation({
    // Người tạo là quản trị đội, để đội có người quản trị ngay và hiện trong danh sách thành viên của đội.
    mutationFn: (input: { name: string; slug: string }) =>
      api.teams.create.call({ ...input, color: nextTeamColor(0), adminUserId: me.id }),
    onSuccess: async (team) => {
      await queryClient.invalidateQueries({ queryKey: api.teams.key() });
      await navigate({ to: "/tao-to-chuc", search: { buoc: "moi", doi: team.id } });
    },
    onError: (error) => {
      const { field, message } = formError(error);
      if (field === "name" || field === "slug") setErrors({ [field]: message });
      else setFailure(message);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const local = checkNameSlug(form);
    setErrors(local);
    setFailure(null);
    if (local.name || local.slug) return;
    create.mutate({ name: String(form.get("name")).trim(), slug: String(form.get("slug")) });
  }

  const busy = create.isPending || create.isSuccess;
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-4.5">
      <Heading title="Tạo đội đầu tiên">
        Đội của {org.name} sở hữu hệ thống và dự án. Bạn là quản trị của đội này.
      </Heading>
      <NameSlugFields
        nameLabel="Tên đội"
        namePlaceholder="Ví dụ: Thanh toán"
        slugPlaceholder="thanh-toan"
        slugHint="Dùng trong đường dẫn và tên hệ thống."
        errors={errors}
        disabled={busy}
        autoFocus
      />
      {failure && <Alert>{failure}</Alert>}
      <div className="flex justify-end gap-2">
        <Link to="/quan-tri/doi" className={buttonClass({ variant: "ghost" })}>
          Để sau
        </Link>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Đang tạo đội…" : "Tiếp: mời người"}
        </Button>
      </div>
    </form>
  );
}

function InviteStep({ teamId }: { teamId: string | undefined }) {
  const { current } = useOrgs();
  const navigate = useNavigate();
  const leave = () => navigate({ to: "/quan-tri/doi", search: teamId ? { doi: teamId } : {} });
  if (!current)
    return (
      <p aria-busy="true" className="text-muted">
        Đang tải…
      </p>
    );
  // Hub chỉ cho quản trị mời người; người đã tạo tổ chức là chủ sở hữu, nhưng tổ chức đang chọn có thể là tổ chức khác.
  if (!canInvite(current.org.role))
    return (
      <div className="grid gap-4.5">
        <Heading title="Mời người">Chỉ quản trị tổ chức mời được người vào {current.org.name}.</Heading>
        <div className="flex justify-end">
          <Button variant="primary" onClick={leave}>
            Vào trang Đội và hệ thống
          </Button>
        </div>
      </div>
    );
  return (
    <InviteForm
      title={
        <Heading title="Mời người">
          Mời đồng nghiệp vào {current.org.name}. Mỗi người nhận một link dùng một lần, hết hạn sau 7 ngày.
        </Heading>
      }
      defaultTeamId={teamId}
      cancelLabel="Để sau"
      doneLabel="Xong: vào trang Đội và hệ thống"
      onClose={leave}
    />
  );
}
