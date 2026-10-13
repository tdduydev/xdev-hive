import { useQuery } from "@tanstack/react-query";
import { PersonAvatar } from "@/components/person.tsx";
import { fetchHealth, formatBuiltAt, shortVersion } from "@/lib/build-info.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { useMe } from "@/shell/me-context.ts";
import { SignOutButton } from "@/shell/sign-out-button.tsx";

const text: Dict<{ version: (v: string) => string; built: (d: string) => string; title: string }> = {
  vi: { version: (v) => `Phiên bản ${v}`, built: (d) => `build ${d}`, title: "Phiên bản hub và web đang chạy" },
  en: { version: (v) => `Version ${v}`, built: (d) => `built ${d}`, title: "Hub and web version in use" },
};

/** Phiên bản và ngày build của hub (web nằm chung image), để biết đang dùng bản nào khi báo lỗi. */
function BuildInfo() {
  const t = useT(text);
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth, staleTime: 5 * 60_000 });
  if (!health.data) return null;
  const built = formatBuiltAt(health.data.builtAt);
  return (
    <p
      title={`${t.title}: ${health.data.version}${health.data.builtAt ? ` · ${health.data.builtAt}` : ""}`}
      className="px-0.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden"
    >
      {t.version(shortVersion(health.data.version))}
      {built && ` · ${t.built(built)}`}
    </p>
  );
}

/** Chân sidebar: người đang đăng nhập, đăng xuất. Thu gọn còn ảnh đại diện. Giao diện và ngôn ngữ ở Topbar. */
export function UserCard() {
  const me = useMe();
  return (
    <div className="grid gap-2 border-t border-sidebar-border pt-2">
      <div className="flex items-center gap-2.5 px-0.5">
        <PersonAvatar person={me} />
        <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <b className="block truncate text-sm font-medium text-foreground">{me.name}</b>
          <span className="block truncate">
            <small className="text-xs text-muted-foreground">{me.email}</small>
          </span>
        </span>
        <span className="group-data-[collapsible=icon]:hidden">
          <SignOutButton />
        </span>
      </div>
      <BuildInfo />
    </div>
  );
}
