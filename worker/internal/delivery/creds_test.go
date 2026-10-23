package delivery

import "testing"

func TestReadCredential(t *testing.T) {
	r := MapCredentials{"jenkins-prod": "bot:tok", "empty": ""}
	if v, err := readCredential(r, "jenkins-prod"); err != nil || string(v) != "bot:tok" {
		t.Fatalf("v=%q err=%v", v, err)
	}
	if _, err := readCredential(r, "missing"); CodeOf(err) != CodeMissingCredential {
		t.Fatalf("got %v", err)
	}
	if _, err := readCredential(r, "empty"); CodeOf(err) != CodeMissingCredential {
		t.Fatalf("got %v", err)
	}
	if _, err := readCredential(r, "Bad Name"); CodeOf(err) != CodeBadRequest {
		t.Fatalf("got %v", err)
	}
	if _, err := readCredential(nil, "x"); CodeOf(err) != CodeMissingCredential {
		t.Fatalf("got %v", err)
	}
}
