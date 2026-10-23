package secretstore

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

const (
	KindRun      = "run"
	KindTerminal = "terminal"
	KindReveal   = "reveal"
	kindLeak     = "leak"

	OutcomeGranted    = "granted"
	OutcomeDenied     = "denied"
	OutcomeDeclined   = "declined"
	OutcomeTimeout    = "timeout"
	OutcomeStoreError = "store_error"

	grantsFile      = "secret-grants.jsonl"
	logKeep         = 90 * 24 * time.Hour
	logMaxLines     = 10_000
	DefaultLogLimit = 200
)

// GrantRecord là một dòng của secret-grants.jsonl (data-model §4). Chỉ có tên, không bao giờ giá trị.
type GrantRecord struct {
	ID          string    `json:"id"`
	At          time.Time `json:"at"`
	Kind        string    `json:"kind"`
	SessionID   string    `json:"sessionId,omitempty"`
	Project     string    `json:"project,omitempty"`
	ProjectName string    `json:"projectName,omitempty"`
	Names       []string  `json:"names"`
	Policy      string    `json:"policy,omitempty"`
	Outcome     string    `json:"outcome,omitempty"`
	Leaked      []string  `json:"leaked,omitempty"`
	Copy        bool      `json:"copy,omitempty"`
}

// LogName và LogEntry là dạng đọc ra cho desktop (GrantEntry trong contracts/sidecar-cli.md).
type LogName struct {
	Name    string `json:"name"`
	Deleted bool   `json:"deleted"`
	Leaked  bool   `json:"leaked"`
}

type LogEntry struct {
	ID          string    `json:"id"`
	At          time.Time `json:"at"`
	Kind        string    `json:"kind"`
	SessionID   string    `json:"sessionId"`
	Project     string    `json:"project"`
	ProjectName string    `json:"projectName"`
	Names       []LogName `json:"names"`
	Policy      string    `json:"policy"`
	Outcome     string    `json:"outcome"`
	Copy        bool      `json:"copy,omitempty"`
}

type LogFilter struct {
	Name    string
	Project string
	Limit   int
}

// now là đồng hồ của nhật ký; test thay để kiểm cắt tỉa 90 ngày.
var now = time.Now

// GrantsPath đặt nhật ký cạnh secrets.json.
func GrantsPath(workerConfig string) string {
	return filepath.Join(filepath.Dir(workerConfig), grantsFile)
}

// Append ghi một dòng và trả ID của dòng (để MarkLeaked). ID và At rỗng thì được điền.
func Append(path string, r GrantRecord) (string, error) {
	if r.ID == "" {
		r.ID = newGrantID(now())
	}
	if r.At.IsZero() {
		r.At = now()
	}
	r.At = stamp(r.At)
	if r.Names == nil {
		r.Names = []string{}
	}
	line, err := json.Marshal(r)
	if err != nil {
		return "", err
	}
	return r.ID, projects.WithLock(path, func() error { return appendLine(path, line) })
}

// MarkLeaked ghi dòng leak cho lần cấp id thay vì sửa dòng gốc, để file chỉ ghi nối (data-model §4).
func MarkLeaked(path, id string, names []string) error {
	if len(names) == 0 {
		return nil
	}
	_, err := Append(path, GrantRecord{ID: id, Kind: kindLeak, Names: names})
	return err
}

// ReadLog trả các lần cấp mới nhất trước, đã gộp dòng leak. Tên không còn trong danh mục được gắn Deleted (FR-044):
// nhãn tính lúc đọc nên xoá bí mật không phải ghi lại nhật ký.
func ReadLog(path string, f LogFilter, cat Catalog) ([]LogEntry, error) {
	records, err := readRecords(path)
	if err != nil {
		return nil, err
	}
	leaked := map[string][]string{}
	for _, r := range records {
		if r.Kind == kindLeak {
			leaked[r.ID] = append(leaked[r.ID], r.Names...)
		}
	}
	limit := f.Limit
	if limit <= 0 {
		limit = DefaultLogLimit
	}
	out := []LogEntry{}
	for i := len(records) - 1; i >= 0 && len(out) < limit; i-- {
		r := records[i]
		if r.Kind == kindLeak || (f.Project != "" && r.Project != f.Project) || (f.Name != "" && !slices.Contains(r.Names, f.Name)) {
			continue
		}
		e := LogEntry{
			ID: r.ID, At: r.At, Kind: r.Kind, SessionID: r.SessionID, Project: r.Project, ProjectName: r.ProjectName,
			Policy: r.Policy, Outcome: r.Outcome, Copy: r.Copy, Names: make([]LogName, 0, len(r.Names)),
		}
		for _, n := range r.Names {
			e.Names = append(e.Names, LogName{
				Name:    n,
				Deleted: cat.Find(n) == nil,
				Leaked:  slices.Contains(r.Leaked, n) || slices.Contains(leaked[r.ID], n),
			})
		}
		out = append(out, e)
	}
	return out, nil
}

