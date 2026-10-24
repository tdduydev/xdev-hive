import { useQuery } from "@tanstack/react-query";
import { ArtifactPanel, type ArtifactRef, type ArtifactSelection } from "@xdev-hive/artifacts-ui";
import type { ChatMessage } from "@xdev-hive/contracts";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet.tsx";
import { useMediaQuery } from "@/hooks/use-media-query.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { meQuery } from "@/lib/me.ts";

const text: Dict<{ resize: string; panel: string }> = {
  vi: { resize: "Kéo để đổi độ rộng khung artifact", panel: "Artifact" },
  en: { resize: "Drag to resize the artifact panel", panel: "Artifacts" },
};

/** FR-042: từ 1024 px chat và khung chia đôi; hẹp hơn thì khung là ngăn kéo phủ toàn màn. */
const WIDE = "(min-width: 1024px)";

const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;
const STEP = 0.05;
const clampRatio = (ratio: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));

interface PanelPrefs {
  open: boolean;
  /** Phần bề ngang dành cho khung. */
  ratio: number;
}

const DEFAULT_PREFS: PanelPrefs = { open: true, ratio: 0.5 };

// Mỗi người một khoá: máy dùng chung không lấy độ rộng hay trạng thái đóng của người đăng nhập trước.
const prefsKey = (userId: string | undefined) => `hive.artifacts.panel:${userId ?? "anon"}`;

function readPrefs(key: string): PanelPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<PanelPrefs> | null;
    return {
      open: typeof raw?.open === "boolean" ? raw.open : DEFAULT_PREFS.open,
      ratio: typeof raw?.ratio === "number" && Number.isFinite(raw.ratio) ? clampRatio(raw.ratio) : DEFAULT_PREFS.ratio,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePrefs(key: string, prefs: PanelPrefs) {
  try {
    localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    /* Trình duyệt chặn bộ nhớ: vẫn dùng được cho phiên hiện tại. */
  }
}

const keyOf = (ref: ArtifactSelection) => `${ref.id}@${ref.version}`;

/** Thẻ artifact của cuộc trò chuyện theo thứ tự tin nhắn; thẻ của artifact đã xoá không mở được nên không thành tab. */
export function chatArtifacts(messages: readonly ChatMessage[]): ArtifactRef[] {
  return messages.flatMap((m) =>
    m.artifact && !m.artifact.deleted
      ? [{ id: m.artifact.id, version: m.artifact.version, title: m.artifact.title, type: m.artifact.type }]
      : [],
  );
}

export interface ThreadArtifacts {
  items: ArtifactRef[];
  selection: ArtifactSelection | null;
  /** Khung đang hiện (cột bên phải ở màn rộng, ngăn kéo ở màn hẹp). */
  visible: boolean;
  wide: boolean;
  open: (ref?: ArtifactSelection) => void;
  select: (ref: ArtifactSelection) => void;
  close: () => void;
  ratio: number;
  setRatio: (ratio: number, persist: boolean) => void;
}

/**
 * Trạng thái khung bên cạnh của một cuộc trò chuyện. Khi khung đang mở, `ArtifactPanel` tự chuyển sang thẻ mới (trừ khi
 * đang sửa); khi khung đóng thì component không có mặt, nên thẻ mới đến lúc đó do đây mở khung (US1-2).
 */
export function useThreadArtifacts(messages: readonly ChatMessage[] | undefined): ThreadArtifacts {
  const wide = useMediaQuery(WIDE);
  const me = useQuery(meQuery);
  const key = prefsKey(me.data?.id);
  const [prefs, setPrefs] = useState(() => readPrefs(key));
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selection, setSelection] = useState<ArtifactSelection | null>(null);
  const items = chatArtifacts(messages ?? []);

  useEffect(() => setPrefs(readPrefs(key)), [key]);

  const update = useCallback(
    (next: Partial<PanelPrefs>, persist = true) =>
      setPrefs((prev) => {
        const merged = { ...prev, ...next };
        if (persist) writePrefs(key, merged);
        return merged;
      }),
    [key],
  );

  const open = useCallback(
    (ref?: ArtifactSelection) => {
      if (ref) setSelection(ref);
      update({ open: true });
      setSheetOpen(true);
    },
    [update],
  );

  const seen = useRef<Set<string> | null>(null);
  const live = useRef({ visible: false, open });
  const visible = items.length > 0 && (wide ? prefs.open : sheetOpen);
  live.current = { visible, open };
  const itemsKey = items.map(keyOf).join(",");
  const loaded = messages !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `itemsKey` đại diện cho `items` (mảng mới mỗi lần vẽ).
  useEffect(() => {
    // Thẻ đã có lúc tải cuộc trò chuyện không phải "mới": chỉ thẻ đến sau mới mở khung.
    if (!loaded) return;
    if (!seen.current) {
      seen.current = new Set(items.map(keyOf));
      return;
    }
    const known = seen.current;
    const fresh = items.filter((item) => !known.has(keyOf(item)));
    for (const item of fresh) known.add(keyOf(item));
    const newest = fresh.at(-1);
    if (newest && !live.current.visible) live.current.open({ id: newest.id, version: newest.version });
  }, [itemsKey, loaded]);

  return {
    items,
    selection,
    visible,
    wide,
    open,
    select: setSelection,
    close: () => (wide ? update({ open: false }) : setSheetOpen(false)),
    ratio: prefs.ratio,
    setRatio: (ratio, persist) => update({ ratio: clampRatio(ratio) }, persist),
  };
}

