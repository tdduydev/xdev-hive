// Package hubtls dùng chung CA người dùng đã xác nhận trong app, ngoài kho CA hệ thống.
package hubtls

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// NewClient không sửa transport toàn cục: CA của hub không ảnh hưởng các kết nối khác.
// File chỉ được đọc khi tạo client, nên lần kết nối lại nhận thay đổi từ app.
func NewClient(timeout time.Duration) *http.Client {
	transport, err := transport()
	if err != nil {
		// Giữ lỗi đến lúc gọi mạng để các API tạo client hiện có không phải bỏ qua lỗi đọc CA.
		return &http.Client{Timeout: timeout, Transport: failedTransport{err}}
	}
	return &http.Client{Timeout: timeout, Transport: checkedTransport{transport}}
}

func transport() (*http.Transport, error) {
	path := os.Getenv("HIVE_CA_FILE")
	explicit := path != ""
	if !explicit {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("không tìm được thư mục nhà để đọc CA hub: %w", err)
		}
		path = filepath.Join(home, ".xdev-hive", "hub-ca.pem")
	}
	t := http.DefaultTransport.(*http.Transport).Clone()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) && !explicit {
		return t, nil
	}
	if err != nil {
		return nil, fmt.Errorf("không đọc được CA hub %s: %w", path, err)
	}
	roots, err := x509.SystemCertPool()
	if err != nil {
		return nil, fmt.Errorf("không đọc được kho CA hệ thống: %w", err)
	}
	if !roots.AppendCertsFromPEM(data) {
		return nil, fmt.Errorf("CA hub %s không chứa chứng chỉ PEM hợp lệ; xác nhận lại chứng chỉ trong app hoặc kiểm HIVE_CA_FILE", path)
	}
	t.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	return t, nil
}

type failedTransport struct{ err error }

func (t failedTransport) RoundTrip(*http.Request) (*http.Response, error) { return nil, t.err }

// Lỗi CA cần dẫn người dùng về bước đối chiếu vân tay, thay vì khuyên tắt TLS.
type checkedTransport struct{ *http.Transport }

func (t checkedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	response, err := t.Transport.RoundTrip(r)
	var verification *tls.CertificateVerificationError
	if errors.As(err, &verification) {
		return response, fmt.Errorf("không xác thực được chứng chỉ HTTPS của hub: kiểm địa chỉ và hạn dùng. Nếu CA chưa tin hoặc đã đổi, đối chiếu SHA-256 với quản trị hub và xác nhận trong app, hoặc đặt HIVE_CA_FILE tới CA đã kiểm tra. Có thể cài CA vào hệ điều hành: macOS mở Keychain Access → System → Always Trust; Windows mở Install Certificate → Local Machine → Trusted Root Certification Authorities; iOS cài hồ sơ rồi bật Cài đặt chung → Giới thiệu → Cài đặt tin cậy chứng chỉ; Android vào Bảo mật → Mã hoá và thông tin xác thực → Cài chứng chỉ CA: %w", err)
	}
	return response, err
}
