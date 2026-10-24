package outbox

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
)

// Khôi phục database hub (spec 027 FR-042) làm mất mọi việc hub nhận sau thời điểm của bản sao lưu, kể cả bảng chống
// trùng. Hub đổi `dbEpoch` mỗi lần khôi phục; hộp thư đi giữ bản nén của việc đã gửi suốt 14 ngày (cùng sent.jsonl) để
// thấy mốc đổi thì đưa việc bị mất về hàng đợi, gửi lại cùng khoá.

// EpochCheckEvery giãn số lần hỏi health: lượt gửi chạy sau mỗi lần nộp, còn khôi phục hiếm và gửi lại muộn vài phút
// không sao.
const EpochCheckEvery = 5 * time.Minute

// Epoch là mốc database hub trả trong health. RestoredTo nil là hub không biết thời điểm của bản đã khôi phục.
type Epoch struct {
	ID         string
	RestoredTo *time.Time
}

// EpochSource hỏi mốc database của hub. ID rỗng là hub cũ hay hub không có database: giữ mốc đã thấy.
type EpochSource func(ctx context.Context, hubURL string) (Epoch, error)

// HubEpoch đọc mốc từ GET /api/v1/health.
func HubEpoch(hc *http.Client) EpochSource {
	return func(ctx context.Context, hubURL string) (Epoch, error) {
		h, err := hubclient.NewWithHTTP(hubURL, hc).Health(ctx)
		if err != nil {
			return Epoch{}, err
		}
		return Epoch{ID: h.DBEpoch, RestoredTo: h.DBRestoredTo}, nil
	}
}

type epochState struct {
	HubURL    string    `json:"hubUrl"`
	Epoch     string    `json:"epoch,omitempty"`
	CheckedAt time.Time `json:"checkedAt"`
}

func (s Store) epochPath(id Identity) string  { return filepath.Join(s.dir(id), "epoch.json") }
func (s Store) archiveDir(id Identity) string { return filepath.Join(s.dir(id), "sent") }
func (s Store) archivePath(id Identity, key string) string {
	return filepath.Join(s.archiveDir(id), key+".json.gz")
}

// checkEpoch hỏi mốc khi đã quá EpochCheckEvery từ lần trước; gọi khi đang giữ khoá. Không gọi được hub thì để lượt gửi
// tự thấy hub vắng, lần sau hỏi lại.
func (s Store) checkEpoch(ctx context.Context, id Identity) (int, error) {
	if s.Epoch == nil {
		return 0, nil
	}
	hub := normalizeHub(id.HubURL)
	var st epochState
	if b, err := os.ReadFile(s.epochPath(id)); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	now := s.now()
	if st.HubURL == hub && now.Sub(st.CheckedAt) < EpochCheckEvery && now.After(st.CheckedAt) {
		return 0, nil
	}
	ep, err := s.Epoch(ctx, hub)
	if err != nil {
		return 0, nil
	}
	n := 0
	// Lần đầu thấy hub (hay máy đổi hub) chỉ ghi mốc: không biết việc đã gửi trước đó thuộc mốc nào.
	if ep.ID != "" && st.HubURL == hub && st.Epoch != "" && st.Epoch != ep.ID {
		if n, err = s.requeueLost(id, ep.RestoredTo, now); err != nil {
			return n, err
		}
	}
	next := epochState{HubURL: hub, Epoch: ep.ID, CheckedAt: now}
	if ep.ID == "" && st.HubURL == hub {
		next.Epoch = st.Epoch
	}
	b, err := json.Marshal(next)
	if err != nil {
		return n, err
	}
	return n, writeAtomic(s.epochPath(id), b)
}

// requeueLost đưa việc hub nhận từ restoredTo trở đi (nil thì mọi việc còn trong sent.jsonl) về `pending`. Việc gửi
// lại có thể đã nằm trong bản sao lưu; hub vẫn còn khoá đó nên chỉ trả `duplicate`.
func (s Store) requeueLost(id Identity, restoredTo *time.Time, now time.Time) (int, error) {
	entries, err := s.Sent(id)
	if err != nil {
		return 0, err
	}
	var keep []byte
	n := 0
	for _, e := range entries {
		if lost(e, restoredTo) {
			it, err := s.readArchive(id, e.Key)
			if err == nil {
				it.State, it.Attempts, it.LastAttemptAt, it.NextAttemptAt, it.LastError, it.Result = StatePending, 0, nil, nil, "", nil
				it.HeldReason = ""
				// Việc gửi gần 14 ngày trước thì vừa gửi lại đã hết hạn; tính lại hạn từ lúc đưa về hàng đợi.
				it.RetriedAt = &now
				if err := s.write(id, it); err != nil {
					return n, err
				}
				n++
				continue
			}
			// Không còn bản nén (bản worker cũ gửi, hay người dùng xoá tay): không gửi lại được, giữ dòng để xem lại.
			if !errors.Is(err, fs.ErrNotExist) {
				return n, err
			}
		}
		b, err := json.Marshal(e)
		if err != nil {
			return n, err
		}
		keep = append(append(keep, b...), '\n')
	}
	if n == 0 {
		return 0, nil
	}
	if err := writeAtomic(s.sentPath(id), keep); err != nil {
		return n, err
	}
	// Xoá bản nén sau khi sent.jsonl đã bỏ dòng: chết giữa chừng thì lần sau pruneSent dọn bản nén thừa.
	items, _, err := s.load(id)
	if err != nil {
		return n, err
	}
	for _, it := range items {
		if err := os.Remove(s.archivePath(id, it.Key)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return n, err
		}
	}
	return n, nil
}

// lost so giờ hub nhận (đồng hồ hub, cùng nguồn với restoredTo); thiếu thì dùng giờ máy ghi lúc gửi.
func lost(e SentEntry, restoredTo *time.Time) bool {
	if restoredTo == nil {
		return true
	}
	at := e.SentAt
	if t, err := time.Parse(time.RFC3339Nano, e.ReceivedAt); err == nil {
		at = t
	}
	return !at.Before(*restoredTo)
}

func (s Store) archive(id Identity, it Item) error {
	if err := os.MkdirAll(s.archiveDir(id), 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(it)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, werr := zw.Write(b)
	if err := errors.Join(werr, zw.Close()); err != nil {
		return err
	}
	return writeAtomic(s.archivePath(id, it.Key), buf.Bytes())
}

func (s Store) readArchive(id Identity, key string) (Item, error) {
	var it Item
	f, err := os.Open(s.archivePath(id, key))
	if err != nil {
		return it, err
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return it, err
	}
	b, err := io.ReadAll(zr)
	if err != nil {
		return it, err
	}
	err = json.Unmarshal(b, &it)
	return it, err
}

// pruneArchive bỏ bản nén không còn dòng trong sent.jsonl (hết 14 ngày, hay tiến trình chết giữa lúc ghi).
func (s Store) pruneArchive(id Identity, entries []SentEntry, now time.Time) error {
	files, err := os.ReadDir(s.archiveDir(id))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	keep := make(map[string]bool, len(entries))
	for _, e := range entries {
		if now.Sub(e.SentAt) < SentRetention {
			keep[e.Key+".json.gz"] = true
		}
	}
	for _, f := range files {
		if f.IsDir() || keep[f.Name()] {
			continue
		}
		// Bản nén của mục còn trong hộp thư đi (chết giữa archive và appendSent) cũng bỏ: finish ghi lại.
		if err := os.Remove(filepath.Join(s.archiveDir(id), f.Name())); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return nil
}
