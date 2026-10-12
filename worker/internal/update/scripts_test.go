package update

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// scriptRelease dựng một bản phát hành giả cho nền tảng đang chạy test, với binary là chính binary test (đóng vai
// hive-worker, xem TestMain), ký bằng khoá tạo trong test. Script cài được chép ra với khoá công khai thay bằng khoá đó.
type scriptRelease struct {
	srv    *httptest.Server
	files  map[string][]byte
	key    *ecdsa.PrivateKey
	keyPEM string
}

func newScriptRelease(t *testing.T) *scriptRelease {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	r := &scriptRelease{files: map[string][]byte{}, key: key, keyPEM: strings.TrimSpace(string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})))}
	asset := AssetName(runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		r.files[asset] = zipped(t, "hive-worker.exe", string(testBinary(t)))
	} else {
		r.files[asset] = tarGz(t, "hive-worker", string(testBinary(t)))
	}
	sum := sha256.Sum256(r.files[asset])
	r.files["checksums.txt"] = []byte(fmt.Sprintf("%s  %s\n", hex.EncodeToString(sum[:]), asset))
	r.resign(t)
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		name := filepath.Base(req.URL.Path)
		dir := strings.TrimSuffix(req.URL.Path, "/"+name)
		if dir != "/releases/latest/download" && dir != "/releases/download/v1.2.3" {
			http.NotFound(w, req)
			return
		}
		data, ok := r.files[name]
		if !ok {
			http.NotFound(w, req)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *scriptRelease) resign(t *testing.T) {
	t.Helper()
	digest := sha256.Sum256(r.files["checksums.txt"])
	sig, err := ecdsa.SignASN1(rand.Reader, r.key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	r.files["checksums.txt.sig"] = sig
}

// script chép script cài ra thư mục tạm, thay khoá công khai thật bằng khoá của bản phát hành giả.
func (r *scriptRelease) script(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("../../../scripts", name))
	if err != nil {
		t.Fatal(err)
	}
	body := strings.ReplaceAll(string(data), "\r\n", "\n")
	real := strings.TrimSpace(strings.ReplaceAll(string(releaseKeyPEM), "\r\n", "\n"))
	if !strings.Contains(body, real) {
		t.Fatalf("%s không chứa khoá công khai thật", name)
	}
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(strings.Replace(body, real, r.keyPEM, 1)), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

type install struct {
	dir, log string
	out      string
	err      error
}

func (r *scriptRelease) run(t *testing.T, args ...string) install {
	t.Helper()
	home := t.TempDir()
	res := install{dir: filepath.Join(home, "bin"), log: filepath.Join(home, "calls.log")}
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		ps := append([]string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", r.script(t, "install.ps1"), "-Dir", res.dir, "-NoPathUpdate"}, args...)
		cmd = exec.Command("powershell.exe", ps...)
	} else {
		cmd = exec.Command("sh", append([]string{r.script(t, "install.sh"), "--dir", res.dir}, args...)...)
	}
	cmd.Env = append(os.Environ(),
		"HOME="+home,
		"HIVE_RELEASES_URL="+r.srv.URL+"/releases",
		fakeVersionEnv+"=1.2.3",
		fakeLogEnv+"="+res.log,
		"HIVE_REGISTRATION_TOKEN=",
		"HIVE_HUB_URL=",
		"HIVE_WORKER_VERSION=",
		"HIVE_INSTALL_DIR=",
	)
	out, err := cmd.CombinedOutput()
	res.out, res.err = string(out), err
	return res
}

func (i install) binary() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(i.dir, "hive-worker.exe")
	}
	return filepath.Join(i.dir, "hive-worker")
}

func (i install) calls(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(i.log)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return string(data)
}

func skipWithoutInstallTools(t *testing.T) {
	t.Helper()
	tools := []string{"sh", "curl", "tar", "openssl", "awk"}
	if runtime.GOOS == "windows" {
		tools = []string{"powershell.exe"}
	}
	for _, tool := range tools {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("thiếu %s", tool)
		}
	}
}

func flag(name string) string {
	// install.ps1 nhận tham số kiểu PowerShell (-Hub), install.sh kiểu GNU (--hub).
	if runtime.GOOS == "windows" {
		return "-" + strings.ToUpper(name[:1]) + name[1:]
	}
	return "--" + strings.ToLower(name)
}

func TestInstallScriptRegistersAndInstallsService(t *testing.T) {
	skipWithoutInstallTools(t)
	r := newScriptRelease(t)
	res := r.run(t, flag("hub"), "https://hive.example.com", flag("token"), "hwr_bimat", flag("machine"), "may-1", flag("capacity"), "2")
	if res.err != nil {
		t.Fatalf("%v\n%s", res.err, res.out)
	}
	if !strings.Contains(res.out, "Đã cài hive-worker 1.2.3") {
		t.Errorf("thiếu thông báo cài:\n%s", res.out)
	}
	calls := res.calls(t)
	want := []string{
		"register --hub https://hive.example.com --capacity 2 --machine may-1 token=hwr_bimat",
		"service install --capacity 2 token=",
	}
	if got := strings.Split(strings.TrimSpace(strings.ReplaceAll(calls, "\r\n", "\n")), "\n"); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("lệnh gọi:\n%s\ncần:\n%s", calls, strings.Join(want, "\n"))
	}
	if strings.Contains(res.out, "hwr_bimat") {
		t.Error("token đăng ký bị in ra")
	}
}

func TestInstallScriptUpgradeRestartsService(t *testing.T) {
	skipWithoutInstallTools(t)
	r := newScriptRelease(t)
	res := r.run(t, flag("version"), "v1.2.3")
	if res.err != nil {
		t.Fatalf("%v\n%s", res.err, res.out)
	}
	if _, err := os.Stat(res.binary()); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(res.calls(t)); got != "service restart token=" {
		t.Errorf("lệnh gọi = %q, cần service restart", got)
	}
}

func TestInstallScriptRejectsBadSignature(t *testing.T) {
	skipWithoutInstallTools(t)
	r := newScriptRelease(t)
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	r.key = other
	r.resign(t)
	res := r.run(t)
	if res.err == nil {
		t.Fatalf("cần lỗi chữ ký:\n%s", res.out)
	}
	if !strings.Contains(res.out, "hữ ký") {
		t.Errorf("thông báo không nói về chữ ký:\n%s", res.out)
	}
	if _, err := os.Stat(res.binary()); !os.IsNotExist(err) {
		t.Error("vẫn cài binary dù chữ ký sai")
	}
}

func TestInstallScriptRejectsTamperedArchive(t *testing.T) {
	skipWithoutInstallTools(t)
	r := newScriptRelease(t)
	asset := AssetName(runtime.GOOS, runtime.GOARCH)
	r.files[asset] = append([]byte{}, r.files[asset]...)
	r.files[asset][len(r.files[asset])-1] ^= 0xff
	res := r.run(t)
	if res.err == nil || !strings.Contains(res.out, "sha256") {
		t.Fatalf("cần lỗi sha256, có %v:\n%s", res.err, res.out)
	}
	if _, err := os.Stat(res.binary()); !os.IsNotExist(err) {
		t.Error("vẫn cài binary dù file nén bị sửa")
	}
}
