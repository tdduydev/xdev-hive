package secretstore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

// Credential triển khai (specs/032 FR-060…FR-066): token Jenkins, Argo CD mà worker dùng khi chạy việc delivery. Chúng ở
// dịch vụ kho và danh mục riêng, không phải Service và secrets.json mà run, exec và terminal đọc, nên không gán được cho
// dự án và không bao giờ vào biến môi trường của agent hay phiên terminal (FR-062).
const (
	DeliveryService        = "dev.xdev.hive.delivery"
	DeliveryCatalogVersion = 1
	// MaxDeliveryCredentials chặn danh mục phình vô hạn khi script gọi set lặp lại; một máy chạy thường chỉ cần vài cái.
	MaxDeliveryCredentials = 128
	deliveryCatalogFile    = "delivery-credentials.json"
)

var deliveryNamePattern = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)

// NewDeliveryStore dùng go-keyring trực tiếp, để unit test thay bằng keyring.MockInit().
func NewDeliveryStore() *Store { return &Store{kr: osKeyring{}, service: DeliveryService} }

// NewSystemDeliveryStore giới hạn thời gian chờ kho như NewSystemStore.
func NewSystemDeliveryStore() *Store {
	s := NewSystemStore()
	s.service = DeliveryService
	return s
}

// DeliveryAccount là khoá trong kho của credential name thuộc đăng ký registration (data-model §"Cách ly theo đăng ký"),
// cùng khoá delivery.ScopedCredentials đọc. Hai tổ chức trên một máy đặt cùng tên thì vẫn là hai mục.
func DeliveryAccount(registration, name string) string {
	return "delivery/" + registration + "/" + name
}

// DeliveryCredential là một mục của delivery-credentials.json. Như Secret, không có trường nào suy ra được giá trị.
type DeliveryCredential struct {
	Name           string    `json:"name"`
	CreatedAt      time.Time `json:"createdAt"`
	ValueChangedAt time.Time `json:"valueChangedAt"`
}

type DeliveryCatalog struct {
	Version     int                  `json:"version"`
	Credentials []DeliveryCredential `json:"credentials"`
}

// DeliveryCatalogPath đặt danh mục cạnh worker.json của đăng ký, nên mỗi đăng ký có danh mục riêng.
func DeliveryCatalogPath(workerConfig string) string {
	return filepath.Join(filepath.Dir(workerConfig), deliveryCatalogFile)
}

// ValidDeliveryName kiểm tên tham chiếu như hub (FR-061). Tên chữ thường không bao giờ là tên biến hợp lệ của spec 031,
// nên không thể nhầm sang bí mật của dự án.
func ValidDeliveryName(name string) error {
	if !deliveryNamePattern.MatchString(name) {
		return &Error{
			Code:    CodeInvalidName,
			Message: "Tên credential chỉ gồm chữ thường, số và `-`, tối đa 64 ký tự.",
		}
	}
	return nil
}

func LoadDeliveryCatalog(path string) (DeliveryCatalog, error) {
	c := DeliveryCatalog{Version: DeliveryCatalogVersion}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("đọc %s: %w", path, err)
	}
	return c, nil
}

// ModifyDeliveryCatalog giữ khoá như ModifyCatalog: app và lệnh terminal có thể sửa cùng lúc.
func ModifyDeliveryCatalog(path string, change func(*DeliveryCatalog) error) error {
	return projects.WithLock(path, func() error {
		c, err := LoadDeliveryCatalog(path)
		if err != nil {
			return err
		}
		if c.Version > DeliveryCatalogVersion {
			return &Error{Code: CodeCatalogNewer, Message: "Danh mục credential triển khai do bản mới hơn tạo. Hãy cập nhật xDev Hive để sửa."}
		}
		if err := change(&c); err != nil {
			return err
		}
		c.Version = DeliveryCatalogVersion
		if c.Credentials == nil {
			c.Credentials = []DeliveryCredential{}
		}
		return projects.WriteJSON(path, c)
	})
}

func (c *DeliveryCatalog) Find(name string) *DeliveryCredential {
	for i := range c.Credentials {
		if c.Credentials[i].Name == name {
			return &c.Credentials[i]
		}
	}
	return nil
}

// Put thêm mục mới hay ghi lúc đổi giá trị của mục đã có. Giá trị ghi vào kho do bên gọi làm trước, như Catalog.Add.
func (c *DeliveryCatalog) Put(name string, now time.Time) (DeliveryCredential, error) {
	if err := ValidDeliveryName(name); err != nil {
		return DeliveryCredential{}, err
	}
	now = stamp(now)
	if d := c.Find(name); d != nil {
		d.ValueChangedAt = now
		return *d, nil
	}
	if len(c.Credentials) >= MaxDeliveryCredentials {
		return DeliveryCredential{}, &Error{
			Code:    CodeTooMany,
			Message: fmt.Sprintf("Máy đã có %d credential triển khai.", MaxDeliveryCredentials),
			Names:   []string{name},
		}
	}
	c.Credentials = append(c.Credentials, DeliveryCredential{Name: name, CreatedAt: now, ValueChangedAt: now})
	slices.SortFunc(c.Credentials, func(a, b DeliveryCredential) int { return strings.Compare(a.Name, b.Name) })
	return *c.Find(name), nil
}

func (c *DeliveryCatalog) Remove(name string) error {
	i := slices.IndexFunc(c.Credentials, func(d DeliveryCredential) bool { return d.Name == name })
	if i < 0 {
		return &Error{Code: CodeNotFound, Message: fmt.Sprintf("Không tìm thấy credential `%s`.", name), Names: []string{name}}
	}
	c.Credentials = slices.Delete(c.Credentials, i, i+1)
	return nil
}
