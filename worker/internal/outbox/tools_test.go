package outbox

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

const toolsFixturePath = "../../../packages/contracts/fixtures/client-write-tools.json"

func TestGroupsMatchContractsFixture(t *testing.T) {
	b, err := os.ReadFile(toolsFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Tools         map[string]string `json:"tools"`
		Procedures    map[string]string `json:"procedures"`
		MachineEvents map[string]string `json:"machineEvents"`
	}
	if err := json.Unmarshal(b, &fx); err != nil {
		t.Fatal(err)
	}
	for name, pair := range map[string][2]map[string]string{
		"tools":         {fx.Tools, toolGroups},
		"procedures":    {fx.Procedures, procedureGroups},
		"machineEvents": {fx.MachineEvents, machineEventGroups},
	} {
		if !reflect.DeepEqual(pair[0], pair[1]) {
			t.Errorf("%s lệch fixture:\nfixture %v\ngo      %v", name, pair[0], pair[1])
		}
	}
}

func TestGroupOf(t *testing.T) {
	for _, c := range []struct {
		transport, kind, group string
		ok                     bool
	}{
		{TransportMCP, "task_update", GroupProgress, true},
		{TransportMCP, "artifact_create", GroupImmediate, true},
		{TransportRPC, "memory.write", GroupProposal, true},
		{TransportWorker, KindTokenScore, GroupProgress, true},
		{TransportMCP, "memory.write", "", false},
		{TransportRPC, "task_update", "", false},
		{"ftp", "task_update", "", false},
	} {
		g, ok := GroupOf(c.transport, c.kind)
		if g != c.group || ok != c.ok {
			t.Errorf("GroupOf(%s, %s) = %q, %v; muốn %q, %v", c.transport, c.kind, g, ok, c.group, c.ok)
		}
	}
	if Queueable(GroupImmediate) || !Queueable(GroupProgress) || !Queueable(GroupProposal) {
		t.Error("Queueable sai nhóm")
	}
}
