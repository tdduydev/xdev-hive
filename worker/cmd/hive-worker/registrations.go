package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/instancelock"
	"github.com/tdduydev/xdev-hive/worker/internal/registry"
)

// registryBook là chỗ test trỏ sổ đăng ký vào thư mục tạm.
var registryBook = registry.Default

const registrationsUsage = "Cách dùng: hive-worker registrations <list [--json] | add --hub URL --token MÃ [--machine TÊN] [--label NHÃN] [--json] | use ID | set ID --label NHÃN | remove ID>"

// takeRegistrationFlag đọc `--registration ID` đứng trước lệnh. Cờ thành HIVE_REGISTRATION để mọi lệnh con, và tiến
// trình con worker gọi lại chính nó (hook, askpass), chọn cùng một đăng ký mà không phải thêm cờ vào từng lệnh.
func takeRegistrationFlag(args []string) ([]string, bool) {
	if len(args) == 0 {
		return args, false
	}
	if v, ok := strings.CutPrefix(args[0], "--registration="); ok {
		os.Setenv(registry.EnvRegistration, v)
		return args[1:], true
	}
	if args[0] == "--registration" && len(args) >= 2 {
		os.Setenv(registry.EnvRegistration, args[1])
		return args[2:], true
	}
	return args, false
}

// pinRegistration giữ đăng ký worker đang chạy: người dùng đổi đăng ký đang chọn trong lúc worker chạy thì hook và lệnh
// con của run vẫn ra đúng thư mục của đăng ký ban đầu.
func pinRegistration() error {
	if os.Getenv(registry.EnvWorkerConfig) != "" {
		return nil
	}
	book, err := registryBook()
	if err != nil {
		return err
	}
	id, err := book.Selected("")
	if err != nil {
		return err
	}
	return os.Setenv(registry.EnvRegistration, id)
}

// registerTarget là đăng ký và phạm vi khoá máy cho `register`. worker.json đặt tay (--config, HIVE_WORKER_CONFIG) nằm
// ngoài sổ nên giữ phạm vi đang ghi trong nó.
func registerTarget(configFlag, path string) (id, scope string) {
	if configFlag != "" || os.Getenv(registry.EnvWorkerConfig) != "" {
		cfg, _ := config.Load(path)
		return "", cfg.KeyScope
	}
	book, err := registryBook()
	if err != nil {
		return "", ""
	}
	id, err = book.Selected("")
	if err != nil {
		return "", ""
	}
	return id, registry.KeyScope(id)
}

// recordOrg ghi tổ chức hub vừa trả vào sổ. Máy chỉ có worker.json cũ và chưa có sổ thì không tạo sổ: tổ chức đã nằm
// trong worker.json.
func recordOrg(id string, cfg config.Config, stderr io.Writer) {
	book, err := registryBook()
	if err != nil {
		return
	}
	if _, err := os.Stat(book.IndexPath()); errors.Is(err, os.ErrNotExist) {
		return
	}
	err = book.Update(func(ix *registry.Index) error {
		if r, ok := ix.Find(id); ok {
			r.HubURL, r.OrgID, r.OrgName = cfg.HubURL, cfg.OrgID, cfg.OrgName
		}
		return nil
	})
	if err != nil {
		fmt.Fprintf(stderr, "Không cập nhật được sổ đăng ký: %v\n", err)
	}
}

func registrationsCommand(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		args = []string{"list"}
	}
	book, err := registryBook()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	switch args[0] {
	case "list":
		return registrationsList(book, args[1:], stdout, stderr)
	case "add":
		return registrationsAdd(book, args[1:], stdout, stderr)
	case "use", "set", "remove":
		if len(args) < 2 || strings.HasPrefix(args[1], "-") {
			fmt.Fprintln(stderr, registrationsUsage)
			return 2
		}
		if !registry.ValidID(args[1]) {
			fmt.Fprintf(stderr, "Id đăng ký %q không hợp lệ.\n", args[1])
			return 2
		}
		switch args[0] {
		case "use":
			return registrationsUse(book, args[1], stdout, stderr)
		case "set":
			return registrationsSet(book, args[1], args[2:], stdout, stderr)
		default:
			return registrationsRemove(book, args[1], stdout, stderr)
		}
	default:
		fmt.Fprintln(stderr, registrationsUsage)
		return 2
	}
}

// registrationView là một đăng ký in cho người hay app đọc. Không có token.
type registrationView struct {
	ID         string `json:"id"`
	HubURL     string `json:"hubUrl"`
	OrgID      string `json:"orgId,omitempty"`
	OrgName    string `json:"orgName,omitempty"`
	Label      string `json:"label,omitempty"`
	MachineID  string `json:"machineId,omitempty"`
	Active     bool   `json:"active"`
	Registered bool   `json:"registered"`
	ConfigPath string `json:"configPath"`
}

