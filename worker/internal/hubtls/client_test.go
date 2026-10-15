package hubtls

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func tlsHub(t *testing.T) (*httptest.Server, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Hive test CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	root, err := x509.CreateCertificate(rand.Reader, ca, ca, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), NotBefore: ca.NotBefore, NotAfter: ca.NotAfter, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, leaf, ca, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws/worker" {
			conn, err := websocket.Accept(w, r, nil)
			if err == nil {
				_ = conn.Close(websocket.StatusNormalClosure, "xong")
			}
			return
		}
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	server.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS12}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: root})
}

func TestPrivateCAForHTTPAndWebsocket(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("HIVE_CA_FILE", "")
	hub, ca := tlsHub(t)
	if _, err := NewClient(time.Second).Get(hub.URL); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("CA chưa tin phải báo cách đối chiếu vân tay: %v", err)
	}
	path := filepath.Join(home, ".xdev-hive", "hub-ca.pem")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, ca, 0600); err != nil {
		t.Fatal(err)
	}
	client := NewClient(time.Second)
	t.Cleanup(client.CloseIdleConnections)
	res, err := client.Get(hub.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	conn, _, err := websocket.Dial(context.Background(), "wss"+strings.TrimPrefix(hub.URL, "https")+"/ws/worker", &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.CloseNow()
	other, _ := tlsHub(t)
	if _, err := client.Get(other.URL); err == nil {
		t.Fatal("chấp nhận hub đổi CA")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := NewClient(time.Second).Get(hub.URL); err == nil {
		t.Fatal("vẫn tin sau khi quên CA")
	}
}

func TestExplicitCAAndInvalidFilesFailClosed(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	hub, ca := tlsHub(t)
	path := filepath.Join(home, "custom.pem")
	t.Setenv("HIVE_CA_FILE", path)
	if _, err := NewClient(time.Second).Get(hub.URL); err == nil {
		t.Fatal("bỏ qua CA không đọc được")
	}
	if err := os.WriteFile(path, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewClient(time.Second).Get(hub.URL); err == nil || !strings.Contains(err.Error(), "PEM") {
		t.Fatalf("lỗi CA hỏng: %v", err)
	}
	if err := os.WriteFile(path, ca, 0600); err != nil {
		t.Fatal(err)
	}
	client := NewClient(time.Second)
	t.Cleanup(client.CloseIdleConnections)
	res, err := client.Get(hub.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	transport := client.Transport.(checkedTransport).Transport
	if transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("đã tắt xác thực TLS")
	}
	system, err := x509.SystemCertPool()
	if err != nil {
		t.Fatal(err)
	}
	if len(transport.TLSClientConfig.RootCAs.Subjects()) <= len(system.Subjects()) {
		t.Fatal("không giữ CA hệ thống")
	}
}
