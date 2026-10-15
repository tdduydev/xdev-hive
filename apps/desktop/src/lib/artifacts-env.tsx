import { ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ArtifactsEnv,
  type ArtifactsLink,
  type ArtifactsOfflineCache,
  ArtifactsProvider,
  type FixRequest,
  FixRequestDialog,
  PublicLinkDialog,
} from "@xdev-hive/artifacts-ui";
import type { ArtifactSummary, ArtifactTheme, Contract } from "@xdev-hive/contracts";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { accountStatus, profileOf, useLinkedAccount } from "@/lib/account.ts";
import { cachedFrameUrl, cacheGet, cachePut } from "@/lib/artifact-cache.ts";
import { queryClient } from "@/lib/hub-query.tsx";
import { hub } from "@/lib/hub-rpc.ts";
import { useLang } from "@/lib/i18n.ts";
import { can } from "@/lib/nav.ts";
import { errorText, invoke } from "@/lib/tauri.ts";

/** Hub trả lời được thì app online; Rust không tới được hub (mạng, hub tắt) thì offline và đọc từ bộ đệm (D17). */
export interface ArtifactsProbe {
  reachable: boolean;
  /** Hub có nhóm route `artifacts`: hub cũ trả 404 nên menu ẩn mục Artifact. */
  capable: boolean;
}

export const PROBE_KEY = ["desktop", "artifacts-probe"] as const;
export const PROBE_INTERVAL_MS = 15_000;

export async function probeArtifacts(): Promise<ArtifactsProbe> {
  try {
    await hub.artifacts.settings();
    return { reachable: true, capable: true };
  } catch (error) {
    // Lỗi từ Rust (hub không tới được) là chuỗi hay Error thường; lỗi có mã HTTP nghĩa là hub đã trả lời.
    if (!(error instanceof ORPCError)) return { reachable: false, capable: true };
    // Chỉ 404 mới là "hub không có artifacts": lỗi khác (401, 5xx) chưa đủ để ẩn menu.
    return { reachable: true, capable: error.status !== 404 };
  }
}

const probeQuery = {
  queryKey: PROBE_KEY,
  queryFn: probeArtifacts,
  refetchInterval: PROBE_INTERVAL_MS,
  staleTime: 0,
} as const;

/** Trạng thái kết nối cho màn artifact; chưa dò xong thì coi là online để không loé banner offline lúc mở màn. */
export function useArtifactsProbe(): ArtifactsProbe {
  const probe = useQuery(probeQuery);
  return probe.data ?? { reachable: true, capable: true };
}

/**
 * Hub có artifacts không, cho menu (AppShell nằm ngoài QueryClientProvider nên đọc thẳng queryClient). `undefined` là
 * chưa biết: chưa liên kết tài khoản hay chưa dò xong thì mục vẫn hiện, để người dùng thấy lời mời kết nối.
 */