func registrationsList(book registry.Book, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("registrations list", flag.ContinueOnError)
	fs.SetOutput(stderr)
	asJSON := fs.Bool("json", false, "in dạng JSON (cho app desktop)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	ix, err := book.Load()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	views := make([]registrationView, 0, len(ix.Registrations))
	for _, r := range ix.Registrations {
		v := registrationView{ID: r.ID, HubURL: r.HubURL, OrgID: r.OrgID, OrgName: r.OrgName, Label: r.Label, Active: r.ID == ix.Active, ConfigPath: book.ConfigPath(r.ID)}
		if cfg, err := config.Load(v.ConfigPath); err == nil {
			v.MachineID, v.Registered = cfg.MachineID, cfg.Registered()
		}
		views = append(views, v)
	}
	if *asJSON {
		_ = json.NewEncoder(stdout).Encode(views)
		return 0
	}
	if len(views) == 0 {
		fmt.Fprintln(stdout, "Máy chưa đăng ký với tổ chức nào. Chạy `hive-worker registrations add --hub URL --token MÃ`.")
		return 0
	}
	for _, v := range views {
		mark := " "
		if v.Active {
			mark = "*"
		}
		name := v.OrgName
		if v.Label != "" {
			name = v.Label
		}
		if name == "" {
			name = "(chưa rõ tổ chức)"
		}
		fmt.Fprintf(stdout, "%s %s  %s  %s  máy %s\n", mark, v.ID, name, v.HubURL, v.MachineID)
	}
	return 0
}

func registrationsAdd(book registry.Book, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("registrations add", flag.ContinueOnError)
	fs.SetOutput(stderr)
	hub := fs.String("hub", envOr("HIVE_HUB_URL", ""), "địa chỉ hub")
	token := fs.String("token", envOr("HIVE_REGISTRATION_TOKEN", ""), "mã đăng ký admin đội tạo trên web")
	hostname, _ := os.Hostname()
	machine := fs.String("machine", defaultMachineID(hostname), "tên máy trên hub")
	capacity := fs.Int("capacity", 1, "số run chạy cùng lúc")
	label := fs.String("label", "", "nhãn tự đặt để phân biệt tổ chức")
	asJSON := fs.Bool("json", false, "in kết quả dạng JSON (cho app desktop)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *hub == "" || *token == "" {
		fmt.Fprintln(stderr, "Cần --hub và --token")
		return 2
	}
	ix, err := book.Load()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if len(ix.Registrations) >= registry.MaxRegistrations {
		fmt.Fprintf(stderr, "Máy đã có %d đăng ký; gỡ bớt trước khi thêm.\n", len(ix.Registrations))
		return 1
	}
	id, err := registry.NewID()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	path := book.ConfigPath(id)
	cfg, err := enroll(enrollment{path: path, scope: id, hub: *hub, token: *token, machine: *machine, capacity: *capacity}, stderr)
	if err != nil {
		// Khoá vừa tạo cho đăng ký không thành thì không ai dùng nữa.
		store := newKeyStore(path)
		store.Scope = id
		_ = store.Delete(*hub, *machine)
		_ = os.RemoveAll(book.ConfigDir(id))
		fmt.Fprintln(stderr, err)
		return 1
	}
	// Cùng hub, cùng tổ chức đã có đăng ký (FR-004): hub vừa cấp danh tính mới cho máy, nên thay vào đăng ký đó thay vì
	// thêm dòng thứ hai cho một tổ chức.
	target := id
	if old, ok := ix.FindOrg(cfg.HubURL, cfg.OrgID); ok {
		target = old.ID
	}
	if target != id {
		if err := adoptKeyFile(book, id, target); err != nil {
			fmt.Fprintf(stderr, "Đã đăng ký nhưng không chuyển được khoá máy: %v\nXin admin đội tạo mã mới rồi chạy lại.\n", err)
			return 1
		}
	}
	targetPath := book.ConfigPath(target)
	previous, prevErr := config.Load(targetPath)
	if err := config.Save(targetPath, cfg); err != nil {
		fmt.Fprintf(stderr, "Đã đăng ký nhưng không lưu được token: %v\nXin admin đội tạo mã mới rồi chạy lại.\n", err)
		return 1
	}
	if prevErr == nil && previous.Registered() && (previous.KeyScope != cfg.KeyScope || previous.MachineID != cfg.MachineID) {
		// Khoá của lần đăng ký trước không còn dùng: hub đã nhận khoá mới hoặc máy đổi tên. Chỉ xoá trong keychain: file
		// khoá cạnh worker.json giờ là khoá mới vừa chuyển sang.
		old := newKeyStore(targetPath)
		old.Scope, old.File = previous.KeyScope, ""
		_ = old.Delete(previous.HubURL, previous.MachineID)
	}
	err = book.Update(func(ix *registry.Index) error {
		if r, ok := ix.Find(target); ok {
			r.HubURL, r.OrgID, r.OrgName = cfg.HubURL, cfg.OrgID, cfg.OrgName
			if *label != "" {
				r.Label = *label
			}
			return nil
		}
		ix.Registrations = append(ix.Registrations, registry.Registration{
			ID: target, HubURL: cfg.HubURL, OrgID: cfg.OrgID, OrgName: cfg.OrgName, Label: *label, CreatedAt: time.Now().UTC(),
		})
		if ix.Active == "" {
			ix.Active = target
		}
		return nil
	})
	if err != nil {
		fmt.Fprintf(stderr, "Đã lưu cấu hình ở %s nhưng không ghi được sổ đăng ký: %v\n", targetPath, err)
		return 1
	}
	if *asJSON {
		_ = json.NewEncoder(stdout).Encode(registrationView{
			ID: target, HubURL: cfg.HubURL, OrgID: cfg.OrgID, OrgName: cfg.OrgName, Label: *label, MachineID: cfg.MachineID,
			Registered: true, ConfigPath: targetPath,
		})
		return 0
	}
	if target != id {
		fmt.Fprintf(stdout, "Máy đã có đăng ký %s%s; đã thay bằng lần đăng ký này. Khởi động lại worker nếu đang chạy.\n", target, orgSuffix(cfg.OrgName))
		return 0
	}
	fmt.Fprintf(stdout, "Đã thêm đăng ký %s%s. Chạy `hive-worker --registration %s run` để nhận việc của tổ chức này.\n", id, orgSuffix(cfg.OrgName), id)
	return 0
}

// adoptKeyFile chuyển file khoá (máy không có keychain) từ thư mục đăng ký mới sang đăng ký cũ cùng tổ chức, vì
// machinekey tìm file khoá cạnh worker.json. Chuyển cả khi hub chưa nhận khoá: lần chạy sau worker gửi lại khoá này.
func adoptKeyFile(book registry.Book, from, to string) error {
	defer os.RemoveAll(book.ConfigDir(from))
	src, dst := newKeyStore(book.ConfigPath(from)).File, newKeyStore(book.ConfigPath(to)).File
	if _, err := os.Stat(src); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	return os.Rename(src, dst)
}

func registrationsUse(book registry.Book, id string, stdout, stderr io.Writer) int {
	err := book.Update(func(ix *registry.Index) error {
		if _, ok := ix.Find(id); !ok {
			return fmt.Errorf("máy không có đăng ký %s; xem `hive-worker registrations list`", id)
		}
		ix.Active = id
		return nil
	})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "Lệnh không có --registration giờ dùng đăng ký %s. Khởi động lại worker nếu đang chạy.\n", id)
	return 0
}

