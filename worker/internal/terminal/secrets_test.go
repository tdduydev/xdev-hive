package terminal

import (
	"context"
	"encoding/base64"
	"path/filepath"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
	"github.com/zalando/go-keyring"
)

func TestLocalSecretGrantOnlyForLocalOrigin(t *testing.T) {
	keyring.MockInit()
	dir := t.TempDir()
	cfg := filepath.Join(dir, "worker.json")
	value := "fake-terminal-credential-123456"
	if secretstore.NewStore().Set("DEMO_CREDENTIAL", value) != nil {
		t.Fatal("không tạo được kho giả")
	}
	if err := projects.WriteJSON(projects.DefaultPath(cfg), map[string]any{"projects": []projects.Project{{LocalID: "local", Name: "demo", Folder: dir}}}); err != nil {
		t.Fatal(err)
	}
	if err := secretstore.ModifyCatalog(secretstore.CatalogPath(cfg), func(c *secretstore.Catalog) error {
		_, err := c.Add("DEMO_CREDENTIAL", "Dùng thử", time.Now())
		if err != nil {
			return err
		}
		_, err = c.Assign("DEMO_CREDENTIAL", "local")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	l := Local{WorkerConfig: cfg}
	for _, origin := range []string{"", OriginLocal, OriginRemote} {
		g, err := l.localSecrets(context.Background(), "session", CreateParams{Cwd: dir, origin: origin})
		if err != nil {
			t.Fatal(err)
		}
		if origin == OriginRemote {
			if len(g.Values) != 0 {
				t.Fatal("phiên từ xa nhận bí mật")
			}
			continue
		}
		if g.Env["DEMO_CREDENTIAL"] != value {
			t.Fatal("phiên local không nhận đúng env")
		}
		encoded := base64.StdEncoding.EncodeToString([]byte(value))
		if got := feed(newRedactor(g.Values), encoded[:8], encoded[8:]); got != "***" {
			t.Fatal("bản ghi terminal chưa che")
		}
	}
}
