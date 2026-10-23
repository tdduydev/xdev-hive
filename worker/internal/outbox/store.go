// Package outbox giữ việc chờ gửi lên hub khi hub vắng (spec 027 "Mục hộp thư đi", ADR 0032). Ba kênh: `worker` (sự
// kiện máy gửi tới `POST /api/v1/client-events` bằng machine token), `mcp` (tool có ghi, `POST /mcp`) và `rpc`
// (procedure có ghi, `POST /rpc/<path>`), hai kênh sau gửi bằng token của người đã tạo mục.
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
	TransportMCP    = "mcp"
	TransportRPC    = "rpc"

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

type State string

const (
	StatePending   State = "pending"
	StateSending   State = "sending"
	StateHeld      State = "held"
	StateAccepted  State = "accepted"
	StateDuplicate State = "duplicate"
	StateRejected  State = "rejected"
	StateExpired   State = "expired"
)

// Lý do giữ mục: gửi bằng danh tính hiện tại thì hub chắc chắn từ chối, nên chờ người dùng đăng nhập lại thay vì thử
// lại tới khi hết hạn.
const (
	HeldLoginRequired    = "login_required"
	HeldIdentityMismatch = "identity_mismatch"
	HeldMachineRevoked   = "machine_revoked"
)

// sources là giá trị `X-Hive-Source` hub nhận (CLIENT_SOURCES trong contracts).
var sources = map[string]bool{
	"worker-run": true, "worker": true, "desktop": true, "hive-cli": true, "mcp-local": true, "vscode": true, "web": true,
}

var defaultSource = map[string]string{TransportWorker: "worker", TransportMCP: "mcp-local", TransportRPC: "hive-cli"}

// Target là thứ mục ghi vào (task, doc, project…). Các mục cùng target tạo một stream gửi theo thứ tự.
type Target struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// Result là trả lời của hub. Response giữ kết quả tool hay procedure để client đang chờ nhận đúng nội dung như gọi thẳng.
type Result struct {
	Outcome    string          `json:"outcome"`
	Code       string          `json:"code,omitempty"`
	Reason     string          `json:"reason,omitempty"`
	ReceivedAt string          `json:"receivedAt,omitempty"`
	Response   json.RawMessage `json:"response,omitempty"`
}

