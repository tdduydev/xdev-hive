package branches

import (
	"context"
	"testing"
)

// mergeNoFF tạo nhánh name từ main có một commit rồi merge vào main bằng merge commit; trả đỉnh của nhánh.
func mergeNoFF(t testing.TB, dir, name string) string {
	t.Helper()
	gitT(t, dir, "switch", "-q", "-c", name, "main")
	commit(t, dir, name)
	tip := gitT(t, dir, "rev-parse", "HEAD")
	gitT(t, dir, "switch", "-q", "main")
	gitT(t, dir, "merge", "-q", "--no-ff", "-m", "Merge "+name, name)
	return tip
}

func evidenceOf(t *testing.T, dir, ref string, tips ...string) map[string]tipEvidence {
	t.Helper()
	got, err := testEnv(t).gitEvidence(context.Background(), dir, ref, tips)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestGitEvidenceKinds(t *testing.T) {
	isolateGit(t)
	dir := newRepo(t)
	merged := mergeNoFF(t, dir, "ai/merged")

	gitT(t, dir, "switch", "-q", "-c", "ai/ff", "main")
	commit(t, dir, "ff")
	ff := gitT(t, dir, "rev-parse", "HEAD")
	gitT(t, dir, "switch", "-q", "main")
	gitT(t, dir, "merge", "-q", "--ff-only", "ai/ff")

	gitT(t, dir, "switch", "-q", "-c", "ai/open", "main")
	commit(t, dir, "open")
	open := gitT(t, dir, "rev-parse", "HEAD")
	gitT(t, dir, "switch", "-q", "main")
	fresh := gitT(t, dir, "rev-parse", "main")

	// Đỉnh không là nhánh local (chỉ còn trong tag) đi đường hỏi riêng bằng rev-list.
	gitT(t, dir, "tag", "only-tag", merged)
	gitT(t, dir, "branch", "-D", "ai/merged")

	got := evidenceOf(t, dir, "refs/heads/main", merged, ff, open, fresh)
	want := map[string]Evidence{
		merged: {Kind: EvidenceMergedGit, Onto: "main"},
		ff:     {Kind: EvidenceNone, Note: NoteNoOwnCommits},
		open:   {Kind: EvidenceNone, Note: NoteNotMerged},
		fresh:  {Kind: EvidenceNone, Note: NoteNoOwnCommits},
	}
	for tip, w := range want {
		if got[tip].Evidence != w {
			t.Errorf("%s: %+v, muốn %+v", tip, got[tip].Evidence, w)
		}
	}
	if !got[merged].inDefault || !got[ff].inDefault || got[open].inDefault || !got[fresh].inDefault {
		t.Fatalf("inDefault sai: %+v", got)
	}
}

func TestGitEvidenceOnto(t *testing.T) {
	isolateGit(t)
	_, _, folder := newRemote(t)
	tip := mergeNoFF(t, folder, "ai/a")
	gitT(t, folder, "push", "-q", "origin", "main")
	got := evidenceOf(t, folder, "refs/remotes/origin/main", tip)
	if got[tip].Evidence != (Evidence{Kind: EvidenceMergedGit, Onto: "origin/main"}) {
		t.Fatalf("%+v", got[tip])
	}
}

func TestGitEvidenceOlderThanWindow(t *testing.T) {
	isolateGit(t)
	old := firstParentWindow
	firstParentWindow = 3
	t.Cleanup(func() { firstParentWindow = old })

	dir := newRepo(t)
	oldTip := mergeNoFF(t, dir, "ai/old")
	commit(t, dir, "c1")
	commit(t, dir, "c2")
	newTip := mergeNoFF(t, dir, "ai/new")
	// Cửa sổ 3 commit first-parent: merge ai/new, c2, c1. Merge ai/old nằm ngoài.
	got := evidenceOf(t, dir, "refs/heads/main", oldTip, newTip)
	if got[oldTip].Evidence != (Evidence{Kind: EvidenceNone, Note: NoteOlderThanWindow}) || !got[oldTip].inDefault {
		t.Fatalf("ai/old: %+v", got[oldTip])
	}
	if got[newTip].Kind != EvidenceMergedGit {
		t.Fatalf("ai/new: %+v", got[newTip])
	}
	if msg := noEvidenceText(NoteOlderThanWindow); msg != "Cũ hơn 3 commit của nhánh mặc định, không rõ đã merge chưa." {
		t.Fatalf("câu báo: %q", msg)
	}
}

func TestGitEvidenceWindowNotFull(t *testing.T) {
	isolateGit(t)
	old := firstParentWindow
	firstParentWindow = 4
	t.Cleanup(func() { firstParentWindow = old })

	// Lịch sử first-parent vừa ngắn hơn cửa sổ: đã đọc hết nên merge cũ nhất vẫn là bằng chứng.
	dir := newRepo(t)
	tip := mergeNoFF(t, dir, "ai/a")
	commit(t, dir, "c1")
	got := evidenceOf(t, dir, "refs/heads/main", tip)
	if got[tip].Kind != EvidenceMergedGit {
		t.Fatalf("%+v", got[tip])
	}
}

func TestGitEvidenceNoDefault(t *testing.T) {
	isolateGit(t)
	dir := newRepo(t)
	tip := gitT(t, dir, "rev-parse", "HEAD")
	got := evidenceOf(t, dir, "", tip)
	if got[tip].Evidence != (Evidence{Kind: EvidenceNone, Note: NoteNoDefaultBranch}) || got[tip].inDefault {
		t.Fatalf("%+v", got[tip])
	}
	pub, err := GitEvidence(context.Background(), testEnv(t), dir, "refs/heads/main", []string{tip})
	if err != nil || pub[tip].Note != NoteNoOwnCommits {
		t.Fatalf("GitEvidence: %+v %v", pub, err)
	}
}
