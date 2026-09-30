// One short message at the bottom of the window, optionally with an undo (DS: inverse surface, auto-hides).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useT } from "#ui/i18n/index.tsx";

export interface ToastOptions {
  /** Shows an Undo button; runs this and hides the toast. */
  undo?: () => void;
  /** Errors stay until dismissed. */
  tone?: "info" | "error";
}

type Show = (text: string, options?: ToastOptions) => void;

const ToastContext = createContext<Show | null>(null);

/** toast("Đã tạo T-12", { undo }) from anywhere inside the shell; outside it the call does nothing. */
export function useToast(): Show {
  return useContext(ToastContext) ?? (() => undefined);
}

const HIDE_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [toast, setToast] = useState<{ id: number; text: string } & ToastOptions>();
  const seq = useRef(0);
  const paused = useRef(false);
  const show = useCallback<Show>((text, options) => setToast({ id: ++seq.current, text, ...options }), []);

  useEffect(() => {
    if (!toast || toast.tone === "error") return;
    const timer = setInterval(() => {
      if (!paused.current) setToast((cur) => (cur?.id === toast.id ? undefined : cur));
    }, HIDE_MS);
    return () => clearInterval(timer);
  }, [toast]);

  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? (
        <div
          key={toast.id}
          role={toast.tone === "error" ? "alert" : "status"}
          onMouseEnter={() => (paused.current = true)}
          onMouseLeave={() => (paused.current = false)}
          className="fixed bottom-10 left-1/2 z-400 flex max-w-[calc(100%-32px)] -translate-x-1/2 animate-xd-in items-center gap-2.5 rounded-md bg-inverse py-2 pr-2 pl-3.5 text-[13px]/[18px] font-medium text-fg-inverse shadow-e4"
        >
          <span className="min-w-0">{toast.text}</span>
          {toast.undo ? (
            <button
              type="button"
              className="h-[26px] cursor-pointer rounded-sm px-2.5 text-xs font-bold underline outline-none hover:bg-white/10 focus-visible:focus-ring"
              onClick={() => {
                toast.undo?.();
                setToast(undefined);
              }}
            >
              {t("toast.undo")}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t("toast.close")}
            className="grid size-6 cursor-pointer place-items-center rounded-sm opacity-70 outline-none hover:bg-white/10 hover:opacity-100 focus-visible:focus-ring"
            onClick={() => setToast(undefined)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}
