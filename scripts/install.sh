#!/bin/sh
# Cài hoặc nâng cấp hive-worker (Linux, macOS) từ bản phát hành của xDev Hive.
#
#   curl -fsSL https://github.com/tdduydev/xdev-hive/releases/latest/download/install.sh | sh -s -- --hub URL --token MÃ
#
# Có --token: cài binary, đăng ký máy với hub rồi cài dịch vụ chạy nền. Không có --token: chỉ thay binary bằng bản mới
# và khởi động lại dịch vụ nếu đang chạy, nên chạy lại đúng lệnh này là cách nâng cấp.
#
# Tham số: --hub URL, --token MÃ, --machine TÊN, --capacity N, --version X.Y.Z (mặc định bản mới nhất),
# --dir THƯ_MỤC (mặc định ~/.local/bin), --no-service (không cài, không khởi động lại dịch vụ).
# HIVE_RELEASES_URL thay trang phát hành bằng bản sao nội bộ có cùng cấu trúc thư mục.
set -eu

releases="${HIVE_RELEASES_URL:-https://github.com/tdduydev/xdev-hive/releases}"
version="${HIVE_WORKER_VERSION:-latest}"
dir="${HIVE_INSTALL_DIR:-$HOME/.local/bin}"
hub="${HIVE_HUB_URL:-}"
token="${HIVE_REGISTRATION_TOKEN:-}"
machine=""
capacity=1
service=1

die() {
	printf 'Lỗi: %s\n' "$1" >&2
	exit 1
}

need() {
	command -v "$1" >/dev/null 2>&1 || die "cần lệnh $1 để cài"
}

while [ $# -gt 0 ]; do
	case "$1" in
	--no-service)
		service=0
		shift
		continue
		;;
	--hub | --token | --machine | --capacity | --version | --dir)
		[ $# -ge 2 ] || die "thiếu giá trị cho $1"
		;;
	*) die "tham số lạ: $1" ;;
	esac
	case "$1" in
	--hub) hub="$2" ;;
	--token) token="$2" ;;
	--machine) machine="$2" ;;
	--capacity) capacity="$2" ;;
	--version) version="${2#v}" ;;
	--dir) dir="$2" ;;
	esac
	shift 2
done

case "$(uname -s)" in
Linux) os=linux ;;
Darwin) os=darwin ;;
*) die "install.sh chỉ hỗ trợ Linux và macOS; trên Windows dùng install.ps1" ;;
esac
case "$(uname -m)" in
x86_64 | amd64) arch=amd64 ;;
arm64 | aarch64) arch=arm64 ;;
*) die "chưa có bản dựng cho CPU $(uname -m)" ;;
esac
[ -z "$token" ] || [ -n "$hub" ] || die "cần --hub khi có --token"
for cmd in curl tar openssl awk; do need "$cmd"; done

if [ "$version" = latest ]; then
	base="$releases/latest/download"
else
	base="$releases/download/v$version"
fi
asset="hive-worker_${os}_${arch}.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

fetch() {
	curl -fsSL --retry 3 -o "$tmp/$1" "$base/$1" || die "không tải được $base/$1"
}
fetch checksums.txt
fetch checksums.txt.sig
fetch "$asset"

# Khoá công khai ký checksums.txt; phải giống worker/internal/update/release-signing.pem (test Go kiểm).
cat >"$tmp/release-signing.pem" <<'EOF'
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAECNJFCSV1DBE0CC+kFeD8/XczocK2
ljQvs/rj+YhGueIFOP6GBwd+ROnZSkb3O7I7iAtvCwOQdEiLpXXAdM0Umw==
-----END PUBLIC KEY-----
EOF
openssl dgst -sha256 -verify "$tmp/release-signing.pem" -signature "$tmp/checksums.txt.sig" "$tmp/checksums.txt" >/dev/null 2>&1 ||
	die "chữ ký của checksums.txt không hợp lệ; không cài bản này"
want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/checksums.txt")
[ -n "$want" ] || die "bản phát hành không có $asset"
if command -v sha256sum >/dev/null 2>&1; then
	got=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
else
	got=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
fi
[ "$got" = "$want" ] || die "sha256 của $asset không khớp checksums.txt"

# -m: không đặt lại giờ sửa file, để máy chủ lệch đồng hồ không in cảnh báo "time stamp in the future".
tar -xzmf "$tmp/$asset" -C "$tmp" hive-worker
mkdir -p "$dir"
bin="$dir/hive-worker"
# Chép ra file tạm cùng thư mục rồi đổi tên đè: worker cũ đang chạy vẫn giữ file cũ, không bị ghi đè giữa chừng.
cp "$tmp/hive-worker" "$dir/.hive-worker.new"
chmod 755 "$dir/.hive-worker.new"
installed=$("$dir/.hive-worker.new" version) || {
	rm -f "$dir/.hive-worker.new"
	die "bản vừa tải không chạy được trên máy này"
}
if [ "$version" != latest ] && [ "$installed" != "$version" ]; then
	rm -f "$dir/.hive-worker.new"
	die "bản vừa tải báo phiên bản $installed, cần $version"
fi
mv -f "$dir/.hive-worker.new" "$bin"
printf 'Đã cài hive-worker %s vào %s\n' "$installed" "$bin"

case ":$PATH:" in
*":$dir:"*) ;;
*)
	# shellcheck disable=SC2016 # $PATH để nguyên cho người dùng chép vào shell của họ.
	printf 'Thêm %s vào PATH để gõ được hive-worker:\n  export PATH="%s:$PATH"\n' "$dir" "$dir"
	;;
esac
found=$(command -v hive-worker 2>/dev/null || true)
if [ -n "$found" ] && [ "$found" != "$bin" ]; then
	printf 'Lưu ý: PATH đang trỏ tới bản khác ở %s (có thể cài từ go install); xoá bản đó để dùng bản vừa cài.\n' "$found"
fi

if [ -n "$token" ]; then
	set -- register --hub "$hub" --capacity "$capacity"
	[ -z "$machine" ] || set -- "$@" --machine "$machine"
	# Token đi qua biến môi trường để không hiện trong danh sách tiến trình.
	HIVE_REGISTRATION_TOKEN="$token" "$bin" "$@"
	if [ "$service" = 1 ]; then
		"$bin" service install --capacity "$capacity"
	fi
elif [ "$service" = 1 ]; then
	"$bin" service restart
fi
