package channel

import (
	"encoding/json"
	"testing"
)

func TestSecretPolicyProtocol(t *testing.T) {
	for _, raw := range loadFixtures(t) {
		var envelope struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &envelope) != nil {
			t.Fatal("fixture không hợp lệ")
		}
		if envelope.Type == "welcome" {
			var w Welcome
			if json.Unmarshal(raw, &w) != nil {
				t.Fatal("không đọc được welcome")
			}
			if w.Policy != nil {
				p := w.Policy.SecretInjection
				if p != "" && p != "allow" && p != "approve" && p != "deny" {
					t.Fatal("sai chính sách từ fixture")
				}
			}
		}
	}
	var w Welcome
	if json.Unmarshal([]byte(`{"policy":{"totpFallback":true,"secretInjection":"approve"}}`), &w) != nil || w.Policy.SecretInjection != "approve" {
		t.Fatal("mất trường chính sách")
	}
}
