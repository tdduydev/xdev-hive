import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from "react";

export type ChatOpen = { kind: "thread"; id: number } | { kind: "new" } | null;
export interface ChatPageContext { id: string; href: string; project?: string; }

function draftStore() {
  return { values: new Map<string, unknown>(), listeners: new Map<string, Set<() => void>>() };
}

interface Session {
  panelOpen: boolean;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  selections: Record<string, ChatOpen>;
  select: (scope: string, open: ChatOpen) => void;
  drafts: ReturnType<typeof draftStore>;
  previews: Set<string>;
  pageContext: ChatPageContext | null;
  setPageContext: Dispatch<SetStateAction<ChatPageContext | null>>;
}

const ChatSession = createContext<Session | null>(null);

/** One session survives page navigation and moving the conversation into the shell sheet. */
export function ChatSessionProvider({ children }: { children: ReactNode }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [selections, setSelections] = useState<Record<string, ChatOpen>>({});
  const [pageContext, setPageContext] = useState<ChatPageContext | null>(null);
  const drafts = useRef(draftStore()).current;
  const previews = useRef(new Set<string>()).current;
  const select = useCallback((scope: string, open: ChatOpen) => setSelections((was) => ({ ...was, [scope]: open })), []);
  useEffect(() => () => { for (const url of previews) URL.revokeObjectURL(url); }, [previews]);
  return <ChatSession.Provider value={{ panelOpen, setPanelOpen, selections, select, drafts, previews, pageContext, setPageContext }}>{children}</ChatSession.Provider>;
}

export function useChatSession() {
  const session = useContext(ChatSession);
  if (!session) throw new Error("ChatSessionProvider is required");
  return session;
}

/** Drafts stay in memory for this signed-in client, including uploads that finish while the sheet is closed. */
export function useChatDraft<T>(key: string | undefined, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const session = useContext(ChatSession);
  const fallback = useRef(draftStore()).current;
  const store = key && session ? session.drafts : fallback;
  const id = key ?? "local";
  if (!store.values.has(id)) store.values.set(id, typeof initial === "function" ? (initial as () => T)() : initial);
  const subscribe = useCallback((listener: () => void) => {
    const listeners = store.listeners.get(id) ?? new Set<() => void>();
    store.listeners.set(id, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) store.listeners.delete(id);
    };
  }, [store, id]);
  const snapshot = useCallback(() => store.values.get(id) as T, [store, id]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    const previous = store.values.get(id) as T;
    const resolved = typeof next === "function" ? (next as (was: T) => T)(previous) : next;
    if (Object.is(previous, resolved)) return;
    store.values.set(id, resolved);
    for (const listener of store.listeners.get(id) ?? []) listener();
  }, [store, id]);
  return [value, set];
}

export function useChatPreviews() { return useContext(ChatSession)?.previews; }

export function useChatPageContext(context: ChatPageContext | null) {
  const { setPageContext } = useChatSession();
  const id = context?.id, href = context?.href, project = context?.project;
  useEffect(() => {
    setPageContext(id && href ? { id, href, project } : null);
    return () => setPageContext(null);
  }, [id, href, project, setPageContext]);
}