type Item struct {
	Key           string          `json:"key"`
	Source        string          `json:"source"`
	Identity      Identity        `json:"identity"`
	Transport     string          `json:"transport"`
	Kind          string          `json:"kind"`
	Group         string          `json:"group"`
	Stream        string          `json:"stream"`
	Target        *Target         `json:"target,omitempty"`
	Project       string          `json:"project,omitempty"`
	Body          json.RawMessage `json:"body"`
	CreatedAt     time.Time       `json:"createdAt"`
	State         State           `json:"state"`
	HeldReason    string          `json:"heldReason,omitempty"`
	RetriedAt     *time.Time      `json:"retriedAt,omitempty"`
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
// điểm chờ của bản trước, client gửi lại sau khi socket đứt) để hub vẫn nhận ra trùng. Replace bỏ các mục cùng kind chưa
// gửi được, cho loại chỉ cần số đọc mới nhất như điểm máy. Transport bỏ trống là `worker`. Stream bỏ trống thì lấy từ
// Target (`task:<id>`), không có Target thì là kind.
type Submission struct {
	Transport string
	Kind      string
	Source    string
	Stream    string
	Target    *Target
	Project   string
	Payload   json.RawMessage
	Key       string
	CreatedAt time.Time
	Replace   bool
}

var keyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

func (s Store) Submit(id Identity, sub Submission) (Item, error) {
	it, b, err := s.prepare(id, sub, false)
	if err != nil {
		return Item{}, err
	}
	maxTotal := s.MaxTotalBytes
	if maxTotal <= 0 {
		maxTotal = DefaultMaxTotalBytes
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

// Prepare kiểm và dựng mục như Submit nhưng không ghi đĩa, cho nhóm `immediate` gửi thẳng tới hub qua cùng Dispatcher.
func (s Store) Prepare(id Identity, sub Submission) (Item, error) {
	it, _, err := s.prepare(id, sub, true)
	return it, err
}

func (s Store) prepare(id Identity, sub Submission, immediate bool) (Item, []byte, error) {
	transport := sub.Transport
	if transport == "" {
		transport = TransportWorker
	}
	group, ok := GroupOf(transport, sub.Kind)
	if !ok {
		return Item{}, nil, &Error{Code: "UNKNOWN_KIND", Message: fmt.Sprintf("loại việc %q không gửi được qua hộp thư đi", sub.Kind)}
	}
	if !immediate && !Queueable(group) {
		return Item{}, nil, &Error{Code: "NOT_QUEUEABLE", Message: fmt.Sprintf("%q cần hub trả lời ngay nên không xếp hàng được", sub.Kind)}
	}
	switch {
	case transport == TransportWorker && (id.MachineID == "" || id.HubURL == ""):
		return Item{}, nil, errors.New("máy chưa đăng ký với hub; chạy `hive-worker register --hub URL --token MÃ` trước")
	case transport != TransportWorker && (id.UserID == "" || id.HubURL == ""):
		return Item{}, nil, &Error{Code: "NOT_SIGNED_IN", Message: "Chưa đăng nhập hub; chạy `hive login` trước."}
	}
	if sub.Source != "" && !sources[sub.Source] {
		return Item{}, nil, fmt.Errorf("nguồn %q không hợp lệ", sub.Source)
	}
	if t := sub.Target; t != nil && (t.Type == "" || t.ID == "") {
		return Item{}, nil, errors.New("đích ghi cần cả loại và id")
	}
	payload := strings.TrimSpace(string(sub.Payload))
	if !json.Valid([]byte(payload)) || !strings.HasPrefix(payload, "{") {
		return Item{}, nil, errors.New("nội dung gửi phải là một object JSON")
	}
	now := s.now()
	it := Item{
		Key: sub.Key, Source: sub.Source, Identity: id, Transport: transport, Kind: sub.Kind, Group: group,
		Stream: sub.Stream, Target: sub.Target, Project: sub.Project, Body: json.RawMessage(payload), CreatedAt: sub.CreatedAt.UTC(),
		State: StatePending,
	}
	it.Identity.HubURL = normalizeHub(id.HubURL)
	if it.Key == "" {
		it.Key = NewKey(now)
	} else if !keyPattern.MatchString(it.Key) {
		return Item{}, nil, errors.New("khoá chống trùng gồm 16–64 ký tự chữ, số, `_` hoặc `-`")
	}
	if sub.CreatedAt.IsZero() {
		it.CreatedAt = now.UTC()
	}
	if it.Source == "" {
		it.Source = defaultSource[transport]
	}
	switch {
	case it.Stream != "":
	case it.Target != nil:
		it.Stream = it.Target.Type + ":" + it.Target.ID
	default:
		it.Stream = it.Kind
	}
	b, err := json.Marshal(it)
	if err != nil {
		return Item{}, nil, err
	}
	maxItem := s.MaxItemBytes
	if maxItem <= 0 {
		maxItem = DefaultMaxItemBytes
	}
	if int64(len(b)) > maxItem {
		return Item{}, nil, &Error{Code: "ITEM_TOO_LARGE", Message: fmt.Sprintf("Việc chờ gửi quá lớn (tối đa %d MB).", maxItem>>20)}
	}
	return it, b, nil
}

// IncomingDir là nơi client đặt file tạm của mục lớn hơn một dòng socket (`bodyFile`); không phải thư mục danh tính.
const IncomingDir = "incoming"

// Identities trả danh tính của các thư mục còn mục, đọc từ mục đầu tiên: tên thư mục là băm nên không suy ngược được.
// Vòng gửi của `hive-worker run` dùng để gửi cả mục của người đã đăng xuất hay đổi tài khoản khi họ đăng nhập lại.
func (s Store) Identities() ([]Identity, error) {
	entries, err := os.ReadDir(s.Root)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Identity
	for _, e := range entries {
		if !e.IsDir() || e.Name() == IncomingDir || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		files, err := os.ReadDir(filepath.Join(s.Root, e.Name()))
		if err != nil {
			continue
		}
		for _, f := range files {
			name := f.Name()
			if f.IsDir() || strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".json") {
				continue
			}
			it, err := s.read(filepath.Join(s.Root, e.Name(), name))
			if err != nil || it.Identity.Key() != e.Name() {
				continue
			}
			out = append(out, it.Identity)
			break
		}
	}
	return out, nil
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

// expired tính 14 ngày từ lúc tạo, hoặc từ lần người dùng bấm Gửi lại mục đã hết hạn.
func (it Item) expired(now time.Time) bool {
	from := it.CreatedAt
	if it.RetriedAt != nil && it.RetriedAt.After(from) {
		from = *it.RetriedAt
	}
	return now.Sub(from) >= ExpireAfter
}

// update đọc, sửa rồi ghi lại từng mục có khoá trong keys khi đang giữ khoá file. fn trả false thì bỏ qua mục đó.
func (s Store) update(id Identity, keys []string, fn func(*Item) bool) (int, error) {
	unlock, err := s.lock(id)
	if err != nil {
		return 0, err
	}
	defer unlock()
	n := 0
	for _, key := range keys {
		if !keyPattern.MatchString(key) {
			return n, errors.New("khoá không hợp lệ")
		}
		it, err := s.read(s.itemPath(id, key))
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return n, err
		}
		if !fn(&it) {
			continue
		}
		if err := s.write(id, it); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// Hold giữ mục tới khi người dùng đăng nhập lại; sender gọi khi hub trả 401 hay token là của người khác.
func (s Store) Hold(id Identity, key, reason string) error {
	_, err := s.update(id, []string{key}, func(it *Item) bool {
		if it.State != StatePending && it.State != StateSending {
			return false
		}
		it.State, it.HeldReason, it.NextAttemptAt = StateHeld, reason, nil
		return true
	})
	return err
}

// Retry đưa mục `held` hay `expired` về `pending` để lượt gửi sau thử ngay. Mục bị từ chối không gửi lại: hub trả đúng
// lần từ chối cũ cho cùng khoá.
func (s Store) Retry(id Identity, keys []string) (int, error) {
	now := s.now()
	return s.update(id, keys, func(it *Item) bool {
		if it.State != StateHeld && it.State != StateExpired {
			return false
		}
		if it.State == StateExpired {
			it.RetriedAt = &now
		}
		it.State, it.HeldReason, it.NextAttemptAt, it.LastError = StatePending, "", nil, ""
		return true
	})
}

// RetryHeld đưa mọi mục bị giữ vì reason về `pending`, vd. sau `hive login` cho đúng người.
func (s Store) RetryHeld(id Identity, reason string) (int, error) {
	items, err := s.List(id)
	if err != nil {
		return 0, err
	}
	var keys []string
	for _, it := range items {
		if it.State == StateHeld && (reason == "" || it.HeldReason == reason) {
			keys = append(keys, it.Key)
		}
	}
	return s.Retry(id, keys)
}

// Export trả các mục có khoá trong keys, rỗng thì mọi mục, để người dùng lưu ra file trước khi bỏ.
func (s Store) Export(id Identity, keys []string) ([]Item, error) {
	items, err := s.List(id)
	if err != nil || len(keys) == 0 {
		return items, err
	}
	want := map[string]bool{}
	for _, k := range keys {
		want[k] = true
	}
	out := []Item{}
	for _, it := range items {
		if want[it.Key] {
			out = append(out, it)
		}
	}
	return out, nil
}

// Stats là số mục theo trạng thái và dung lượng, cho thanh trạng thái "Hub đang vắng – N mục chờ gửi".
type Stats struct {
	Pending    int   `json:"pending"`
	Held       int   `json:"held"`
	Rejected   int   `json:"rejected"`
	Expired    int   `json:"expired"`
	Bytes      int64 `json:"bytes"`
	LimitBytes int64 `json:"limitBytes"`
}

func (s Store) Stats(id Identity) (Stats, error) {
	st := Stats{LimitBytes: s.MaxTotalBytes}
	if st.LimitBytes <= 0 {
		st.LimitBytes = DefaultMaxTotalBytes
	}
	items, total, err := s.load(id)
	if err != nil {
		return st, err
	}
	st.Bytes = total
	for _, it := range items {
		switch it.State {
		case StatePending, StateSending:
			st.Pending++
		case StateHeld:
			st.Held++
		case StateRejected:
			st.Rejected++
		case StateExpired:
			st.Expired++
		}
	}
	return st, nil
}
