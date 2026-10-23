package runner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/tdduydev/xdev-hive/worker/internal/secretmask"
	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

func (r Runner) grantSecrets(ctx context.Context, job Job) (secretstore.Granted, error) {
	if r.WorkerConfig == "" || r.Sandbox != nil || job.Execution == "sandbox" || job.SandboxPolicy != nil {
		return secretstore.Granted{}, nil
	}
	return secretstore.Grant(ctx, secretstore.GrantRequest{
		WorkerConfig: r.WorkerConfig, LocalID: job.LocalID, Kind: "run",
		SessionID: fmt.Sprintf("%s#%d", job.RunID, job.Attempt), Policy: job.Policy.SecretInjection,
		Approve: func(ctx context.Context, req secretstore.ApprovalRequest) (bool, error) {
			return secretstore.AwaitApproval(ctx, r.WorkerConfig, req)
		},
	})
}

func secretContext(g secretstore.Granted) string {
	policy := secretstore.PolicyAllow
	if len(g.Items) > 0 && g.Outcome != secretstore.OutcomeGranted {
		policy = secretstore.PolicyDeny
	}
	return secretstore.ContextBlock(policy, g.Items)
}

type secretStream struct {
	writer *secretmask.Writer
	offset int64
}

// secretSink nằm trước transport, nên cả hàng đợi bền trên đĩa cũng chỉ nhận bản đã che.
type secretSink struct {
	mu      sync.Mutex
	next    Sink
	masker  *secretmask.Masker
	config  string
	grant   secretstore.Granted
	marked  map[int]bool
	streams map[string]*secretStream
}

func newSecretSink(next Sink, masker *secretmask.Masker, config string, grant secretstore.Granted) *secretSink {
	return &secretSink{next: next, masker: masker, config: config, grant: grant, marked: map[int]bool{}, streams: map[string]*secretStream{}}
}

func (s *secretSink) mark(indices []int) {
	var names []string
	for _, i := range indices {
		if i < 0 || i >= len(s.grant.Names) || s.marked[i] {
			continue
		}
		s.marked[i] = true
		name := s.grant.Names[i]
		names = append(names, name)
		fmt.Fprintf(os.Stderr, "hive-worker: đã che bí mật: %s\n", name)
	}
	if s.grant.ID != "" && len(names) > 0 {
		_ = secretstore.MarkLeaked(secretstore.GrantsPath(s.config), s.grant.ID, names)
	}
}

func (s *secretSink) text(text string) string {
	out, hits := s.masker.String(text)
	s.mark(hits)
	return out
}

// Duyệt mọi trường để trường báo cáo mới cũng mặc nhiên được che, kể cả chuỗi lồng trong mảng.
func (s *secretSink) clean(v reflect.Value) reflect.Value {
	switch v.Kind() {
	case reflect.String:
		x := reflect.New(v.Type()).Elem()
		x.SetString(s.text(v.String()))
		return x
	case reflect.Pointer:
		if v.IsNil() {
			return v
		}
		x := reflect.New(v.Type().Elem())
		x.Elem().Set(s.clean(v.Elem()))
		return x
	case reflect.Struct:
		x := reflect.New(v.Type()).Elem()
		x.Set(v)
		for i := 0; i < v.NumField(); i++ {
			if x.Field(i).CanSet() && v.Type().Field(i).IsExported() {
				x.Field(i).Set(s.clean(v.Field(i)))
			}
		}
		return x
	case reflect.Slice:
		if v.IsNil() {
			return v
		}
		if v.Type().Elem().Kind() == reflect.Uint8 {
			return reflect.ValueOf([]byte(s.text(string(v.Bytes()))))
		}
		x := reflect.MakeSlice(v.Type(), v.Len(), v.Len())
		for i := 0; i < v.Len(); i++ {
			x.Index(i).Set(s.clean(v.Index(i)))
		}
		return x
	}
	return v
}

