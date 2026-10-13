package channel

import (
	"fmt"
	"os"
	"testing"
)

// BenchmarkAckPending đo một ack khi máy còn nhiều gói chờ trên đĩa (CLI in log nhanh hơn hub ack, hoặc vừa nối lại
// sau lúc mất mạng): ack chạy trên vòng đọc kết nối nên chậm thì đề nghị, lease, lệnh huỷ đến sau cũng phải chờ.
func BenchmarkAckPending(b *testing.B) {
	for _, n := range []int{100, 1000} {
		b.Run(fmt.Sprint(n), func(b *testing.B) {
			dir := b.TempDir()
			write := func(run string, seq int64) {
				msg := LogChunk{Type: "log_chunk", V: protocolVersion, ID: "x", RunID: run, Attempt: 1, Seq: seq, Bytes: make([]byte, 16*1024)}
				if err := writePending(dir, run, 1, seq, msg); err != nil {
					b.Fatal(err)
				}
			}
			for i := range n {
				write("other-run", int64(i+1))
			}
			b.ResetTimer()
			for i := range b.N {
				b.StopTimer()
				write("run", int64(i+1))
				b.StartTimer()
				ackPending(dir, "run", int64(i+1))
			}
			b.StopTimer()
			if left, _ := os.ReadDir(dir); len(left) != n {
				b.Fatalf("còn %d gói, muốn %d", len(left), n)
			}
		})
	}
}

// Tên gói tách ngược đúng run và seq, kể cả run id có gạch nối và số như attempt.
func TestParsePendingNameRoundTrip(t *testing.T) {
	for _, tc := range []struct {
		run     string
		attempt int
		seq     int64
	}{{"run-1", 2, 3}, {"0f8b2c1e-1d2a-4c3b-9a8e-123456789abc", 10, 123456}, {"a/b:c", 1, 1}} {
		id, seq, ok := parsePendingName(pendingName(tc.run, tc.attempt, tc.seq))
		if !ok || id != safeID(tc.run) || seq != tc.seq {
			t.Fatalf("%+v → %q %d %v", tc, id, seq, ok)
		}
	}
	for _, bad := range []string{"x.json", "run-1-abc.json", "run-x-00000000000000000001.json", "run-1-00000000000000000001.tmp"} {
		if _, _, ok := parsePendingName(bad); ok {
			t.Fatalf("%q không phải tên gói", bad)
		}
	}
}
