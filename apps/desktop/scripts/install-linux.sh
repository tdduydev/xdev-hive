#!/bin/sh
# Installs xDev Hive for the current user from its AppImage, in the layout the app updates by itself without a
# password: ~/.local/share/xdev-hive/app-<version> chosen by a `current` symlink (updater.ts, linux-update.ts).
# The AppImage is unpacked, not run, so FUSE (libfuse2) is not needed. No root, no apt.
#   sh install-linux.sh xdev-hive-<version>-linux-x86_64.AppImage [--no-start]
# Moving off the .deb: run this, then `sudo apt remove xdev-hive`. Settings and data stay (~/.config is shared).
set -eu

image=""
start=1
for arg in "$@"; do
  case "$arg" in
    --no-start) start=0 ;;
    -h|--help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) image=$arg ;;
  esac
done
[ -n "$image" ] && [ -f "$image" ] || { echo "Usage: sh $0 xdev-hive-<version>-linux-<arch>.AppImage [--no-start]" >&2; exit 2; }
case "$image" in /*) ;; *) image="$PWD/$image" ;; esac

# The app holds a single-instance lock: a running copy (deb or this layout) would swallow the new start.
if pgrep -x xdev-hive >/dev/null 2>&1; then
  echo "xDev Hive is running. Quit it first (tray icon → Quit), then run this again." >&2
  exit 1
fi

root="${XDG_DATA_HOME:-$HOME/.local/share}/xdev-hive"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$root" "$apps"
stage=$(mktemp -d "$root/.install-XXXXXX")
trap 'rm -rf "$stage"' EXIT

chmod +x "$image"
(cd "$stage" && "$image" --appimage-extract >/dev/null)
new="$stage/squashfs-root"
[ -x "$new/AppRun" ] || { echo "Not an xDev Hive AppImage: no AppRun inside." >&2; exit 1; }

# The version decides the folder name the updater looks for (app-<digits>…): from the build's own desktop entry,
# else from the file name.
version=$(sed -n 's/^X-AppImage-Version=//p' "$new"/*.desktop 2>/dev/null | head -n 1)
[ -n "$version" ] || version=$(basename "$image" | sed -n 's/^xdev-hive-\([0-9][0-9.]*[0-9]\)-linux.*/\1/p')
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' || { echo "Cannot tell the version of $image." >&2; exit 1; }

target="$root/app-$version"
if [ -e "$target" ]; then
  echo "app-$version already installed; switching to it."
else
  mv "$new" "$target"
fi
# Atomic switch, as the updater's helper does it: a half-written link never points at nothing.
ln -s "app-$version" "$root/current.new"
mv -Tf "$root/current.new" "$root/current"

# Same desktop file id as the .deb's (xdev-hive.desktop): the user's copy wins in the menu, so there is one entry
# and it starts this install even while the .deb is still there.
entry=$(ls "$target"/*.desktop 2>/dev/null | head -n 1 || true)
icon="$root/current/xdev-hive.png"
[ -f "$target/xdev-hive.png" ] || icon=xdev-hive
{
  if [ -n "$entry" ]; then
    sed -e "s|^Exec=AppRun|Exec=\"$root/current/AppRun\"|" -e "s|^Exec=xdev-hive|Exec=\"$root/current/AppRun\"|" \
        -e "s|^Icon=.*|Icon=$icon|" -e '/^X-AppImage-/d' "$entry"
  else
    printf '[Desktop Entry]\nName=xDev Hive\nExec="%s" %%U\nTerminal=false\nType=Application\nIcon=%s\nStartupWMClass=xDev Hive\nCategories=Development;\n' "$root/current/AppRun" "$icon"
  fi
} > "$apps/xdev-hive.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps" >/dev/null 2>&1 || true

# An autostart entry made for the .deb would keep starting the old copy.
autostart="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/xdev-hive.desktop"
if [ -f "$autostart" ]; then
  hidden=""
  grep -q '^Exec=.*--hidden' "$autostart" && hidden=" --hidden"
  sed -i "s|^Exec=.*|Exec=\"$root/current/AppRun\"$hidden|" "$autostart"
fi

mkdir -p "$HOME/.local/bin"
ln -sfn "$root/current/AppRun" "$HOME/.local/bin/xdev-hive"

echo "Installed xDev Hive $version in $root (updates itself from the hub, no password)."
if dpkg-query -W -f='${Status}' xdev-hive 2>/dev/null | grep -q "install ok installed"; then
  echo "The old .deb is still installed. Remove it with: sudo apt remove xdev-hive   (settings and data are kept)"
fi
if [ "$start" = 1 ]; then
  nohup "$root/current/AppRun" >/dev/null 2>&1 &
  echo "Started."
fi
