package outbox

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
)

// fakeEpoch giả health của hub: trả mốc đặt sẵn và đếm số lần hỏi.
type fakeEpoch struct {
	ep    Epoch
	err   error
	calls int
}

func (f *fakeEpoch) source(context.Context, string) (Epoch, error) {
	f.calls++
	return f.ep, f.err
}

// receivingHub giả hub ghi giờ nhận theo đồng hồ test, để so với thời điểm của bản khôi phục.
func receivingHub(c *clock, keys *[]string) Sender {
	return func(_ context.Context, ev hubclient.ClientEvent) (hubclient.ClientEventResult, error) {
		*keys = append(*keys, ev.Key)
		return hubclient.ClientEventResult{Key: ev.Key, Outcome: hubclient.OutcomeAccepted, ReceivedAt: c.now.Format(time.RFC3339)}, nil
	}
}

func epochStore(t *testing.T) (Store, *clock, *fakeEpoch) {
	t.Helper()
	s, c := newStore(t)
	f := &fakeEpoch{ep: Epoch{ID: "epoch-a"}}
	s.Epoch = f.source
	return s, c, f
}

func sentKeys(t *testing.T, s Store) []string {
	t.Helper()
	entries, err := s.Sent(testID)
	if err != nil {
		t.Fatal(err)
	}
	keys := []string{}
	for _, e := range entries {
		keys = append(keys, e.Key)
	}
	return keys
}

func TestEpochFirstSightingOnlyRecords(t *testing.T) {
	s, c, f := epochStore(t)
	it := submit(t, s, KindMemoryPropose, `{"n":1}`)
	var got []string
	c.add(time.Second)
	res, err := s.Flush(context.Background(), testID, receivingHub(c, &got))
	if err != nil || res.Accepted != 1 || res.Requeued != 0 || f.calls != 1 {
		t.Fatalf("kết quả %+v, lỗi %v, hỏi mốc %d lần", res, err, f.calls)
	}
	if _, err := os.Stat(filepath.Join(s.Root, "machine-may-1", "sent", it.Key+".json.gz")); err != nil {
		t.Errorf("thiếu bản nén của việc đã gửi: %v", err)
	}
	// Trong 5 phút không hỏi lại dù mốc đổi.
	f.ep = Epoch{ID: "epoch-b"}
	c.add(time.Minute)
	if res, _ := s.Flush(context.Background(), testID, receivingHub(c, &got)); f.calls != 1 || res.Requeued != 0 {
		t.Fatalf("hỏi mốc %d lần, kết quả %+v", f.calls, res)
	}
}

func TestEpochChangeRequeuesItemsAfterRestorePoint(t *testing.T) {
	s, c, f := epochStore(t)
	var got []string
	hub := receivingHub(c, &got)
	before := submit(t, s, KindMemoryPropose, `{"n":1}`)
	c.add(time.Second)
	if _, err := s.Flush(context.Background(), testID, hub); err != nil {
		t.Fatal(err)
	}
	c.add(2 * time.Hour)
	after := submit(t, s, KindMemoryPropose, `{"n":2}`)
	if _, err := s.Flush(context.Background(), testID, hub); err != nil {
		t.Fatal(err)
	}

	restoredTo := t0.Add(time.Hour)
	f.ep = Epoch{ID: "epoch-b", RestoredTo: &restoredTo}
	c.add(EpochCheckEvery)
	got = nil
	res, err := s.Flush(context.Background(), testID, hub)
	if err != nil {
		t.Fatal(err)
	}
	// Chỉ việc hub nhận sau thời điểm của bản khôi phục được gửi lại, cùng khoá và cùng nội dung.
	if res.Requeued != 1 || res.Accepted != 1 || len(got) != 1 || got[0] != after.Key {
		t.Fatalf("kết quả %+v, hub nhận %v", res, got)
	}
	if keys := sentKeys(t, s); len(keys) != 2 || keys[0] != before.Key || keys[1] != after.Key {
		t.Errorf("sent.jsonl: %v", keys)
	}
	// Mốc mới đã ghi: lần hỏi sau không gửi lại nữa.
	c.add(EpochCheckEvery)
	if res, _ := s.Flush(context.Background(), testID, hub); res.Requeued != 0 || len(got) != 1 {
		t.Fatalf("gửi lại lần hai: %+v", res)
	}
}

func TestEpochChangeWithoutRestorePointRequeuesAll(t *testing.T) {
	s, c, f := epochStore(t)
	var got []string
	hub := receivingHub(c, &got)
	first := submit(t, s, KindMemoryPropose, `{"n":1}`)
	c.add(time.Millisecond)
	second := submit(t, s, KindMemoryPropose, `{"n":2}`)
	if res, err := s.Flush(context.Background(), testID, hub); err != nil || res.Accepted != 2 {
		t.Fatalf("%+v %v", res, err)
	}
	f.ep = Epoch{ID: "epoch-b"}
	c.add(EpochCheckEvery)
	got = nil
	res, err := s.Flush(context.Background(), testID, hub)
	if err != nil || res.Requeued != 2 || len(got) != 2 || got[0] != first.Key || got[1] != second.Key {
		t.Fatalf("kết quả %+v, lỗi %v, hub nhận %v", res, err, got)
	}
}

func TestEpochKeepsLastWhenHubSilent(t *testing.T) {
	s, c, f := epochStore(t)
	var got []string
	hub := receivingHub(c, &got)
	submit(t, s, KindMemoryPropose, `{"n":1}`)
	if _, err := s.Flush(context.Background(), testID, hub); err != nil {
		t.Fatal(err)
	}
	// Hub vắng, rồi hub cũ không trả mốc: không coi là khôi phục, giữ mốc đã thấy.
	for _, step := range []fakeEpoch{{err: errors.New("mất mạng")}, {ep: Epoch{}}, {ep: Epoch{ID: "epoch-a"}}} {
		f.ep, f.err = step.ep, step.err
		c.add(EpochCheckEvery)
		if res, err := s.Flush(context.Background(), testID, hub); err != nil || res.Requeued != 0 {
			t.Fatalf("mốc %+v: %+v %v", step.ep, res, err)
		}
	}
	if len(got) != 1 {
		t.Errorf("hub nhận %v", got)
	}
}

func TestEpochArchivePrunedWithSentLog(t *testing.T) {
	s, c, _ := epochStore(t)
	var got []string
	it := submit(t, s, KindMemoryPropose, `{"n":1}`)
	if _, err := s.Flush(context.Background(), testID, receivingHub(c, &got)); err != nil {
		t.Fatal(err)
	}
	archived := filepath.Join(s.Root, "machine-may-1", "sent", it.Key+".json.gz")
	if _, err := os.Stat(archived); err != nil {
		t.Fatal(err)
	}
	c.add(SentRetention)
	if _, err := s.Flush(context.Background(), testID, receivingHub(c, &got)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(archived); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("bản nén quá 14 ngày còn: %v", err)
	}
}
