package secretstore

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

const (
	testPassword = "correct horse battery"
	testValue    = "fake-Value-transfer-0123456789-never-print"
)

var transferClock = time.Date(2026, 10, 24, 8, 0, 0, 0, time.UTC)

// fastKDF hạ Argon2 cho test; tham số thật (64 MiB, 3 lượt) làm mỗi lần Seal/Open mất cỡ trăm mili giây.
func fastKDF(t *testing.T) {
	t.Helper()
	old := DefaultKDF
	DefaultKDF = KDFParams{Time: 1, Memory: 8 << 10, Threads: 1}
	t.Cleanup(func() { DefaultKDF = old })
}

func sampleTransfer() []TransferSecret {
	return []TransferSecret{
		{
			Name: "DATABASE_URL", Description: "Postgres của môi trường thử", Value: testValue,
			Projects: []TransferProject{{Name: "shop-api", RemoteURL: "https://git.example.test/acme/shop-api.git"}},
		},
		{Name: "SENTRY_DSN", Value: testValue + "-2", AllProjects: true},
	}
}

func sealSample(t *testing.T) []byte {
	t.Helper()
	b, err := Seal(sampleTransfer(), testPassword, transferClock)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestTransferRoundTrip(t *testing.T) {
	fastKDF(t)
	file := sealSample(t)
	got, err := Open(file, testPassword)
	if err != nil {
		t.Fatal(err)
	}
	want := sampleTransfer()
	want[1].Projects = []TransferProject{}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("khứ hồi lệch:\n%+v\n%+v", got, want)
	}
	// Hai lần xuất cùng nội dung khác salt và nonce.
	if again := sealSample(t); bytes.Equal(again, file) {
		t.Fatal("salt, nonce không ngẫu nhiên")
	}
}

// Vỏ ngoài không có tên bí mật, mô tả, tên dự án hay remote (FR-067), và tham số mặc định đúng data-model §9.
func TestTransferEnvelopeHidesNames(t *testing.T) {
	file, err := Seal(sampleTransfer(), testPassword, transferClock)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"DATABASE_URL", "SENTRY_DSN", "Postgres", "shop-api", "git.example.test", testValue, testPassword} {
		if bytes.Contains(file, []byte(s)) {
			t.Errorf("vỏ ngoài chứa %q", s)
		}
	}
	var env map[string]json.RawMessage
	if err := json.Unmarshal(file, &env); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	if !slices.Equal(keys, []string{"cipher", "createdAt", "data", "format", "kdf", "version"}) {
		t.Fatalf("trường vỏ ngoài: %v", keys)
	}
	var kdf KDFParams
	_ = json.Unmarshal(env["kdf"], &kdf)
	if kdf.Name != "argon2id" || len(kdf.Salt) != 16 || kdf.Time != 3 || kdf.Memory != 64<<10 || kdf.Threads != 4 {
		t.Fatalf("kdf: %+v", kdf)
	}
}

func TestTransferWeakPassword(t *testing.T) {
	_, err := Seal(sampleTransfer(), "short-pass", transferClock)
	if !errors.Is(err, &Error{Code: CodeWeakPassword}) {
		t.Fatalf("muốn weak_password, có %v", err)
	}
	// 12 ký tự tính theo rune, không theo byte.
	if err := ValidPassword("mậtkhẩuđủdài"); err != nil {
		t.Fatal(err)
	}
}

// Sai mật khẩu và mọi kiểu sửa file cho cùng một lỗi (FR-068).
func TestTransferWrongPasswordAndTamper(t *testing.T) {
	fastKDF(t)
	file := sealSample(t)
	_, wrong := Open(file, testPassword+"x")
	if !errors.Is(wrong, &Error{Code: CodeDecryptFailed}) {
		t.Fatalf("sai mật khẩu: %v", wrong)
	}

	edit := func(change func(map[string]any)) []byte {
		var m map[string]any
		if err := json.Unmarshal(file, &m); err != nil {
			t.Fatal(err)
		}
		change(m)
		b, _ := json.Marshal(m)
		return b
	}
	flip := func(field string) func(map[string]any) {
		return func(m map[string]any) {
			parent, key := m, field
			if p, k, ok := strings.Cut(field, "."); ok {
				parent, key = m[p].(map[string]any), k
			}
			raw, _ := base64.StdEncoding.DecodeString(parent[key].(string))
			raw[len(raw)/2] ^= 1
			parent[key] = base64.StdEncoding.EncodeToString(raw)
		}
	}
	cases := map[string][]byte{
		"data":        edit(flip("data")),
		"salt":        edit(flip("kdf.salt")),
		"nonce":       edit(flip("cipher.nonce")),
		"createdAt":   edit(func(m map[string]any) { m["createdAt"] = "2026-10-24T08:00:01Z" }),
		"kdf.time":    edit(func(m map[string]any) { m["kdf"].(map[string]any)["time"] = 2 }),
		"thêm trường": edit(func(m map[string]any) { m["host"] = "máy-cũ" }),
		"base64 hỏng": edit(func(m map[string]any) { m["data"] = "@@" }),
		// Tham số ngoài khoảng bị từ chối trước khi chạy Argon2.
		"memory lớn": edit(func(m map[string]any) { m["kdf"].(map[string]any)["memory"] = 4 << 20 }),
	}
	// Sửa đúng một byte của file: một ký tự base64 ở giữa bản mã.
	i := bytes.Index(file, []byte(`"data": "`)) + len(`"data": "`) + 20
	oneByte := bytes.Clone(file)
	oneByte[i] = map[bool]byte{true: 'A', false: 'B'}[oneByte[i] != 'A']
	cases["một byte"] = oneByte

	for name, f := range cases {
		_, err := Open(f, testPassword)
		var e *Error
		if !errors.As(err, &e) || e.Code != CodeDecryptFailed || e.Message != wrong.Error() {
			t.Errorf("%s: muốn cùng lỗi với sai mật khẩu, có %v", name, err)
		}
		if err != nil && strings.Contains(err.Error(), testPassword) {
			t.Errorf("%s: lỗi chứa mật khẩu", name)
		}
	}
}

func TestTransferFormatAndVersion(t *testing.T) {
	fastKDF(t)
	file := sealSample(t)
	newer := bytes.Replace(file, []byte(`"version": 1`), []byte(`"version": 2`), 1)
	if _, err := Open(newer, testPassword); !errors.Is(err, &Error{Code: CodeFileVersion}) {
		t.Fatalf("version lạ: %v", err)
	}
	for name, f := range map[string][]byte{
		"không phải JSON": []byte("DATABASE_URL=x"),
		"format khác":     bytes.Replace(file, []byte(TransferFormat), []byte("hive-other"), 1),
		"rỗng":            nil,
	} {
		if _, err := Open(f, testPassword); !errors.Is(err, &Error{Code: CodeFileFormat}) {
			t.Errorf("%s: %v", name, err)
		}
	}
}
