The xDev Hive logo: the blue gradient X on a navy hexagon (a hive cell), with HIVE / DEV HUB lettering.

- `xdev-hive-icon.svg`: the mark alone, 1024×1024: X on a `brand-navy` (`#142745`) hexagon. App icon, favicon.
- `xdev-hive-mark-navy.svg`: the same mark with the hexagon lifted to `#22406E`, for the navy sidebar of web and
  desktop (next to the written name "xDev Hive"); on navy the `#142745` hexagon would vanish.
- `xdev-hive-light.svg`: mark plus lettering for light theme on `canvas` or `surface`. Lettering ink `#344568`
  (`brand-letter` light).
- `xdev-hive-dark.svg`: for dark theme on `brand-navy` or dark `surface`. Lettering ink `#E8ECF8` (`brand-letter`
  dark); the hexagon is lifted to `#22406E` so it still reads on a navy background.
- `apps/desktop/src-tauri/icons/tray-template.svg`: one-colour version for the tray (hexagon with the X cut out), a
  macOS template image; the app draws the status dot on top.

Every file draws the X and the hexagon as paths, so no font is needed. `png/` holds both wordmarks rendered at 4×
and cropped, for places that cannot show SVG (GitHub README). After changing an SVG, regenerate:

- desktop icons: `pnpm --filter @xdev-hive/desktop tauri icon ../../docs/design-system/assets/logos/xdev-hive-icon.svg`;
- tray PNG: `tauri icon <tray-template.svg> -o <dir> -p 44`, then copy `44x44.png` to `icons/tray-template.png`;
- `apps/web/public/` keeps copies of the SVGs it serves (favicon, sidebar mark, sign-in pages).