func (s *secretSink) Emit(e Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e.Type == "log" {
		stream := s.streams[e.Stream]
		if stream == nil {
			stream = &secretStream{}
			template := e
			template.Data = nil
			stream.writer = s.masker.Writer(writerFunc(func(p []byte) (int, error) {
				x := template
				x.Offset = stream.offset
				x.Data = append([]byte(nil), p...)
				err := s.next.Emit(x)
				if err == nil {
					stream.offset += int64(len(p))
				}
				return len(p), err
			}))
			s.streams[e.Stream] = stream
		}
		_, err := stream.writer.Write(e.Data)
		s.mark(stream.writer.Found())
		return err
	}
	if e.Type == "result" {
		for _, stream := range s.streams {
			if err := stream.writer.Flush(); err != nil {
				return err
			}
			s.mark(stream.writer.Found())
		}
	}
	// Nhị phân không thể thay byte mà vẫn giữ định dạng; giữ artifact tại máy thay vì gửi bản hỏng.
	if e.Result != nil {
		copyResult := *e.Result
		copyResult.Artifacts = nil
		for _, a := range e.Result.Artifacts {
			_, hits := s.masker.String(a.Content)
			if len(hits) > 0 && (!utf8.ValidString(a.Content) || strings.ContainsRune(a.Content, 0)) {
				s.mark(hits)
				if err := s.next.Emit(Event{Type: "log", RunID: e.RunID, Attempt: e.Attempt, Stream: "stderr", Data: []byte("[xdev-hive] Đã giữ lại artifact nhị phân chứa bí mật.\n")}); err != nil {
					return err
				}
				continue
			}
			a.Content = s.text(a.Content)
			hash := sha256.Sum256([]byte(a.Content))
			a.SHA256 = hex.EncodeToString(hash[:])
			copyResult.Artifacts = append(copyResult.Artifacts, a)
		}
		e.Result = &copyResult
	}
	return s.next.Emit(s.clean(reflect.ValueOf(e)).Interface().(Event))
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

var _ io.Writer = writerFunc(nil)

func (s *secretSink) safeError(err error) error {
	if err == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	safe, hits := s.masker.String(err.Error())
	s.mark(hits)
	if len(hits) > 0 {
		return errors.New(safe)
	}
	return err
}

// Quét cả object gốc vì git biểu diễn diff nhị phân bằng base85, không còn chuỗi để bộ che nhận ra.
func scanDiffForSecrets(ctx context.Context, work, base string, masker *secretmask.Masker) ([]int, error) {
	if masker.Empty() {
		return nil, nil
	}
	var hits []int
	scan := func(args ...string) error {
		w := masker.Writer(io.Discard)
		cmd := exec.CommandContext(ctx, "git", args...)
		cmd.Dir = work
		cmd.Stdout = w
		cmd.Stderr = io.Discard
		if err := cmd.Run(); err != nil {
			return errors.New("Không kiểm được bí mật trong thay đổi Git; đã chặn commit/đẩy.")
		}
		if err := w.Flush(); err != nil {
			return err
		}
		hits = append(hits, w.Found()...)
		return nil
	}
	if err := scan("diff", "--cached", "--no-ext-diff", "--no-textconv", "-z"); err != nil {
		return nil, err
	}
	if err := scan("log", "--no-ext-diff", "--no-textconv", "-p", base+"..HEAD", "--"); err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	output := func(args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, "git", args...)
		cmd.Dir = work
		b, err := cmd.Output()
		if err != nil {
			return "", errors.New("Không đọc được object Git; đã chặn commit/đẩy.")
		}
		return string(b), nil
	}
	raw, err := output("diff", "--cached", "--raw", "--no-abbrev", "--no-renames", "-z")
	if err != nil {
		return nil, err
	}
	parts := strings.Split(raw, "\x00")
	for i := 0; i+1 < len(parts); i += 2 {
		fields := strings.Fields(parts[i])
		if len(fields) == 5 && strings.Trim(fields[3], "0") != "" {
			ids[fields[3]] = true
		}
	}
	objects, err := output("rev-list", "--objects", "--no-object-names", base+"..HEAD", "--")
	if err != nil {
		return nil, err
	}
	for _, id := range strings.Fields(objects) {
		ids[id] = true
	}
	for id := range ids {
		if err := scan("cat-file", "-p", id); err != nil {
			return nil, err
		}
	}
	slices.Sort(hits)
	return slices.Compact(hits), nil
}

func blockSecretChanges(ctx context.Context, work, base string, secure *secretSink) error {
	if secure == nil {
		return nil
	}
	hits, err := scanDiffForSecrets(ctx, work, base, secure.masker)
	if err != nil {
		return err
	}
	if len(hits) == 0 {
		return nil
	}
	secure.mu.Lock()
	defer secure.mu.Unlock()
	secure.mark(hits)
	var names []string
	for _, i := range hits {
		names = append(names, secure.grant.Names[i])
	}
	return fmt.Errorf("Thay đổi chứa giá trị của bí mật %s; đã chặn commit/đẩy.", strings.Join(names, ", "))
}

func mergeSecretEnv(base, granted map[string]string) map[string]string {
	out := mergeMap(base, nil)
	for name, value := range granted {
		if secretstore.ValidName(name) == nil {
			out[name] = value
		}
	}
	return out
}

func (r Runner) attachSecretContext(job *Job, block string) (func(), error) {
	noop := func() {}
	if block == "" {
		return noop, nil
	}
	if !r.packInSystemPrompt(*job) {
		job.Prompt = block + "\n---\n\n" + job.Prompt
		return noop, nil
	}
	if job.guard == nil {
		g, err := r.prepareGuard(*job, block, 0, 0, false)
		if err != nil {
			return noop, err
		}
		job.guard = g
		return g.cleanup, nil
	}
	if job.guard.packFile == "" {
		job.guard.packFile = filepath.Join(job.guard.dir, "context-pack.md")
	}
	f, err := os.OpenFile(job.guard.packFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return noop, err
	}
	_, err = f.WriteString("\n\n" + block)
	return noop, errors.Join(err, f.Close())
}
