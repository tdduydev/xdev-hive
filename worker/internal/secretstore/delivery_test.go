package secretstore

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/zalando/go-keyring"
)

const deliveryValue = "bot:fake-jenkins-token-never-print"

func TestDeliveryStoreIsSeparateFromProjectSecrets(t *testing.T) {
	keyring.MockInit()
	d, p := NewDeliveryStore(), NewStore()
	account := DeliveryAccount("reg_legacy", "jenkins-prod")
	if account != "delivery/reg_legacy/jenkins-prod" {
		t.Fatalf("account = %s", account)
	}
	if err := d.Set(account, deliveryValue); err != nil {
		t.Fatal(err)
	}
	if got, err := d.Get(account); err != nil || got != deliveryValue {
		t.Fatalf("đọc lại credential: lỗi %v", err)
	}
	// FR-062: kho của bí mật dự án (run, exec, terminal đọc) không thấy mục delivery.
	if _, err := p.Get(account); !errors.Is(err, ErrMissing) {
		t.Fatalf("Service không được có mục delivery, got %v", err)
	}
	if _, err := keyring.Get(Service, account); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatalf("mục delivery lọt vào %s: %v", Service, err)
	}
	if _, err := keyring.Get(DeliveryService, account); err != nil {
		t.Fatalf("mục delivery phải nằm ở %s: %v", DeliveryService, err)
	}
	if err := d.Delete(account); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Get(account); !errors.Is(err, ErrMissing) {
		t.Fatalf("sau khi xoá, got %v", err)
	}
}

func TestDeliveryNamesNeverValidProjectSecretNames(t *testing.T) {
	for _, n := range []string{"jenkins-prod", "argocd", "a", "x-1"} {
		if err := ValidDeliveryName(n); err != nil {
			t.Fatalf("%q phải hợp lệ: %v", n, err)
		}
		// Tên chữ thường không bao giờ thành biến môi trường của dự án.
		if ValidName(n) == nil {
			t.Fatalf("%q không được là tên bí mật dự án hợp lệ", n)
		}
	}
	for _, n := range []string{"", "Jenkins", "a_b", "a/b", "../x", "a b", string(make([]byte, 65))} {
		if err := ValidDeliveryName(n); !errors.Is(err, &Error{Code: CodeInvalidName}) {
			t.Fatalf("%q phải bị từ chối, got %v", n, err)
		}
	}
}

func TestDeliveryCatalogPutRemove(t *testing.T) {
	path := DeliveryCatalogPath(filepath.Join(t.TempDir(), "worker.json"))
	t0 := time.Date(2026, 10, 23, 8, 0, 0, 500, time.UTC)
	t1 := t0.Add(time.Hour)
	if err := ModifyDeliveryCatalog(path, func(c *DeliveryCatalog) error {
		if _, err := c.Put("zeta", t0); err != nil {
			return err
		}
		_, err := c.Put("alpha", t0)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := ModifyDeliveryCatalog(path, func(c *DeliveryCatalog) error {
		d, err := c.Put("alpha", t1)
		if err != nil {
			return err
		}
		if !d.CreatedAt.Equal(t0.Truncate(time.Second)) || !d.ValueChangedAt.Equal(t1.Truncate(time.Second)) {
			t.Errorf("thay giá trị phải giữ createdAt, đổi valueChangedAt: %+v", d)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	c, err := LoadDeliveryCatalog(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Credentials) != 2 || c.Credentials[0].Name != "alpha" || c.Credentials[1].Name != "zeta" {
		t.Fatalf("danh mục phải xếp theo tên: %+v", c.Credentials)
	}
	if err := c.Remove("missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
	if err := c.Remove("alpha"); err != nil || len(c.Credentials) != 1 {
		t.Fatalf("Remove: %v %+v", err, c.Credentials)
	}
	// Danh mục delivery không đụng secrets.json của bí mật dự án.
	if _, err := os.Stat(CatalogPath(filepath.Join(filepath.Dir(path), "worker.json"))); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("secrets.json không được được tạo: %v", err)
	}
}

func TestDeliveryCatalogLimitsAndNewerVersion(t *testing.T) {
	var c DeliveryCatalog
	now := time.Now()
	for i := range MaxDeliveryCredentials {
		if _, err := c.Put("c-"+strconv.Itoa(i), now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := c.Put("one-more", now); !errors.Is(err, &Error{Code: CodeTooMany}) {
		t.Fatalf("got %v", err)
	}
	// Thay giá trị của mục đã có vẫn được khi đầy.
	if _, err := c.Put("c-0", now); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Put("Bad", now); !errors.Is(err, &Error{Code: CodeInvalidName}) {
		t.Fatalf("got %v", err)
	}

	path := filepath.Join(t.TempDir(), deliveryCatalogFile)
	if err := os.WriteFile(path, []byte(`{"version":99,"credentials":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	err := ModifyDeliveryCatalog(path, func(*DeliveryCatalog) error { return nil })
	if !errors.Is(err, ErrCatalogNewer) {
		t.Fatalf("got %v", err)
	}
}
