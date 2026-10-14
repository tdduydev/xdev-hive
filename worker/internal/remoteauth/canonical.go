// Package remoteauth kiểm xác thực điều khiển từ xa phiên terminal trên máy cá nhân (specs/010 FR-014…FR-017,
// FR-033…FR-037, ADR 0019). Worker tự kiểm assertion passkey, mã TOTP, tag ghép và HMAC gói nhập; hub chỉ chuyển tiếp,
// nên hub bị chiếm cũng không mở được phiên hay gõ vào máy. Mọi định dạng byte khớp packages/contracts/src/terminal-auth.ts
// và được kiểm bằng cùng vector packages/contracts/fixtures/terminal-auth.json.
package remoteauth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// maxSafeInteger là Number.MAX_SAFE_INTEGER: số lớn hơn thì JS in khác Go nên không cho vào JSON chuẩn hoá.
const maxSafeInteger = 1<<53 - 1

// Canonical in JSON chuẩn hoá đúng như canonicalJson của contracts: khoá xếp theo byte (chỉ ASCII in được), không khoảng
// trắng, chuỗi NFC, số nguyên an toàn. Chuỗi thoát như JSON.stringify (không thoát <, >, &, U+2028), khác encoding/json.
func Canonical(v any) ([]byte, error) {
	var b bytes.Buffer
	if err := writeCanonical(&b, v); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

func writeCanonical(b *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(x))
	case string:
		return writeString(b, x)
	case int:
		return writeInt(b, int64(x))
	case int64:
		return writeInt(b, x)
	case json.Number:
		n, err := strconv.ParseInt(x.String(), 10, 64)
		if err != nil {
			return fmt.Errorf("JSON chuẩn hoá chỉ nhận số nguyên: %s", x)
		}
		return writeInt(b, n)
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeCanonical(b, e); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			for i := 0; i < len(k); i++ {
				if k[i] < 0x20 || k[i] > 0x7e {
					return fmt.Errorf("khoá phải là ASCII: %q", k)
				}
			}
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeString(b, k); err != nil {
				return err
			}
			b.WriteByte(':')
			if err := writeCanonical(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("JSON chuẩn hoá không nhận kiểu %T", v)
	}
	return nil
}

func writeInt(b *bytes.Buffer, n int64) error {
	if n > maxSafeInteger || n < -maxSafeInteger {
		return fmt.Errorf("số vượt giới hạn an toàn của JSON: %d", n)
	}
	b.WriteString(strconv.FormatInt(n, 10))
	return nil
}

func writeString(b *bytes.Buffer, s string) error {
	if !utf8.ValidString(s) {
		return fmt.Errorf("chuỗi không phải UTF-8 hợp lệ")
	}
	b.WriteByte('"')
	for _, r := range norm.NFC.String(s) {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return nil
}
