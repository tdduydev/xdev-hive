package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Test cài thật cần một file chạy được trên mọi hệ điều hành: dùng chính binary test. Có fakeVersionEnv thì nó đóng
// vai hive-worker: `version` in phiên bản, lệnh khác ghi tham số (và token đăng ký) vào fakeLogEnv rồi thoát.
const (
	fakeVersionEnv = "HIVE_UPDATE_TEST_VERSION"
	fakeLogEnv     = "HIVE_UPDATE_TEST_LOG"
)

func TestMain(m *testing.M) {
	if v := os.Getenv(fakeVersionEnv); v != "" {
		if len(os.Args) > 1 && os.Args[1] == "version" {
			fmt.Println(v)
		} else if log := os.Getenv(fakeLogEnv); log != "" {
			f, err := os.OpenFile(log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
			if err == nil {
				fmt.Fprintf(f, "%s token=%s\n", strings.Join(os.Args[1:], " "), os.Getenv("HIVE_REGISTRATION_TOKEN"))
				f.Close()
			}
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.2.0", "0.1.9", true},
		{"0.1.0", "0.1.0", false},
		{"0.1.0", "0.0.0-dev", true},
		{"1.0.0", "1.0.0-rc.1", true},
		{"1.0.0-rc.2", "1.0.0-rc.10", false},
		{"1.0.0-rc.a", "1.0.0-rc.1", true},
		{"0.10.0", "0.9.0", true},
		{"v0.2.0", "0.1.0", false},
	}
	for _, c := range cases {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, cần %v", c.a, c.b, got, c.want)
		}
	}
}

func TestEmbeddedKeyParses(t *testing.T) {
	if _, err := Default(); err != nil {
		t.Fatal(err)
	}
}

// install.sh kiểm chữ ký bằng openssl với khoá viết sẵn trong script; lệch với khoá trong binary thì một trong hai
// đường cài sẽ từ chối mọi bản phát hành.
func TestInstallScriptsCarrySameKey(t *testing.T) {
	body := strings.TrimSpace(string(releaseKeyPEM))
	for _, script := range []string{"../../../scripts/install.sh", "../../../scripts/install.ps1"} {
		data, err := os.ReadFile(script)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(strings.ReplaceAll(string(data), "\r\n", "\n"), body) {
			t.Errorf("%s không chứa khoá công khai trong worker/internal/update/release-signing.pem", script)
		}
	}
}

type fakeRelease struct {
	key     *ecdsa.PrivateKey
	files   map[string][]byte
	sumsFor []string
}

func newFakeRelease(t *testing.T, version, binary string) *fakeRelease {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	r := &fakeRelease{key: key, files: map[string][]byte{}}
	r.files[AssetName("linux", "amd64")] = tarGz(t, "hive-worker", binary)
	r.files[AssetName("windows", "amd64")] = zipped(t, "hive-worker.exe", binary)
	r.files["latest"] = []byte(`{"tag_name":"v` + version + `","name":"v` + version + `"}`)
	r.sign(t)
	return r
}

func (r *fakeRelease) sign(t *testing.T) {
	t.Helper()
	var sums strings.Builder
	for _, name := range []string{AssetName("linux", "amd64"), AssetName("windows", "amd64")} {
		sum := sha256.Sum256(r.files[name])
		fmt.Fprintf(&sums, "%s  %s\n", hex.EncodeToString(sum[:]), name)
	}
	r.files["checksums.txt"] = []byte(sums.String())
	digest := sha256.Sum256(r.files["checksums.txt"])
	sig, err := ecdsa.SignASN1(rand.Reader, r.key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	r.files["checksums.txt.sig"] = sig
}

func (r *fakeRelease) serve(t *testing.T, version, goos string) Source {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		name := strings.TrimPrefix(req.URL.Path, "/releases/download/v"+version+"/")
		if req.URL.Path == "/latest" {
			name = "latest"
		}
		data, ok := r.files[name]
		if !ok {
			http.NotFound(w, req)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(srv.Close)
	return Source{HTTP: srv.Client(), Releases: srv.URL + "/releases", LatestAPI: srv.URL + "/latest", PublicKey: &r.key.PublicKey, GOOS: goos, GOARCH: "amd64"}
}

func tarGz(t *testing.T, name, content string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, f := range []struct{ name, body string }{{"README.md", "đọc tôi"}, {name, content}} {
		if err := tw.WriteHeader(&tar.Header{Name: f.name, Mode: 0o755, Size: int64(len(f.body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write([]byte(f.body))
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

func zipped(t *testing.T, name, content string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte(content))
	_ = zw.Close()
	return buf.Bytes()
}

func TestLatestAndDownload(t *testing.T) {
	r := newFakeRelease(t, "1.2.3", "binary-moi")
	for _, goos := range []string{"linux", "windows"} {
		src := r.serve(t, "1.2.3", goos)
		latest, err := src.Latest(context.Background())
		if err != nil || latest != "1.2.3" {
			t.Fatalf("Latest = %q, %v", latest, err)
		}
		got, err := src.Download(context.Background(), latest)
		if err != nil {
			t.Fatalf("%s: %v", goos, err)
		}
		if string(got) != "binary-moi" {
			t.Errorf("%s: binary = %q", goos, got)
		}
	}
}

func TestDownloadRejectsTampering(t *testing.T) {
	t.Run("chữ ký của khoá khác", func(t *testing.T) {
		r := newFakeRelease(t, "1.2.3", "binary")
		src := r.serve(t, "1.2.3", "linux")
		other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		src.PublicKey = &other.PublicKey
		if _, err := src.Download(context.Background(), "1.2.3"); err == nil || !strings.Contains(err.Error(), "chữ ký") {
			t.Fatalf("cần lỗi chữ ký, có %v", err)
		}
	})
	t.Run("file nén bị thay sau khi ký", func(t *testing.T) {
		r := newFakeRelease(t, "1.2.3", "binary")
		r.files[AssetName("linux", "amd64")] = tarGz(t, "hive-worker", "mã độc")
		src := r.serve(t, "1.2.3", "linux")
		if _, err := src.Download(context.Background(), "1.2.3"); err == nil || !strings.Contains(err.Error(), "sha256") {
			t.Fatalf("cần lỗi sha256, có %v", err)
		}
	})
	t.Run("checksums.txt bị sửa", func(t *testing.T) {
		r := newFakeRelease(t, "1.2.3", "binary")
		r.files["checksums.txt"] = append(r.files["checksums.txt"], []byte("00  thêm\n")...)
		src := r.serve(t, "1.2.3", "linux")
		if _, err := src.Download(context.Background(), "1.2.3"); err == nil || !strings.Contains(err.Error(), "chữ ký") {
			t.Fatalf("cần lỗi chữ ký, có %v", err)
		}
	})
	t.Run("nền tảng không có trong bản phát hành", func(t *testing.T) {
		r := newFakeRelease(t, "1.2.3", "binary")
		src := r.serve(t, "1.2.3", "darwin")
		if _, err := src.Download(context.Background(), "1.2.3"); err == nil || !strings.Contains(err.Error(), "darwin/amd64") {
			t.Fatalf("cần lỗi thiếu nền tảng, có %v", err)
		}
	})
	t.Run("phiên bản lạ", func(t *testing.T) {
		r := newFakeRelease(t, "1.2.3", "binary")
		src := r.serve(t, "1.2.3", "linux")
		if _, err := src.Download(context.Background(), "../../x"); err == nil {
			t.Fatal("cần lỗi phiên bản")
		}
	})
}

func testBinary(t *testing.T) []byte {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestInstallReplacesExecutable(t *testing.T) {
	t.Setenv(fakeVersionEnv, "1.2.3")
	dir := t.TempDir()
	exe := filepath.Join(dir, "hive-worker")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	if err := os.WriteFile(exe, []byte("bản cũ"), 0o755); err != nil {
		t.Fatal(err)
	}
	binary := testBinary(t)
	if err := Install(exe, binary, "1.2.3"); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(exe)
	if !bytes.Equal(got, binary) {
		t.Fatal("exe chưa được thay bằng bản mới")
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.Contains(e.Name(), ".new") {
			t.Errorf("còn file tạm %s", e.Name())
		}
	}
}

func TestInstallRefusesWrongVersion(t *testing.T) {
	t.Setenv(fakeVersionEnv, "9.9.9")
	dir := t.TempDir()
	exe := filepath.Join(dir, "hive-worker")
	if err := os.WriteFile(exe, []byte("bản cũ"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Install(exe, testBinary(t), "1.2.3"); err == nil || !strings.Contains(err.Error(), "9.9.9") {
		t.Fatalf("cần lỗi lệch phiên bản, có %v", err)
	}
	if got, _ := os.ReadFile(exe); string(got) != "bản cũ" {
		t.Fatal("exe bị thay dù bản mới sai phiên bản")
	}
}
