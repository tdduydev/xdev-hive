package egress

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type logBuffer struct {
	sync.Mutex
	bytes.Buffer
}

func (b *logBuffer) Write(data []byte) (int, error) {
	b.Lock()
	defer b.Unlock()
	return b.Buffer.Write(data)
}
func (b *logBuffer) snapshot() string { b.Lock(); defer b.Unlock(); return b.Buffer.String() }

func startProxy(t *testing.T, config Config) (string, *Proxy) {
	t.Helper()
	if config.Logger == nil {
		config.Logger = slog.New(slog.NewJSONHandler(io.Discard, nil))
	}
	p, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- p.Serve(ctx, listener) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	})
	return listener.Addr().String(), p
}

func openTunnel(t *testing.T, proxyAddress, target string) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp", proxyAddress)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	_, err = fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: "CONNECT"})
	if err != nil || response.StatusCode != 200 {
		conn.Close()
		t.Fatalf("CONNECT: %v %v", response, err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func TestHTTPForwardingAndLogs(t *testing.T) {
	var seen atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" || r.Header.Get("X-Hop") != "" {
			t.Error("proxy credentials/hop header forwarded")
		}
		if r.Header.Get("Authorization") != "Bearer test-credential" {
			t.Error("origin authorization lost")
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != "private-request-body" || r.URL.Path != "/test" {
			t.Error("body/path lost")
		}
		seen.Store(true)
		w.Header().Set("Proxy-Authenticate", "remove")
		fmt.Fprint(w, "private-response-body")
	}))
	defer upstream.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(upstream.URL, "http://"))
	logs := &logBuffer{}
	address, _ := startProxy(t, Config{Allowlist: mustList(t, "127.0.0.1:"+port), Logger: slog.New(slog.NewJSONHandler(logs, nil))})
	proxyURL, _ := url.Parse("http://" + address)
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL)}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	request, _ := http.NewRequest("POST", upstream.URL+"/test", strings.NewReader("private-request-body"))
	request.Header.Set("Authorization", "Bearer test-credential")
	request.Header.Set("Proxy-Authorization", "Basic proxy-credential")
	request.Header.Set("Connection", "X-Hop")
	request.Header.Set("X-Hop", "remove")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || string(body) != "private-response-body" || response.Header.Get("Proxy-Authenticate") != "" || !seen.Load() {
		t.Fatalf("response: %v %s", response, body)
	}
	deadline := time.Now().Add(time.Second)
	for logs.snapshot() == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	text := logs.snapshot()
	for _, secret := range []string{"test-credential", "proxy-credential", "private-request-body", "private-response-body", "Authorization"} {
		if strings.Contains(text, secret) {
			t.Fatalf("secret logged: %s", text)
		}
	}
	var event struct {
		Allowed  bool  `json:"allowed"`
		Sent     int64 `json:"bytes_sent"`
		Received int64 `json:"bytes_received"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(text)), &event); err != nil {
		t.Fatal(err)
	}
	if !event.Allowed || event.Sent != int64(len("private-request-body")) || event.Received != int64(len("private-response-body")) {
		t.Fatalf("log: %s", text)
	}
}

func TestHTTPDenied(t *testing.T) {
	p, _ := New(Config{Allowlist: mustList(t, "api.example:80"), Logger: slog.New(slog.NewJSONHandler(io.Discard, nil)), Resolver: &fakeResolver{addresses: []netip.Addr{netip.MustParseAddr("127.0.0.1")}}})
	for _, tc := range []struct{ method, target, host string }{
		{"GET", "http://denied.example/path", ""}, {"GET", "http://api.example/path", ""},
		{"GET", "http://user:password@api.example/path", ""}, {"GET", "https://api.example/path", ""},
		{"GET", "http://api.example/path", "other.example"}, {"GET", "/path", "api.example"},
		{"CONNECT", "127.0.0.1:443", ""}, {"CONNECT", "[::1]:443", ""}, {"CONNECT", "api.example", ""},
	} {
		t.Run(tc.target+tc.host, func(t *testing.T) {
			request := httptest.NewRequest(tc.method, tc.target, nil)
			if tc.host != "" {
				request.Host = tc.host
			}
			out := httptest.NewRecorder()
			p.ServeHTTP(out, request)
			if out.Code != 403 || out.Body.Len() == 0 {
				t.Fatalf("status=%d body=%s", out.Code, out.Body)
			}
		})
	}
}

func TestHTTPPinnedDNS(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ok") }))
	defer upstream.Close()
	resolver := &fakeResolver{addresses: []netip.Addr{netip.MustParseAddr("1.1.1.1")}}
	var calls atomic.Int32
	address, _ := startProxy(t, Config{Allowlist: mustList(t, "api.example:80"), Resolver: resolver, DialContext: func(ctx context.Context, network, destination string) (net.Conn, error) {
		calls.Add(1)
		if network != "tcp4" || destination != "1.1.1.1:80" {
			t.Errorf("unverified dial: %s %s", network, destination)
		}
		return (&net.Dialer{}).DialContext(ctx, "tcp4", strings.TrimPrefix(upstream.URL, "http://"))
	}})
	proxyURL, _ := url.Parse("http://" + address)
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL)}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	response, err := client.Get("http://api.example/test")
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || calls.Load() != 1 || resolver.calls != 1 {
		t.Fatalf("status=%d dial=%d DNS=%d", response.StatusCode, calls.Load(), resolver.calls)
	}
}

func TestConnectTLS(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "tls-ok") }))
	defer upstream.Close()
	logs := &logBuffer{}
	resolver := &fakeResolver{addresses: []netip.Addr{netip.MustParseAddr("1.1.1.1")}}
	var calls atomic.Int32
	address, _ := startProxy(t, Config{Allowlist: mustList(t, "allowed.example:443"), Resolver: resolver, Logger: slog.New(slog.NewJSONHandler(logs, nil)), DialContext: func(ctx context.Context, network, destination string) (net.Conn, error) {
		calls.Add(1)
		if destination != "1.1.1.1:443" || network != "tcp4" {
			t.Error("dial not pinned")
		}
		return (&net.Dialer{}).DialContext(ctx, "tcp4", strings.TrimPrefix(upstream.URL, "https://"))
	}})
	conn := openTunnel(t, address, "ALLOWED.EXAMPLE.:443")
	secure := tls.Client(conn, &tls.Config{ServerName: "allowed.example", InsecureSkipVerify: true})
	if err := secure.Handshake(); err != nil {
		t.Fatal(err)
	}
	fmt.Fprint(secure, "GET / HTTP/1.1\r\nHost: allowed.example\r\nConnection: close\r\n\r\n")
	response, err := http.ReadResponse(bufio.NewReader(secure), &http.Request{Method: "GET"})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	secure.Close()
	if string(body) != "tls-ok" || calls.Load() != 1 {
		t.Fatalf("body=%s dials=%d", body, calls.Load())
	}
	deadline := time.Now().Add(time.Second)
	for logs.snapshot() == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	var event struct {
		Allowed        bool `json:"allowed"`
		Sent, Received int64
	}
	text := logs.snapshot()
	if err := json.Unmarshal([]byte(strings.TrimSpace(text)), &event); err != nil {
		t.Fatal(err)
	}
	if !event.Allowed || !strings.Contains(text, `"bytes_sent":`) || strings.Contains(text, "GET /") {
		t.Fatalf("log=%s", text)
	}
}

func TestConnectSNIDenied(t *testing.T) {
	for _, name := range []string{"other.example", ""} {
		t.Run(name, func(t *testing.T) {
			var dials atomic.Int32
			logs := &logBuffer{}
			address, _ := startProxy(t, Config{Allowlist: mustList(t, "allowed.example:443"), Resolver: &fakeResolver{addresses: []netip.Addr{netip.MustParseAddr("1.1.1.1")}}, Logger: slog.New(slog.NewJSONHandler(logs, nil)), DialContext: func(context.Context, string, string) (net.Conn, error) {
				dials.Add(1)
				return nil, fmt.Errorf("unexpected dial")
			}})
			conn := openTunnel(t, address, "allowed.example:443")
			secure := tls.Client(conn, &tls.Config{ServerName: name, InsecureSkipVerify: true})
			if err := secure.Handshake(); err == nil {
				t.Fatal("mismatched/missing SNI succeeded")
			}
			secure.Close()
			if dials.Load() != 0 {
				t.Fatal("unapproved hello reached upstream")
			}
			deadline := time.Now().Add(time.Second)
			for logs.snapshot() == "" && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			if text := logs.snapshot(); !strings.Contains(text, `"allowed":false`) || !strings.Contains(text, "SNI không khớp") {
				t.Fatalf("log: %s", text)
			}
		})
	}
}

func TestUnixSocket(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("socket permissions are Unix-specific")
	}
	// Keep the path within Unix's short sun_path limit even when the workspace path is long.
	dir := t.TempDir()
	path := filepath.Join(dir, "egress.sock")
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	relativePath, err := filepath.Rel(cwd, path)
	if err != nil {
		t.Fatal(err)
	}
	if len(relativePath) < len(path) {
		path = relativePath
	}
	listeners, err := Listen("127.0.0.1:0", path)
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("socket permissions: %v %v", info, err)
	}
	if _, err := Listen("", path); err == nil {
		t.Fatal("must not replace another proxy's socket")
	}
	p, _ := New(Config{Allowlist: mustList(t, ""), Logger: slog.New(slog.NewJSONHandler(io.Discard, nil))})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- p.Serve(ctx, listeners...) }()
	conn, err := net.Dial("unix", path)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	fmt.Fprint(conn, "GET http://denied.example/ HTTP/1.1\r\nHost: denied.example\r\n\r\n")
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 403 {
		t.Fatal(response.StatusCode)
	}
	response.Body.Close()
	conn.Close()
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("socket not cleaned: %v", err)
	}
}

func syntheticHello(name string, ech bool) []byte {
	data := append([]byte{3, 3}, make([]byte, 32)...)
	data = append(data, 0, 0, 2, 0x13, 1, 1, 0)
	var extensions []byte
	if name != "" {
		names := append([]byte{0, byte(len(name) >> 8), byte(len(name))}, []byte(name)...)
		value := append([]byte{byte(len(names) >> 8), byte(len(names))}, names...)
		extensions = append(extensions, 0, 0, byte(len(value)>>8), byte(len(value)))
		extensions = append(extensions, value...)
	}
	if ech {
		extensions = append(extensions, 0xfe, 0x0d, 0, 1, 0)
	}
	data = append(data, byte(len(extensions)>>8), byte(len(extensions)))
	data = append(data, extensions...)
	return append([]byte{1, byte(len(data) >> 16), byte(len(data) >> 8), byte(len(data))}, data...)
}
func tlsRecord(data []byte) []byte {
	return append([]byte{22, 3, 1, byte(len(data) >> 8), byte(len(data))}, data...)
}

func TestClientHelloParser(t *testing.T) {
	hello := syntheticHello("BÜCHER.example.", false)
	wire := append(tlsRecord(hello[:3]), tlsRecord(hello[3:])...)
	got, name, err := readHello(bytes.NewReader(wire))
	if err != nil || name != "xn--bcher-kva.example" || !bytes.Equal(got, wire) {
		t.Fatalf("%s %v", name, err)
	}
	for _, bad := range [][]byte{tlsRecord(syntheticHello("allowed.example", true)), tlsRecord([]byte{2, 0, 0, 0}), {22, 3, 1, 0xff, 0xff}, tlsRecord([]byte{1, 0xff, 0xff, 0xff}), {1, 2, 3}, tlsRecord([]byte{1, 0, 0, 0})} {
		if _, _, err := readHello(bytes.NewReader(bad)); err == nil {
			t.Fatalf("accepted invalid hello %x", bad)
		}
	}
	data := syntheticHello("allowed.example", false)
	data = append(data, 0, 0, 0, 0)
	binary.BigEndian.PutUint16(data[45:47], uint16(len(data)-47))
	data[3] = byte(len(data) - 4)
	if _, _, err := readHello(bytes.NewReader(tlsRecord(data))); err == nil {
		t.Fatal("duplicate SNI extension accepted")
	}
}

func TestConnectIdleTimeoutAndShutdown(t *testing.T) {
	address, p := startProxy(t, Config{Allowlist: mustList(t, "allowed.example:443"), Resolver: &fakeResolver{addresses: []netip.Addr{netip.MustParseAddr("1.1.1.1")}}, ConnectTimeout: 50 * time.Millisecond, IdleTimeout: 50 * time.Millisecond})
	conn := openTunnel(t, address, "allowed.example:443")
	var data [8]byte
	_, _ = conn.Read(data[:])
	if _, err := conn.Read(data[:]); err == nil {
		t.Fatal("idle tunnel remained open")
	}
	p.mu.Lock()
	count := len(p.tunnels)
	p.mu.Unlock()
	if count != 0 {
		t.Fatalf("leaked tunnel: %d", count)
	}
}

func TestConnectExplicitIP(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ip-ok") }))
	defer upstream.Close()
	target := strings.TrimPrefix(upstream.URL, "https://")
	address, _ := startProxy(t, Config{Allowlist: mustList(t, target)})
	conn := openTunnel(t, address, target)
	secure := tls.Client(conn, &tls.Config{InsecureSkipVerify: true})
	if err := secure.Handshake(); err != nil {
		t.Fatal(err)
	}
	fmt.Fprint(secure, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
	response, err := http.ReadResponse(bufio.NewReader(secure), nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	secure.Close()
	if string(body) != "ip-ok" {
		t.Fatalf("body=%s", body)
	}
}

func TestShutdownClosesActiveTunnel(t *testing.T) {
	p, err := New(Config{Allowlist: mustList(t, "allowed.example:443"), Resolver: &fakeResolver{addresses: []netip.Addr{netip.MustParseAddr("1.1.1.1")}}, Logger: slog.New(slog.NewJSONHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- p.Serve(ctx, listener) }()
	conn := openTunnel(t, listener.Addr().String(), "allowed.example:443")
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	var data [1]byte
	if _, err := conn.Read(data[:]); err == nil {
		t.Fatal("tunnel survived shutdown")
	}
}

func TestHTTPRejectsUpgradeWithoutDial(t *testing.T) {
	var dials atomic.Int32
	p, _ := New(Config{Allowlist: mustList(t, "allowed.example:80"), Resolver: &fakeResolver{addresses: []netip.Addr{netip.MustParseAddr("1.1.1.1")}}, Logger: slog.New(slog.NewJSONHandler(io.Discard, nil)), DialContext: func(context.Context, string, string) (net.Conn, error) {
		dials.Add(1)
		return nil, fmt.Errorf("unexpected dial")
	}})
	request := httptest.NewRequest("GET", "http://allowed.example/", nil)
	request.Header.Set("Upgrade", "websocket")
	response := httptest.NewRecorder()
	p.ServeHTTP(response, request)
	if response.Code != 403 || dials.Load() != 0 {
		t.Fatalf("status=%d dial=%d", response.Code, dials.Load())
	}
}

func TestHTTPHeaderTimeout(t *testing.T) {
	address, _ := startProxy(t, Config{Allowlist: mustList(t, ""), ConnectTimeout: 40 * time.Millisecond, IdleTimeout: time.Second})
	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(500 * time.Millisecond))
	fmt.Fprint(conn, "GET http://denied.example/ HTTP/1.1\r\nHost:")
	var data [1]byte
	if _, err := conn.Read(data[:]); err == nil {
		t.Fatal("unfinished headers accepted")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("proxy ignored header deadline")
	}
}
