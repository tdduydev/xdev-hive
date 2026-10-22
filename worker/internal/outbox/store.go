// Package outbox giữ việc chờ gửi lên hub khi máy ngoại tuyến (spec 027 "Mục hộp thư đi"). Đây là phần tối thiểu của
// spec 029: chỉ kênh `worker` (sự kiện máy gửi tới `POST /api/v1/client-events` bằng machine token), không có kênh
// `mcp`, `rpc`, trạng thái `held` hay bản nén để gửi lại khi epoch database đổi.
//
// Mỗi mục là một file `<Root>/<identity>/<key>.json`; khoá ULID cũng là idempotencyKey gửi hub, nên gửi lại sau khi
// tiến trình chết giữa chừng chỉ làm hub trả `duplicate` (SC-006).
package outbox

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/repolock"
)

const (
	TransportWorker = "worker"

	KindTokenScore        = "machine.token_score"
	KindMemoryPropose     = "memory.propose"
	KindProjectTokenUsage = "project.token_usage"

	// Giới hạn theo spec 027 FR-016.
	DefaultMaxItemBytes  = 20 << 20
	DefaultMaxTotalBytes = 200 << 20

	ExpireAfter   = 14 * 24 * time.Hour
	SentRetention = 14 * 24 * time.Hour

	backoffBase = 5 * time.Second
	backoffMax  = 5 * time.Minute
	lockWait    = 30 * time.Second
)

// kindGroups là các kind kênh worker được nhận và nhóm của chúng (MACHINE_EVENT_KINDS trong contracts). Kind lạ bị
// chặn ngay khi nộp, vì hub kiểm schema strict và sẽ từ chối dù gửi bao nhiêu lần.
var kindGroups = map[string]string{
	KindTokenScore:        "progress",
	KindProjectTokenUsage: "progress",
	KindMemoryPropose:     "proposal",
}

type State string

const (
	StatePending   State = "pending"
	StateSending   State = "sending"
	StateAccepted  State = "accepted"
	StateDuplicate State = "duplicate"
	StateRejected  State = "rejected"
	StateExpired   State = "expired"
)

// Identity là danh tính gửi. Kênh worker chỉ có máy: hub đọc tổ chức và máy từ token, không từ body.
type Identity struct {
	HubURL    string `json:"hubUrl"`
	OrgID     string `json:"orgId,omitempty"`
	MachineID string `json:"machineId"`
}

var unsafeIDChars = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// Key là tên thư mục của danh tính: `machine-<machineId>` (spec 027). Ký tự ngoài chữ, số, `_`, `-` bị thay để id lạ
// không thoát ra ngoài thư mục outbox.
func (id Identity) Key() string {
	return "machine-" + unsafeIDChars.ReplaceAllString(id.MachineID, "_")
}

func normalizeHub(u string) string { return strings.TrimRight(u, "/") }

type Result struct {
	Outcome    string `json:"outcome"`
	Code       string `json:"code,omitempty"`
	Reason     string `json:"reason,omitempty"`
	ReceivedAt string `json:"receivedAt,omitempty"`
}

type Item struct {
	Key           string          `json:"key"`
	Source        string          `json:"source"`
	Identity      Identity        `json:"identity"`
	Transport     string          `json:"transport"`
	Kind          string          `json:"kind"`
	Group         string          `json:"group"`
	Stream        string          `json:"stream"`
	Body          json.RawMessage `json:"body"`
	CreatedAt     time.Time       `json:"createdAt"`
	State         State           `json:"state"`
	Attempts      int             `json:"attempts"`
	LastAttemptAt *time.Time      `json:"lastAttemptAt,omitempty"`
	NextAttemptAt *time.Time      `json:"nextAttemptAt,omitempty"`
	LastError     string          `json:"lastError,omitempty"`
	Result        *Result         `json:"result,omitempty"`
}

// Error mang mã ổn định để app desktop hiện đúng thông báo (`ITEM_TOO_LARGE`, `OUTBOX_FULL`).
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// Store là hộp thư đi dưới Root (`~/.xdev-hive/outbox`). Now và hai giới hạn để test thay; bỏ trống thì dùng mặc định.
type Store struct {
	Root          string
	Now           func() time.Time
	MaxItemBytes  int64
	MaxTotalBytes int64
}

func (s Store) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s Store) dir(id Identity) string                  { return filepath.Join(s.Root, id.Key()) }
func (s Store) itemPath(id Identity, key string) string { return filepath.Join(s.dir(id), key+".json") }
func (s Store) sentPath(id Identity) string             { return filepath.Join(s.dir(id), "sent.jsonl") }

// lock giữ khoá file của danh tính: `outbox submit` từ app desktop, `outbox flush` và vòng gửi của `hive-worker run`
// có thể chạy cùng lúc, mà một mục chỉ được một tiến trình gửi.
func (s Store) lock(id Identity) (func(), error) {
	if err := os.MkdirAll(s.dir(id), 0o700); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), lockWait)
	defer cancel()
	f, err := repolock.LockFile(ctx, filepath.Join(s.dir(id), "outbox.lock"))
	if err != nil {
		return nil, fmt.Errorf("không khoá được hộp thư đi: %w", err)
	}
	return func() { _ = repolock.UnlockFile(f); _ = f.Close() }, nil
}

