/**
 * Glob kiểu gitignore rút gọn: `**` khớp nhiều cấp thư mục, `*` và `?` không vượt qua `/`.
 *
 * Nằm ở contracts vì cả `runs` (chính sách kết quả) lẫn `codereview` (phạm vi, điều kiện checkpoint) cần, mà
 * `codereview` không được import `runs` (runs gọi codereview, sẽ thành vòng). Web dùng cùng hàm để chạy thử khớp.
 */
export function matchGlob(glob: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        // `**/` khớp cả không cấp nào.
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // Glob trỏ vào thư mục (`infra/prod`) cũng chặn mọi thứ bên trong.
  return new RegExp(`^${re}(?:/.*)?$`).test(path);
}
