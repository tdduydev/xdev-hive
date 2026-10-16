// Package update tải bản worker dựng sẵn từ GitHub Releases, kiểm chữ ký và checksum rồi thay file đang chạy.
//
// Mỗi bản phát hành có checksums.txt (sha256 của từng file nén) và checksums.txt.sig (chữ ký ECDSA P-256 trên
// checksums.txt). Khoá công khai nằm sẵn trong binary, nên đổi file trên trang phát hành mà không có khoá bí mật thì
// worker không cài.
package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/procattr"
)

//go:embed release-signing.pem
var releaseKeyPEM []byte

const (
	// ReleasesURL là gốc tải file: <ReleasesURL>/download/v1.2.3/<file>.
	ReleasesURL = "https://github.com/tdduydev/xdev-hive/releases"
	// LatestAPI trả JSON có tag_name của bản mới nhất (không tính bản nháp và pre-release).
	LatestAPI = "https://api.github.com/repos/tdduydev/xdev-hive/releases/latest"

	maxSmall   = 1 << 20
	maxArchive = 200 << 20
)

var semver = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$`)

// Source là nơi lấy bản phát hành. Test thay URL bằng server giả và khoá tạo trong test.
type Source struct {
	HTTP      *http.Client
	Releases  string
	LatestAPI string
	PublicKey *ecdsa.PublicKey
	GOOS      string
	GOARCH    string
}

// Default trỏ tới trang phát hành của repo, với khoá công khai nằm trong binary.
func Default() (Source, error) {
	key, err := ParsePublicKey(releaseKeyPEM)
	if err != nil {
		return Source{}, err
	}
	return Source{
		HTTP:      &http.Client{Timeout: 5 * time.Minute},
		Releases:  ReleasesURL,
		LatestAPI: LatestAPI,
		PublicKey: key,
		GOOS:      runtime.GOOS,
		GOARCH:    runtime.GOARCH,
	}, nil
}

// ParsePublicKey đọc khoá công khai ECDSA dạng PEM "PUBLIC KEY".
func ParsePublicKey(data []byte) (*ecdsa.PublicKey, error) {
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PUBLIC KEY" {
		return nil, errors.New("khoá ký bản phát hành không phải PEM PUBLIC KEY")
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("đọc khoá ký bản phát hành: %w", err)
	}
	ec, ok := key.(*ecdsa.PublicKey)
	if !ok {
		return nil, errors.New("khoá ký bản phát hành không phải ECDSA")
	}
	return ec, nil
}

// ValidVersion: phiên bản dạng semver, không có tiền tố v.
func ValidVersion(v string) bool { return semver.MatchString(v) }

// Newer cho biết a mới hơn b theo semver. Bản dựng từ mã nguồn (0.0.0-dev) luôn cũ hơn bản phát hành.
func Newer(a, b string) bool {
	x, y := semver.FindStringSubmatch(a), semver.FindStringSubmatch(b)
	if x == nil || y == nil {
		return false
	}
	for i := 1; i <= 3; i++ {
		xn, _ := strconv.ParseUint(x[i], 10, 64)
		yn, _ := strconv.ParseUint(y[i], 10, 64)
		if xn != yn {
			return xn > yn
		}
	}
	xp, yp := x[4], y[4]
	if xp == "" || yp == "" {
		return xp == "" && yp != ""
	}
	xs, ys := strings.Split(xp, "."), strings.Split(yp, ".")
	for i := 0; i < len(xs) || i < len(ys); i++ {
		if i >= len(xs) {
			return false
		}
		if i >= len(ys) {
			return true
		}
		if xs[i] == ys[i] {
			continue
		}
		xn, xerr := strconv.ParseUint(xs[i], 10, 64)
		yn, yerr := strconv.ParseUint(ys[i], 10, 64)
		switch {
		case xerr == nil && yerr == nil:
			return xn > yn
		case (xerr == nil) != (yerr == nil):
			// Định danh số đứng trước định danh chữ (semver mục 11).
			return xerr != nil
		default:
			return xs[i] > ys[i]
		}
	}
	return false
}

// AssetName là tên file nén của worker cho một nền tảng, khớp name_template trong worker/.goreleaser.yaml.
func AssetName(goos, goarch string) string {
	if goos == "windows" {
		return "hive-worker_" + goos + "_" + goarch + ".zip"
	}
	return "hive-worker_" + goos + "_" + goarch + ".tar.gz"
}

// Latest trả phiên bản mới nhất trên trang phát hành, không có tiền tố v.
func (s Source) Latest(ctx context.Context) (string, error) {
	body, err := s.get(ctx, s.LatestAPI, maxSmall)
	if err != nil {
		return "", fmt.Errorf("hỏi bản mới nhất: %w", err)
	}
	var release struct {
		TagName string `json:"tag_name"`
	}
	if err := json.Unmarshal(body, &release); err != nil {
		return "", fmt.Errorf("đọc bản mới nhất: %w", err)
	}
	v := strings.TrimPrefix(release.TagName, "v")
	if !ValidVersion(v) {
		return "", fmt.Errorf("bản phát hành có tag lạ %q", release.TagName)
	}
	return v, nil
}

// Binaries là các binary trong một file nén phát hành. Hive rỗng khi bản phát hành chưa có lệnh `hive` (bản cũ).
type Binaries struct {
	Worker []byte
	Hive   []byte
}

// Download tải binary worker của một phiên bản cho nền tảng của Source, sau khi kiểm chữ ký checksums.txt và sha256
// của file nén. Cần cả `hive` thì dùng DownloadAll.
func (s Source) Download(ctx context.Context, version string) ([]byte, error) {
	b, err := s.DownloadAll(ctx, version)
	return b.Worker, err
}

// DownloadAll như Download nhưng trả cả `hive` khi file nén có.
func (s Source) DownloadAll(ctx context.Context, version string) (Binaries, error) {
	if !ValidVersion(version) {
		return Binaries{}, fmt.Errorf("phiên bản không hợp lệ: %q", version)
	}
	base := strings.TrimRight(s.Releases, "/") + "/download/v" + version + "/"
	sums, err := s.get(ctx, base+"checksums.txt", maxSmall)
	if err != nil {
		return Binaries{}, fmt.Errorf("tải checksums.txt: %w", err)
	}
	sig, err := s.get(ctx, base+"checksums.txt.sig", maxSmall)
	if err != nil {
		return Binaries{}, fmt.Errorf("tải checksums.txt.sig: %w", err)
	}
	digest := sha256.Sum256(sums)
	if s.PublicKey == nil || !ecdsa.VerifyASN1(s.PublicKey, digest[:], sig) {
		return Binaries{}, errors.New("chữ ký của checksums.txt không hợp lệ; không cài bản này")
	}
	asset := AssetName(s.GOOS, s.GOARCH)
	want, ok := lookupChecksum(sums, asset)
	if !ok {
		return Binaries{}, fmt.Errorf("bản %s không có file cho %s/%s", version, s.GOOS, s.GOARCH)
	}
	archive, err := s.get(ctx, base+asset, maxArchive)
	if err != nil {
		return Binaries{}, fmt.Errorf("tải %s: %w", asset, err)
	}
	got := sha256.Sum256(archive)
	if hex.EncodeToString(got[:]) != want {
		return Binaries{}, fmt.Errorf("sha256 của %s không khớp checksums.txt", asset)
	}
	return extract(asset, archive)
}

func (s Source) get(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	client := s.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s trả HTTP %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("%s lớn hơn %d byte", url, limit)
	}
	return body, nil
}

// lookupChecksum đọc định dạng của sha256sum: "<hex>  <tên file>" mỗi dòng.
func lookupChecksum(sums []byte, name string) (string, bool) {
	for _, line := range strings.Split(string(sums), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name && len(fields[0]) == 64 {
			return strings.ToLower(fields[0]), true
		}
	}
	return "", false
}

// extract lấy hive-worker và (nếu có) hive ra khỏi file nén. Thiếu hive không phải lỗi: bản phát hành trước khi có
// lệnh `hive` chỉ chứa worker.
func extract(asset string, archive []byte) (Binaries, error) {
	var out Binaries
	suffix := ""
	if strings.HasSuffix(asset, ".zip") {
		suffix = ".exe"
	}
	assign := func(name string, r io.Reader) error {
		switch name {
		case "hive-worker" + suffix:
			data, err := readLimited(r)
			out.Worker = data
			return err
		case "hive" + suffix:
			data, err := readLimited(r)
			out.Hive = data
			return err
		}
		return nil
	}
	if suffix != "" {
		zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return Binaries{}, err
		}
		for _, f := range zr.File {
			if f.FileInfo().IsDir() {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return Binaries{}, err
			}
			err = assign(path.Base(f.Name), rc)
			rc.Close()
			if err != nil {
				return Binaries{}, err
			}
		}
	} else {
		gz, err := gzip.NewReader(bytes.NewReader(archive))
		if err != nil {
			return Binaries{}, err
		}
		tr := tar.NewReader(gz)
		for {
			h, err := tr.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return Binaries{}, err
			}
			if h.Typeflag != tar.TypeReg {
				continue
			}
			if err := assign(path.Base(h.Name), tr); err != nil {
				return Binaries{}, err
			}
		}
	}
	if out.Worker == nil {
		return Binaries{}, fmt.Errorf("%s không có hive-worker%s", asset, suffix)
	}
	return out, nil
}

func readLimited(r io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxArchive+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxArchive {
		return nil, errors.New("binary trong file nén quá lớn")
	}
	return data, nil
}

// Executable là đường dẫn thật của binary đang chạy (đã giải symlink), nơi Install ghi đè.
func Executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return "", err
	}
	// Binary đi kèm app desktop nằm trong gói .app đã ký; ghi đè làm hỏng chữ ký, và app tự cập nhật cả gói.
	if strings.Contains(filepath.ToSlash(exe), ".app/Contents/") {
		return "", errors.New("worker này đi kèm app desktop; cập nhật bằng app desktop")
	}
	return exe, nil
}

// Install thay riêng worker. Gói có cả `hive` thì dùng InstallAll.
func Install(exe string, binary []byte, version string) error {
	return InstallAll(exe, Binaries{Worker: binary}, version)
}

// InstallAll ghi binary mới cạnh exe, chạy thử `version` của từng file để chắc chúng chạy được trên máy này và đúng
// phiên bản, rồi mới thay. Hỏng bước nào trước khi thay thì không file nào bị đổi. `hive` nằm cùng thư mục với worker
// (install.sh và install.ps1 cài chung một thư mục); gói không có `hive` thì chỉ thay worker và để nguyên `hive` cũ.
func InstallAll(exe string, b Binaries, version string) error {
	dir := filepath.Dir(exe)
	cleanOld(exe)
	worker, err := stage(dir, ".hive-worker-*.new", b.Worker, version, false)
	if err != nil {
		return err
	}
	defer os.Remove(worker)
	var hiveNew, hiveExe string
	if b.Hive != nil {
		hiveNew, err = stage(dir, ".hive-*.new", b.Hive, version, true)
		if err != nil {
			return err
		}
		defer os.Remove(hiveNew)
		hiveExe = filepath.Join(dir, "hive"+filepath.Ext(exe))
	}
	if hiveExe == "" {
		return replace(worker, exe)
	}
	// Thay `hive` trước: nếu thay worker lỗi thì trả `hive` về bản cũ, để hai binary luôn cùng một bản (hive và worker
	// nói chuyện qua giao thức cục bộ có phiên bản, lệch bản thì hive báo lỗi).
	previous, readErr := os.ReadFile(hiveExe)
	if err := replace(hiveNew, hiveExe); err != nil {
		return err
	}
	if err := replace(worker, exe); err != nil {
		if readErr == nil {
			_ = restore(hiveExe, previous)
		} else {
			_ = os.Remove(hiveExe)
		}
		return err
	}
	return nil
}

// stage ghi binary ra file tạm cạnh đích rồi chạy thử `version`. hive in "hive <phiên bản>" ở dòng đầu và thoát khác
// 0 khi worker chưa chạy, nên với hive chỉ đọc dòng đầu.
func stage(dir, pattern string, binary []byte, version string, isHive bool) (string, error) {
	if runtime.GOOS == "windows" {
		// Windows chỉ chạy được file có đuôi .exe.
		pattern += ".exe"
	}
	tmp, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return "", fmt.Errorf("không ghi được vào %s (cài lại bằng install.sh hoặc chạy với quyền ghi thư mục này): %w", dir, err)
	}
	name := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			os.Remove(name)
		}
	}()
	if _, err := tmp.Write(binary); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Chmod(name, 0o755); err != nil {
		return "", err
	}
	out, err := procattr.Command(name, "version").Output()
	if err != nil && !(isHive && len(out) > 0) {
		return "", fmt.Errorf("bản mới không chạy được trên máy này: %w", err)
	}
	if got := reportedVersion(string(out)); got != version {
		return "", fmt.Errorf("bản tải về báo phiên bản %q, cần %q", got, version)
	}
	ok = true
	return name, nil
}

// reportedVersion lấy phiên bản từ dòng đầu của `version`: "1.2.3" (hive-worker) hoặc "hive 1.2.3" (hive).
func reportedVersion(out string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(out), "\n")
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return ""
	}
	return fields[len(fields)-1]
}

// restore ghi lại nội dung cũ của một file đã bị thay.
func restore(exe string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(exe), ".hive-restore-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(name, 0o755); err != nil {
		return err
	}
	return replace(name, exe)
}

// replace thay exe bằng file mới. Unix đổi tên đè lên được cả khi exe đang chạy. Windows không ghi đè được file đang
// chạy nhưng đổi tên được, nên dời exe sang .old trước; .old của lần trước còn bị khoá (bản cũ đang chạy) thì dời sang
// tên khác và dọn ở lần cập nhật sau.
func replace(src, exe string) error {
	if runtime.GOOS != "windows" {
		return os.Rename(src, exe)
	}
	if _, err := os.Lstat(exe); errors.Is(err, fs.ErrNotExist) {
		// Máy cài trước khi có hive: chưa có file đích để dời.
		return os.Rename(src, exe)
	}
	old := exe + ".old"
	if err := os.Remove(old); err != nil && !errors.Is(err, fs.ErrNotExist) {
		old = fmt.Sprintf("%s.%d.old", exe, time.Now().UnixNano())
	}
	if err := os.Rename(exe, old); err != nil {
		return err
	}
	if err := os.Rename(src, exe); err != nil {
		_ = os.Rename(old, exe)
		return err
	}
	return nil
}

// cleanOld xoá các file .old do replace để lại trên Windows. Bản cũ còn chạy thì xoá không được, để lần sau.
func cleanOld(exe string) {
	if runtime.GOOS != "windows" {
		return
	}
	for _, base := range []string{exe, filepath.Join(filepath.Dir(exe), "hive"+filepath.Ext(exe))} {
		matches, _ := filepath.Glob(base + "*.old")
		for _, m := range matches {
			_ = os.Remove(m)
		}
	}
}
