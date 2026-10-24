package main

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

// Xuất, nhập file .hivesecrets và nhập .env (US10, FR-067 đến FR-070). Mật khẩu chỉ đi qua stdin như giá trị.

// Test thay cách đọc remote của dự án.
var secretsOrigin = projects.Origin

const (
	maxPasswordInput = 4 << 10
	maxDotenvFile    = 1 << 20

	importNew       = "new"
	importSameName  = "same_name"
	importSameValue = "same_value"
	importInvalid   = "invalid"
	actionCreate    = "create"
	actionOverwrite = "overwrite"
	actionSkip      = "skip"
)

var (
	errPasswordInput = &secretstore.Error{
		Code:    secretstore.CodeInvalidValue,
		Message: `Stdin phải là đúng một JSON {"password":"…"}.`,
	}
	errFileExists = &secretstore.Error{
		Code:    secretstore.CodeFileExists,
		Message: "File đã có. Chọn tên khác hoặc xác nhận ghi đè.",
	}
)

type (
	exportView struct {
		Out   string   `json:"out"`
		Names []string `json:"names"`
	}
	importProject struct {
		LocalID string `json:"localId"`
		Name    string `json:"name"`
	}
	importError struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	importItem struct {
		Name        string                        `json:"name"`
		Status      string                        `json:"status"`
		Action      string                        `json:"action"`
		AllProjects bool                          `json:"allProjects"`
		Projects    []importProject               `json:"projects"`
		Unmatched   []secretstore.TransferProject `json:"unmatched"`
		Limited     []importProject               `json:"limited"`
		Error       *importError                  `json:"error,omitempty"`
		Line        int                           `json:"line,omitempty"`
	}
	importView struct {
		DryRun bool         `json:"dryRun"`
		Items  []importItem `json:"items"`
	}
)

// importCandidate là một mục sắp nhập, từ file .hivesecrets hay .env, đã khớp dự án.
type importCandidate struct {
	line                     int
	name, description, value string
	keepDescription          bool
	allProjects              bool
	targets                  []string
	unmatched                []secretstore.TransferProject
	err                      error
}

// nameList cho --name lặp lại.
type nameList []string

func (n *nameList) String() string     { return strings.Join(*n, ",") }
func (n *nameList) Set(v string) error { *n = append(*n, v); return nil }

func secretsTransferCommand(action string, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	usage := func() int {
		fmt.Fprintln(stderr, secretsUsage)
		return 2
	}
	fs := flag.NewFlagSet("secrets "+action, flag.ContinueOnError)
	// Như secretsCommand: lỗi của gói flag có thể chép lại mật khẩu gõ nhầm vào tham số.
	fs.SetOutput(io.Discard)
	configPath := fs.String("config", "", "file cấu hình worker (secrets.json nằm cạnh)")
	fs.Bool("json", true, "in dạng JSON (mặc định)")
	var names nameList
	fs.Var(&names, "name", "tên bí mật cần xuất, lặp lại được")
	out := fs.String("out", "", "file .hivesecrets sẽ ghi")
	force := fs.Bool("force", false, "ghi đè file đã có")
	in := fs.String("in", "", "file .hivesecrets cần nhập")
	envFile := fs.String("env", "", "file .env cần nhập")
	dryRun := fs.Bool("dry-run", false, "chỉ xem trước, không ghi gì")
	onConflict := fs.String("on-conflict", actionSkip, "skip|overwrite khi trùng tên")
	project := fs.String("project", "", "localId của dự án sẽ gán (--env)")
	allProjects := fs.Bool("all-projects", false, "dùng cho mọi dự án (--env)")
	if err := fs.Parse(args); err != nil || fs.NArg() > 0 {
		fmt.Fprintln(stderr, "Tham số không hợp lệ.")
		return usage()
	}
	path, err := pathOr(*configPath)
	if err != nil {
		return secretsFail(stdout, stderr, err)
	}
	cmd := secretsCmd{
		catalog:  secretstore.CatalogPath(path),
		projects: projects.DefaultPath(path),
		store:    secretsStore(),
	}
	overwrite := *onConflict == actionOverwrite
	var view any
	switch {
	case action == "export":
		if *out == "" || *in != "" || *envFile != "" || *dryRun || *project != "" || *allProjects {
			return usage()
		}
		var password string
		if password, err = readTransferPassword(stdin); err == nil {
			view, err = cmd.export(path, *out, names, *force, password)
		}
	case *onConflict != actionSkip && !overwrite, (*in == "") == (*envFile == ""), len(names) > 0, *out != "", *force,
		*project != "" && *allProjects:
		return usage()
	case *in != "":
		if *project != "" || *allProjects {
			return usage()
		}
		var password string
		if password, err = readTransferPassword(stdin); err == nil {
			view, err = cmd.importFile(path, *in, password, *dryRun, overwrite)
		}
	default:
		view, err = cmd.importEnv(path, *envFile, *dryRun, overwrite, *project, *allProjects)
	}
	if err != nil {
		return secretsFail(stdout, stderr, err)
	}
	_ = json.NewEncoder(stdout).Encode(view)
	return 0
}

