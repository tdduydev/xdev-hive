/** Lựa chọn giao diện, lưu ở localStorage `hive.theme`. index.html đọc cùng khoá để đặt class trước khi vẽ. */
export type ThemeChoice = "system" | "light" | "dark";

const KEY = "hive.theme";
const darkQuery = "(prefers-color-scheme: dark)";

export function readTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    // Trình duyệt chặn bộ nhớ (chế độ riêng tư): theo hệ điều hành.
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const dark = choice === "dark" || (choice === "system" && matchMedia(darkQuery).matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function setTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* Không lưu được thì vẫn đổi cho phiên hiện tại. */
  }
  applyTheme(choice);
}

/** Theo hệ điều hành đổi sáng/tối khi người dùng chưa chọn cố định. */
export function watchSystemTheme(): () => void {
  const query = matchMedia(darkQuery);
  const onChange = () => {
    if (readTheme() === "system") applyTheme("system");
  };
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
