package remoteauth

import (
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
)

// Hằng số khớp contracts (PASSKEY_KEY_INFO, TOTP_KEY_INFO_PREFIX, INPUT_MAC_BYTES).
const (
	PasskeyKeyInfo    = "hive-term-input/v1"
	TOTPKeyInfoPrefix = "hive-totp"
	InputMACBytes     = 16
)

// KeyInfo là info của HKDF: TOTP trộn mã đã dùng vì ephPub của TOTP không được ký, để ai không thấy mã thì không suy ra
// được khoá dù đã thay ephPub (plan.md D15, mối đe doạ T15–T16).
func KeyInfo(kind, code string) string {
	if kind == KindTOTP {
		return TOTPKeyInfoPrefix + code
	}
	return PasskeyKeyInfo
}

// ParseEphPub đọc khoá ECDH P-256 tạm của trình duyệt (điểm không nén 65 byte, base64url).
func ParseEphPub(ephPub string) (*ecdh.PublicKey, error) {
	raw, err := b64url.DecodeString(ephPub)
	if err != nil {
		return nil, err
	}
	return ecdh.P256().NewPublicKey(raw)
}

// SessionKey sinh khoá tạm của worker và suy ra khoá HMAC của gói nhập (FR-017). Trả workerEphPub để gửi trong
// term_granted. Hub thay workerEphPub trên đường về chỉ làm hỏng HMAC (từ chối dịch vụ), không chèn được phím.
func SessionKey(ephPub string, challenge []byte, info string) (workerEphPub string, key []byte, err error) {
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return "", nil, err
	}
	key, err = DeriveInputKey(priv, ephPub, challenge, info)
	if err != nil {
		return "", nil, err
	}
	return b64url.EncodeToString(priv.PublicKey().Bytes()), key, nil
}

// DeriveInputKey: K = HKDF-SHA256(ECDH(priv, ephPub), salt = challenge, info), 32 byte.
func DeriveInputKey(priv *ecdh.PrivateKey, ephPub string, challenge []byte, info string) ([]byte, error) {
	pub, err := ParseEphPub(ephPub)
	if err != nil {
		return nil, err
	}
	shared, err := priv.ECDH(pub)
	if err != nil {
		return nil, err
	}
	return hkdf.Key(sha256.New, shared, challenge, info, 32)
}

// InputPayload là nội dung HMAC của gói phím, khớp inputMacPayload của contracts. data là byte thô; payload dùng chuỗi
// base64 chuẩn như trong gói JSON.
func InputPayload(sessionID, connID string, seq int64, data []byte) ([]byte, error) {
	return Canonical(map[string]any{
		"sessionId": sessionID, "connId": connID, "seq": seq, "kind": "in",
		"data": base64.StdEncoding.EncodeToString(data),
	})
}

// ResizePayload là nội dung HMAC của gói đổi kích thước.
func ResizePayload(sessionID, connID string, seq int64, cols, rows int) ([]byte, error) {
	return Canonical(map[string]any{
		"sessionId": sessionID, "connId": connID, "seq": seq, "kind": "resize", "cols": cols, "rows": rows,
	})
}

// InputVerifier kiểm HMAC và seq tăng nghiêm ngặt của gói nhập một kết nối (FR-017). seq bắt đầu từ 1; nối lại bằng
// resumeToken giữ verifier cũ nên seq đi tiếp.
type InputVerifier struct {
	key  []byte
	last int64
}

func NewInputVerifier(key []byte) *InputVerifier { return &InputVerifier{key: key} }

// Verify kiểm mac trước rồi mới tới seq, để gói giả không đẩy được seq lên làm hỏng gói thật đến sau.
func (v *InputVerifier) Verify(seq int64, payload []byte, mac string) error {
	got, err := b64url.DecodeString(mac)
	if err != nil || len(got) != InputMACBytes {
		return deny(CodeInputRejected)
	}
	h := hmac.New(sha256.New, v.key)
	h.Write(payload)
	if !hmac.Equal(got, h.Sum(nil)[:InputMACBytes]) {
		return denyErr(CodeInputRejected, errors.New("HMAC sai"))
	}
	if seq <= v.last {
		return denyErr(CodeInputRejected, errors.New("seq không tăng"))
	}
	v.last = seq
	return nil
}