// readTransferPassword đọc {"password":"…"} từ stdin, như readSecretValue: lỗi không kèm nội dung đã đọc.
func readTransferPassword(stdin io.Reader) (string, error) {
	if stdin == nil {
		return "", errPasswordInput
	}
	b, err := io.ReadAll(io.LimitReader(stdin, maxPasswordInput+1))
	defer clear(b)
	if err != nil || len(b) > maxPasswordInput {
		return "", errPasswordInput
	}
	var in struct {
		Password *string `json:"password"`
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if dec.Decode(&in) != nil || in.Password == nil || dec.More() {
		return "", errPasswordInput
	}
	return *in.Password, nil
}

// export đọc mọi giá trị trước khi ghi: thiếu một giá trị thì không có file thiếu mục.
func (c secretsCmd) export(config, out string, raw []string, force bool, password string) (exportView, error) {
	if err := secretstore.ValidPassword(password); err != nil {
		return exportView{}, err
	}
	out, err := filepath.Abs(out)
	if err != nil {
		return exportView{}, err
	}
	if _, err := os.Lstat(out); err == nil && !force {
		return exportView{}, errFileExists
	}
	cat, err := secretstore.LoadCatalog(c.catalog)
	if err != nil {
		return exportView{}, err
	}
	local, err := projects.Load(c.projects)
	if err != nil {
		return exportView{}, err
	}
	selected := cat.Secrets
	if len(raw) > 0 {
		selected = nil
		for _, r := range raw {
			name, err := lookupName(r)
			if err != nil {
				return exportView{}, err
			}
			s, err := cat.Get(name)
			if err != nil {
				return exportView{}, err
			}
			if !slices.ContainsFunc(selected, func(x secretstore.Secret) bool { return x.Name == name }) {
				selected = append(selected, *s)
			}
		}
	}
	if len(selected) == 0 {
		return exportView{}, &secretstore.Error{Code: secretstore.CodeNotFound, Message: "Chưa có bí mật nào để xuất."}
	}
	origins := originCache{}
	items := make([]secretstore.TransferSecret, 0, len(selected))
	view := exportView{Out: out, Names: make([]string, 0, len(selected))}
	for _, s := range selected {
		value, err := c.store.Get(s.Name)
		if err != nil {
			return exportView{}, err
		}
		item := secretstore.TransferSecret{Name: s.Name, Description: s.Description, Value: value, AllProjects: s.AllProjects}
		for _, id := range s.Projects {
			if p := projects.FindLocal(local, id); p != nil && !s.AllProjects {
				item.Projects = append(item.Projects, secretstore.TransferProject{Name: p.Name, RemoteURL: origins.get(p.Folder)})
			}
		}
		items = append(items, item)
		view.Names = append(view.Names, s.Name)
	}
	data, err := secretstore.Seal(items, password, secretsNow())
	if err != nil {
		return exportView{}, err
	}
	if err := writeExport(out, data, force); err != nil {
		return exportView{}, err
	}
	_, err = secretstore.Append(secretstore.GrantsPath(config), secretstore.GrantRecord{
		Kind: secretstore.KindExport, Names: view.Names, Policy: secretstore.PolicyAllow, Outcome: secretstore.OutcomeGranted,
	})
	return view, err
}

// writeExport ghi qua file tạm cùng thư mục rồi đổi tên, như projects.WriteJSON: không bao giờ để lại file ghi dở. File
// tạm của os.CreateTemp đã là 0600.
func writeExport(out string, data []byte, force bool) error {
	tmp, err := os.CreateTemp(filepath.Dir(out), "."+filepath.Base(out)+"-*")
	if err != nil {
		return fmt.Errorf("không ghi được file xuất: %w", err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if err := tmp.Chmod(0o600); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("không ghi được file xuất: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	// Kiểm lại ngay trước khi đổi tên: os.Rename thay luôn file đích có sẵn.
	if _, err := os.Lstat(out); err == nil && !force {
		return errFileExists
	}
	return os.Rename(tmp.Name(), out)
}

func (c secretsCmd) importFile(config, in, password string, dryRun, overwrite bool) (importView, error) {
	data, err := readBounded(in, secretstore.MaxTransferFile)
	defer clear(data)
	if err != nil {
		return importView{}, err
	}
	secrets, err := secretstore.Open(data, password)
	if err != nil {
		return importView{}, err
	}
	local, err := projects.Load(c.projects)
	if err != nil {
		return importView{}, err
	}
	origins := originCache{}
	seen := map[string]bool{}
	cands := make([]importCandidate, 0, len(secrets))
	for _, s := range secrets {
		cd := importCandidate{name: secretstore.NormalizeName(s.Name), description: s.Description, value: s.Value, allProjects: s.AllProjects}
		cd.err = validImport(cd.name, s.Value, s.Description)
		if cd.err == nil && seen[cd.name] {
			cd.err = &secretstore.Error{Code: secretstore.CodeDuplicateName, Message: fmt.Sprintf("`%s` lặp lại trong file, chỉ nhập lần đầu.", cd.name)}
		}
		seen[cd.name] = true
		if !s.AllProjects {
			cd.targets, cd.unmatched = matchProjects(s.Projects, local, origins)
		}
		cands = append(cands, cd)
	}
	return c.applyImport(config, cands, local, dryRun, overwrite)
}

// importEnv nhập .env (FR-069). Mô tả của bí mật đã có giữ nguyên khi ghi đè: .env không có mô tả.
func (c secretsCmd) importEnv(config, file string, dryRun, overwrite bool, project string, all bool) (importView, error) {
	local, err := projects.Load(c.projects)
	if err != nil {
		return importView{}, err
	}
	if project != "" && projects.FindLocal(local, project) == nil {
		return importView{}, &secretstore.Error{Code: secretstore.CodeNotFound, Message: "Không tìm thấy dự án trên máy."}
	}
	data, err := readBounded(file, maxDotenvFile)
	defer clear(data)
	if err != nil {
		return importView{}, err
	}
	entries, problems := secretstore.ParseDotenv(data)
	cands := make([]importCandidate, 0, len(entries)+len(problems))
	for _, e := range entries {
		cd := importCandidate{line: e.Line, name: e.Name, value: e.Value, keepDescription: true, allProjects: all}
		if project != "" {
			cd.targets = []string{project}
		}
		if err := secretstore.ValidValue(e.Value); err != nil {
			cd.err = err
		}
		cands = append(cands, cd)
	}
	for _, p := range problems {
		cands = append(cands, importCandidate{line: p.Line, name: p.Name, err: p.Err})
	}
	slices.SortStableFunc(cands, func(a, b importCandidate) int { return a.line - b.line })
	return c.applyImport(config, cands, local, dryRun, overwrite)
}

// applyImport chạy cùng một logic cho xem trước và nhập thật; xem trước làm trên bản danh mục chỉ nằm trong bộ nhớ và
// không ghi kho, nên kết quả xem trước là đúng kết quả sẽ nhập nếu danh mục không đổi giữa hai lần.
func (c secretsCmd) applyImport(config string, cands []importCandidate, local []projects.Project, dryRun, overwrite bool) (importView, error) {
	view := importView{DryRun: dryRun, Items: make([]importItem, 0, len(cands))}
	apply := func(cat *secretstore.Catalog) error {
		view.Items = view.Items[:0]
		for _, cd := range cands {
			view.Items = append(view.Items, c.importOne(cat, cd, local, dryRun, overwrite))
		}
		return nil
	}
	if dryRun {
		cat, err := secretstore.LoadCatalog(c.catalog)
		if err != nil {
			return importView{}, err
		}
		_ = apply(&cat)
		return view, nil
	}
	if err := secretstore.ModifyCatalog(c.catalog, apply); err != nil {
		return importView{}, err
	}
	names := []string{}
	for _, it := range view.Items {
		if it.Action != actionSkip {
			names = append(names, it.Name)
		}
	}
	_, err := secretstore.Append(secretstore.GrantsPath(config), secretstore.GrantRecord{
		Kind: secretstore.KindImport, Names: names, Policy: secretstore.PolicyAllow, Outcome: secretstore.OutcomeGranted,
	})
	return view, err
}

// importOne nhập một mục. Lỗi của mục (kho, giới hạn) nằm trong item, không dừng các mục sau (FR-068).
func (c secretsCmd) importOne(cat *secretstore.Catalog, cd importCandidate, local []projects.Project, dryRun, overwrite bool) importItem {
	it := importItem{
		Name: cd.name, Line: cd.line, Action: actionSkip,
		Projects: []importProject{}, Unmatched: cd.unmatched, Limited: []importProject{},
	}
	if it.Unmatched == nil {
		it.Unmatched = []secretstore.TransferProject{}
	}
	if cd.err != nil {
		it.Status, it.Error = importInvalid, importErrorOf(cd.err)
		return it
	}
	existing := cat.Find(cd.name) != nil
	switch {
	case !existing:
		it.Status, it.Action = importNew, actionCreate
	case c.sameValue(cd.name, cd.value):
		it.Status = importSameValue
	default:
		it.Status = importSameName
	}
	if existing && overwrite {
		it.Action = actionOverwrite
	}
	if it.Action == actionSkip {
		return it
	}
	now := secretsNow()
	if it.Status != importSameValue && !dryRun {
		// Ghi kho trước danh mục, như secrets set: danh mục không bao giờ có tên mà kho chưa có.
		if err := c.store.Set(cd.name, cd.value); err != nil {
			it.Action, it.Error = actionSkip, importErrorOf(err)
			return it
		}
	}
	var err error
	switch {
	case !existing:
		_, err = cat.Add(cd.name, cd.description, now)
	case it.Status != importSameValue:
		_, err = cat.ValueChanged(cd.name, now)
	}
	if err == nil && existing && !cd.keepDescription {
		_, err = cat.Describe(cd.name, cd.description)
	}
	if err != nil {
		it.Action, it.Error = actionSkip, importErrorOf(err)
		return it
	}
	if cd.allProjects {
		if _, err := cat.SetAllProjects(cd.name, true); err != nil {
			it.Error = importErrorOf(err)
		}
	}
	it.AllProjects = cat.Find(cd.name).AllProjects
	if it.AllProjects {
		return it
	}
	for _, id := range cd.targets {
		ip := importProject{LocalID: id}
		if p := projects.FindLocal(local, id); p != nil {
			ip.Name = p.Name
		}
		if slices.Contains(cat.Find(cd.name).Projects, id) {
			continue
		}
		// Giới hạn 64 tính từng gán: gán vượt bị bỏ và liệt kê, bí mật vẫn được nhập.
		if _, err := cat.Assign(cd.name, id); err != nil {
			it.Limited = append(it.Limited, ip)
			continue
		}
		it.Projects = append(it.Projects, ip)
	}
	return it
}

// sameValue so giá trị trong kho với giá trị nhập trong thời gian không đổi; kho lỗi hay thiếu thì coi là khác.
func (c secretsCmd) sameValue(name, value string) bool {
	cur, err := c.store.Get(name)
	if err != nil {
		return false
	}
	a, b := []byte(cur), []byte(value)
	defer clear(a)
	defer clear(b)
	return subtle.ConstantTimeCompare(a, b) == 1
}

// validImport kiểm như khi lưu tay (FR-003 đến FR-005, FR-021).
func validImport(name, value, description string) error {
	if err := secretstore.ValidName(name); err != nil {
		return err
	}
	if err := secretstore.ValidValue(value); err != nil {
		return err
	}
	return secretstore.ValidDescription(description)
}

// matchProjects khớp dự án trong file với dự án trên máy: remote trước, không có thì theo tên (data-model §9).
func matchProjects(want []secretstore.TransferProject, local []projects.Project, origins originCache) ([]string, []secretstore.TransferProject) {
	var ids []string
	unmatched := []secretstore.TransferProject{}
	for _, w := range want {
		var hit []string
		if w.RemoteURL != "" {
			for _, p := range local {
				if p.LocalID != "" && projects.SameRepo(origins.get(p.Folder), w.RemoteURL) {
					hit = append(hit, p.LocalID)
				}
			}
		}
		if len(hit) == 0 {
			for _, p := range local {
				if p.LocalID != "" && strings.EqualFold(p.Name, w.Name) {
					hit = append(hit, p.LocalID)
				}
			}
		}
		if len(hit) == 0 {
			unmatched = append(unmatched, w)
		}
		for _, id := range hit {
			if !slices.Contains(ids, id) {
				ids = append(ids, id)
			}
		}
	}
	return ids, unmatched
}

// originCache gọi git một lần cho mỗi thư mục. Remote đã bỏ tên đăng nhập và mật khẩu, vì nó được ghi vào file xuất.
type originCache map[string]string

func (o originCache) get(folder string) string {
	if u, ok := o[folder]; ok {
		return u
	}
	u, err := secretsOrigin(folder)
	if err != nil {
		u = ""
	} else {
		u = projects.Redact(u)
	}
	o[folder] = u
	return u
}

func readBounded(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("không đọc được file: %w", err)
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return b, fmt.Errorf("không đọc được file: %w", err)
	}
	if int64(len(b)) > limit {
		return b, &secretstore.Error{Code: secretstore.CodeFileFormat, Message: "File quá lớn để nhập."}
	}
	return b, nil
}

func importErrorOf(err error) *importError {
	var e *secretstore.Error
	if errors.As(err, &e) {
		return &importError{Code: e.Code, Message: e.Message}
	}
	return &importError{Code: codeInternal, Message: err.Error()}
}
