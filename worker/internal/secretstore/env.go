package secretstore

import (
	"runtime"
	"strings"
)

func MergeEnv(base []string, granted map[string]string) []string {
	out := make([]string, 0, len(base)+len(granted))
	for _, kv := range base {
		name, _, _ := strings.Cut(kv, "=")
		lookup := name
		if runtime.GOOS == "windows" {
			lookup = strings.ToUpper(name)
		}
		if _, ok := granted[lookup]; ok && ValidName(lookup) == nil {
			continue
		}
		out = append(out, kv)
	}
	for name, value := range granted {
		if ValidName(name) == nil {
			out = append(out, name+"="+value)
		}
	}
	return out
}
