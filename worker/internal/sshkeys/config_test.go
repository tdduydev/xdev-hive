package sshkeys

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const handConfig = `# máy dev
Host macmini
    HostName 10.86.140.63
    User duynh60
    IdentityFile ~/.ssh/id_ed25519

Host joinytran jt
    HostName 10.86.138.74
    User joinytran
    Port 2222

Host bastion-*
    User ops

Host jump-target
    HostName 10.0.0.5
    ProxyJump bastion

Match host 10.1.*
    User matcher

Host *
    ServerAliveInterval 30
`

var hiveProd = Host{Alias: "hive-prod", HostName: "10.86.224.34", User: "adminvm", Port: 22}

func TestParseConfig(t *testing.T) {
	hosts := ParseConfig([]byte(handConfig))
	got := map[string]Host{}
	for _, h := range hosts {
		got[h.Alias] = h
	}
	if len(hosts) != 3 {
		t.Fatalf("muốn 3 khối có tên cụ thể (macmini, joinytran, jump-target), có %d: %+v", len(hosts), hosts)
	}
	if h := got["macmini"]; h.HostName != "10.86.140.63" || h.User != "duynh60" || h.Port != 22 ||
		h.IdentityFile != "~/.ssh/id_ed25519" || h.Managed || h.Proxy {
		t.Errorf("macmini sai: %+v", h)
	}
	if h := got["joinytran"]; h.Port != 2222 || h.User != "joinytran" {
		t.Errorf("joinytran sai: %+v", h)
	}
	if h := got["jump-target"]; !h.Proxy {
		t.Errorf("jump-target phải có cờ proxy: %+v", h)
	}
}

func TestParseConfigDefaultsAndQuotes(t *testing.T) {
	hosts := ParseConfig([]byte("Host only\n  IdentityFile \"C:/Users/a b/.ssh/id\"\nHost=eq\n  HostName=1.2.3.4\n  ProxyCommand none\n"))
	if len(hosts) != 2 {
		t.Fatalf("muốn 2 khối, có %+v", hosts)
	}
	if hosts[0].HostName != "only" || hosts[0].Port != 22 || hosts[0].IdentityFile != "C:/Users/a b/.ssh/id" {
		t.Errorf("mặc định hay bỏ nháy sai: %+v", hosts[0])
	}
	if hosts[1].Alias != "eq" || hosts[1].HostName != "1.2.3.4" || hosts[1].Proxy {
		t.Errorf("dạng key=value hay ProxyCommand none sai: %+v", hosts[1])
	}
}

func TestAddBlockBeforeHostStar(t *testing.T) {
	out, err := AddBlock([]byte(handConfig), hiveProd, "~/.ssh/id_ed25519")
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	block := "# >>> xdev-hive hive-prod\nHost hive-prod\n    HostName 10.86.224.34\n    User adminvm\n    Port 22\n" +
		"    IdentityFile ~/.ssh/id_ed25519\n    IdentitiesOnly yes\n# <<< xdev-hive\n"
	if !strings.Contains(s, block+"\nHost *\n") {
		t.Fatalf("khối phải nằm ngay trước Host *, có:\n%s", s)
	}
	if strings.Replace(s, block+"\n", "", 1) != handConfig {
		t.Error("phần ngoài khối phải giữ nguyên từng byte")
	}
	var managed []Host
	for _, h := range ParseConfig(out) {
		if h.Managed {
			managed = append(managed, h)
		}
	}
	if len(managed) != 1 || managed[0].Alias != "hive-prod" || managed[0].HostName != "10.86.224.34" {
		t.Errorf("đọc lại khối quản lý sai: %+v", managed)
	}
}

func TestAddBlockAppendsAndKeepsCRLF(t *testing.T) {
	in := "Host a\r\n    User x\r\n"
	out, err := AddBlock([]byte(in), hiveProd, "~/.ssh/id_ed25519")
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if !strings.HasPrefix(s, in+"\r\n# >>> xdev-hive hive-prod\r\nHost hive-prod\r\n") ||
		!strings.HasSuffix(s, "# <<< xdev-hive\r\n") {
		t.Fatalf("thêm cuối file với CRLF sai:\n%q", s)
	}
	if strings.Count(s, "\n") != strings.Count(s, "\r\n") {
		t.Errorf("có dòng chỉ LF trong file CRLF: %q", s)
	}
}

func TestAddBlockEmptyFile(t *testing.T) {
	out, err := AddBlock(nil, hiveProd, "~/.ssh/id_ed25519")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(out), "# >>> xdev-hive hive-prod\n") {
		t.Errorf("file rỗng: khối phải ở đầu, có %q", out)
	}
}