export function useArtifactsCapability(linked: boolean): boolean | undefined {
  const [capable, setCapable] = useState<boolean>();
  useEffect(() => {
    if (!linked) return setCapable(undefined);
    let live = true;
    void queryClient
      .fetchQuery({ ...probeQuery, staleTime: 60_000 })
      .then((probe) => live && setCapable(probe.capable))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [linked]);
  return capable;
}

/**
 * CSP của app chỉ cho khung `hive-artifact://` (tauri.conf.json), nên vé khung của hub không nạp được. Thay vì sửa
 * `artifacts-ui`, đổi lời gọi `artifacts.frameUrl`: lấy tài liệu khung do hub dựng, ghi vào bộ đệm rồi trả URL của
 * giao thức app. Cùng một đường cho online và offline, nên khung không khác nhau giữa hai chế độ.
 */
export function withCachedFrames(client: ContractRouterClient<Contract>): ContractRouterClient<Contract> {
  const artifacts = new Proxy(client.artifacts, {
    get(target, prop) {
      if (prop !== "frameUrl") return Reflect.get(target, prop);
      return async (input: { id: string; version: number; theme?: ArtifactTheme }) => {
        const theme = input.theme ?? "light";
        const [detail, frame] = await Promise.all([
          client.artifacts.get({ id: input.id, version: input.version }),
          client.artifacts.frameDocument({ id: input.id, version: input.version, theme }),
        ]);
        await cachePut(detail, { theme, html: frame.html });
        // Khung đọc từ bộ đệm không hết hạn; `expiresAt` xa để `TicketFrame` không coi là vé sắp hết.
        return {
          url: cachedFrameUrl(input.id, input.version, theme),
          expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        };
      };
    },
  });
  return new Proxy(client, {
    get: (target, prop) => (prop === "artifacts" ? artifacts : Reflect.get(target, prop)),
  });
}

export const artifactsApi = createTanstackQueryUtils(withCachedFrames(hub));

/** Hash của màn Artifact và Leader (`#/artifacts/<id>/<version>`, `#/leader/<threadId>`). */
export function linkHash(to: ArtifactsLink): string | null {
  switch (to.kind) {
    case "library":
      return "#/artifacts";
    case "artifact":
      return `#/artifacts/${encodeURIComponent(to.id)}${to.version === undefined ? "" : `/${to.version}`}`;
    case "thread":
      return `#/leader/${encodeURIComponent(to.id)}`;
    default:
      return null;
  }
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/** Khung cách ly nhận theme qua URL, không đọc được CSS của app: theo lớp `dark` mà lib/theme.ts đặt trên <html>. */
export function useDocumentTheme(): ArtifactTheme {
  return useSyncExternalStore(
    subscribeTheme,
    () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
    () => "light",
  );
}

function offlineCacheFor(theme: ArtifactTheme): ArtifactsOfflineCache {
  return {
    get: async (id, version) => {
      const entry = await cacheGet(id, version);
      return entry ? { ...entry.detail, cachedAt: new Date(entry.savedAt).toISOString() } : null;
    },
    // Ghi không chờ: mất bản đệm chỉ làm lần mở offline sau thiếu bản này, không đáng chặn màn đang xem.
    put: (detail) => void cachePut(detail).catch(() => {}),
    frameUrl: (id, version) => cachedFrameUrl(id, version, theme),
  };
}

export interface DesktopArtifactsHandlers {
  onAskLeaderFix?: ArtifactsEnv["onAskLeaderFix"];
  onPublicLinks?: ArtifactsEnv["onPublicLinks"];
}

/** `ArtifactsEnv` của app (D15): client hub qua Rust, bộ đệm offline của T040, liên kết theo hash của app. */
export function useDesktopArtifactsEnv(handlers: DesktopArtifactsHandlers = {}): ArtifactsEnv {
  const lang = useLang();
  const theme = useDocumentTheme();
  const account = useLinkedAccount();
  const probe = useArtifactsProbe();
  const status = useQuery({ queryKey: ["desktop", "account-status"], queryFn: accountStatus, staleTime: 60_000 });
  const offline = !probe.reachable;
  return {
    api: artifactsApi,
    lang,
    theme,
    errorMessage: errorText,
    link: ({ to, className, children }) => {
      const hash = linkHash(to);
      if (hash)
        return (
          <a href={hash} className={className}>
            {children}
          </a>
        );
      // Run là trang của hub: mở trong cửa sổ web của hub như các màn khác của app.
      return (
        <button
          type="button"
          className={`cursor-pointer border-0 bg-transparent p-0 text-left ${className ?? ""}`}
          onClick={() => to.kind === "run" && void invoke("open_hub_page", { path: `/runs/${to.id}` })}
        >
          {children}
        </button>
      );
    },
    frameBase: status.data?.hub ?? "http://hub.local/",
    offline,
    offlineCache: offlineCacheFor(theme),
    // Leader là một run trên hub: offline thì không gửi được; ai dùng được Leader quyết theo hồ sơ như menu.
    canAskLeader: !offline && can(profileOf(account), "leader.use"),
    ...handlers,
  };
}

/**
 * Env cùng hai hộp mà khung bên cạnh và trang chi tiết mở qua env: "Nhờ Leader sửa" và "Link công khai" (như
 * `WebArtifacts`). Gửi lời nhờ xong thì đưa người dùng tới cuộc trò chuyện nhận lời nhờ để thấy bản sửa.
 */
export function DesktopArtifacts({ threadId, children }: { threadId?: string | undefined; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [fix, setFix] = useState<FixRequest | null>(null);
  const [fixOpen, setFixOpen] = useState(false);
  const [share, setShare] = useState<{ artifact: ArtifactSummary; version: number } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const env = useDesktopArtifactsEnv({
    onAskLeaderFix: (request) => {
      setFix(request);
      setFixOpen(true);
    },
    onPublicLinks: (artifact, version) => {
      setShare({ artifact, version });
      setShareOpen(true);
    },
  });
  return (
    <ArtifactsProvider env={env}>
      {children}
      {fix && (
        <FixRequestDialog
          request={fix}
          threadId={threadId}
          open={fixOpen}
          onOpenChange={setFixOpen}
          onSent={(result) => {
            setFixOpen(false);
            void queryClient.invalidateQueries({ queryKey: artifactsApi.leader.key() });
            location.hash = `#/leader/${encodeURIComponent(result.threadId)}`;
          }}
        />
      )}
      {share && (
        <PublicLinkDialog
          artifact={share.artifact}
          version={share.version}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}
    </ArtifactsProvider>
  );
}
