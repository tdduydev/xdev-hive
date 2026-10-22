import type { Deploy, DeployVersion } from "@xdev-hive/contracts";
import { Pill } from "@xdev-hive/ui/pill";
import { DEPLOY_ORIGIN_LABEL } from "@/lib/delivery-text.ts";
import { type Dict, useT } from "@/lib/i18n.ts";

const text: Dict<{ healthy: string; unhealthy: string; none: string }> = {
  vi: { healthy: "Khoẻ", unhealthy: "Không khoẻ", none: "Chưa có phiên bản" },
  en: { healthy: "Healthy", unhealthy: "Unhealthy", none: "No version yet" },
};

/** SHA đầy đủ quá dài cho ô bảng; 7 ký tự như git hiển thị. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/** Người của lần triển khai: người bấm trên Hive, hoặc nhãn "Ngoài Hive" kèm người kích hoạt theo Jenkins. */
export function deployActor(deploy: Pick<Deploy, "requestedBy" | "origin" | "triggeredBy">): string {
  if (deploy.requestedBy) return deploy.requestedBy.name;
  if (deploy.origin === "external")
    return deploy.triggeredBy
      ? `${DEPLOY_ORIGIN_LABEL.external} · ${deploy.triggeredBy}`
      : DEPLOY_ORIGIN_LABEL.external;
  return "—";
}

/**
 * Phiên bản của một lần triển khai, mỗi thông tin một dòng. Cách triển khai nào không biết trường nào thì trường đó
 * không hiện, để ô bảng không đầy dấu gạch.
 */
export function VersionLines({ version }: { version: DeployVersion }) {
  const t = useT(text);
  const lines: { key: string; value: string; mono?: boolean }[] = [];
  if (version.commit) lines.push({ key: "commit", value: shortSha(version.commit), mono: true });
  if (version.tag) lines.push({ key: "tag", value: version.tag, mono: true });
  if (version.jenkinsBuild !== null) lines.push({ key: "build", value: `#${version.jenkinsBuild}`, mono: true });
  if (version.image) lines.push({ key: "image", value: version.image, mono: true });
  if (version.revision) lines.push({ key: "revision", value: shortSha(version.revision), mono: true });
  if (lines.length === 0) return <span className="text-muted-foreground">{t.none}</span>;
  return (
    <ul className="grid gap-0.5">
      {lines.map((line) => (
        // `title` cho image dài bị cắt ở ô hẹp; chữ đầy đủ vẫn nằm trong DOM cho trình đọc màn hình.
        <li
          key={line.key}
          title={line.value}
          className={line.mono ? "truncate font-mono text-xs text-foreground" : "truncate text-foreground"}
        >
          {line.value}
        </li>
      ))}
    </ul>
  );
}

export function HealthPill({ health }: { health: Deploy["health"] }) {
  const t = useT(text);
  if (!health) return null;
  return (
    <Pill tone={health.ok ? "ok" : "bad"} dot title={health.message}>
      {health.ok ? t.healthy : t.unhealthy}
    </Pill>
  );
}
