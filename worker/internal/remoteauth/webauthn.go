package remoteauth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// Assertion là phản hồi WebAuthn trình duyệt gửi (base64url không đệm), giữ nguyên byte để kiểm chữ ký.
type Assertion struct {
	CredentialID      string `json:"credentialId"`
	AuthenticatorData string `json:"authenticatorData"`
	ClientDataJSON    string `json:"clientDataJSON"`
	Signature         string `json:"signature"`
	UserHandle        string `json:"userHandle,omitempty"`
}

const (
	flagUP = 0x01
	flagUV = 0x04
)

var b64url = base64.RawURLEncoding

// HubOrigin trả origin trình duyệt thấy (scheme://host[:port], bỏ cổng mặc định) và rpId (tên máy) từ URL hub trong
// worker.json. Worker so với origin này thay vì tin hub báo, để hub không lừa được worker nhận passkey của trang khác.
func HubOrigin(hubURL string) (origin, rpID string, err error) {
	u, err := url.Parse(strings.TrimSpace(hubURL))
	if err != nil || u.Host == "" {
		return "", "", fmt.Errorf("địa chỉ hub không hợp lệ: %q", hubURL)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "https" && scheme != "http" {
		return "", "", fmt.Errorf("địa chỉ hub phải là http hoặc https: %q", hubURL)
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	hostport := host
	if strings.Contains(host, ":") {
		hostport = "[" + host + "]"
	}
	if port != "" {
		hostport += ":" + port
	}
	return scheme + "://" + hostport, host, nil
}

// ParseSPKI đọc khoá công khai ES256 của thiết bị (getPublicKey() của trình duyệt). Chỉ nhận P-256.
func ParseSPKI(spki string) (*ecdsa.PublicKey, error) {
	der, err := b64url.DecodeString(spki)
	if err != nil {
		return nil, err
	}
	key, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	pub, ok := key.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		return nil, errors.New("khoá thiết bị không phải ES256 (P-256)")
	}
	return pub, nil
}

// VerifyAssertion kiểm một assertion WebAuthn cho challenge mong đợi (FR-016): type, challenge, origin, rpIdHash, cờ
// UP+UV, chữ ký ES256 bằng SPKI của thiết bị, signCount không lùi. Trả signCount mới để lưu.
func VerifyAssertion(dev Device, a Assertion, challenge []byte, origin, rpID string) (uint32, error) {
	authData, err1 := b64url.DecodeString(a.AuthenticatorData)
	clientJSON, err2 := b64url.DecodeString(a.ClientDataJSON)
	sig, err3 := b64url.DecodeString(a.Signature)
	if err := errors.Join(err1, err2, err3); err != nil || len(authData) < 37 {
		return 0, denyErr(CodeAuthInvalid, err)
	}
	var client struct {
		Type        string `json:"type"`
		Challenge   string `json:"challenge"`
		Origin      string `json:"origin"`
		CrossOrigin bool   `json:"crossOrigin"`
	}
	if err := json.Unmarshal(clientJSON, &client); err != nil {
		return 0, denyErr(CodeAuthInvalid, err)
	}
	if client.Type != "webauthn.get" {
		return 0, denyErr(CodeAuthInvalid, fmt.Errorf("clientData.type = %q", client.Type))
	}
	// Challenge lệch nghĩa là yêu cầu đã bị sửa sau khi trình duyệt ký (vd. hub đổi connId).
	if subtle.ConstantTimeCompare([]byte(client.Challenge), []byte(b64url.EncodeToString(challenge))) != 1 {
		return 0, denyErr(CodeAuthInvalid, errors.New("challenge không khớp yêu cầu"))
	}
	if client.Origin != origin || client.CrossOrigin {
		return 0, denyErr(CodeAssertionOrigin, fmt.Errorf("origin %q", client.Origin))
	}
	rpHash := sha256.Sum256([]byte(rpID))
	if subtle.ConstantTimeCompare(authData[:32], rpHash[:]) != 1 {
		return 0, deny(CodeAssertionRPID)
	}
	if flags := authData[32]; flags&flagUP == 0 || flags&flagUV == 0 {
		return 0, deny(CodeAssertionFlags)
	}
	pub, err := ParseSPKI(dev.SPKI)
	if err != nil {
		return 0, denyErr(CodeAssertionSignature, err)
	}
	clientHash := sha256.Sum256(clientJSON)
	signed := sha256.Sum256(append(append([]byte{}, authData...), clientHash[:]...))
	if !ecdsa.VerifyASN1(pub, signed[:], sig) {
		return 0, deny(CodeAssertionSignature)
	}
	// Passkey đồng bộ (iCloud, Google) luôn báo 0; khoá phần cứng tăng dần. Lùi khi đã khác 0 là dấu hiệu bị sao chép.
	count := binary.BigEndian.Uint32(authData[33:37])
	if (count != 0 || dev.SignCount != 0) && count <= dev.SignCount {
		return 0, deny(CodeAssertionCounter)
	}
	return count, nil
}
