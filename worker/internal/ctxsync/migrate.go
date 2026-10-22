package ctxsync

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/memstore"
)

// Migration là bản nháp chuyển memory dùng chung kiểu cũ (memstore.Share, spec 015) sang nguồn ngữ cảnh: người dùng xem
// trước rồi mới áp dụng (FR-007).
type Migration struct {
	Draft string   `json:"draft"`
	Files []string `json:"files"`
}

// sharedRecord là bản ghi dùng chung cũ của thư mục dự án; nil khi dự án không dùng cách cũ.
func (m Manager) sharedRecord(folder string) (*memstore.SharedRecord, error) {
	if folder == "" {
		return nil, nil
	}
	records, err := m.Store.Shared()
	if err != nil {
		return nil, err
	}
	key := memstore.ProjectKey(filepath.Clean(folder))
	for i, r := range records {
		if samePath(r.ProjectPath, folder) || r.Key == key {
			return &records[i], nil
		}
	}
	return nil, nil
}

// MigrationDraft ghép nguồn hiện tại với các file memory dùng chung cũ. nil khi dự án không dùng cách cũ.
func (m Manager) MigrationDraft(key string) (*Migration, error) {
	st, err := m.loadState(key)
	if err != nil {
		return nil, err
	}
	rec, err := m.sharedRecord(st.Folder)
	if err != nil || rec == nil {
		return nil, err
	}
	source, err := m.Source(key)
	if err != nil {
		return nil, err
	}
	return draftFrom(source, rec.SharedDir)
}

// ApplyMigration lưu bản nháp làm nguồn rồi tắt cách dùng chung cũ. Tắt trước khi lưu: Unshare trả mỗi gói một bản sao
// nên lỗi lưu nguồn không làm mất memory, còn lưu trước thì chạy lại sẽ ghép trùng.
func (m Manager) ApplyMigration(key string) (Migration, Project, error) {
	st, err := m.loadState(key)
	if err != nil {
		return Migration{}, Project{}, err
	}
	rec, err := m.sharedRecord(st.Folder)
	if err != nil {
		return Migration{}, Project{}, err
	}
	if rec == nil {
		return Migration{}, Project{}, ErrNoShared
	}
	source, err := m.Source(key)
	if err != nil {
		return Migration{}, Project{}, err
	}
	mig, err := draftFrom(source, rec.SharedDir)
	if err != nil {
		return Migration{}, Project{}, err
	}
	if _, err := m.Store.Unshare(rec.Key); err != nil {
		return *mig, Project{}, err
	}
	p, err := m.SaveSource(key, mig.Draft)
	return *mig, p, err
}

// ErrNoShared: dự án không dùng chia sẻ memory kiểu cũ nên không có gì để chuyển.
var ErrNoShared = errors.New("dự án không dùng chia sẻ memory kiểu cũ, không có gì để chuyển")

// IsNoShared cho bên gọi đổi lỗi sang mã not_found.
func IsNoShared(err error) bool { return errors.Is(err, ErrNoShared) }

func draftFrom(source, dir string) (*Migration, error) {
	mig := &Migration{Files: []string{}}
	var parts []string
	if s := strings.TrimSpace(normalize(source)); s != "" {
		parts = append(parts, s)
	}
	var files []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// MEMORY.md chỉ là mục lục trỏ tới các file khác; chép vào nguồn thì thành link chết.
		if d.Type().IsRegular() && strings.EqualFold(filepath.Ext(p), ".md") && !strings.EqualFold(d.Name(), "MEMORY.md") {
			files = append(files, p)
		}
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	sort.Strings(files)
	for _, p := range files {
		raw, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		text := strings.TrimSpace(stripFrontmatter(normalize(strings.TrimPrefix(string(raw), bom))))
		mig.Files = append(mig.Files, p)
		if text == "" {
			continue
		}
		rel, _ := filepath.Rel(dir, p)
		name := strings.TrimSuffix(filepath.ToSlash(rel), filepath.Ext(rel))
		parts = append(parts, "### "+name+"\n\n"+text)
	}
	if len(parts) > 0 {
		mig.Draft = strings.Join(parts, "\n\n") + "\n"
	}
	return mig, nil
}

// stripFrontmatter bỏ khối YAML đầu file memory của Claude (name, description, type): chỉ là siêu dữ liệu cho CLI.
func stripFrontmatter(text string) string {
	if !strings.HasPrefix(text, "---\n") {
		return text
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return text
	}
	rest := text[4+end+4:]
	if i := strings.IndexByte(rest, '\n'); i >= 0 {
		return rest[i+1:]
	}
	return ""
}
