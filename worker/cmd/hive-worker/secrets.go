package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

const secretsUsage = `Cách dùng: hive-worker secrets <lệnh> [--config FILE] [--json]
  status                                    kho bí mật của máy dùng được không
  list      [--project LOCAL_ID]            danh mục bí mật và tên dành riêng
  set       --name TÊN [--description-file FILE]
                                            giá trị là JSON {"value":"…"} trên stdin, bắt buộc khi tạo
  rename    --name TÊN --to TÊN_MỚI
  describe  --name TÊN --description-file FILE
  assign    --name TÊN --project LOCAL_ID
  unassign  --name TÊN --project LOCAL_ID
  delete    --name TÊN
  log       [--name TÊN] [--project LOCAL_ID] [--limit 200]
  log clear                                 xoá nhật ký cấp tại máy
  approvals                                 yêu cầu đang chờ duyệt
  approve   --id MÃ --allow|--deny
  reveal    --name TÊN [--copy]
  purge     --project LOCAL_ID|--all
Giá trị chỉ đọc từ stdin, không bao giờ từ tham số hay biến môi trường.`

// Kiểu ra của lệnh, khớp contracts/sidecar-cli.md và fixture testdata/cli của secretstore.
type (
	secretProject struct {
		LocalID string `json:"localId"`
		Name    string `json:"name"`
		Folder  string `json:"folder"`
	}
	secretItem struct {
		Name           string          `json:"name"`
		Description    string          `json:"description"`
		CreatedAt      time.Time       `json:"createdAt"`
		ValueChangedAt time.Time       `json:"valueChangedAt"`
		Projects       []secretProject `json:"projects"`
		// InUseBy luôn 0 tới khi worker theo dõi phiên dùng bí mật (FR-016).
		InUseBy int `json:"inUseBy"`
	}
	reservedNames struct {
		Exact    []string `json:"exact"`
		Prefixes []string `json:"prefixes"`
	}
	secretsListView struct {
		Secrets  []secretItem  `json:"secrets"`
		Reserved reservedNames `json:"reserved"`
	}
	secretDeleteView struct {
		Deleted string `json:"deleted"`
		InUse   bool   `json:"inUse"`
	}
)

// Test thay kho và đồng hồ.
var (
	secretsStore = secretstore.NewSystemStore
	secretsNow   = time.Now
)

// codeInternal: lỗi không phải của kho hay danh mục (đọc file, cấu hình). Không có trong bảng của contract; desktop
// hiện message.
const codeInternal = "internal"

// maxSecretInput: 8 KiB giá trị toàn ký tự phải thoát \u00XX trong JSON thành gấp 6, cộng phần khung.
const maxSecretInput = secretstore.MaxValueLen*6 + 64

// maxDescriptionFile đủ cho 500 ký tự 4 byte; file lớn hơn chắc chắn sai, khỏi đọc hết.
const maxDescriptionFile = secretstore.MaxDescriptionLen*4 + 64

var errSecretInput = &secretstore.Error{
	Code:    secretstore.CodeInvalidValue,
	Message: `Stdin phải là đúng một JSON {"value":"…"}.`,
}

