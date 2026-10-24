package secretstore

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

// File .hivesecrets (data-model §9): người dùng tự xuất và tự mang sang máy khác (FR-067, FR-068). Hub không bao giờ
// thấy file này.
const (
	TransferFormat  = "hive-secrets"
	TransferVersion = 1
	MinPasswordLen  = 12
	// MaxTransferFile chặn đọc file lạ quá lớn; 16 MiB đủ cho hàng nghìn bí mật 8 KiB.
	MaxTransferFile = 16 << 20

	kdfName    = "argon2id"
	cipherName = "aes-256-gcm"
	saltLen    = 16
	nonceLen   = 12
	keyLen     = 32
)

const (
	CodeWeakPassword  = "weak_password"
	CodeFileExists    = "file_exists"
	CodeDecryptFailed = "decrypt_failed"
	CodeFileVersion   = "file_version"
	CodeFileFormat    = "file_format"
)

// Sai mật khẩu và file bị sửa trả cùng một lỗi (FR-068): lỗi khác nhau cho biết phần nào của file đã đúng.
var (
	errDecrypt    = &Error{Code: CodeDecryptFailed, Message: "Sai mật khẩu hoặc file đã bị sửa."}
	errFileFormat = &Error{Code: CodeFileFormat, Message: "File không phải file bí mật xuất từ xDev Hive."}
)

// KDFParams nằm trong file để máy nhập dùng đúng tham số máy xuất đã dùng, kể cả khi mặc định đổi sau này.
type KDFParams struct {
	Name    string `json:"name"`
	Salt    []byte `json:"salt"`
	Time    uint32 `json:"time"`
	Memory  uint32 `json:"memory"` // KiB
	Threads uint8  `json:"threads"`
}

// DefaultKDF là tham số khi xuất. Test hạ xuống để chạy nhanh.
var DefaultKDF = KDFParams{Time: 3, Memory: 64 << 10, Threads: 4}

type cipherParams struct {
	Name  string `json:"name"`
	Nonce []byte `json:"nonce"`
}

// envelope là vỏ ngoài không mã hoá. Thứ tự trường là thứ tự của AAD; không thêm trường nào lộ tên bí mật, tên máy hay
// tên dự án.
type envelope struct {
	Format    string       `json:"format"`
	Version   int          `json:"version"`
	CreatedAt time.Time    `json:"createdAt"`
	KDF       KDFParams    `json:"kdf"`
	Cipher    cipherParams `json:"cipher"`
	Data      []byte       `json:"data,omitempty"`
}

// TransferProject ghi dự án bằng thứ máy khác nhận ra được: tên và remote đã bỏ thông tin đăng nhập. localId chỉ có
// nghĩa trên máy xuất nên không ghi.
type TransferProject struct {
	Name      string `json:"name"`
	RemoteURL string `json:"remoteUrl,omitempty"`
}

type TransferSecret struct {
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Value       string            `json:"value"`
	AllProjects bool              `json:"allProjects"`
	Projects    []TransferProject `json:"projects"`
}

type transferPayload struct {
	Secrets []TransferSecret `json:"secrets"`
}

// ValidPassword: mật khẩu xuất tối thiểu MinPasswordLen ký tự. Nhập thì không kiểm: mật khẩu sai chỉ làm giải mã hỏng.
func ValidPassword(p string) error {
	if utf8.RuneCountInString(p) < MinPasswordLen {
		return &Error{Code: CodeWeakPassword, Message: fmt.Sprintf("Mật khẩu phải dài ít nhất %d ký tự.", MinPasswordLen)}
	}
	return nil
}

// Seal mã hoá secrets thành nội dung file .hivesecrets.
func Seal(secrets []TransferSecret, password string, now time.Time) ([]byte, error) {
	if err := ValidPassword(password); err != nil {
		return nil, err
	}
	for i := range secrets {
		if secrets[i].Projects == nil || secrets[i].AllProjects {
			secrets[i].Projects = []TransferProject{}
		}
	}
	env := envelope{
		Format:    TransferFormat,
		Version:   TransferVersion,
		CreatedAt: stamp(now),
		KDF:       DefaultKDF,
		Cipher:    cipherParams{Name: cipherName, Nonce: make([]byte, nonceLen)},
	}
	env.KDF.Name = kdfName
	env.KDF.Salt = make([]byte, saltLen)
	_, _ = rand.Read(env.KDF.Salt)
	_, _ = rand.Read(env.Cipher.Nonce)
	plain, err := json.Marshal(transferPayload{Secrets: secrets})
	defer clear(plain)
	if err != nil {
		return nil, err
	}
	aead, err := env.aead(password)
	if err != nil {
		return nil, err
	}
	aad, err := json.Marshal(env)
	if err != nil {
		return nil, err
	}
	env.Data = aead.Seal(nil, env.Cipher.Nonce, plain, aad)
	return json.MarshalIndent(env, "", "  ")
}

// Open giải mã file .hivesecrets. Lỗi chỉ là file_format, file_version hoặc decrypt_failed; không lỗi nào chép lại nội
// dung file hay mật khẩu.
func Open(file []byte, password string) ([]TransferSecret, error) {
	var head struct {
		Format  string `json:"format"`
		Version int    `json:"version"`
	}
	if json.Unmarshal(file, &head) != nil || head.Format != TransferFormat {
		return nil, errFileFormat
	}
	if head.Version != TransferVersion {
		return nil, &Error{
			Code:    CodeFileVersion,
			Message: fmt.Sprintf("File do bản xDev Hive khác tạo (phiên bản %d). Hãy cập nhật xDev Hive rồi nhập lại.", head.Version),
		}
	}
	var env envelope
	dec := json.NewDecoder(bytes.NewReader(file))
	dec.DisallowUnknownFields()
	if dec.Decode(&env) != nil || !env.valid() {
		return nil, errDecrypt
	}
	data := env.Data
	env.Data = nil
	aad, err := json.Marshal(env)
	if err != nil {
		return nil, errDecrypt
	}
	aead, err := env.aead(password)
	if err != nil {
		return nil, errDecrypt
	}
	plain, err := aead.Open(nil, env.Cipher.Nonce, data, aad)
	defer clear(plain)
	if err != nil {
		return nil, errDecrypt
	}
	var p transferPayload
	pd := json.NewDecoder(bytes.NewReader(plain))
	pd.DisallowUnknownFields()
	if pd.Decode(&p) != nil {
		return nil, errFileFormat
	}
	for i := range p.Secrets {
		if p.Secrets[i].Projects == nil {
			p.Secrets[i].Projects = []TransferProject{}
		}
	}
	return p.Secrets, nil
}

// valid giới hạn tham số đọc từ file, để file lạ không bắt Argon2 chiếm hết RAM hay chạy hàng phút.
func (e envelope) valid() bool {
	k := e.KDF
	return k.Name == kdfName && len(k.Salt) == saltLen && k.Time >= 1 && k.Time <= 10 &&
		k.Memory >= 1<<10 && k.Memory <= 1<<20 && k.Threads >= 1 && k.Threads <= 16 &&
		e.Cipher.Name == cipherName && len(e.Cipher.Nonce) == nonceLen && len(e.Data) > 0
}

func (e envelope) aead(password string) (cipher.AEAD, error) {
	pw := []byte(password)
	defer clear(pw)
	key := argon2.IDKey(pw, e.KDF.Salt, e.KDF.Time, e.KDF.Memory, e.KDF.Threads, keyLen)
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
