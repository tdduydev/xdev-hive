package sshkeys

import (
	"context"
	"path/filepath"
	"runtime"
	"testing"
)

func TestClassify(t *testing.T) {
	for _, c := range []struct {
		exit   int
		stderr string
		want   string
	}{
		{0, "", "ok"},
		{255, "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n" +
			"@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n" +
			"Offending ED25519 key in /home/ha/.ssh/known_hosts:3\nHost key verification failed.\n", "hostkey_changed"},
		{255, "No ED25519 host key is known for 192.0.2.10 and you have requested strict checking.\r\n" +
			"Host key verification failed.\r\n", "hostkey_unknown"},
		{255, "deploy@192.0.2.10: Permission denied (publickey,password).\r\n", "auth"},
		{255, "Received disconnect from 10.0.0.1 port 22:2: Too many authentication failures\n", "auth"},
		{255, "@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @\n" +
			"Load key \"/home/ha/.ssh/id_ed25519\": bad permissions\ndeploy@h: Permission denied (publickey).\n", "key_perms"},
		{255, "Bad permissions. Try removing permissions for user: BUILTIN\\Users (S-1-5-32-545) on file " +
			"C:/Users/ha/.ssh/id_ed25519.\ndeploy@h: Permission denied (publickey).\n", "key_perms"},
		{255, "Bad owner or permissions on C:\\Users\\ha/.ssh/config\r\n", "key_perms"},
		{255, "ssh: connect to host 192.0.2.10 port 22: Connection timed out\r\n", "unreachable"},
		{255, "ssh: connect to host h port 22: Connection refused\n", "unreachable"},
		{255, "ssh: Could not resolve hostname nope: Name or service not known\n", "unreachable"},
		{255, "ssh: connect to host h port 22: No route to host\n", "unreachable"},
		{255, "ssh: connect to host h port 22: Network is unreachable\n", "unreachable"},
		{1, "lạ\n", "error"},
	} {
		if got := Classify(c.exit, c.stderr); got != c.want {
			t.Errorf("Classify(%d, %q) = %s, muốn %s", c.exit, c.stderr, got, c.want)
		}
	}
}

const resolvedPlain = `user deploy
hostname 192.0.2.10
port 22
identitiesonly no
pubkeyauthentication true
identityfile ~/.ssh/id_rsa
identityfile ~/.ssh/id_ed25519
`

const resolvedJump = `hostname 1.2.3.4
port 2222
identitiesonly yes
pubkeyauthentication no
identityfile ~/.ssh/other
proxyjump bastion
`

func TestParseResolved(t *testing.T) {
	r := ParseResolved(resolvedPlain)
	if r.HostName != "192.0.2.10" || r.User != "deploy" || r.Port != 22 || r.IdentitiesOnly || !r.Pubkey || r.Proxy ||
		len(r.IdentityFiles) != 2 {
		t.Errorf("có %+v", r)
	}
	j := ParseResolved(resolvedJump)
	if j.Port != 2222 || !j.IdentitiesOnly || j.Pubkey || !j.Proxy {
		t.Errorf("có %+v", j)
	}
	if ParseResolved("proxyjump none\nproxycommand none\n").Proxy {
		t.Error("`none` không phải máy trung gian")
	}
	if !ParseResolved("proxycommand ssh -W %h:%p b\n").Proxy {
		t.Error("ProxyCommand là máy trung gian")
	}
}

func TestResolvedUses(t *testing.T) {
	home := filepath.FromSlash("/home/ha")
	key := DefaultKeyPath(home)
	if !ParseResolved(resolvedPlain).Uses(key, home) {
		t.Error("identityfile mặc định có ~/.ssh/id_ed25519 thì ssh đưa khoá này")
	}
	if ParseResolved(resolvedJump).Uses(key, home) {
		t.Error("PubkeyAuthentication no thì không dùng khoá")
	}
	if ParseResolved("pubkeyauthentication yes\nidentitiesonly yes\nidentityfile ~/.ssh/other\n").Uses(key, home) {
		t.Error("IdentityFile khác thì ssh không đưa khoá của máy")
	}
	if runtime.GOOS == "windows" {
		home = `C:\Users\Ha`
		if !ParseResolved("pubkeyauthentication true\nidentityfile C:/users/ha/.ssh/ID_ED25519\n").Uses(DefaultKeyPath(home), home) {
			t.Error("Windows: so đường dẫn không phân biệt hoa thường và dấu gạch")
		}
	}
}

func TestCheckWithoutSSH(t *testing.T) {
	if got := Check(context.Background(), "", "hive-prod", KeyInfo{}); got.Status != "no_ssh" {
		t.Errorf("không có ssh: muốn no_ssh, có %+v", got)
	}
}

func TestCheckUnreachable(t *testing.T) {
	ssh, err := SSHPath()
	if err != nil {
		t.Skip("máy chạy test không có ssh")
	}
	// Máy chạy test thường không mở cổng 22 (unreachable); runner có sshd thì máy chủ chưa có trong known_hosts.
	got := Check(context.Background(), ssh, "127.0.0.1", KeyInfo{})
	if got.Status != "unreachable" && got.Status != "hostkey_unknown" {
		t.Errorf("có %+v", got)
	}
}
