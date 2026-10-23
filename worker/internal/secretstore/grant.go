package secretstore

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

const (
	PolicyAllow   = "allow"
	PolicyApprove = "approve"
	PolicyDeny    = "deny"
)

// Đọc kho: tối đa 4 mục cùng lúc, mỗi mục 5 giây (plan §2). Keychain khoá có thể treo chờ hộp thoại; hết giờ coi như
// kho khoá (research D4) để run dừng thay vì chờ mãi.
const (
	readParallel = 4
	readTimeout  = 5 * time.Second
)

// windowsEnvBudget: khối env của Windows tối đa 32 KiB, chừa 8 KiB cho env của máy (data-model §2).
const windowsEnvBudget = 24 << 10

// envBudget là giới hạn tổng name=value của bí mật cấp cho một phiên; 0 là không giới hạn. Test thay để kiểm nhánh
// Windows trên mọi hệ điều hành.
var envBudget = func() int {
	if runtime.GOOS == "windows" {
		return windowsEnvBudget
	}
	return 0
}

// GrantRequest là yêu cầu cấp bí mật cho một phiên (run, terminal).
type GrantRequest struct {
	// WorkerConfig là file cấu hình worker; danh mục, nhật ký và projects.json nằm cạnh nó.
	WorkerConfig string
	Kind         string
	SessionID    string
	// LocalID rỗng (job sandbox, runner-host, thư mục không thuộc dự án nào) thì không cấp gì (FR-018).
	LocalID string
	// Run dùng snapshot; terminal đọc chính sách tổ chức đã nhớ khi Policy rỗng.
	Policy  string
	HubURL  string
	Approve func(context.Context, ApprovalRequest) (bool, error)
	// Store nil là kho của hệ điều hành.
	Store *Store
}

// Granted là kết quả cấp. Values cùng thứ tự với Names, để đưa vào secretmask.New và đổi chỉ số bị che thành tên.
type Granted struct {
	Policy  string
	Outcome string
	Items   []Secret
	ID      string
	Env     map[string]string
	Names   []string
	Values  []string
}

// Grant đọc mọi bí mật gán cho dự án trong một lần và ghi một dòng nhật ký. Dự án không có gán thì trả rỗng, không ghi
// nhật ký. Kho lỗi trả *Error chỉ có tên (FR-060); bên gọi dừng trước khi tạo tiến trình agent.
func Grant(ctx context.Context, req GrantRequest) (Granted, error) {
	if req.LocalID == "" {
		return Granted{}, nil
	}
	cat, err := LoadCatalog(CatalogPath(req.WorkerConfig))
	if err != nil {
		return Granted{}, fmt.Errorf("không đọc được danh mục bí mật: %w", err)
	}
	var names []string
	for _, s := range cat.ForProject(req.LocalID) {
		// Danh mục sửa tay có thể có tên dành riêng; cấp nó sẽ đè PATH, HOME… của agent (research D4).
		if ValidName(s.Name) == nil {
			names = append(names, s.Name)
		}
	}
	if len(names) == 0 {
		return Granted{}, nil
	}
	policy := req.Policy
	if policy == "" {
		policy = PolicyAllow
		if req.Kind == KindTerminal {
			policy = TerminalPolicy(req.WorkerConfig, req.LocalID, req.HubURL)
		}
	}
	if !validPolicy(policy) {
		policy = PolicyDeny
	}
	store := req.Store
	if store == nil {
		store = NewSystemStore()
	}
	record := GrantRecord{
		Kind:        req.Kind,
		SessionID:   req.SessionID,
		Project:     req.LocalID,
		ProjectName: projectName(req.WorkerConfig, req.LocalID),
		Names:       names,
		Policy:      policy,
	}
	var items []Secret
	for _, name := range names {
		if item := cat.Find(name); item != nil {
			items = append(items, *item)
		}
	}
	withheld := func(outcome string) (Granted, error) {
		record.Outcome = outcome
		id, _ := Append(GrantsPath(req.WorkerConfig), record)
		return Granted{ID: id, Items: items, Policy: policy, Outcome: outcome}, nil
	}
	if policy == PolicyDeny {
		return withheld(OutcomeDenied)
	}
	if policy == PolicyApprove {
		if req.Approve == nil {
			return withheld(OutcomeDeclined)
		}
		approvalCtx, cancel := context.WithTimeout(ctx, ApprovalTTL)
		defer cancel()
		allow, err := req.Approve(approvalCtx, ApprovalRequest{RunID: strings.SplitN(req.SessionID, "#", 2)[0], Project: req.LocalID, ProjectName: record.ProjectName, Names: slices.Clone(names), ExpiresAt: time.Now().Add(ApprovalTTL)})
		if err != nil || approvalCtx.Err() != nil {
			return withheld(OutcomeTimeout)
		}
		if !allow {
			return withheld(OutcomeDeclined)
		}
	}
	readCtx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()
	values, err := readAll(readCtx, store, names)
	if err == nil {
		err = checkEnvSize(names, values)
	}
	if err != nil {
		record.Outcome = OutcomeStoreError
		_, _ = Append(GrantsPath(req.WorkerConfig), record)
		return Granted{}, err
	}
	record.Outcome = OutcomeGranted
	// Không ghi được nhật ký thì vẫn cấp: đầy đĩa không nên chặn mọi run có bí mật. ID rỗng làm MarkLeaked bỏ qua.
	id, logErr := Append(GrantsPath(req.WorkerConfig), record)
	if logErr != nil {
		id = ""
	}
	env := make(map[string]string, len(names))
	for i, n := range names {
		env[n] = values[i]
	}
	return Granted{ID: id, Env: env, Names: names, Values: values, Items: items, Policy: policy, Outcome: OutcomeGranted}, nil
}

