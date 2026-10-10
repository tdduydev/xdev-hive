import { useRef } from "react";

/** Controlled overlays may open without a Radix Trigger, so keep their actual opener. */
export function useOverlayFocus({ onOpenAutoFocus, onCloseAutoFocus }: {
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus(event: Event) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus(event: Event) {
      onCloseAutoFocus?.(event);
      if (event.defaultPrevented || !opener.current?.isConnected || opener.current === document.body) return;
      event.preventDefault();
      opener.current.focus();
    },
  };
}
