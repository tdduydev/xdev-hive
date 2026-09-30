// The xDev Hive identity: the xDev X with HIVE / DEV HUB (docs/design/2026-09-redesign/assets). Drawn inline, not
// as <img>, so the X picks up the page's Space Grotesk; the lettering is paths. Do not redraw: copy the assets.
import { useId } from "react";
import { cn } from "cn";

const X_FONT = "'Space Grotesk Variable', 'Space Grotesk', Inter, sans-serif";

/** Gradient stops of the X for light and dark backgrounds (the dark one is the original xDev dark asset). */
const X_STOPS = {
  light: ["#7BD4FF", "#1E90FF", "#004CFF"],
  dark: ["#B8F1FF", "#3FA9FF", "#1C58FF"],
} as const;

function Wordmark({ tone, height, className }: { tone: "light" | "dark"; height: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const ink = tone === "light" ? "#344568" : "#E8ECF8";
  const [a, b, c] = X_STOPS[tone];
  return (
    <svg viewBox="0 0 178 78" height={height} width={(height * 178) / 78} fill="none" aria-hidden="true" className={className}>
      <defs>
        <radialGradient id={`xg-${id}`} cx="50%" cy="50%" r="80%">
          <stop offset="0%" stopColor={a} />
          <stop offset="40%" stopColor={b} />
          <stop offset="90%" stopColor={c} />
        </radialGradient>
        <filter id={`xf-${id}`} x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow
            dx="0"
            dy="0"
            stdDeviation={tone === "light" ? 1.5 : 2}
            floodColor={tone === "light" ? "#3399FF" : "#66B2FF"}
            floodOpacity={tone === "light" ? 0.35 : 0.4}
          />
        </filter>
      </defs>
      <text x="8" y="52" transform="scale(1.1,1)" fontFamily={X_FONT} fontWeight="600" fontSize="60" fill={`url(#xg-${id})`} filter={`url(#xf-${id})`}>
        X
      </text>
      <g stroke={ink} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
        <path d="M0 0V24M18 0V24M0 12H18" transform="translate(64 12)" />
        <path d="M0 0V24" transform="translate(94 12)" />
        <path d="M0 0L10 24L20 0" transform="translate(105 12)" />
        <path d="M18 0H0V24H18M0 12H15" transform="translate(137 12)" />
      </g>
      <g stroke={ink} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M0 0V24H7C22 24 22 0 7 0Z" transform="translate(64 43) scale(.31)" />
        <path d="M18 0H0V24H18M0 12H15" transform="translate(72.68 43) scale(.31)" />
        <path d="M0 0L10 24L20 0" transform="translate(80.43 43) scale(.31)" />
        <path d="M0 0V24M18 0V24M0 12H18" transform="translate(92.21 43) scale(.31)" />
        <path d="M0 0V15C0 28 19 28 19 15V0" transform="translate(99.96 43) scale(.31)" />
        <path d="M0 0V24H9C22 24 22 12 9 12H0M0 0H9C21 0 21 12 9 12" transform="translate(108.02 43) scale(.31)" />
      </g>
    </svg>
  );
}

/** X + HIVE / DEV HUB, switching lettering colour with the theme. Keep it at least 24px tall; below that use XMark. */
export function HiveWordmark({ height = 30, className }: { height?: number; className?: string }) {
  return (
    <span role="img" aria-label="xDev Hive · Dev Hub" className={cn("inline-flex shrink-0", className)}>
      <Wordmark tone="light" height={height} className="dark:hidden" />
      <Wordmark tone="dark" height={height} className="hidden dark:block" />
    </span>
  );
}

/** The standalone X, for places too small for the wordmark (icon rail, favicon-sized spots). */
export function XMark({ size = 22, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const [a, b, c] = X_STOPS.light;
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} role="img" aria-label="xDev" className={cn("shrink-0", className)}>
      <defs>
        <radialGradient id={`xm-${id}`} cx="50%" cy="50%" r="80%">
          <stop offset="0%" stopColor={a} />
          <stop offset="40%" stopColor={b} />
          <stop offset="90%" stopColor={c} />
        </radialGradient>
      </defs>
      <text x="29" y="54" textAnchor="middle" transform="scale(1.1,1)" fontFamily={X_FONT} fontWeight="600" fontSize="66" fill={`url(#xm-${id})`}>
        X
      </text>
    </svg>
  );
}
