package hubclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRegister(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/worker/register" {
			http.NotFound(w, r)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["registrationToken"] != "hwr_x" || body["machineId"] != "build-01" || body["os"] != "linux" || body["capacity"] != float64(2) {
			t.Errorf("body = %v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"00000000-0000-4000-8000-000000000001","orgId":"00000000-0000-4000-8000-000000000002","teamId":"00000000-0000-4000-8000-000000000003","machineId":"build-01","machineToken":"hwm_y"}`))
	}))
	defer srv.Close()

	reg, err := New(srv.URL).Register(context.Background(), RegisterRequest{RegistrationToken: "hwr_x", MachineID: "build-01", OS: "linux", Version: "1.0.0", CLIs: []string{"claude"}, Capacity: 2})
	if err != nil {
		t.Fatal(err)
	}
	if reg.MachineToken != "hwm_y" || reg.TeamID != "00000000-0000-4000-8000-000000000003" {
		t.Fatalf("reg = %+v", reg)
	}
}

func TestRegisterRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"defined":true,"code":"UNAUTHORIZED","status":401,"message":"Mã đăng ký không hợp lệ, đã hết hạn hoặc đã dùng."}`))
	}))
	defer srv.Close()

	_, err := New(srv.URL).Register(context.Background(), RegisterRequest{RegistrationToken: "hwr_x", MachineID: "m", OS: "linux"})
	if err == nil || !strings.Contains(err.Error(), "Mã đăng ký không hợp lệ") {
		t.Fatalf("err = %v", err)
	}
}