func TestAddBlockRejectsDuplicateAlias(t *testing.T) {
	for _, alias := range []string{"macmini", "jt", "MacMini"} {
		h := hiveProd
		h.Alias = alias
		if _, err := AddBlock([]byte(handConfig), h, "~/.ssh/id_ed25519"); !errors.Is(err, ErrAliasExists) {
			t.Errorf("%s: muốn ErrAliasExists, có %v", alias, err)
		}
	}
}

func TestAddBlockRejectsBadValues(t *testing.T) {
	for _, h := range []Host{
		{Alias: "a*", HostName: "h", User: "u", Port: 22},
		{Alias: "-a", HostName: "h", User: "u", Port: 22},
		{Alias: "a", HostName: "h\nProxyCommand x", User: "u", Port: 22},
		{Alias: "a", HostName: "h", User: "u x", Port: 22},
		{Alias: "a", HostName: "h", User: "u", Port: 0},
	} {
		if _, err := AddBlock(nil, h, "~/.ssh/id_ed25519"); err == nil {
			t.Errorf("phải từ chối %+v", h)
		}
	}
}

func TestRemoveBlockRestoresOriginal(t *testing.T) {
	for name, in := range map[string]string{
		"giữa file":   handConfig,
		"cuối file":   "Host a\n    User x\n",
		"CRLF":        "Host a\r\n    User x\r\n\r\nHost *\r\n    User y\r\n",
		"chỉ có khối": "",
	} {
		added, err := AddBlock([]byte(in), hiveProd, "~/.ssh/id_ed25519")
		if err != nil {
			t.Fatal(name, err)
		}
		out, err := RemoveBlock(added, "hive-prod")
		if err != nil {
			t.Fatal(name, err)
		}
		if string(out) != in {
			t.Errorf("%s: gỡ xong phải về đúng bản cũ\nmuốn %q\ncó   %q", name, in, out)
		}
	}
}

func TestRemoveBlockErrors(t *testing.T) {
	if _, err := RemoveBlock([]byte(handConfig), "macmini"); !errors.Is(err, ErrNotManaged) {
		t.Errorf("khối viết tay: muốn ErrNotManaged, có %v", err)
	}
	unclosed := "# >>> xdev-hive x\nHost x\n    User u\n"
	if _, err := RemoveBlock([]byte(unclosed), "x"); !errors.Is(err, ErrUnclosedBlock) {
		t.Errorf("thiếu dòng đóng: muốn ErrUnclosedBlock, có %v", err)
	}
}

func TestWriteFileSafeBacksUpAndKeepsFive(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config")
	if err := os.WriteFile(path, []byte("v0"), 0o600); err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)
	for i := 1; i <= 7; i++ {
		if err := WriteFileSafe(path, []byte("v"+string(rune('0'+i))), true, start.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := os.ReadFile(path)
	if string(got) != "v7" {
		t.Fatalf("file phải là bản mới nhất, có %q", got)
	}
	backups, _ := filepath.Glob(filepath.Join(dir, "config.xdev-hive-*.bak"))
	if len(backups) != 5 {
		t.Fatalf("giữ 5 bản sao lưu, có %d: %v", len(backups), backups)
	}
	newest, _ := os.ReadFile(filepath.Join(dir, "config.xdev-hive-20261017-090007.bak"))
	if string(newest) != "v6" {
		t.Errorf("bản sao lưu mới nhất phải là nội dung trước lần ghi cuối, có %q", newest)
	}
	if _, err := os.Stat(filepath.Join(dir, "config.xdev-hive-20261017-090002.bak")); !os.IsNotExist(err) {
		t.Error("bản cũ nhất phải bị xoá")
	}
	leftovers, _ := filepath.Glob(filepath.Join(dir, "config.tmp-*"))
	if len(leftovers) != 0 {
		t.Errorf("còn file tạm: %v", leftovers)
	}
}

func TestWriteFileSafePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("quyền Windows kiểm ở perm_windows_test.go")
	}
	dir := t.TempDir()
	fresh := filepath.Join(dir, "config")
	if err := WriteFileSafe(fresh, []byte("x"), true, time.Now()); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(fresh); st.Mode().Perm() != 0o600 {
		t.Errorf("file mới phải 0600, có %v", st.Mode().Perm())
	}
	loose := filepath.Join(dir, "known")
	if err := os.WriteFile(loose, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(loose, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileSafe(loose, []byte("y"), false, time.Now()); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(loose); st.Mode().Perm() != 0o644 {
		t.Errorf("phải giữ quyền cũ 0644, có %v", st.Mode().Perm())
	}
}
