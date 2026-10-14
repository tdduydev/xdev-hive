import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, CornerDownLeftIcon, SendIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type Dict, useT } from "@/lib/i18n.ts";
import {
  applyModifiers,
  composeLine,
  encodeKey,
  hasModifier,
  type KeyName,
  type Modifiers,
  NO_MODIFIERS,
} from "@/lib/terminal/keys.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{
  keys: string;
  line: string;
  linePlaceholder: string;
  send: string;
  arrows: Record<string, string>;
}> = {
  vi: {
    keys: "Thanh phím terminal",
    line: "Soạn dòng",
    linePlaceholder: "Gõ cả dòng (có dấu) rồi gửi",
    send: "Gửi dòng",
    arrows: { up: "Mũi tên lên", down: "Mũi tên xuống", left: "Mũi tên trái", right: "Mũi tên phải", enter: "Enter" },
  },
  en: {
    keys: "Terminal key bar",
    line: "Compose line",
    linePlaceholder: "Type a whole line, then send",
    send: "Send line",
    arrows: { up: "Arrow up", down: "Arrow down", left: "Arrow left", right: "Arrow right", enter: "Enter" },
  },
};

export interface KeyPad {
  mods: Modifiers;
  toggle: (name: keyof Modifiers) => void;
  /** Chữ vừa gõ trên bàn phím ảo của xterm, đã áp Ctrl/Alt đang giữ (rồi nhả). Truyền cho `TerminalView.transformInput`. */
  transform: (data: string) => string;
  /** Chuỗi byte của nút trên thanh phím, đã áp Ctrl/Alt đang giữ (rồi nhả). */
  encode: (key: KeyName) => string;
}

/**
 * Ctrl/Alt "giữ" của thanh phím. Giá trị đọc lúc gõ nằm ở ref để `transform` không trễ một lần vẽ so với state:
 * xterm gọi nó đồng bộ ngay khi có chữ.
 */
export function useKeyPad(): KeyPad {
  const ref = useRef<Modifiers>(NO_MODIFIERS);
  const [mods, setMods] = useState<Modifiers>(NO_MODIFIERS);
  const set = useCallback((next: Modifiers) => {
    ref.current = next;
    setMods(next);
  }, []);
  const toggle = useCallback((name: keyof Modifiers) => set({ ...ref.current, [name]: !ref.current[name] }), [set]);
  const transform = useCallback(
    (data: string) => {
      const out = applyModifiers(data, ref.current);
      if (hasModifier(ref.current)) set(NO_MODIFIERS);
      return out;
    },
    [set],
  );
  const encode = useCallback(
    (key: KeyName) => {
      const out = encodeKey(key, ref.current);
      if (hasModifier(ref.current)) set(NO_MODIFIERS);
      return out;
    },
    [set],
  );
  return { mods, toggle, transform, encode };
}

/**
 * Giữ tiêu điểm ở chỗ đang gõ (xterm hoặc ô soạn): bấm nút mà mất tiêu điểm thì bàn phím ảo của điện thoại thụt xuống
 * rồi nảy lên, rất khó chịu khi bấm liên tiếp. Chặn ở mousedown vì trình duyệt cảm ứng cũng phát mousedown sau chạm.
 */
const keepFocus = { onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault() };

function KeyButton({
  children,
  label,
  pressed,
  onPress,
  className,
}: {
  children: ReactNode;
  label?: string | undefined;
  pressed?: boolean | undefined;
  onPress: () => void;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onPress}
      {...keepFocus}
      // 44 px là cỡ chạm tối thiểu của Apple/WCAG; nút bật (Ctrl, Alt) đổi màu để thấy đang giữ.
      className={cn(
        "h-11 min-w-11 shrink-0 px-3 font-mono text-sm aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground",
        className,
      )}
    >
      {children}
    </Button>
  );
}

/** Chờ giữa chữ và Enter của ô soạn, xem composeLine. */
const SUBMIT_DELAY_MS = 80;

/**
 * Thanh phím và ô soạn dòng cho terminal trên điện thoại: bàn phím ảo không có Esc/Tab/Ctrl/mũi tên, và gõ chữ Việt
 * bằng IME ngay trong xterm hay hỏng dấu nên có ô soạn thường để gõ cả dòng rồi gửi một lần.
 */
export function TerminalKeys({ pad, send }: { pad: KeyPad; send: (data: string) => void }) {
  const t = useT(text);
  const [line, setLine] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const press = (key: KeyName) => () => send(pad.encode(key));

  const submit = () => {
    const { text: body, submit: enter } = composeLine(line);
    setLine("");
    if (body) send(body);
    if (timer.current) clearTimeout(timer.current);
    // Dòng rỗng vẫn là một lần Enter, gửi ngay.
    if (!body) send(enter);
    else timer.current = setTimeout(() => send(enter), SUBMIT_DELAY_MS);
  };

  return (
    <div className="grid min-w-0 gap-2">
      <div role="toolbar" aria-label={t.keys} className="flex min-w-0 gap-1.5 overflow-x-auto pb-0.5">
        <KeyButton onPress={press("esc")}>Esc</KeyButton>
        <KeyButton onPress={press("tab")}>Tab</KeyButton>
        <KeyButton pressed={pad.mods.ctrl} onPress={() => pad.toggle("ctrl")}>
          Ctrl
        </KeyButton>
        <KeyButton pressed={pad.mods.alt} onPress={() => pad.toggle("alt")}>
          Alt
        </KeyButton>
        <KeyButton label={t.arrows.left} onPress={press("left")}>
          <ArrowLeftIcon aria-hidden="true" />
        </KeyButton>
        <KeyButton label={t.arrows.up} onPress={press("up")}>
          <ArrowUpIcon aria-hidden="true" />
        </KeyButton>
        <KeyButton label={t.arrows.down} onPress={press("down")}>
          <ArrowDownIcon aria-hidden="true" />
        </KeyButton>
        <KeyButton label={t.arrows.right} onPress={press("right")}>
          <ArrowRightIcon aria-hidden="true" />
        </KeyButton>
        <KeyButton onPress={press("ctrl-c")}>Ctrl-C</KeyButton>
        <KeyButton onPress={press("ctrl-d")}>Ctrl-D</KeyButton>
        <KeyButton onPress={press("slash")}>/</KeyButton>
        <KeyButton label={t.arrows.enter} onPress={press("enter")}>
          <CornerDownLeftIcon aria-hidden="true" />
        </KeyButton>
      </div>
      <form
        className="flex min-w-0 gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          value={line}
          onValueChange={setLine}
          aria-label={t.line}
          placeholder={t.linePlaceholder}
          className="h-11"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="send"
        />
        <Button type="submit" className="h-11 shrink-0 px-4" aria-label={t.send} {...keepFocus}>
          <SendIcon aria-hidden="true" />
        </Button>
      </form>
    </div>
  );
}