// secretsCommand: quản lý bí mật tại máy cho agent (specs/031). In một JSON ra stdout; lỗi in {"error":…} và thoát 1.
func secretsCommand(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) > 0 && args[0] == "exec" {
		return runSecretsExec(args[1:], stdin, stdout, stderr)
	}
	action := ""
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		action, args = args[0], args[1:]
	}
	clearLog := action == "log" && len(args) > 0 && args[0] == "clear"
	if clearLog {
		args = args[1:]
	}
	usage := func() int {
		fmt.Fprintln(stderr, secretsUsage)
		return 2
	}
	fs := flag.NewFlagSet("secrets "+action, flag.ContinueOnError)
	// Lỗi của gói flag có thể chép lại giá trị của tham số (--json=<chuỗi>): người dùng gõ nhầm giá trị bí mật vào tham số
	// thì nó không được hiện lại ở đâu cả.
	fs.SetOutput(io.Discard)
	configPath := fs.String("config", "", "file cấu hình worker (secrets.json nằm cạnh)")
	fs.Bool("json", true, "in dạng JSON (mặc định)")
	name := fs.String("name", "", "tên bí mật")
	to := fs.String("to", "", "tên mới")
	project := fs.String("project", "", "localId của dự án trên máy")
	descFile := fs.String("description-file", "", "file chứa mô tả")
	limit := fs.Int("limit", secretstore.DefaultLogLimit, "số dòng nhật ký")
	approvalID := fs.String("id", "", "mã yêu cầu duyệt")
	allow := fs.Bool("allow", false, "cho phép")
	deny := fs.Bool("deny", false, "từ chối")
	copyValue := fs.Bool("copy", false, "ghi thao tác sao chép")
	all := fs.Bool("all", false, "xoá mọi bí mật")
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
	var view any
	switch action {
	case "reveal":
		if *name == "" {
			return usage()
		}
		view, err = cmd.reveal(path, *name, *copyValue)
	case "purge":
		if *all == (*project != "") {
			return usage()
		}
		view, err = cmd.purge(*project, *all)
	case "approvals":
		var pending []secretstore.ApprovalRequest
		pending, err = secretstore.PendingApprovals(path)
		view = struct {
			Pending []secretstore.ApprovalRequest `json:"pending"`
		}{pending}
	case "approve":
		if *approvalID == "" || *allow == *deny {
			return usage()
		}
		err = secretstore.AnswerApproval(path, *approvalID, *allow)
		view = struct {
			OK bool `json:"ok"`
		}{true}
	case "status":
		view = cmd.store.Status()
	case "list":
		view, err = cmd.list(*project)
	case "set":
		if *name == "" {
			return usage()
		}
		view, err = cmd.set(*name, *descFile, stdin)
	case "rename":
		if *name == "" || *to == "" {
			return usage()
		}
		view, err = cmd.rename(*name, *to)
	case "describe":
		if *name == "" || *descFile == "" {
			return usage()
		}
		view, err = cmd.describe(*name, *descFile)
	case "assign", "unassign":
		if *name == "" || *project == "" {
			return usage()
		}
		view, err = cmd.assign(*name, *project, action == "assign")
	case "delete":
		if *name == "" {
			return usage()
		}
		view, err = cmd.delete(*name)
	case "log":
		if clearLog {
			var n int
			n, err = secretstore.ClearLog(secretstore.GrantsPath(path))
			view = struct {
				Cleared int `json:"cleared"`
			}{n}
		} else {
			var cat secretstore.Catalog
			cat, err = secretstore.LoadCatalog(cmd.catalog)
			if err == nil {
				var entries []secretstore.LogEntry
				entries, err = secretstore.ReadLog(secretstore.GrantsPath(path), secretstore.LogFilter{Name: *name, Project: *project, Limit: *limit}, cat)
				view = struct {
					Entries []secretstore.LogEntry `json:"entries"`
				}{entries}
			}
		}
	default:
		return usage()
	}
	if err != nil {
		return secretsFail(stdout, stderr, err)
	}
	_ = json.NewEncoder(stdout).Encode(view)
	return 0
}

type secretsCmd struct {
	catalog, projects string
	store             *secretstore.Store
}

func (c secretsCmd) reveal(config, raw string, copyValue bool) (any, error) {
	name, err := lookupName(raw)
	if err != nil {
		return nil, err
	}
	cat, err := secretstore.LoadCatalog(c.catalog)
	if err != nil {
		return nil, err
	}
	if _, err = cat.Get(name); err != nil {
		return nil, err
	}
	value, err := c.store.Get(name)
	if err != nil {
		return nil, err
	}
	if _, err = secretstore.Append(secretstore.GrantsPath(config), secretstore.GrantRecord{Kind: secretstore.KindReveal, Names: []string{name}, Copy: copyValue, Policy: secretstore.PolicyAllow, Outcome: secretstore.OutcomeGranted}); err != nil {
		return nil, err
	}
	return struct {
		Value string `json:"value"`
	}{value}, nil
}

type secretPurgeView struct {
	Removed []string `json:"removed"`
	Left    []string `json:"left"`
}

func (c secretsCmd) purge(project string, all bool) (secretPurgeView, error) {
	view := secretPurgeView{Removed: []string{}, Left: []string{}}
	if !all {
		if err := secretstore.DropProject(c.catalog, project); err != nil {
			return view, err
		}
	}
	cat, err := secretstore.LoadCatalog(c.catalog)
	if err != nil {
		return view, err
	}
	for _, item := range cat.Secrets {
		if !all {
			view.Left = append(view.Left, item.Name)
			continue
		}
		if _, err := c.delete(item.Name); err != nil {
			view.Left = append(view.Left, item.Name)
		} else {
			view.Removed = append(view.Removed, item.Name)
		}
	}
	return view, nil
}

