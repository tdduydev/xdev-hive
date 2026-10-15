import { ORPCError } from "@orpc/client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  ItemBoard,
  ItemDetail,
  NewItem,
  Questions,
  type SdlcCan,
  type SdlcEnv,
  type SdlcItemTab,
  type SdlcLink,
  SdlcProvider,
  sdlcText,
} from "@xdev-hive/sdlc-ui";
import { Button } from "@xdev-hive/ui/button";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { bridge, hub } from "@/bridge.ts";

/** Màn trong webview. Không có thanh điều hướng của app chủ nên route do màn tự giữ, và sống qua lần nạp lại. */
export type SdlcRoute =
  | { kind: "board"; projectId?: string; modeRef?: string }
  | { kind: "new" }
  | { kind: "questions" }
  | { kind: "item"; projectKey: string; number: number; tab?: SdlcItemTab };

type Lang = "vi" | "en";

const TABS: readonly SdlcItemTab[] = [
  "overview",
  "projects",
  "docs",
  "contracts",
  "questions",
  "tasks",
  "trace",
  "converge",
];
const HOST = "https://hive.invalid/rpc/host";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
const api = createTanstackQueryUtils(hub);

const NETWORK: Record<Lang, string> = {
  vi: "Không kết nối được hub. Kiểm tra mạng rồi thử lại.",
  en: "Cannot reach the hub. Check your network and try again.",
};
const SERVER: Record<Lang, string> = {
  vi: "Hub đang gặp lỗi. Thử lại sau ít phút.",
  en: "The hub is having trouble. Try again in a few minutes.",
};
const BY_CODE: Record<Lang, Record<string, string>> = {
  vi: {
    UNAUTHORIZED: "Phiên đăng nhập đã hết hạn. Đăng nhập lại xDev Hive trong VS Code.",
    FORBIDDEN: "Bạn không có quyền làm việc này.",
    NOT_FOUND: "Không tìm thấy. Có thể dữ liệu vừa bị xoá; làm mới để xem bản mới.",
    CONFLICT: "Dữ liệu bị trùng hoặc vừa bị người khác đổi. Làm mới rồi thử lại.",
    BAD_REQUEST: "Dữ liệu gửi lên không hợp lệ.",
    TOO_MANY_REQUESTS: "Thao tác quá nhanh. Đợi một lát rồi thử lại.",
    SERVICE_UNAVAILABLE: "Chưa kết nối hub.",
  },
  en: {
    UNAUTHORIZED: "Your session expired. Sign in to xDev Hive again in VS Code.",
    FORBIDDEN: "You are not allowed to do this.",
    NOT_FOUND: "Not found. The data may have just been deleted; refresh to see the latest.",
    CONFLICT: "The data is duplicated or was just changed by someone else. Refresh and try again.",
    BAD_REQUEST: "The submitted data is invalid.",
    TOO_MANY_REQUESTS: "Too many actions. Wait a moment and try again.",
    SERVICE_UNAVAILABLE: "Not connected to a hub.",
  },
};

/** Lỗi đã khai báo trong hợp đồng mang câu hub viết rõ lý do nên dùng nguyên văn; lỗi khác đổi theo mã. */
export function errorText(lang: Lang, error: unknown): string {
  if (!(error instanceof ORPCError)) return NETWORK[lang];
  if (error.defined && error.code !== "UNAUTHORIZED" && error.message) return error.message;
  const byCode = BY_CODE[lang][error.code];
  if (byCode) return byCode;
  if (error.status >= 500) return SERVER[lang];
  return lang === "en"
    ? `Could not do this (code ${error.code}). Try again or contact your hub admin.`
    : `Không làm được việc này (mã ${error.code}). Thử lại hoặc báo quản trị hub.`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;

/** Route đọc từ trạng thái đã lưu hoặc từ host: không tin hình dạng, chỉ nhận đúng các màn đã biết. */
export function parseRoute(value: unknown): SdlcRoute | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.kind) {
    case "board": {
      const projectId = text(value.projectId);
      const modeRef = text(value.modeRef);
      return { kind: "board", ...(projectId ? { projectId } : {}), ...(modeRef ? { modeRef } : {}) };
    }
    case "new":
    case "questions":
      return { kind: value.kind };
    case "item": {
      const projectKey = text(value.projectKey);
      const number = value.number;
      if (!projectKey || typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return undefined;
      const tab = TABS.find((candidate) => candidate === value.tab);
      return { kind: "item", projectKey, number, ...(tab && tab !== "overview" ? { tab } : {}) };
    }
    default:
      return undefined;
  }
}