// ClearLog thay nhật ký bằng file rỗng (FR-042) và trả số lần cấp đã xoá.
func ClearLog(path string) (int, error) {
	var n int
	err := projects.WithLock(path, func() error {
		records, err := readRecords(path)
		if err != nil {
			return err
		}
		for _, r := range records {
			if r.Kind != kindLeak {
				n++
			}
		}
		return writeLines(path, nil)
	})
	return n, err
}

// appendLine cắt tỉa trước khi ghi nối. Phải gọi trong khoá: ghi lại file và ghi nối cùng lúc sẽ mất dòng.
func appendLine(path string, line []byte) error {
	lines, err := readLines(path)
	if err != nil {
		return err
	}
	kept := prune(lines, now())
	if len(kept) != len(lines) {
		return writeLines(path, append(kept, line))
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// prune bỏ dòng cũ hơn logKeep (A7) và giữ tối đa logMaxLines dòng, kể cả dòng sắp ghi. Chạm trần thì cắt xuống 90%,
// để không phải ghi lại cả file ở mỗi lần cấp sau đó. Dòng hỏng bị bỏ: nó là dấu vết của lần ghi bị ngắt, không đọc
// được thì cũng không hiện được.
func prune(lines [][]byte, t time.Time) [][]byte {
	cutoff := t.Add(-logKeep)
	kept := lines[:0:0]
	for _, l := range lines {
		var r struct {
			At time.Time `json:"at"`
		}
		if json.Unmarshal(l, &r) != nil || r.At.Before(cutoff) {
			continue
		}
		kept = append(kept, l)
	}
	if len(kept) >= logMaxLines {
		kept = kept[len(kept)-logMaxLines*9/10:]
	}
	return kept
}

func readRecords(path string) ([]GrantRecord, error) {
	lines, err := readLines(path)
	if err != nil {
		return nil, err
	}
	out := make([]GrantRecord, 0, len(lines))
	for _, l := range lines {
		var r GrantRecord
		if json.Unmarshal(l, &r) == nil && r.ID != "" {
			out = append(out, r)
		}
	}
	return out, nil
}

func readLines(path string) ([][]byte, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var lines [][]byte
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		if l := bytes.TrimSpace(sc.Bytes()); len(l) > 0 {
			lines = append(lines, slices.Clone(l))
		}
	}
	return lines, sc.Err()
}

// writeLines thay nguyên file (file tạm + rename) như projects.WriteJSON, để người đọc không gặp file ghi dở.
func writeLines(path string, lines [][]byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if err := tmp.Chmod(0o600); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		_ = tmp.Close()
		return err
	}
	w := bufio.NewWriter(tmp)
	for _, l := range lines {
		_, _ = w.Write(l)
		_ = w.WriteByte('\n')
	}
	if err := w.Flush(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// crockford là bảng chữ của ULID: không có I, L, O, U nên đọc to không nhầm.
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// newGrantID: "g_" + 26 ký tự kiểu ULID (48 bit mili giây + 80 bit ngẫu nhiên), xếp theo chữ là xếp theo thời gian.
func newGrantID(t time.Time) string {
	var b [16]byte
	binary.BigEndian.PutUint64(b[:8], uint64(t.UnixMilli())<<16)
	_, _ = rand.Read(b[6:])
	hi, lo := binary.BigEndian.Uint64(b[:8]), binary.BigEndian.Uint64(b[8:])
	out := make([]byte, 26)
	// 128 bit chia thành 26 nhóm 5 bit tính từ cuối; nhóm đầu chỉ có 3 bit.
	for i := 25; i >= 0; i-- {
		out[i] = crockford[lo&31]
		lo = lo>>5 | hi<<59
		hi >>= 5
	}
	return "g_" + string(out)
}