func registrationsSet(book registry.Book, id string, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("registrations set", flag.ContinueOnError)
	fs.SetOutput(stderr)
	label := fs.String("label", "", "nhãn tự đặt; để trống thì bỏ nhãn")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	err := book.Update(func(ix *registry.Index) error {
		r, ok := ix.Find(id)
		if !ok {
			return fmt.Errorf("máy không có đăng ký %s", id)
		}
		r.Label = strings.TrimSpace(*label)
		return nil
	})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "Đã cập nhật đăng ký %s.\n", id)
	return 0
}

// registrationsRemove xoá token, khoá máy, cấu hình và dữ liệu của một đăng ký trên máy. Máy vẫn còn trên hub cho tới khi
// admin đội thu hồi: worker không có phiên người dùng để gọi thu hồi.
func registrationsRemove(book registry.Book, id string, stdout, stderr io.Writer) int {
	if id == registry.LegacyID {
		fmt.Fprintln(stderr, "Đăng ký cũ (reg_legacy) dùng worker.json ở chỗ cũ; xoá file đó để gỡ.")
		return 1
	}
	ix, err := book.Load()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if _, ok := ix.Find(id); !ok {
		fmt.Fprintf(stderr, "Máy không có đăng ký %s.\n", id)
		return 1
	}
	// Worker đang chạy có thể đang dùng thư mục của đăng ký này; xoá dưới chân nó làm hỏng run đang chạy.
	lock, err := instancelock.Acquire()
	if err != nil {
		if errors.Is(err, instancelock.ErrAlreadyRunning) {
			fmt.Fprintln(stderr, "Worker đang chạy; dừng worker rồi gỡ đăng ký.")
		} else {
			fmt.Fprintln(stderr, err)
		}
		return 1
	}
	defer lock.Close()
	path := book.ConfigPath(id)
	if cfg, err := config.Load(path); err == nil {
		store := newKeyStore(path)
		store.Scope = cfg.KeyScope
		if err := store.Delete(cfg.HubURL, cfg.MachineID); err != nil {
			fmt.Fprintln(stderr, err)
		}
	}
	if err := book.Update(func(ix *registry.Index) error { ix.Remove(id); return nil }); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := os.RemoveAll(book.ConfigDir(id)); err != nil {
		fmt.Fprintf(stderr, "Không xoá hết cấu hình %s: %v\n", book.ConfigDir(id), err)
	}
	if err := os.RemoveAll(filepath.Dir(book.DataDir(id))); err != nil {
		fmt.Fprintf(stderr, "Không xoá hết dữ liệu %s: %v\n", filepath.Dir(book.DataDir(id)), err)
	}
	fmt.Fprintf(stdout, "Đã gỡ đăng ký %s khỏi máy. Máy vẫn còn trên hub: admin đội thu hồi máy trên web.\n", id)
	return 0
}