/** Liên kết ở trong màn AI SDLC thì đổi route tại chỗ; còn lại là trang của hub, host mở bằng trình duyệt. */
export function routeOf(to: SdlcLink): SdlcRoute | undefined {
  switch (to.kind) {
    case "board":
    case "new":
    case "questions":
    case "item":
      return parseRoute(to);
    default:
      return undefined;
  }
}

/** Quyền theo tổ chức như web; hub vẫn kiểm lại từng thao tác. Chưa biết quyền thì coi là chỉ đọc. */
export function canOf(permissions: readonly string[] | undefined): SdlcCan {
  const has = (permission: string) => !!permissions?.includes(permission);
  return {
    write: () => has("sdlc.write"),
    override: has("sdlc.override"),
    manageModes: has("sdlc.modes.write"),
  };
}

async function host(procedure: string, body: unknown): Promise<unknown> {
  const response = await bridge.fetch(
    new Request(`${HOST}/${procedure}`, { method: "POST", body: JSON.stringify(body) }),
  );
  return response.ok ? await response.json() : undefined;
}

function Anchor({
  to,
  className,
  children,
  go,
}: {
  to: SdlcLink;
  className?: string | undefined;
  children: ReactNode;
  go: (route: SdlcRoute) => void;
}) {
  const route = routeOf(to);
  return (
    <button
      type="button"
      className={`cursor-pointer border-0 bg-transparent p-0 text-left ${className ?? ""}`}
      onClick={() => {
        if (route) go(route);
        else void host("sdlcOpen", to).catch(() => undefined);
      }}
    >
      {children}
    </button>
  );
}

function routeKey(route: SdlcRoute): string {
  return JSON.stringify(route);
}

function Content({ route, go, lang }: { route: SdlcRoute; go: (route: SdlcRoute) => void; lang: Lang }) {
  switch (route.kind) {
    case "new":
      return <NewItem onCreated={(item) => go({ kind: "item", projectKey: item.project.key, number: item.number })} />;
    case "questions":
      return (
        <div className="flex flex-col gap-3">
          <div>
            <Button variant="ghost" size="sm" onClick={() => go({ kind: "board" })}>
              {sdlcText[lang].newItem.backBoard}
            </Button>
          </div>
          <Questions />
        </div>
      );
    case "item":
      return (
        <ItemDetail
          key={`${route.projectKey}/${route.number}`}
          projectKey={route.projectKey}
          number={route.number}
          tab={route.tab ?? "overview"}
          onTabChange={(tab) => go(parseRoute({ ...route, tab }) ?? route)}
        />
      );
    case "board":
      return (
        <ItemBoard
          key={routeKey(route)}
          initialProjectId={route.projectId}
          initialModeRef={route.modeRef}
          // Cột rộng không vừa thanh bên; danh sách đọc được ở mọi bề rộng.
          initialView="list"
        />
      );
  }
}

function Screen() {
  const lang: Lang = document.documentElement.lang === "en" ? "en" : "vi";
  const [route, setRoute] = useState<SdlcRoute>(
    () => parseRoute(bridge.getState<{ route?: unknown }>()?.route) ?? { kind: "board" },
  );
  const go = useCallback((next: SdlcRoute) => {
    setRoute(next);
    bridge.setState({ route: next });
  }, []);
  const mine = useQuery({ ...api.roles.mine.queryOptions({ input: {} }), staleTime: 60_000 });

  useEffect(() => {
    // Mở từ lệnh khác (ví dụ câu hỏi ở "Chờ duyệt") thì host giữ route chờ cho đến khi màn nạp xong.
    void host("sdlcInit", {})
      .then((value) => {
        const next = isRecord(value) ? parseRoute(value.route) : undefined;
        if (next) go(next);
      })
      .catch(() => undefined);
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!isRecord(event.data) || event.data.type !== "sdlc.navigate") return;
      const next = parseRoute(event.data.to);
      if (next) go(next);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [go]);

  const permissions = mine.data?.permissions;
  const env = useMemo<SdlcEnv>(
    () => ({
      api,
      lang,
      errorMessage: (error) => errorText(lang, error),
      can: canOf(permissions),
      link: ({ to, className, children }) => (
        <Anchor to={to} className={className} go={go}>
          {children}
        </Anchor>
      ),
    }),
    [lang, permissions, go],
  );

  return (
    <SdlcProvider env={env}>
      <div className="p-3">
        <Content route={route} go={go} lang={lang} />
      </div>
    </SdlcProvider>
  );
}

export function SdlcScreen() {
  return (
    <QueryClientProvider client={queryClient}>
      <Screen />
    </QueryClientProvider>
  );
}
