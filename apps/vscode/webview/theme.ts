export function syncTheme(): () => void {
  const update = () => {
    const classes = document.body.classList;
    const dark = classes.contains("vscode-dark") || classes.contains("vscode-high-contrast");
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  };
  update();
  const observer = new MutationObserver(update);
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