func (c secretsCmd) list(project string) (secretsListView, error) {
	cat, err := secretstore.LoadCatalog(c.catalog)
	if err != nil {
		return secretsListView{}, err
	}
	local, err := projects.Load(c.projects)
	if err != nil {
		return secretsListView{}, err
	}
	view := secretsListView{
		Secrets:  []secretItem{},
		Reserved: reservedNames{Exact: secretstore.ReservedExact, Prefixes: secretstore.ReservedPrefixes},
	}
	for _, s := range cat.Secrets {
		item := secretItemOf(s, local)
		if project != "" && !assignedTo(item, project) {
			continue
		}
		view.Secrets = append(view.Secrets, item)
	}
	return view, nil
}

func (c secretsCmd) set(rawName, descFile string, stdin io.Reader) (secretItem, error) {
	name := secretstore.NormalizeName(rawName)
	value, hasValue, err := readSecretValue(stdin)
	if err != nil {
		return secretItem{}, err
	}
	desc, hasDesc, err := readDescription(descFile)
	if err != nil {
		return secretItem{}, err
	}
	return c.modify(name, func(cat *secretstore.Catalog) error {
		if cat.Find(name) == nil {
			if !hasValue {
				return &secretstore.Error{Code: secretstore.CodeInvalidValue, Message: "Bí mật mới cần có giá trị."}
			}
			// Kiểm mọi thứ trước khi ghi kho, để lỗi tên hay mô tả không để lại giá trị không có trong danh mục.
			if err := secretstore.ValidName(name); err != nil {
				return err
			}
			if err := secretstore.ValidDescription(desc); err != nil {
				return err
			}
			if err := c.store.Set(name, value); err != nil {
				return err
			}
			_, err := cat.Add(name, desc, secretsNow())
			return err
		}
		if hasDesc {
			if _, err := cat.Describe(name, desc); err != nil {
				return err
			}
		}
		if !hasValue {
			return nil
		}
		if err := c.store.Set(name, value); err != nil {
			return err
		}
		_, err := cat.ValueChanged(name, secretsNow())
		return err
	})
}

// rename chép giá trị sang tên mới trong lúc giữ khoá danh mục, rồi mới xoá mục cũ trong kho khi danh mục đã ghi: dừng
// giữa chừng thì còn thừa một bản trong kho, không mất giá trị.
func (c secretsCmd) rename(rawFrom, rawTo string) (secretItem, error) {
	from, err := lookupName(rawFrom)
	if err != nil {
		return secretItem{}, err
	}
	to := secretstore.NormalizeName(rawTo)
	moved := false
	item, err := c.modify(to, func(cat *secretstore.Catalog) error {
		if _, err := cat.Rename(from, to); err != nil || from == to {
			return err
		}
		value, err := c.store.Get(from)
		if err != nil {
			return err
		}
		if err := c.store.Set(to, value); err != nil {
			return err
		}
		moved = true
		return nil
	})
	if err == nil && moved {
		// Xoá lỗi thì bản cũ còn trong kho nhưng không ai đọc tới; tên đã đổi xong nên không báo lỗi.
		_ = c.store.Delete(from)
	}
	return item, err
}

func (c secretsCmd) describe(rawName, descFile string) (secretItem, error) {
	name, err := lookupName(rawName)
	if err != nil {
		return secretItem{}, err
	}
	desc, _, err := readDescription(descFile)
	if err != nil {
		return secretItem{}, err
	}
	return c.modify(name, func(cat *secretstore.Catalog) error {
		_, err := cat.Describe(name, desc)
		return err
	})
}

func (c secretsCmd) assign(rawName, localID string, on bool) (secretItem, error) {
	name, err := lookupName(rawName)
	if err != nil {
		return secretItem{}, err
	}
	if on {
		// Bỏ gán thì không kiểm: dự án đã gỡ khỏi máy vẫn phải bỏ gán được.
		local, err := projects.Load(c.projects)
		if err != nil {
			return secretItem{}, err
		}
		if projects.FindLocal(local, localID) == nil {
			return secretItem{}, &secretstore.Error{Code: secretstore.CodeNotFound, Message: "Không tìm thấy dự án trên máy."}
		}
	}
	return c.modify(name, func(cat *secretstore.Catalog) error {
		if on {
			_, err := cat.Assign(name, localID)
			return err
		}
		_, err := cat.Unassign(name, localID)
		return err
	})
}

// delete xoá trong kho trước rồi mới gỡ khỏi danh mục (data-model §1).
func (c secretsCmd) delete(rawName string) (secretDeleteView, error) {
	name, err := lookupName(rawName)
	if err != nil {
		return secretDeleteView{}, err
	}
	err = secretstore.ModifyCatalog(c.catalog, func(cat *secretstore.Catalog) error {
		if _, err := cat.Get(name); err != nil {
			return err
		}
		if err := c.store.Delete(name); err != nil {
			return err
		}
		return cat.Remove(name)
	})
	if err != nil {
		return secretDeleteView{}, err
	}
	return secretDeleteView{Deleted: name}, nil
}

