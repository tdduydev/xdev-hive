package egress

import (
	"context"
	"net/netip"
	"strings"
	"testing"
)

func mustList(t *testing.T, text string) *Allowlist {
	t.Helper()
	list, err := Parse(strings.NewReader(text))
	if err != nil {
		t.Fatal(err)
	}
	return list
}

func TestAllowlist(t *testing.T) {
	list := mustList(t, "# closed by default\nAPI.Example.:443\n*.packages.example:80\nbücher.example。:443\n10.0.0.0/8:8443\n127.0.0.1:443\n[2001:db8::/32]:443\n")
	for _, tc := range []struct {
		host, port string
		want       bool
	}{
		{"api.example", "443", true}, {"api.example", "80", false}, {"x.api.example", "443", false},
		{"x.packages.example", "80", true}, {"a.b.packages.example", "80", true}, {"packages.example", "80", false},
		{"x.packages.example.evil", "80", false}, {"badpackages.example", "80", false}, {"xn--bcher-kva.example", "443", true},
		{"10.1.2.3", "8443", true}, {"10.1.2.3", "443", false}, {"127.0.0.1", "443", true}, {"127.0.0.2", "443", false},
		{"2001:db8::1", "443", true}, {"2001:db9::1", "443", false},
	} {
		t.Run(tc.host+":"+tc.port, func(t *testing.T) {
			if got := list.allowsHost(tc.host, tc.port); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
	if mustList(t, "").allowsHost("api.example", "443") {
		t.Fatal("empty policy must deny")
	}
}

func TestNormalizeHost(t *testing.T) {
	for input, want := range map[string]string{"API.EXAMPLE.": "api.example", "BÜCHER.example。": "xn--bcher-kva.example", "127.0.0.1": "127.0.0.1"} {
		got, err := normalizeHost(input)
		if err != nil || got != want {
			t.Fatalf("%s: %s %v", input, got, err)
		}
	}
	for _, input := range []string{"", "*.example", "a..example", "example..", "-a.example", "a-.example", "a/b.example", "user@example", "127.1", "2130706433", "fe80::1%lo0", strings.Repeat("a", 64) + ".example"} {
		if _, err := normalizeHost(input); err == nil {
			t.Fatalf("accepted %q", input)
		}
	}
}

func TestInvalidPolicy(t *testing.T) {
	for _, entry := range []string{"example:0", "example:65536", "example:https", "https://example", "*.127.0.0.1", "*", "*.example:443:80", "10.0.0.0/33", "[::ffff:127.0.0.0/120]:443", "api_example"} {
		if _, err := Parse(strings.NewReader(entry)); err == nil {
			t.Fatalf("accepted %q", entry)
		}
	}
}

type fakeResolver struct {
	addresses []netip.Addr
	calls     int
}

func (r *fakeResolver) LookupNetIP(_ context.Context, network, host string) ([]netip.Addr, error) {
	r.calls++
	return r.addresses, nil
}

func TestResolveRebindingAndIPv6(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.100.100.200", "224.0.0.1", "0.0.0.0", "240.1.1.1", "168.63.129.16", "::1", "fd00:ec2::254", "fe80::1", "ff02::1", "2606:4700::1111", "::ffff:127.0.0.1"} {
		t.Run(address, func(t *testing.T) {
			resolver := &fakeResolver{addresses: []netip.Addr{netip.MustParseAddr(address)}}
			proxy, err := New(Config{Allowlist: mustList(t, "allowed.example:443"), Resolver: resolver})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := proxy.resolve(context.Background(), "allowed.example", "443"); err == nil {
				t.Fatalf("allowed %s", address)
			}
		})
	}
	resolver := &fakeResolver{addresses: []netip.Addr{netip.MustParseAddr("1.1.1.1"), netip.MustParseAddr("10.0.0.1")}}
	proxy, _ := New(Config{Allowlist: mustList(t, "allowed.example"), Resolver: resolver})
	if _, err := proxy.resolve(context.Background(), "allowed.example", "443"); err == nil {
		t.Fatal("mixed public/private DNS must fail closed")
	}
	proxy.config.Allowlist = mustList(t, "allowed.example:443\n10.0.0.0/8:443")
	if _, err := proxy.resolve(context.Background(), "allowed.example", "443"); err != nil {
		t.Fatal(err)
	}
	if _, err := proxy.resolve(context.Background(), "denied.example", "443"); err == nil {
		t.Fatal("IP exception cannot authorize another domain")
	}
	resolver.addresses = []netip.Addr{netip.MustParseAddr("1.1.1.1"), netip.MustParseAddr("2606:4700::1111")}
	destination, err := proxy.resolve(context.Background(), "allowed.example", "443")
	if err != nil || len(destination.addresses) != 1 || !destination.addresses[0].Is4() {
		t.Fatalf("dual stack: %+v %v", destination, err)
	}
	proxy.config.Allowlist = mustList(t, "[2606:4700::1111]:443")
	if _, err := proxy.resolve(context.Background(), "2606:4700::1111", "443"); err == nil {
		t.Fatal("explicit IPv6 must still be disabled")
	}
	proxy.config.AllowIPv6 = true
	if _, err := proxy.resolve(context.Background(), "2606:4700::1111", "443"); err != nil {
		t.Fatal(err)
	}
	proxy.config.Allowlist = mustList(t, "allowed.example:443")
	for _, address := range []string{"fd00:ec2::254", "::1", "64:ff9b::a00:1", "2002:a00:1::"} {
		resolver.addresses = []netip.Addr{netip.MustParseAddr(address)}
		if _, err := proxy.resolve(context.Background(), "allowed.example", "443"); err == nil {
			t.Fatalf("IPv6 exception flag allowed private/translation %s", address)
		}
	}
}
