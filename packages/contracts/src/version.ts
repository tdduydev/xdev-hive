/** Phiên bản semver không có tiền tố v (worker, app desktop). */
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function validVersion(v: string): boolean {
  return semver.test(v);
}

/** a mới hơn b theo thứ tự semver. Bản dựng từ mã nguồn (0.0.0-dev) cũ hơn mọi bản phát hành. */
export function newerVersion(a: string, b: string): boolean {
  const x = semver.exec(a),
    y = semver.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d > 0;
  }
  const xp = x[4],
    yp = y[4];
  if (xp === undefined || yp === undefined) return xp === undefined && yp !== undefined;
  const xs = xp.split("."),
    ys = yp.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const xv = xs[i];
    const yv = ys[i];
    if (xv === undefined) return false;
    if (yv === undefined) return true;
    if (xv === yv) continue;
    const xn = /^\d+$/.test(xv),
      yn = /^\d+$/.test(yv);
    if (xn && yn) return BigInt(xv) > BigInt(yv);
    // Định danh số đứng trước định danh chữ (semver mục 11).
    if (xn !== yn) return !xn;
    return xv > yv;
  }
  return false;
}
