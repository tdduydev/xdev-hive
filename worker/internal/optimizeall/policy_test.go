package optimizeall

import (
	"reflect"
	"testing"
)

func TestMergePolicies(t *testing.T) {
	cases := []struct {
		name     string
		policies map[string]Policy
		level    string
		levelBy  []string
		rtk      bool
		rtkBy    []string
		graph    bool
		window   *int
		windowBy []string
	}{
		{name: "không có chính sách thì balanced mặc định", level: "balanced"},
		{
			name:     "mức cao nhất thắng",
			policies: map[string]Policy{"a/x": {Level: "off"}, "b/y": {Level: "aggressive"}, "c/z": {Level: "balanced"}},
			level:    "aggressive", levelBy: []string{"b/y"},
		},
		{
			name:     "cùng mức thì ghi mọi dự án đòi mức đó",
			policies: map[string]Policy{"b/y": {Level: "balanced"}, "a/x": {Level: "balanced"}},
			level:    "balanced", levelBy: []string{"a/x", "b/y"},
		},
		{
			name:     "mức rỗng là balanced",
			policies: map[string]Policy{"a/x": {}},
			level:    "balanced", levelBy: []string{"a/x"},
		},
		{
			name:     "mọi dự án off thì off",
			policies: map[string]Policy{"a/x": {Level: "off"}, "b/y": {Level: "off"}},
			level:    "off", levelBy: []string{"a/x", "b/y"},
		},
		{
			name:     "rtk và codegraph là hoặc",
			policies: map[string]Policy{"a/x": {Level: "balanced", RTK: true}, "b/y": {Level: "balanced", Codegraph: true}},
			level:    "balanced", levelBy: []string{"a/x", "b/y"}, rtk: true, rtkBy: []string{"a/x"}, graph: true,
		},
		{
			name: "trần nén lấy nhỏ nhất",
			policies: map[string]Policy{
				"a/x": {Level: "balanced", AutoCompactWindow: intPtr(400_000)},
				"b/y": {Level: "balanced", AutoCompactWindow: intPtr(150_000)},
				"c/z": {Level: "balanced"},
			},
			level: "balanced", levelBy: []string{"a/x", "b/y", "c/z"}, window: intPtr(150_000), windowBy: []string{"b/y"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Merge(tc.policies)
			if err != nil {
				t.Fatal(err)
			}
			if got.Level != tc.level || !reflect.DeepEqual(got.LevelFrom, tc.levelBy) {
				t.Fatalf("mức %q từ %v, muốn %q từ %v", got.Level, got.LevelFrom, tc.level, tc.levelBy)
			}
			if got.RTK != tc.rtk || !reflect.DeepEqual(got.RTKFrom, tc.rtkBy) {
				t.Fatalf("rtk %v từ %v", got.RTK, got.RTKFrom)
			}
			if got.Codegraph != tc.graph {
				t.Fatalf("codegraph %v", got.Codegraph)
			}
			if !reflect.DeepEqual(got.AutoCompactWindow, tc.window) || !reflect.DeepEqual(got.AutoCompactFrom, tc.windowBy) {
				t.Fatalf("trần nén %v từ %v", got.AutoCompactWindow, got.AutoCompactFrom)
			}
		})
	}
}

func TestMergeRejectsInvalidPolicy(t *testing.T) {
	if _, err := Merge(map[string]Policy{"a/x": {Level: "max"}}); err == nil {
		t.Fatal("mức lạ phải lỗi")
	}
	if _, err := Merge(map[string]Policy{"a/x": {AutoCompactWindow: intPtr(10)}}); err == nil {
		t.Fatal("trần nén ngoài 50.000–1.000.000 phải lỗi")
	}
}

func TestParsePoliciesSkipsUnset(t *testing.T) {
	got, err := ParsePolicies([]byte(`{"a/x": null, "b/y": {"level": "aggressive", "rtk": true, "autoCompactWindow": null}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got["b/y"].Level != "aggressive" || !got["b/y"].RTK || got["b/y"].AutoCompactWindow != nil {
		t.Fatalf("chính sách đọc sai: %+v", got)
	}
	if _, err := ParsePolicies([]byte(`[]`)); err == nil {
		t.Fatal("file chính sách không phải đối tượng phải lỗi")
	}
}