// Submission là việc cần gửi. Key và CreatedAt bỏ trống thì tạo mới; truyền vào khi chuyển việc đã có khoá (báo cáo
// điểm chờ của bản trước) để hub vẫn nhận ra trùng. Replace bỏ các mục cùng kind chưa gửi được, cho loại chỉ cần số đọc
// mới nhất như điểm máy.
type Submission struct {
	Kind      string
	Source    string
	Stream    string
	Payload   json.RawMessage
	Key       string
	CreatedAt time.Time
	Replace   bool
}

var keyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

func (s Store) Submit(id Identity, sub Submission) (Item, error) {
	group, ok := kindGroups[sub.Kind]
	if !ok {
		return Item{}, fmt.Errorf("loại việc %q không gửi được qua hộp thư đi", sub.Kind)
	}
	if id.MachineID == "" || id.HubURL == "" {
		return Item{}, errors.New("máy chưa đăng ký với hub; chạy `hive-worker register --hub URL --token MÃ` trước")
	}
	payload := strings.TrimSpace(string(sub.Payload))
	if !json.Valid([]byte(payload)) || !strings.HasPrefix(payload, "{") {
		return Item{}, errors.New("nội dung gửi phải là một object JSON")
	}
	now := s.now()
	it := Item{
		Key: sub.Key, Source: sub.Source, Identity: id, Transport: TransportWorker, Kind: sub.Kind, Group: group,
		Stream: sub.Stream, Body: json.RawMessage(payload), CreatedAt: sub.CreatedAt.UTC(), State: StatePending,
	}
	it.Identity.HubURL = normalizeHub(id.HubURL)
	if it.Key == "" {
		it.Key = NewKey(now)
	} else if !keyPattern.MatchString(it.Key) {
		return Item{}, errors.New("khoá chống trùng gồm 16–64 ký tự chữ, số, `_` hoặc `-`")
	}
	if sub.CreatedAt.IsZero() {
		it.CreatedAt = now.UTC()
	}
	if it.Source == "" {
		it.Source = "worker"
	}
	if it.Stream == "" {
		it.Stream = it.Kind
	}
	b, err := json.Marshal(it)
	if err != nil {
		return Item{}, err
	}
	maxItem, maxTotal := s.MaxItemBytes, s.MaxTotalBytes
	if maxItem <= 0 {
		maxItem = DefaultMaxItemBytes
	}
	if maxTotal <= 0 {
		maxTotal = DefaultMaxTotalBytes
	}
	if int64(len(b)) > maxItem {
		return Item{}, &Error{Code: "ITEM_TOO_LARGE", Message: fmt.Sprintf("Việc chờ gửi quá lớn (tối đa %d MB).", maxItem>>20)}
	}

	unlock, err := s.lock(id)
	if err != nil {
		return Item{}, err
	}
	defer unlock()
	if _, err := os.Stat(s.itemPath(id, it.Key)); err == nil {
		// Đã nộp cùng khoá (chuyển việc cũ chạy lại): giữ nguyên mục đang có để không xoá kết quả gửi.
		return s.read(s.itemPath(id, it.Key))
	}
	items, total, err := s.load(id)
	if err != nil {
		return Item{}, err
	}
	if sub.Replace {
		for _, old := range items {
			if old.Kind == it.Kind && old.State != StateSending {
				if err := os.Remove(s.itemPath(id, old.Key)); err != nil && !errors.Is(err, fs.ErrNotExist) {
					return Item{}, err
				}
				total -= old.size
			}
		}
	}
	if total+int64(len(b)) > maxTotal {
		return Item{}, &Error{Code: "OUTBOX_FULL", Message: fmt.Sprintf("Hộp thư đi đã đầy (tối đa %d MB); kết nối lại hub để gửi bớt.", maxTotal>>20)}
	}
	if err := writeAtomic(s.itemPath(id, it.Key), b); err != nil {
		return Item{}, err
	}
	return it, nil
}

type loaded struct {
	Item
	size int64
}

// load đọc mọi mục theo thứ tự khoá (cũng là thứ tự tạo). File tạm của lần ghi dở và file không đọc được bị bỏ qua: ghi
// tạm rồi đổi tên nên file `<key>.json` hỏng chỉ có thể do người sửa tay.
func (s Store) load(id Identity) ([]loaded, int64, error) {
	entries, err := os.ReadDir(s.dir(id))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	var (
		items []loaded
		total int64
	)
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".json") {
			continue
		}
		path := filepath.Join(s.dir(id), name)
		it, err := s.read(path)
		if err != nil || it.Key+".json" != name {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		items = append(items, loaded{Item: it, size: info.Size()})
		total += info.Size()
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Key < items[j].Key })
	return items, total, nil
}

func (s Store) read(path string) (Item, error) {
	var it Item
	b, err := os.ReadFile(path)
	if err != nil {
		return it, err
	}
	err = json.Unmarshal(b, &it)
	return it, err
}

