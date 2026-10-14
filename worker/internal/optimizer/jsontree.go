package optimizer

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
)

// object là object JSON giữ thứ tự khoá. settings.json do người dùng và Claude Code cùng sửa: đọc vào map rồi ghi ra sẽ
// xếp lại mọi khoá, làm diff khó đọc và bật rồi tắt không trả về file cũ.
type object struct {
	keys []string
	vals map[string]any
}

func newObject() *object { return &object{vals: map[string]any{}} }

func (o *object) get(k string) (any, bool) {
	v, ok := o.vals[k]
	return v, ok
}

func (o *object) set(k string, v any) {
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
}

func (o *object) del(k string) {
	if _, ok := o.vals[k]; !ok {
		return
	}
	delete(o.vals, k)
	for i, x := range o.keys {
		if x == k {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

func (o *object) empty() bool { return len(o.keys) == 0 }

// parseJSON đọc thành cây: *object, []any, string, json.Number, bool, nil. Số giữ nguyên chữ để ghi lại y như cũ.
func parseJSON(b []byte) (any, error) {
	if !json.Valid(b) {
		return nil, errors.New("JSON không hợp lệ")
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	v, err := readValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("JSON không hợp lệ: còn dữ liệu sau giá trị đầu")
	}
	return v, nil
}

func readValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	d, ok := tok.(json.Delim)
	if !ok {
		return tok, nil
	}
	switch d {
	case '{':
		o := newObject()
		for dec.More() {
			kt, err := dec.Token()
			if err != nil {
				return nil, err
			}
			k, _ := kt.(string)
			v, err := readValue(dec)
			if err != nil {
				return nil, err
			}
			o.set(k, v)
		}
		_, err = dec.Token()
		return o, err
	case '[':
		arr := []any{}
		for dec.More() {
			v, err := readValue(dec)
			if err != nil {
				return nil, err
			}
			arr = append(arr, v)
		}
		_, err = dec.Token()
		return arr, err
	}
	return nil, errors.New("JSON không hợp lệ")
}

// jsonStyle là cách trình bày của file gốc, để file ghi lại chỉ khác ở chỗ Hive sửa.
type jsonStyle struct {
	indent  string
	newline bool
}

// styleOf đoán thụt lề từ dòng có thụt đầu tiên; Claude Code ghi bằng JSON.stringify(…, null, 2) nên mặc định 2 dấu cách.
func styleOf(b []byte) jsonStyle {
	s := jsonStyle{indent: "  ", newline: bytes.HasSuffix(b, []byte("\n"))}
	for _, line := range strings.Split(string(b), "\n")[1:] {
		trimmed := strings.TrimLeft(line, " \t")
		if trimmed == "" {
			continue
		}
		if n := len(line) - len(trimmed); n > 0 {
			s.indent = line[:n]
		}
		break
	}
	return s
}

func encodeJSON(v any, s jsonStyle) []byte {
	var buf bytes.Buffer
	writeJSON(&buf, v, s.indent, 0)
	if s.newline {
		buf.WriteByte('\n')
	}
	return buf.Bytes()
}

// compactJSON dùng để so hai giá trị (hook đã ghi với hook đang có), không để ghi file.
func compactJSON(v any) string {
	var buf bytes.Buffer
	writeJSON(&buf, v, "", -1)
	return buf.String()
}

// writeJSON: depth < 0 là viết liền một dòng.
func writeJSON(buf *bytes.Buffer, v any, indent string, depth int) {
	pad := func(d int) {
		if depth >= 0 {
			buf.WriteByte('\n')
			buf.WriteString(strings.Repeat(indent, d))
		}
	}
	next := depth + 1
	if depth < 0 {
		next = -1
	}
	sep := ": "
	if depth < 0 {
		sep = ":"
	}
	switch x := v.(type) {
	case *object:
		if x.empty() {
			buf.WriteString("{}")
			return
		}
		buf.WriteByte('{')
		for i, k := range x.keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			pad(depth + 1)
			writeString(buf, k)
			buf.WriteString(sep)
			writeJSON(buf, x.vals[k], indent, next)
		}
		pad(depth)
		buf.WriteByte('}')
	case []any:
		if len(x) == 0 {
			buf.WriteString("[]")
			return
		}
		buf.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				buf.WriteByte(',')
			}
			pad(depth + 1)
			writeJSON(buf, e, indent, next)
		}
		pad(depth)
		buf.WriteByte(']')
	case string:
		writeString(buf, x)
	case json.Number:
		buf.WriteString(x.String())
	case bool:
		if x {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case int:
		buf.WriteString(strconv.Itoa(x))
	case nil:
		buf.WriteString("null")
	}
}

// writeString không thoát <, >, & như JSON.stringify, để chuỗi của người dùng giữ nguyên.
func writeString(buf *bytes.Buffer, s string) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	buf.Write(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
}