/** Vạch chia kéo được (chuột, cảm ứng) và chỉnh được bằng phím mũi tên; độ rộng nhớ khi thả. */
function Divider({ state }: { state: ThreadArtifacts }) {
  const t = useT(text);
  const ratioAt = (event: PointerEvent<HTMLDivElement>) => {
    const grid = event.currentTarget.parentElement?.getBoundingClientRect();
    return grid && grid.width > 0 ? (grid.right - event.clientX) / grid.width : state.ratio;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Khung nằm bên phải: mũi tên trái kéo vạch sang trái, khung rộng ra; giá trị của vạch là độ rộng khung.
    const next = {
      ArrowLeft: state.ratio + STEP,
      ArrowRight: state.ratio - STEP,
      Home: MIN_RATIO,
      End: MAX_RATIO,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    state.setRatio(next, true);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> không nhận focus và kéo được; vạch chia theo mẫu ARIA "window splitter".
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t.resize}
      aria-valuemin={MIN_RATIO * 100}
      aria-valuemax={MAX_RATIO * 100}
      aria-valuenow={Math.round(state.ratio * 100)}
      onKeyDown={onKeyDown}
      // Bắt con trỏ để khi kéo qua iframe của khung vẫn nhận sự kiện (iframe nuốt sự kiện chuột của trang).
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) state.setRatio(ratioAt(event), false);
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        state.setRatio(ratioAt(event), true);
      }}
      className="group flex w-3 cursor-col-resize touch-none justify-center self-stretch rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="w-px bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
    </div>
  );
}

/**
 * Lưới `chat | vạch chia | khung` ở màn rộng, ngăn kéo toàn màn ở màn hẹp (FR-042). Cuộc trò chuyện chưa có artifact thì
 * chỉ có chat, không chiếm chỗ cho khung rỗng.
 */
export function ThreadArtifactLayout({ state, chat }: { state: ThreadArtifacts; chat: ReactNode }) {
  const t = useT(text);
  if (state.items.length === 0) return chat;
  const panel = (props: { onClose?: () => void; onBack?: () => void; className?: string }) => (
    <ArtifactPanel items={state.items} value={state.selection} onValueChange={state.select} {...props} />
  );
  if (state.wide)
    return state.visible ? (
      <div
        className="grid min-w-0 items-start"
        style={{ gridTemplateColumns: `minmax(0, ${1 - state.ratio}fr) auto minmax(0, ${state.ratio}fr)` }}
      >
        {chat}
        <Divider state={state} />
        {panel({
          onClose: state.close,
          className: "sticky top-4 max-h-[calc(100dvh-7rem)] rounded-xl border border-border",
        })}
      </div>
    ) : (
      chat
    );
  return (
    <>
      {chat}
      <Sheet open={state.visible} onOpenChange={(open) => (open ? state.open() : state.close())}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none"
        >
          <SheetTitle className="sr-only">{t.panel}</SheetTitle>
          {panel({ onBack: state.close, className: "h-full" })}
        </SheetContent>
      </Sheet>
    </>
  );
}
