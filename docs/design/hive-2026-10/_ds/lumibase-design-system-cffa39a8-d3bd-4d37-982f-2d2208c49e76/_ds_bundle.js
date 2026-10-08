/* Trimmed copy of the Claude Design bundle (project e9ddc9b3…, 8/10): only the five components
   xDev Hive.dc.html uses (Badge, Button, Input, Tag, Toggle) and the glass filter they need.
   The LumiBase landing kit (Hero, Footer, PillNav…) is left out on purpose. */
(() => {
const ns = (window.LumibaseDesignSystem_cffa39 = window.LumibaseDesignSystem_cffa39 || {});
const h = (...a) => React.createElement(...a);

function ensureLiquidGlass() {
  if (typeof document === "undefined" || document.getElementById("dgm-liquid-glass-defs")) return;
  const wrap = document.createElement("div");
  wrap.id = "dgm-liquid-glass-defs";
  wrap.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;";
  wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true"><defs>
    <filter id="dgmLensSoft" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.016" numOctaves="2" seed="4" result="noise2" />
      <feGaussianBlur in="noise2" stdDeviation="1.4" result="sn2" />
      <feDisplacementMap in="SourceGraphic" in2="sn2" scale="34" xChannelSelector="R" yChannelSelector="G" />
    </filter></defs></svg>`;
  document.body.appendChild(wrap);
}

function Badge({ children, tone = "neutral", dot = true, style = {}, ...rest }) {
  const tones = { neutral: "var(--color-text-secondary)", violet: "var(--color-violet)", blue: "var(--color-blue)", green: "var(--color-green)" };
  const c = tones[tone] || tones.neutral;
  return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px", borderRadius: "var(--radius-full)", background: "var(--color-glass)", boxShadow: "var(--ring-glass)", font: "var(--text-micro)", color: "var(--color-text-secondary)", whiteSpace: "nowrap", ...style }, ...rest },
    dot && h("span", { style: { width: 6, height: 6, borderRadius: "50%", background: c, boxShadow: `0 0 8px ${c}` } }), children);
}

function Tag({ children, active = false, icon = null, style = {}, ...rest }) {
  return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px", borderRadius: "var(--radius-xs)", background: active ? "var(--color-violet)" : "var(--color-surface-3)", color: active ? "#fff" : "var(--color-text-secondary)", boxShadow: active ? "none" : "var(--ring-glass)", font: "600 12px/1 var(--font-sans)", whiteSpace: "nowrap", ...style }, ...rest }, icon, children);
}

function Input({ value, onChange, placeholder = "", icon = null, trailing = null, size = "md", style = {}, ...rest }) {
  const height = size === "lg" ? 52 : size === "sm" ? 36 : 44;
  return h("div", { style: { display: "flex", alignItems: "center", gap: 10, height, padding: "0 14px", borderRadius: "var(--radius-sm)", background: "var(--color-surface-sunken)", boxShadow: "var(--ring-glass)", ...style } }, icon,
    h("input", { value, onChange, placeholder, style: { flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "var(--color-text)", font: "var(--text-body-sm)" }, ...rest }), trailing);
}

function Toggle({ checked = false, onChange, disabled = false, style = {} }) {
  return h("button", { role: "switch", "aria-checked": checked, disabled, onClick: () => !disabled && onChange && onChange(!checked),
    style: { width: 44, height: 26, flexShrink: 0, borderRadius: "var(--radius-full)", border: "none", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, background: checked ? "var(--color-violet)" : "var(--color-surface-4)", boxShadow: checked ? "none" : "var(--ring-glass)", position: "relative", transition: "background var(--duration) var(--ease-out)", ...style } },
    h("span", { style: { position: "absolute", top: 3, left: checked ? 21 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", boxShadow: "var(--shadow-sm)", transition: "left var(--duration) var(--ease-out)" } }));
}

function Button({ children, variant = "glass", size = "md", icon = null, iconRight = null, as = "button", disabled = false, style = {}, ...rest }) {
  const sizes = { sm: { height: 34, padding: "0 14px", font: "600 13px/1 var(--font-sans)", gap: 6 }, md: { height: 46, padding: "0 22px", font: "600 14px/1 var(--font-sans)", gap: 8 }, lg: { height: 54, padding: "0 28px", font: "600 16px/1 var(--font-sans)", gap: 10 } };
  const s = sizes[size] || sizes.md;
  React.useEffect(() => { ensureLiquidGlass(); }, []);
  const variants = {
    glass: { background: "rgba(24,23,28,0.55)", color: "var(--color-text)", textShadow: "0 1px 2px rgba(0,0,0,0.55)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.28), inset 0 0 0 1px rgba(255,255,255,0.14), inset 0 -7px 14px rgba(0,0,0,0.28), 0 7px 20px -4px rgba(0,0,0,0.55)" },
    solid: { background: "var(--color-violet)", color: "#fff", boxShadow: "0 8px 24px -8px rgba(123,97,255,0.7)" },
    blue: { background: "var(--color-blue)", color: "#fff", boxShadow: "0 8px 24px -8px rgba(24,160,251,0.7)" },
    ghost: { background: "transparent", color: "var(--color-text-secondary)", boxShadow: "none" },
  };
  const v = variants[variant] || variants.glass;
  const isGlass = variant === "glass";
  return h(as, { disabled: as === "button" ? disabled : undefined,
    style: { position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: s.gap, height: s.height, padding: s.padding, font: s.font, letterSpacing: "0.2px", border: "none", borderRadius: "var(--radius-pill)", overflow: isGlass ? "hidden" : "visible", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1, textDecoration: "none", whiteSpace: "nowrap", transition: "filter var(--duration) var(--ease-out), transform 380ms cubic-bezier(0.34,1.56,0.64,1), background var(--duration) var(--ease-out)", ...v, ...style },
    onMouseEnter: (e) => { if (disabled) return; e.currentTarget.style.filter = "brightness(1.14)"; e.currentTarget.style.transform = "translateY(-1px)"; },
    onMouseLeave: (e) => { e.currentTarget.style.filter = "none"; e.currentTarget.style.transform = "none"; },
    onMouseDown: (e) => { if (!disabled) e.currentTarget.style.transform = "translateY(0) scale(0.96)"; },
    onMouseUp: (e) => { if (!disabled) e.currentTarget.style.transform = "translateY(-1px)"; },
    ...rest },
    isGlass && h("span", { "aria-hidden": true, style: { position: "absolute", inset: 0, borderRadius: "var(--radius-pill)", zIndex: 0, background: "linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.02) 100%)", backdropFilter: "blur(5px) saturate(185%) url(#dgmLensSoft)", WebkitBackdropFilter: "blur(5px) saturate(185%)" } }),
    h("span", { style: { position: "relative", zIndex: 1, display: "inline-flex", alignItems: "center", gap: s.gap } }, icon, children, iconRight));
}

Object.assign(ns, { Badge, Button, Input, Tag, Toggle });
})();
