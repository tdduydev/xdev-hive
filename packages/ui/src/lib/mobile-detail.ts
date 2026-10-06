import { useCallback, useEffect, useState } from "react";

const phone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;

function fromHash(name: string): string | null {
  const query = window.location.hash.split("?")[1];
  return query ? new URLSearchParams(query).get(name) : null;
}

/** Keep the phone pane in the hash so a browser Back returns to the list. */
export function useMobileDetail(name: string) {
  const [mobile, setMobile] = useState(phone);
  const [value, setValue] = useState<string | null>(() => fromHash(name));
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const resize = () => setMobile(media.matches);
    const location = () => setValue(fromHash(name));
    media.addEventListener("change", resize);
    window.addEventListener("popstate", location);
    window.addEventListener("hashchange", location);
    return () => {
      media.removeEventListener("change", resize);
      window.removeEventListener("popstate", location);
      window.removeEventListener("hashchange", location);
    };
  }, [name]);
  const navigate = useCallback((next: string | null, replace = false) => {
    if (fromHash(name) === next) return;
    const [path, query] = window.location.hash.split("?");
    const params = new URLSearchParams(query ?? "");
    if (next === null) params.delete(name);
    else params.set(name, next);
    const hash = `${path || "#/"}${params.size ? `?${params}` : ""}`;
    if (replace) window.history.replaceState(null, "", hash);
    else window.history.pushState(null, "", hash);
    setValue(next);
  }, [name]);
  return { mobile, value, navigate, showingDetail: mobile && value !== null };
}