// List trả các mục còn trong hộp thư đi (chưa gửi, bị từ chối, hết hạn) theo thứ tự tạo.
func (s Store) List(id Identity) ([]Item, error) {
	items, _, err := s.load(id)
	if err != nil {
		return nil, err
	}
	out := make([]Item, 0, len(items))
	for _, it := range items {
		out = append(out, it.Item)
	}
	return out, nil
}

// Drop bỏ một mục (người dùng bấm Bỏ mục bị từ chối hay hết hạn).
func (s Store) Drop(id Identity, key string) error {
	if !keyPattern.MatchString(key) {
		return errors.New("khoá không hợp lệ")
	}
	unlock, err := s.lock(id)
	if err != nil {
		return err
	}
	defer unlock()
	err = os.Remove(s.itemPath(id, key))
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("không có việc chờ gửi %s", key)
	}
	return err
}

// DropKind bỏ mọi mục của một kind, vd. người dùng tắt gửi điểm thì điểm đang chờ không còn được gửi.
func (s Store) DropKind(id Identity, kind string) (int, error) {
	unlock, err := s.lock(id)
	if err != nil {
		return 0, err
	}
	defer unlock()
	items, _, err := s.load(id)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, it := range items {
		if it.Kind != kind {
			continue
		}
		if err := os.Remove(s.itemPath(id, it.Key)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return n, err
		}
		n++
	}
	return n, nil
}

// SentEntry là một dòng sent.jsonl: việc hub đã nhận, giữ 14 ngày để người dùng xem lại.
type SentEntry struct {
	Key        string    `json:"key"`
	Kind       string    `json:"kind"`
	Stream     string    `json:"stream"`
	Outcome    string    `json:"outcome"`
	ReceivedAt string    `json:"receivedAt"`
	SentAt     time.Time `json:"sentAt"`
}

func (s Store) Sent(id Identity) ([]SentEntry, error) {
	f, err := os.Open(s.sentPath(id))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []SentEntry
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		var e SentEntry
		// Dòng cuối dở dang do mất điện giữa lúc ghi thì bỏ, các dòng khác vẫn đọc được.
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.Key != "" {
			out = append(out, e)
		}
	}
	return out, sc.Err()
}

func (s Store) appendSent(id Identity, e SentEntry) error {
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(s.sentPath(id), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.Write(append(b, '\n'))
	serr := f.Sync()
	cerr := f.Close()
	return errors.Join(werr, serr, cerr)
}

func (s Store) pruneSent(id Identity, now time.Time) error {
	entries, err := s.Sent(id)
	if err != nil || len(entries) == 0 {
		return err
	}
	var keep []byte
	dropped := false
	for _, e := range entries {
		if now.Sub(e.SentAt) >= SentRetention {
			dropped = true
			continue
		}
		b, err := json.Marshal(e)
		if err != nil {
			return err
		}
		keep = append(append(keep, b...), '\n')
	}
	if !dropped {
		return nil
	}
	return writeAtomic(s.sentPath(id), keep)
}

// cleanTemp dọn file tạm do tiến trình bị giết giữa lúc ghi để lại; gọi khi đang giữ khoá nên không có lần ghi nào đang dở.
func (s Store) cleanTemp(id Identity) {
	entries, err := os.ReadDir(s.dir(id))
	if err != nil {
		return
	}
	for _, e := range entries {
		if name := e.Name(); strings.HasPrefix(name, ".") && strings.Contains(name, ".json") && !e.IsDir() {
			_ = os.Remove(filepath.Join(s.dir(id), name))
		}
	}
}

// writeAtomic ghi file tạm cạnh đích, fsync rồi đổi tên: tiến trình bị giết hay mất điện giữa chừng để lại file cũ hoặc
// file mới đầy đủ, không có file dở. CreateTemp tạo file quyền 0600.
func writeAtomic(path string, b []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(b)
	serr := tmp.Sync()
	cerr := tmp.Close()
	if err := errors.Join(werr, serr, cerr); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return nil
}

// NewKey tạo khoá ULID (26 ký tự Crockford base32): 48 bit thời gian mili giây rồi 80 bit ngẫu nhiên, nên tên file xếp
// theo thứ tự tạo và khớp khoá ULID của các client khác.
func NewKey(now time.Time) string {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	var b [16]byte
	ms := uint64(now.UnixMilli())
	for i := 5; i >= 0; i-- {
		b[i] = byte(ms)
		ms >>= 8
	}
	_, _ = rand.Read(b[6:])
	// 128 bit chia thành 26 ký tự: ký tự đầu lấy 3 bit cao, còn lại mỗi ký tự 5 bit, như ULID chuẩn.
	out := make([]byte, 26)
	out[0] = alphabet[b[0]>>5]
	acc, bits, j := uint32(b[0]&0x1f), 5, 1
	for i := 1; i < 16; i++ {
		acc = acc<<8 | uint32(b[i])
		bits += 8
		for bits >= 5 {
			bits -= 5
			out[j] = alphabet[(acc>>bits)&0x1f]
			j++
		}
	}
	return string(out)
}
