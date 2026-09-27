// Generates the app icons from one geometry (the HiveLogo hexagons in packages/ui) — macOS only:
// SVG → PNG through AppKit (swift), .icns through iconutil, .ico packed here.
//   npm run icons -w @xdev-hive/desktop
// Outputs are committed; rerun after changing the shapes or colours below.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const build = path.join(desktop, "build");
const resources = path.join(desktop, "resources");
const webPublic = path.resolve(desktop, "..", "web", "client", "public");

const COLORS = { top: "#F0A53A", bottom: "#B86B05", mark: "#FFF7E8" };

/** Pointy-top regular hexagon, as in HiveLogo (outer radius 9.5, inner 3.8 on a 24 grid). */
function hexagon(cx, cy, r) {
  const dx = (r * Math.sqrt(3)) / 2;
  const pts = [
    [cx, cy - r],
    [cx + dx, cy - r / 2],
    [cx + dx, cy + r / 2],
    [cx, cy + r],
    [cx - dx, cy + r / 2],
    [cx - dx, cy - r / 2],
  ];
  return pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

/**
 * margin/radius place the tile on the 1024 canvas: macOS keeps a 100 px margin (Big Sur grid),
 * Windows/Linux use nearly the full square, the iOS touch icon is a plain square (iOS rounds it).
 */
function iconSvg({ margin, radius }) {
  const size = 1024 - 2 * margin;
  const scale = size / 824; // mark proportions are set on the macOS tile
  const c = 512;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${COLORS.top}"/>
      <stop offset="1" stop-color="${COLORS.bottom}"/>
    </linearGradient>
  </defs>
  <rect x="${margin}" y="${margin}" width="${size}" height="${size}" rx="${radius}" fill="url(#bg)"/>
  <polygon points="${hexagon(c, c, 232 * scale)}" fill="none" stroke="${COLORS.mark}" stroke-width="${(58 * scale).toFixed(1)}" stroke-linejoin="round"/>
  <polygon points="${hexagon(c, c, 96 * scale)}" fill="${COLORS.mark}" stroke="${COLORS.mark}" stroke-width="${(16 * scale).toFixed(1)}" stroke-linejoin="round"/>
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
  };
  writeFileSync(svgs.mac, iconSvg({ margin: 100, radius: 185 }));
  writeFileSync(svgs.square, iconSvg({ margin: 24, radius: 216 }));
  writeFileSync(svgs.touch, iconSvg({ margin: 0, radius: 0 }));
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

  const swiftFile = path.join(tmp, "rasterize.swift");
  writeFileSync(swiftFile, RASTERIZE);
  execFileSync("swift", [swiftFile, ...jobs.flat().map(String)], { stdio: "inherit" });
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(build, "icon.icns")], { stdio: "inherit" });
  writeFileSync(
    path.join(build, "icon.ico"),
    packIco(icoSizes.map((size) => ({ size, data: readFileSync(path.join(tmp, `ico-${size}.png`)) }))),
  );
  console.log(`icons written to ${path.relative(process.cwd(), build)}, resources/icon.png and web/client/public`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
