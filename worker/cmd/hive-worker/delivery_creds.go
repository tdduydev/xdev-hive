package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/registry"
	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

const deliveryCredsUsage = `Cách dùng: hive-worker secrets delivery <lệnh> [--config FILE] [--json]
  status                  kho bí mật của máy dùng được không
  list                    tên credential triển khai của đăng ký, không có giá trị
  set     --name TÊN      thêm hoặc thay giá trị; giá trị là JSON {"value":"…"} trên stdin
  delete  --name TÊN
Tên chỉ gồm chữ thường, số và -. Jenkins: "user:token"; Argo CD: token trần.`

type (
	deliveryCredsListView struct {
		Registration string                           `json:"registration"`
		Credentials  []secretstore.DeliveryCredential `json:"credentials"`
	}
	deliveryCredDeleteView struct {
		Deleted string `json:"deleted"`
	}
)

// Test thay kho.
var deliveryCredsStore = secretstore.NewSystemDeliveryStore

var errDeliveryValueRequired = &secretstore.Error{
	Code:    secretstore.CodeInvalidValue,
	Message: `Cần giá trị credential dạng JSON {"value":"…"} trên stdin.`,
}

// deliveryCredsCommand quản lý credential triển khai (specs/032 FR-060…FR-066): khác bí mật của dự án, chúng không gán
// được cho dự án và không vào biến môi trường của agent hay terminal. Ra và lỗi theo cùng dạng với `secrets`.
func deliveryCredsCommand(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	action := ""
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		action, args = args[0], args[1:]
	}
	usage := func() int {
		fmt.Fprintln(stderr, deliveryCredsUsage)
		return 2
	}
	fs := flag.NewFlagSet("secrets delivery "+action, flag.ContinueOnError)
	// Như secretsCommand: lỗi của gói flag có thể chép lại giá trị người dùng gõ nhầm vào tham số.
	fs.SetOutput(io.Discard)
	configPath := fs.String("config", "", "file cấu hình worker (delivery-credentials.json nằm cạnh)")
	fs.Bool("json", true, "in dạng JSON (mặc định)")
	name := fs.String("name", "", "tên credential")
	if err := fs.Parse(args); err != nil || fs.NArg() > 0 {
		fmt.Fprintln(stderr, "Tham số không hợp lệ.")
		return usage()
	}
	path, err := pathOr(*configPath)
	if err != nil {
		return secretsFail(stdout, stderr, err)
	}
	cmd := deliveryCredsCmd{catalog: secretstore.DeliveryCatalogPath(path), store: deliveryCredsStore()}
	var view any
	switch action {
	case "status":
		view = cmd.store.Status()
	case "list", "set", "delete":
		if (action == "list") != (*name == "") {
			return usage()
		}
		cmd.registration, err = deliveryRegistration(path)
		if err != nil {
			return secretsFail(stdout, stderr, err)
		}
		switch action {
		case "list":
			view, err = cmd.list()
		case "set":
			view, err = cmd.set(*name, stdin)
		default:
			view, err = cmd.delete(*name)
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

type deliveryCredsCmd struct {
	catalog, registration string
	store                 *secretstore.Store
}

// deliveryRegistration là đăng ký có worker.json ở path, để khoá trong kho khớp delivery.ScopedCredentials của worker
// chạy đăng ký đó. worker.json ngoài sổ (--config, HIVE_WORKER_CONFIG) thuộc `reg_legacy`, như thư mục dữ liệu của nó.
func deliveryRegistration(path string) (string, error) {
	book, err := registryBook()
	if err != nil {
		return "", err
	}
	ix, err := book.Load()
	if err != nil {
		return "", err
	}
	for _, r := range ix.Registrations {
		if filepath.Clean(book.ConfigPath(r.ID)) == filepath.Clean(path) {
			return r.ID, nil
		}
	}
	return registry.LegacyID, nil
}

func (c deliveryCredsCmd) list() (deliveryCredsListView, error) {
	cat, err := secretstore.LoadDeliveryCatalog(c.catalog)
	if err != nil {
		return deliveryCredsListView{}, err
	}
	creds := cat.Credentials
	if creds == nil {
		creds = []secretstore.DeliveryCredential{}
	}
	return deliveryCredsListView{Registration: c.registration, Credentials: creds}, nil
}

// set ghi kho trong lúc giữ khoá danh mục và sau khi Put đã kiểm tên, số lượng: lỗi ở bước nào thì danh mục cũng không
// ghi mục không có giá trị, và kho không có giá trị mà danh mục không biết.
func (c deliveryCredsCmd) set(name string, stdin io.Reader) (secretstore.DeliveryCredential, error) {
	if err := secretstore.ValidDeliveryName(name); err != nil {
		return secretstore.DeliveryCredential{}, err
	}
	value, ok, err := readSecretValue(stdin)
	if err != nil {
		return secretstore.DeliveryCredential{}, err
	}
	if !ok {
		return secretstore.DeliveryCredential{}, errDeliveryValueRequired
	}
	// Token dán từ trình duyệt hay kèm xuống dòng; ký tự trắng ở đầu, cuối làm header Authorization sai.
	value = strings.TrimSpace(value)
	if err := secretstore.ValidValue(value); err != nil {
		return secretstore.DeliveryCredential{}, err
	}
	var item secretstore.DeliveryCredential
	err = secretstore.ModifyDeliveryCatalog(c.catalog, func(cat *secretstore.DeliveryCatalog) error {
		var err error
		if item, err = cat.Put(name, secretsNow()); err != nil {
			return err
		}
		return c.store.Set(secretstore.DeliveryAccount(c.registration, name), value)
	})
	return item, err
}

func (c deliveryCredsCmd) delete(name string) (deliveryCredDeleteView, error) {
	if err := secretstore.ValidDeliveryName(name); err != nil {
		return deliveryCredDeleteView{}, err
	}
	err := secretstore.ModifyDeliveryCatalog(c.catalog, func(cat *secretstore.DeliveryCatalog) error {
		if err := cat.Remove(name); err != nil {
			return err
		}
		return c.store.Delete(secretstore.DeliveryAccount(c.registration, name))
	})
	return deliveryCredDeleteView{Deleted: name}, err
}
