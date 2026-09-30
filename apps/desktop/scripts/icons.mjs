// Generates the app icons from the xDev X (docs/design/2026-09-redesign: below 24 px the wordmark becomes the X alone)
// on the brand navy — macOS only: SVG → PNG through AppKit (swift), .icns through iconutil, .ico packed here.
//   npm run icons -w @xdev-hive/desktop
// Outputs are committed; rerun after changing the geometry or colours below.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const build = path.join(desktop, "build");
const resources = path.join(desktop, "resources");
const webPublic = path.resolve(desktop, "..", "web", "client", "public");

/** Navy tile (--brand-navy) and the X's gradient for dark backgrounds, as in assets/hive-dark.svg. */
const COLORS = { tile: "#142745", stops: ["#B8F1FF", "#3FA9FF", "#1C58FF"] };

/**
 * The "X" of Space Grotesk 600 (the font the wordmark sets its X in), as an outline so the icon needs no font:
 * 1000-unit em, baseline at y = 0, ink box x 24–618, y −700–0. The wordmark stretches it 1.1× horizontally.
 */
const X_PATH = "M162 0L24 0L235-353L27-700L164-700L313-438L330-438L478-700L616-700L408-353L618 0L481 0L330-268L313-268L162 0Z";
const X_BOX = { x: 24, y: -700, w: 594, h: 700, stretch: 1.1 };

/** The X centred in a box of `size` px at (x, y), `height` px tall. */
function xMark(x, y, size, height, fill) {
  const k = height / X_BOX.h;
  const w = X_BOX.w * X_BOX.stretch * k;
  const tx = x + (size - w) / 2 - X_BOX.x * X_BOX.stretch * k;
  const ty = y + (size - height) / 2 - X_BOX.y * k;
  return `<path d="${X_PATH}" transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${(k * X_BOX.stretch).toFixed(5)} ${k.toFixed(5)})" fill="${fill}"/>`;
}

/**
 * margin/radius place the tile on the 1024 canvas: macOS keeps a 100 px margin (Big Sur grid),
 * Windows/Linux use nearly the full square, the iOS touch icon is a plain square (iOS rounds it).
 */
function iconSvg({ margin, radius }) {
  const size = 1024 - 2 * margin;
  const [a, b, c] = COLORS.stops;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="x" cx="50%" cy="50%" r="80%">
      <stop offset="0" stop-color="${a}"/>
      <stop offset="0.4" stop-color="${b}"/>
      <stop offset="0.9" stop-color="${c}"/>
    </radialGradient>
  </defs>
  <rect x="${margin}" y="${margin}" width="${size}" height="${size}" rx="${radius}" fill="${COLORS.tile}"/>
  ${xMark(margin, margin, size, size * 0.5, "url(#x)")}
</svg>
`;
}

/** macOS menu-bar template: black X on transparent (the system tints it), a little inset like other tray icons. */
function traySvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  ${xMark(0, 0, 64, 50, "#000000")}
</svg>
`;
}

const RASTERIZE = `
import AppKit
// argv: [svg, size, out.png]...
let a = Array(CommandLine.arguments.dropFirst())
for i in stride(from: 0, to: a.count, by: 3) {
  guard let img = NSImage(contentsOfFile: a[i]) else { fatalError("cannot load \\(a[i])") }
  let n = Int(a[i + 1])!
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: n, pixelsHigh: n, bitsPerSample: 8, samplesPerPixel: 4,
                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = NSSize(width: n, height: n)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSGraphicsContext.current!.imageInterpolation = .high
  img.draw(in: NSRect(x: 0, y: 0, width: n, height: n), from: .zero, operation: .copy, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[i + 2]))
}
`;

/** ICO whose entries are PNGs (Windows Vista+). */
function packIco(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "hive-icons-"));
try {
  mkdirSync(build, { recursive: true });
  mkdirSync(webPublic, { recursive: true });
  const svgs = {
    mac: path.join(build, "icon.svg"),
    square: path.join(build, "icon-square.svg"),
    touch: path.join(tmp, "touch.svg"),
    tray: path.join(tmp, "tray.svg"),
  };
  writeFileSync(svgs.mac, iconSvg({ margin: 100, radius: 185 }));
  writeFileSync(svgs.square, iconSvg({ margin: 24, radius: 216 }));
  writeFileSync(svgs.touch, iconSvg({ margin: 0, radius: 0 }));
  writeFileSync(svgs.tray, traySvg());
  writeFileSync(path.join(webPublic, "favicon.svg"), readFileSync(svgs.square));

  const iconset = path.join(tmp, "icon.iconset");
  mkdirSync(iconset);
  const jobs = [];
  for (const base of [16, 32, 128, 256, 512]) {
    jobs.push([svgs.mac, base, path.join(iconset, `icon_${base}x${base}.png`)]);
    jobs.push([svgs.mac, base * 2, path.join(iconset, `icon_${base}x${base}@2x.png`)]);
  }
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  for (const s of icoSizes) jobs.push([svgs.square, s, path.join(tmp, `ico-${s}.png`)]);
  jobs.push([svgs.square, 1024, path.join(build, "icon.png")]);
  jobs.push([svgs.square, 512, path.join(resources, "icon.png")]);
  jobs.push([svgs.touch, 180, path.join(webPublic, "apple-touch-icon.png")]);
  jobs.push([svgs.tray, 16, path.join(resources, "trayTemplate.png")]);
  jobs.push([svgs.tray, 32, path.join(resources, "trayTemplate@2x.png")]);

  const swiftFile = path.join(tmp, "rasterize.swift");
  writeFileSync(swiftFile, RASTERIZE);
  execFileSync("swift", [swiftFile, ...jobs.flat().map(String)], { stdio: "inherit" });
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(build, "icon.icns")], { stdio: "inherit" });
  writeFileSync(
    path.join(build, "icon.ico"),
    packIco(icoSizes.map((size) => ({ size, data: readFileSync(path.join(tmp, `ico-${size}.png`)) }))),
  );
  console.log(`icons written to ${path.relative(process.cwd(), build)}, resources/ (icon, tray) and web/client/public`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
