package sshkeys

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func hostPort(host string, port int) string { return net.JoinHostPort(host, strconv.Itoa(port)) }

// loadKnown đọc known_hosts, bỏ dòng hỏng như ssh làm (knownhosts.New từ chối cả file vì một dòng). Chưa có file thì
// coi như rỗng.
func loadKnown(path string) (ssh.HostKeyCallback, error) {
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	var good bytes.Buffer
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if _, _, _, _, _, err := ssh.ParseKnownHosts([]byte(line)); err == nil {
			good.WriteString(line + "\n")
		}
	}
	tmp, err := os.CreateTemp("", "xdev-hive-known-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	_, werr := tmp.Write(good.Bytes())
	if cerr := tmp.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		return nil, werr
	}
	return knownhosts.New(tmp.Name())
}

// lookup gọi callback của known_hosts với key. KeyError có Want rỗng là máy chủ chưa biết; Want có phần tử là đã biết
// bằng khoá khác.
func lookup(path, host string, port int, key ssh.PublicKey) (*knownhosts.KeyError, error) {
	cb, err := loadKnown(path)
	if err != nil {
		return nil, err
	}
	addr := &net.TCPAddr{IP: net.ParseIP(host), Port: port}
	err = cb(hostPort(host, port), addr, key)
	var ke *knownhosts.KeyError
	switch {
	case err == nil:
		return nil, nil
	case errors.As(err, &ke):
		return ke, nil
	default:
		return nil, err
	}
}

// HostKeyStatus so khoá máy chủ với known_hosts: "known", "unknown" hoặc "changed". Máy chủ chỉ được biết bằng khoá
// loại khác là "unknown", vì ssh hỏi lại trong trường hợp này chứ không báo giả mạo.
func HostKeyStatus(path, host string, port int, key ssh.PublicKey) (string, error) {
	ke, err := lookup(path, host, port, key)
	switch {
	case err != nil:
		return "", err
	case ke == nil:
		return "known", nil
	}
	for _, w := range ke.Want {
		if w.Key.Type() == key.Type() {
			return "changed", nil
		}
	}
	return "unknown", nil
}

// KnownKeyTypes là loại khoá known_hosts đã có cho máy chủ. Gọi callback với một khoá tạm để đọc danh sách Want.
func KnownKeyTypes(path, host string, port int) []string {
	ke, err := lookup(path, host, port, probeKey)
	if err != nil || ke == nil {
		return nil
	}
	var types []string
	for _, w := range ke.Want {
		types = append(types, w.Key.Type())
	}
	return types
}

// probeKey là khoá ed25519 cố định không thuộc máy chủ nào, chỉ để hỏi known_hosts.
var probeKey = func() ssh.PublicKey {
	k, err := ssh.NewPublicKey(ed25519.PublicKey(make([]byte, ed25519.PublicKeySize)))
	if err != nil {
		panic(err)
	}
	return k
}()

// hostKeyAlgorithms: đã biết máy chủ thì chỉ xin đúng loại khoá đã biết, để không báo nhầm "đã đổi" khi máy chủ có
// nhiều loại khoá (FR-034). Chưa biết thì xin ed25519 trước: x/crypto/ssh mặc định xin ECDSA và RSA trước, khi đó dấu
// vân tay không khớp lệnh người quản trị hay chạy cho ed25519 (FR-035).
func hostKeyAlgorithms(known []string) []string {
	var algos []string
	for _, t := range known {
		switch t {
		case ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521:
			algos = append(algos, t)
		case ssh.KeyAlgoRSA:
			algos = append(algos, ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256)
		}
	}
	if len(algos) > 0 {
		return algos
	}
	return []string{ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521,
		ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256}
}

// AppendKnownHost thêm khoá máy chủ vào cuối known_hosts nếu chưa có; không sửa dòng có sẵn.
func AppendKnownHost(path, host string, port int, key ssh.PublicKey) error {
	if status, err := HostKeyStatus(path, host, port, key); err != nil {
		return err
	} else if status == "known" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	existing, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	line := knownhosts.Line([]string{knownhosts.Normalize(hostPort(host, port))}, key) + "\n"
	if len(existing) > 0 && !bytes.HasSuffix(existing, []byte("\n")) {
		line = "\n" + line
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(line); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