// modify sửa danh mục rồi trả mục name sau khi sửa, kèm tên và thư mục dự án.
func (c secretsCmd) modify(name string, change func(*secretstore.Catalog) error) (secretItem, error) {
	var s secretstore.Secret
	err := secretstore.ModifyCatalog(c.catalog, func(cat *secretstore.Catalog) error {
		if err := change(cat); err != nil {
			return err
		}
		found, err := cat.Get(name)
		if err != nil {
			return err
		}
		s = *found
		return nil
	})
	if err != nil {
		return secretItem{}, err
	}
	local, err := projects.Load(c.projects)
	if err != nil {
		return secretItem{}, err
	}
	return secretItemOf(s, local), nil
}

// secretItemOf bỏ localId không còn trong projects.json (data-model §2) thay vì hiện dự án không tên.
func secretItemOf(s secretstore.Secret, local []projects.Project) secretItem {
	item := secretItem{
		Name:           s.Name,
		Description:    s.Description,
		CreatedAt:      s.CreatedAt,
		ValueChangedAt: s.ValueChangedAt,
		Projects:       []secretProject{},
	}
	for _, id := range s.Projects {
		if p := projects.FindLocal(local, id); p != nil {
			item.Projects = append(item.Projects, secretProject{LocalID: id, Name: p.Name, Folder: p.Folder})
		}
	}
	return item
}

func assignedTo(item secretItem, localID string) bool {
	for _, p := range item.Projects {
		if p.LocalID == localID {
			return true
		}
	}
	return false
}

// lookupName chuẩn hoá tên của bí mật đã có. Tên dành riêng vẫn nhận, để bí mật tạo trước khi danh sách dành riêng
// thêm tên đó vẫn đổi tên hay xoá được.
func lookupName(raw string) (string, error) {
	name := secretstore.NormalizeName(raw)
	if err := secretstore.ValidName(name); err != nil && !errors.Is(err, &secretstore.Error{Code: secretstore.CodeReservedName}) {
		return "", err
	}
	return name, nil
}

// readSecretValue đọc {"value":"…"} từ stdin (FR-009). Stdin rỗng là không đổi giá trị. Lỗi không bao giờ kèm nội dung
// đã đọc: lỗi cú pháp của encoding/json có chép lại ký tự của nó.
func readSecretValue(stdin io.Reader) (string, bool, error) {
	if stdin == nil {
		return "", false, nil
	}
	b, err := io.ReadAll(io.LimitReader(stdin, maxSecretInput+1))
	defer clear(b)
	if err != nil {
		return "", false, errSecretInput
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return "", false, nil
	}
	if len(b) > maxSecretInput {
		// Cùng lỗi invalid_value của giá trị sai độ dài.
		return "", false, secretstore.ValidValue("")
	}
	var in struct {
		Value *string `json:"value"`
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if dec.Decode(&in) != nil || in.Value == nil || dec.More() {
		return "", false, errSecretInput
	}
	if err := secretstore.ValidValue(*in.Value); err != nil {
		return "", false, err
	}
	return *in.Value, true, nil
}

// readDescription đọc mô tả từ file tạm của desktop; mô tả có thể dài và xuống dòng nên không đi qua tham số.
func readDescription(path string) (string, bool, error) {
	if path == "" {
		return "", false, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return "", false, fmt.Errorf("không đọc được file mô tả: %w", err)
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxDescriptionFile+1))
	if err != nil {
		return "", false, fmt.Errorf("không đọc được file mô tả: %w", err)
	}
	if len(b) > maxDescriptionFile {
		return "", false, &secretstore.Error{
			Code:    secretstore.CodeInvalidDescription,
			Message: fmt.Sprintf("Mô tả tối đa %d ký tự.", secretstore.MaxDescriptionLen),
		}
	}
	return strings.TrimSpace(string(b)), true, nil
}

// secretsFail in lỗi dạng {"error":{code,message,names}} ra stdout cho desktop và message ra stderr cho người gõ lệnh.
func secretsFail(stdout, stderr io.Writer, err error) int {
	var e *secretstore.Error
	if !errors.As(err, &e) {
		e = &secretstore.Error{Code: codeInternal, Message: err.Error()}
	}
	_ = json.NewEncoder(stdout).Encode(struct {
		Error *secretstore.Error `json:"error"`
	}{e})
	fmt.Fprintln(stderr, e.Message)
	return 1
}