func projectName(workerConfig, localID string) string {
	list, err := projects.Load(projects.DefaultPath(workerConfig))
	if err != nil {
		return ""
	}
	if p := projects.FindLocal(list, localID); p != nil {
		return p.Name
	}
	return ""
}

// readAll đọc mọi tên; lỗi gộp theo loại để thông báo liệt kê đủ tên cần sửa một lần.
func readAll(ctx context.Context, store *Store, names []string) ([]string, error) {
	values := make([]string, len(names))
	errs := make([]error, len(names))
	start := 0
	// Keychain có thể hỏi mở khoá. Chỉ đọc một mục trước; thất bại thì không bật thêm hộp thoại cho từng biến.
	if runtime.GOOS == "darwin" && len(names) > 0 {
		values[0], errs[0] = readOne(ctx, store, names[0])
		if errors.Is(errs[0], ErrLocked) || errors.Is(errs[0], ErrUnavailable) {
			return nil, mergeErrors(names[:1], errs[:1])
		}
		start = 1
	}
	sem := make(chan struct{}, readParallel)
	var wg sync.WaitGroup
	for i := start; i < len(names); i++ {
		name := names[i]
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			values[i], errs[i] = readOne(ctx, store, name)
		}()
	}
	wg.Wait()
	return values, mergeErrors(names, errs)
}

// readOne bỏ lại goroutine đọc khi hết giờ: go-keyring không nhận context. Giá trị nó đọc được sau đó bị bỏ.
func readOne(ctx context.Context, store *Store, name string) (string, error) {
	if ctx.Err() != nil {
		return "", locked(name)
	}
	type result struct {
		v   string
		err error
	}
	ch := make(chan result, 1)
	go func() {
		v, err := store.Get(name)
		ch <- result{v, err}
	}()
	timer := time.NewTimer(readTimeout)
	defer timer.Stop()
	select {
	case r := <-ch:
		return r.v, r.err
	case <-timer.C:
		return "", locked(name)
	case <-ctx.Done():
		return "", locked(name)
	}
}

// mergeErrors: kho không có hay khoá là lỗi của cả kho, báo trước; sau đó mới đến lỗi từng mục (thiếu, hỏng). Mỗi loại
// một thông báo kèm mọi tên của loại đó, để người dùng sửa một lần.
func mergeErrors(names []string, errs []error) error {
	byCode := map[string][]string{}
	for i, err := range errs {
		if err == nil {
			continue
		}
		code := CodeStoreUnavailable
		var e *Error
		if errors.As(err, &e) && slices.Contains(storeCodes, e.Code) {
			code = e.Code
		}
		byCode[code] = append(byCode[code], names[i])
	}
	for _, code := range storeCodes {
		if failed := byCode[code]; len(failed) > 0 {
			return storeErrors[code](failed...)
		}
	}
	return nil
}

// storeCodes theo thứ tự ưu tiên của mergeErrors.
var storeCodes = []string{CodeStoreUnavailable, CodeStoreLocked, CodeStoreMissing, CodeStoreCorrupt}

var storeErrors = map[string]func(...string) *Error{
	CodeStoreUnavailable: unavailable,
	CodeStoreLocked:      locked,
	CodeStoreMissing:     missing,
	CodeStoreCorrupt:     corrupt,
}

func checkEnvSize(names, values []string) error {
	budget := envBudget()
	if budget == 0 {
		return nil
	}
	total := 0
	for i := range names {
		total += len(names[i]) + len(values[i]) + 2
	}
	if total <= budget {
		return nil
	}
	// Liệt kê tên từ giá trị lớn nhất, để người dùng biết bỏ gán cái nào trước.
	order := slices.Clone(names)
	size := map[string]int{}
	for i, n := range names {
		size[n] = len(values[i])
	}
	slices.SortStableFunc(order, func(a, b string) int { return size[b] - size[a] })
	return &Error{
		Code:    CodeEnvTooLarge,
		Message: fmt.Sprintf("Bí mật gán cho dự án quá lớn để đưa vào môi trường Windows: %s.", strings.Join(order, ", ")),
		Names:   order,
	}
}
