package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

// projectsView là kết quả của `hive-worker projects --json` cho app desktop. Exists cho app biết đã nhập danh sách của
// app v1 lần nào chưa.
type projectsView struct {
	Path     string          `json:"path"`
	Exists   bool            `json:"exists"`
	Imported int             `json:"imported"`
	Projects []projects.View `json:"projects"`
}

// projectsHome là thư mục nhà, nơi có cấu hình app v1; test thay.
var projectsHome = os.UserHomeDir

const projectsUsage = "Cách dùng: hive-worker projects [bind --id ID --folder THƯ_MỤC [--name TÊN] [--repo-url URL] | unbind (--id ID | --folder THƯ_MỤC) | set --id ID --full=true|false | import-legacy [--from FILE] [--force]] [--json]"

// projectsCommand: dự án của hub gắn với repo trên máy và công tắc toàn quyền theo dự án (ADR 0020). Không đối số thì
// liệt kê; lệnh con sửa projects.json rồi in lại danh sách.
func projectsCommand(args []string, stdout, stderr io.Writer) int {
	action := "list"
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		action, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("projects "+action, flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", "", "file cấu hình worker (projects.json nằm cạnh)")
	asJSON := fs.Bool("json", false, "in dạng JSON (cho app desktop)")
	id := fs.String("id", "", "id dự án trên hub")
	folder := fs.String("folder", "", "thư mục repo trên máy")
	name := fs.String("name", "", "tên hiển thị")
	repoURL := fs.String("repo-url", "", "URL repo của dự án; có thì kiểm remote origin của thư mục khớp")
	full := fs.String("full", "", "true hoặc false")
	from := fs.String("from", "", "file cấu hình của app v1 (mặc định ~/.xdev-hive/config.json)")
	force := fs.Bool("force", false, "nhập lại dù projects.json đã có")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	path, err := pathOr(*configPath)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	file := projects.DefaultPath(path)
	view := projectsView{Path: file}
	fail := func(err error) int {
		fmt.Fprintln(stderr, err)
		return 1
	}
	switch action {
	case "list":
	case "bind":
		if *id == "" || *folder == "" {
			fmt.Fprintln(stderr, projectsUsage)
			return 2
		}
		if err := projects.Bind(file, *id, *folder, *name, *repoURL); err != nil {
			return fail(err)
		}
	case "unbind":
		switch {
		case *id != "":
			_, err = projects.Unbind(file, *id)
		case *folder != "":
			_, err = projects.UnbindFolder(file, *folder)
		default:
			fmt.Fprintln(stderr, projectsUsage)
			return 2
		}
		if err != nil {
			return fail(err)
		}
	case "set":
		on, perr := strconv.ParseBool(*full)
		if *id == "" || perr != nil {
			fmt.Fprintln(stderr, "Cách dùng: hive-worker projects set --id ID --full=true|false")
			return 2
		}
		if err := projects.SetFull(file, *id, on); err != nil {
			return fail(err)
		}
	case "import-legacy":
		legacy := *from
		if legacy == "" {
			home, err := projectsHome()
			if err != nil {
				return fail(err)
			}
			legacy = projects.LegacyPath(home)
		}
		if view.Imported, err = projects.ImportLegacy(legacy, file, *force); err != nil {
			return fail(err)
		}
	default:
		fmt.Fprintln(stderr, projectsUsage)
		return 2
	}
	list, err := projects.Load(file)
	if err != nil {
		return fail(err)
	}
	view.Exists = fileExists(file)
	view.Projects = projects.Inspect(list)
	if *asJSON {
		_ = json.NewEncoder(stdout).Encode(view)
		return 0
	}
	if view.Imported > 0 {
		fmt.Fprintf(stdout, "Đã nhập %d repo từ app v1 vào %s.\n", view.Imported, file)
	}
	if len(view.Projects) == 0 {
		fmt.Fprintf(stdout, "Chưa gắn dự án nào với repo trên máy (%s); run dùng repo cache của worker.\n", file)
		return 0
	}
	for _, p := range view.Projects {
		id := p.ProjectID
		if id == "" {
			id = "(chưa có trên hub)"
		}
		state := "đã gắn"
		switch {
		case !p.Exists:
			state = "thư mục mất"
		case !p.IsGit:
			state = "không phải repo git"
		case p.FullPermission:
			state = "đã gắn, toàn quyền"
		}
		fmt.Fprintf(stdout, "%-36s %-20s %s (%s)\n", id, p.Name, p.Folder, state)
	}
	return 0
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
