package sshkeys

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// KeyInfo mô tả khoá của máy. Khoá riêng không bao giờ ra khỏi worker: giao diện chỉ thấy phần công khai.
type KeyInfo struct {
	Path        string `json:"path"`
	Exists      bool   `json:"exists"`
	Type        string `json:"type,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
	Comment     string `json:"comment,omitempty"`
	// PublicKey là một dòng của file .pub.
	PublicKey string `json:"publicKey,omitempty"`
	// Encrypted: khoá có passphrase; ssh chỉ dùng được khi ssh-agent đã nạp khoá.
	Encrypted bool `json:"encrypted"`
}

var ErrKeyExists = errors.New("khoá đã có, app không ghi đè")

// DefaultKeyPath: khoá ssh tự thử với mọi máy chủ, nên `ssh user@host` dùng được cả khi không có alias (Q1 của spec).
func DefaultKeyPath(home string) string { return filepath.Join(home, ".ssh", "id_ed25519") }

// InspectKey đọc khoá ở path. Chưa có khoá thì Exists=false, không lỗi. Thiếu .pub thì lấy khoá công khai từ phần đầu
// không mã hoá của khoá riêng định dạng OpenSSH, kể cả khi khoá có passphrase.
func InspectKey(path string) (KeyInfo, error) {
	info := KeyInfo{Path: path}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return info, nil
	}
	if err != nil {
		return info, err
	}
	defer clear(raw)
	info.Exists = true
	var pk ssh.PublicKey
	if pub, err := os.ReadFile(path + ".pub"); err == nil {
		if k, comment, _, _, err := ssh.ParseAuthorizedKey(pub); err == nil {
			pk, info.Comment = k, comment
		}
	}
	signer, err := ssh.ParsePrivateKey(raw)
	var missing *ssh.PassphraseMissingError
	switch {
	case errors.As(err, &missing):
		info.Encrypted = true
		if pk == nil {
			pk = missing.PublicKey
		}
	case err == nil:
		if pk == nil {
			pk = signer.PublicKey()
		}
	case pk == nil:
		return info, fmt.Errorf("không đọc được khoá %s: %w", path, err)
	}
	if pk == nil {
		return info, fmt.Errorf("không đọc được khoá công khai của %s", path)
	}
	info.Type = pk.Type()
	info.Fingerprint = ssh.FingerprintSHA256(pk)
	info.PublicKey = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pk)))
	if info.Comment != "" {
		info.PublicKey += " " + info.Comment
	}
	return info, nil
}

// GenerateKey tạo khoá ed25519 không passphrase (Q2 của spec) ở path và file .pub cạnh nó. Có khoá rồi thì từ chối.
func GenerateKey(path, comment string) (KeyInfo, error) {
	if fileExists(path) || fileExists(path+".pub") {
		return KeyInfo{}, ErrKeyExists
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return KeyInfo{}, err
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return KeyInfo{}, err
	}
	defer clear(priv)
	block, err := ssh.MarshalPrivateKey(priv, comment)
	if err != nil {
		return KeyInfo{}, err
	}
	pemBytes := pem.EncodeToMemory(block)
	defer clear(pemBytes)
	// O_EXCL: hai lần tạo cùng lúc không ghi đè lẫn nhau.
	if err := writeNew(path, pemBytes, 0o600); err != nil {
		return KeyInfo{}, err
	}
	if err := restrictPrivate(path); err != nil {
		return KeyInfo{}, fmt.Errorf("không đặt được quyền cho khoá %s: %w", path, err)
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		return KeyInfo{}, err
	}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshPub))) + " " + comment + "\n"
	if err := writeNew(path+".pub", []byte(line), 0o644); err != nil {
		return KeyInfo{}, err
	}
	if err := newFileMode(path+".pub", 0o644); err != nil {
		return KeyInfo{}, err
	}
	return InspectKey(path)
}

func writeNew(path string, data []byte, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return ErrKeyExists
		}
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// KeyComment: comment của khoá mới để người quản trị nhận ra dòng nào trong authorized_keys là của máy nào.
func KeyComment(user, host string, now time.Time) string {
	return unsafeName.ReplaceAllString(user, "_") + "@" + unsafeName.ReplaceAllString(host, "_") +
		" xdev-hive " + now.Format("2006-01-02")
}

var safeComment = regexp.MustCompile(`^[A-Za-z0-9@._ -]+$`)

// AuthorizedLine là dòng sẽ thêm vào authorized_keys. Comment có ký tự ngoài tập an toàn bị bỏ, vì dòng này nằm trong
// script chạy trên máy chủ.
func AuthorizedLine(k KeyInfo) (string, error) {
	pk, comment, _, _, err := ssh.ParseAuthorizedKey([]byte(k.PublicKey))
	if err != nil {
		return "", fmt.Errorf("không đọc được khoá công khai: %w", err)
	}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pk)))
	if safeComment.MatchString(comment) {
		line += " " + comment
	}
	return line, nil
}
