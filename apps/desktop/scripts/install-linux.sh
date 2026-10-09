#!/bin/sh
# Installs xDev Hive for the current user from its AppImage, in the layout the app updates by itself without a
# password: ~/.local/share/xdev-hive/app-<version> chosen by a `current` symlink (updater.ts, linux-update.ts).
# The AppImage is unpacked, not run, so FUSE (libfuse2) is not needed. No root, no apt.
#   sh install-linux.sh xdev-hive-<version>-linux-x86_64.AppImage [--no-start] [--quit-running | --force-quit]
# Moving off the .deb: run this, then `sudo apt remove xdev-hive`. Settings and data stay (~/.config is shared).
set -eu

image=""
start=1
quit_running=0
force_quit=0
for arg in "$@"; do
  case "$arg" in
    --no-start) start=0 ;;
    --quit-running) quit_running=1 ;;
    --force-quit) quit_running=1; force_quit=1 ;;
    -h|--help)
      sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
      printf '\n--quit-running: close the app and wait up to 30 seconds for its work to stop.\n--force-quit: also force-stop it after that wait; unsaved work may be lost.\n'
      exit 0 ;;
    --*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) image=$arg ;;
  esac
done
[ -n "$image" ] && [ -f "$image" ] || { echo "Usage: sh $0 xdev-hive-<version>-linux-<arch>.AppImage [--no-start] [--quit-running | --force-quit]" >&2; exit 2; }
case "$image" in /*) ;; *) image="$PWD/$image" ;; esac

# Electron Node helpers have no app lock; only signal the GUI main process so it can stop its agents first.
gui_process() {
  [ -r "/proc/$1/stat" ] || return 1
  [ "$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null)" != Z ] || return 1
  if tr '\000' '\n' < "/proc/$1/environ" 2>/dev/null | grep -qx 'ELECTRON_RUN_AS_NODE=1'; then return 1; fi
  if tr '\000' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -Eq '(^|[[:space:]])--type='; then return 1; fi
  return 0
}

running_apps() {
  for pid in $(pgrep -u "$(id -u)" -x xdev-hive 2>/dev/null || true); do
    gui_process "$pid" || continue
    printf '%s:%s\n' "$pid" "$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null)"
  done
}

# A PID may be reused while waiting: never send a later signal to a different process.
still_running() {
  app_pid=${1%%:*}
  app_birth=${1#*:}
  gui_process "$app_pid" && [ "$(awk '{print $22}' "/proc/$app_pid/stat" 2>/dev/null)" = "$app_birth" ]
}

stop_running_apps() {
  running=$(running_apps)
  [ -n "$running" ] || return 0
  if [ "$quit_running" = 0 ] && [ -t 0 ]; then
    printf 'xDev Hive is running. Close it and stop its active runs to install? [y/N] '
    read -r answer || answer=n
    case "$answer" in y|Y|yes|YES) quit_running=1 ;; esac
  fi
  if [ "$quit_running" = 0 ]; then
    echo 'xDev Hive is running. Run again with --quit-running to close it and continue, or quit from the tray.' >&2
    exit 1
  fi
  echo 'Closing xDev Hive; waiting up to 30 seconds for its work to stop...'
  for app in $running; do
    if still_running "$app"; then kill -TERM "${app%%:*}" 2>/dev/null || true; fi
  done
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    pending=""
    for app in $running; do
      if still_running "$app"; then pending="$pending $app"; fi
    done
    [ -n "$pending" ] || break
    sleep 1
    attempts=$((attempts + 1))
  done
  for app in $running; do
    if still_running "$app"; then
      if [ "$force_quit" = 0 ]; then
        echo 'xDev Hive has not stopped. Wait for its work to finish, or use --force-quit (unsaved work may be lost).' >&2
        exit 1
      fi
      echo "Force stopping xDev Hive PID ${app%%:*}."
      kill -KILL "${app%%:*}" 2>/dev/null || true
    fi
  done
  # A service or an updater may have restarted the app while the original process was quitting.
  attempts=0
  while [ -n "$(running_apps)" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 5 ] || { echo 'xDev Hive is still running or restarted; installation was not switched.' >&2; exit 1; }
    sleep 1
  done
}

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

# Validate/extract the new build before interrupting a working app.
stop_running_apps

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
