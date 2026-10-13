import { type Editor, Extension, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { Suggestion } from "@tiptap/suggestion";

export type SlashItem = { id: string; label: string; hint?: string | undefined; run: (editor: Editor) => void };

export type SlashState = { items: SlashItem[]; active: number; host: HTMLElement; pick: (item: SlashItem) => void };

/**
 * Cầu nối giữa plugin gợi ý của Tiptap và React: plugin báo mở, đóng, đổi chữ lọc; menu React đọc qua
 * useSyncExternalStore và vẽ vào `host` mà plugin giữ bám theo con trỏ.
 */
export class SlashController {
  state: SlashState | null = null;
  private listeners = new Set<() => void>();
  items: (query: string) => SlashItem[] = () => [];

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.state;

  set(state: SlashState | null) {
    this.state = state;
    for (const l of this.listeners) l();
  }

  move(delta: number) {
    const s = this.state;
    if (!s?.items.length) return;
    this.set({ ...s, active: (s.active + delta + s.items.length) % s.items.length });
  }
}

/** Menu `/` đầu dòng để chèn khối (DocEditor.dc.html), giống ô `/` của trình soạn theo khối trước đây. */
export function slashCommand(controller: SlashController) {
  return Extension.create({
    name: "hiveSlash",
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem, SlashItem>({
          editor: this.editor,
          char: "/",
          startOfLine: true,
          pluginKey: new PluginKey("hiveSlash"),
          items: ({ query }) => controller.items(query),
          command: ({ editor, range, props }) => {
            editor.chain().focus().deleteRange(range).run();
            props.run(editor);
          },
          render: () => {
            let unmount: (() => void) | undefined;
            let host: HTMLElement | null = null;
            const publish = (p: { items: SlashItem[]; command: (item: SlashItem) => void; range: Range }) => {
              if (!host) return;
              const active = controller.state ? Math.min(controller.state.active, Math.max(p.items.length - 1, 0)) : 0;
              controller.set({ items: p.items, active, host, pick: p.command });
            };
            return {
              onStart: (p) => {
                host = document.createElement("div");
                host.className = "z-50";
                unmount = p.mount(host);
                publish(p);
              },
              onUpdate: (p) => publish(p),
              onKeyDown: ({ event }) => {
                const s = controller.state;
                if (!s) return false;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  controller.move(event.key === "ArrowDown" ? 1 : -1);
                  return true;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  const item = s.items[s.active];
                  if (!item) return false;
                  s.pick(item);
                  return true;
                }
                return false;
              },
              onExit: () => {
                unmount?.();
                host = null;
                controller.set(null);
              },
            };
          },
        }),
      ];
    },
  });
}
