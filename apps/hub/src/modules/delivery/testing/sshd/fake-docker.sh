#!/bin/sh
# Lệnh `docker` giả cho test ssh-script: không có Docker trong container, chỉ in log, ngủ hoặc lỗi theo cờ.
#
# Cờ đọc từ môi trường hoặc từ `$FAKE_DOCKER_DIR/env` (test ghi file này qua helper; file thắng môi trường):
#   FAKE_DOCKER_LOG       in thêm dòng này ra stdout ở mỗi lần gọi
#   FAKE_DOCKER_SLEEP     ngủ bao nhiêu giây khi gặp từ FAKE_DOCKER_SLEEP_ON (mặc định `up`)
#   FAKE_DOCKER_FAIL      gặp từ này trong đối số thì in lỗi ra stderr và thoát mã FAKE_DOCKER_EXIT (mặc định 1)
# Project compose "đang chạy" đọc từ `$FAKE_DOCKER_DIR/projects`, mỗi dòng `<tên> <file compose,…>`.
# Mọi lần gọi ghi vào `$FAKE_DOCKER_DIR/calls` để test kiểm lệnh nào đã chạy.

state=${FAKE_DOCKER_DIR:-$HOME/.fake-docker}
mkdir -p "$state"
if [ -f "$state/env" ]; then
  . "$state/env"
fi
printf '%s\n' "$*" >> "$state/calls"
set -f

has_arg() {
  for a in $args; do
    [ "$a" = "$1" ] && return 0
  done
  return 1
}
args=$*

if [ -n "$FAKE_DOCKER_LOG" ]; then
  printf '%s\n' "$FAKE_DOCKER_LOG"
fi
if [ -n "$FAKE_DOCKER_SLEEP" ] && has_arg "${FAKE_DOCKER_SLEEP_ON:-up}"; then
  printf 'fake docker: ngủ %s giây\n' "$FAKE_DOCKER_SLEEP"
  sleep "$FAKE_DOCKER_SLEEP"
fi
if [ -n "$FAKE_DOCKER_FAIL" ] && has_arg "$FAKE_DOCKER_FAIL"; then
  printf 'fake docker: lỗi giả ở "%s"\n' "$FAKE_DOCKER_FAIL" >&2
  exit "${FAKE_DOCKER_EXIT:-1}"
fi

project=
prev=
for a in "$@"; do
  case "$prev" in
    -p | --project-name) project=$a ;;
  esac
  prev=$a
done

case "$1" in
  version)
    echo "Docker version 0.0.0-fake"
    exit 0
    ;;
  compose) ;;
  *)
    echo "fake docker: $*"
    exit 0
    ;;
esac

if has_arg version; then
  echo "Docker Compose version v0.0.0-fake"
elif has_arg ls; then
  if has_arg json; then
    sep=
    printf '['
    if [ -f "$state/projects" ]; then
      while read -r name files; do
        [ -n "$name" ] || continue
        printf '%s{"Name":"%s","Status":"running(1)","ConfigFiles":"%s"}' "$sep" "$name" "$files"
        sep=,
      done < "$state/projects"
    fi
    printf ']\n'
  elif has_arg -q; then
    [ -f "$state/projects" ] && cut -d ' ' -f 1 "$state/projects"
  else
    echo "NAME STATUS CONFIG FILES"
    [ -f "$state/projects" ] && sed 's/ / running(1) /' "$state/projects"
  fi
elif has_arg up; then
  echo "Container ${project:-${COMPOSE_PROJECT_NAME:-app}}-app-1  Started"
elif has_arg config; then
  :
else
  echo "fake docker: $*"
fi
exit 0
