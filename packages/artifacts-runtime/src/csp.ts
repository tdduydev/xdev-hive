/**
 * Nguồn CSP của thư mục thư viện, dạng `scheme://host[:port]/path/`. Hub dùng `https://<host>/_artifact/lib/`, app dùng
 * `hive-artifact://…/lib/`. Từ chối mọi thứ có thể mở rộng chỉ thị (`;`, `,`, khoảng trắng, nháy) hay không phải một thư
 * mục: libBase đến từ cấu hình của chính hub/app, nhưng CSP là chốt chặn cuối nên không tin chuỗi thô.
 */
export function libSource(libBase: string): string {
  if (/[\s;,'"]/.test(libBase)) throw new Error("libBase chứa ký tự không hợp lệ cho CSP");
  let url: URL;
  try {
    url = new URL(libBase);
  } catch {
    throw new Error("libBase không phải URL tuyệt đối");
  }
  if (!url.host || url.search || url.hash || url.username || url.password) {
    throw new Error("libBase phải có host và không có query, fragment hay tài khoản");
  }
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * CSP của tài liệu khung (US3-3, ADR 0023 mục 5). Chỉ host của hub, `connect-src 'none'` cố định: không có tham số CDN hay
 * chính sách tổ chức nào nới được. Ngoại lệ duy nhất là `blobBase` của ảnh và PDF (T062): khung đọc đúng một thư mục của
 * hub, nơi mọi tệp cần vé đã ký. Chỉ thị `sandbox` có mặt để mở URL khung trực tiếp trên tab mới vẫn bị cách ly.
 */
export function buildCsp({ libBase, blobBase }: { libBase: string; blobBase?: string | undefined }): string {
  const lib = libSource(libBase);
  const blob = blobBase ? libSource(blobBase) : null;
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${lib}`,
    `style-src 'unsafe-inline' ${lib}`,
    `img-src data: blob:${blob ? ` ${blob}` : ""}`,
    `connect-src ${blob ?? "'none'"}`,
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "sandbox allow-scripts",
  ].join("; ");
}
