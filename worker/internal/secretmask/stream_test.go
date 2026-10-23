package secretmask

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"
)

// writeChunks ghi s qua Writer, cắt ở các vị trí cuts, rồi Flush.
func writeChunks(t *testing.T, m *Masker, s string, cuts ...int) (string, []int) {
	t.Helper()
	var out bytes.Buffer
	w := m.Writer(&out)
	prev := 0
	for _, c := range append(cuts, len(s)) {
		n, err := w.Write([]byte(s[prev:c]))
		if err != nil || n != c-prev {
			t.Fatalf("Write: %d %v", n, err)
		}
		prev = c
	}
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	return out.String(), w.Found()
}

func TestWriterSplitValue(t *testing.T) {
	const v = "ghp-FAKE-0123456789-abcdef"
	m := New([]string{"unused-value-1", v})
	s := "đầu " + v + " giữa " + v + " cuối\n"
	want := "đầu " + Mask + " giữa " + Mask + " cuối\n"
	for _, cut := range []int{1, 6, 10, 20, len("đầu ") + 1, len("đầu ") + len(v) - 1, len(s) - 3} {
		got, found := writeChunks(t, m, s, cut)
		if got != want || !slices.Equal(found, []int{1}) {
			t.Errorf("cắt ở %d: lộ=%v found=%v", cut, strings.Contains(got, v[:MinLen]), found)
		}
	}
}

func TestWriterByteByByte(t *testing.T) {
	block := "line-one-xxxx\nline-two-yyyy\n"
	m := New([]string{block, "tail-secret-z"})
	b64 := base64.StdEncoding.EncodeToString([]byte(block))
	s := "A " + strings.ReplaceAll(block, "\n", "\r\n") + "B " + b64 + " C tail-secret-z"
	cuts := make([]int, 0, len(s))
	for i := 1; i < len(s); i++ {
		cuts = append(cuts, i)
	}
	got, found := writeChunks(t, m, s, cuts...)
	whole, _ := m.String(s)
	if got != whole {
		t.Fatalf("ghi từng byte khác che cả chuỗi: lộ=%v", strings.Contains(got, "line-one") || strings.Contains(got, "tail-secret"))
	}
	if !slices.Equal(found, []int{0, 1}) {
		t.Fatalf("found %v", found)
	}
}

// Giá trị bắt đầu ngay trước chỗ cắt mà phần đầu không phải tiền tố của dạng nào khác: Writer phải giữ đúng phần đó.
func TestWriterHoldsOnlyPossiblePrefix(t *testing.T) {
	m := New([]string{"zzzz-secret-0001"})
	var out bytes.Buffer
	w := m.Writer(&out)
	_, _ = w.Write([]byte("hello zzzz-sec"))
	if out.String() != "hello " {
		t.Fatalf("phải gửi ngay phần không thể là bí mật, giữ phần còn lại: %q", out.String())
	}
	_, _ = w.Write([]byte("ret-0001 bye"))
	_ = w.Flush()
	if out.String() != "hello "+Mask+" bye" {
		t.Fatalf("kết quả: %q", out.String())
	}
}

func TestWriterFlushReleasesUnfinishedPrefix(t *testing.T) {
	m := New([]string{"zzzz-secret-0001"})
	got, found := writeChunks(t, m, "end zzzz-sec")
	if got != "end zzzz-sec" || found != nil {
		t.Fatalf("Flush phải nhả phần chưa thành bí mật: %q %v", got, found)
	}
}

func TestWriterEmptyMaskerPassesThrough(t *testing.T) {
	got, _ := writeChunks(t, New(nil), "abc", 1)
	if got != "abc" {
		t.Fatal(got)
	}
}

func BenchmarkWriter16KiB(b *testing.B) {
	values := make([]string, 64)
	for i := range values {
		values[i] = fmt.Sprintf("bench-secret-%02d-%s", i, strings.Repeat("q", 40))
	}
	m := New(values)
	chunk := []byte(strings.Repeat("log line without secrets, but with q and b and s\n", 16<<10/50))
	w := m.Writer(io.Discard)
	b.SetBytes(int64(len(chunk)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = w.Write(chunk)
	}
}
