package optimizeall

import (
	"errors"
	"fmt"
	"os"
)

// Undo đảo lần tối ưu runID (FR-013): các bước ok và hoàn tác được, theo thứ tự ngược. Chỉ lần gần nhất chưa hoàn tác
// được đảo, như ngăn xếp score-fixes của 025, để không đảo một lần cũ đè lên thay đổi của lần mới hơn. File bị sửa tay
// sau lần tối ưu thì bước đụng file đó được bỏ và báo lại; các bước khác vẫn đảo.
func (r *Runner) Undo(runID string) (*OptimizeRun, error) {
	unlock, err := Lock(r.Dir)
	if err != nil {
		return nil, err
	}
	defer unlock()
	if !validRunID(runID) {
		return nil, &Error{Code: CodeRunNotFound, Message: fmt.Sprintf("Không có lần tối ưu %q", runID)}
	}
	run, err := r.readRun(runID)
	if errors.Is(err, os.ErrNotExist) {
		return nil, &Error{Code: CodeRunNotFound, Message: fmt.Sprintf("Không có lần tối ưu %s (chỉ giữ %d lần gần nhất)", runID, keepRuns)}
	}
	if err != nil {
		return nil, err
	}
	if run.UndoneAt != nil {
		return nil, &Error{Code: CodeAlreadyUndone, Message: "Lần tối ưu này đã được hoàn tác"}
	}
	ids, err := r.runIDs()
	if err != nil {
		return nil, err
	}
	for i := len(ids) - 1; i >= 0 && ids[i] != runID; i-- {
		later, err := r.readRun(ids[i])
		if err != nil {
			return nil, err
		}
		if later.UndoneAt == nil {
			return nil, &Error{Code: CodeNotLatest, Message: "Chỉ hoàn tác được lần tối ưu gần nhất"}
		}
	}

	edited := r.editedFiles(run)
	for i := len(run.Steps) - 1; i >= 0; i-- {
		s := &run.Steps[i]
		if s.Status != StatusOK || !s.Undoable || s.Undo == nil {
			continue
		}
		if f := firstEdited(s.Undo, edited); f != "" {
			s.Error = strPtr(fmt.Sprintf("File %s đã bị sửa sau lần tối ưu nên không hoàn tác bước này", f))
		} else if err := r.undoStep(s); err != nil {
			s.Error = strPtr("Không hoàn tác được: " + err.Error())
		} else {
			s.Status, s.Error = StatusUndone, nil
		}
		if err := r.writeRun(run); err != nil {
			return run, err
		}
	}
	at := r.now().UTC()
	run.UndoneAt = &at
	return run, r.writeRun(run)
}

// editedFiles so từng file với mã băm của bước cuối cùng đã ghi nó: các bước sau trong cùng lần chạy cũng ghi file đó
// (bật tối ưu rồi bật RTK cùng settings.json), nên chỉ trạng thái cuối mới là thứ Hive để lại.
func (r *Runner) editedFiles(run *OptimizeRun) map[string]bool {
	last := map[string]string{}
	for _, s := range run.Steps {
		if s.Status != StatusOK || s.Undo == nil {
			continue
		}
		for path, sum := range s.Undo.Files {
			last[path] = sum
		}
	}
	edited := map[string]bool{}
	for path, sum := range last {
		if hashFile(path) != sum {
			edited[path] = true
		}
	}
	return edited
}

func firstEdited(u *Undo, edited map[string]bool) string {
	for _, path := range sortedKeys(u.Files) {
		if edited[path] {
			return path
		}
	}
	return ""
}

func (r *Runner) undoStep(s *RunStep) error {
	u := s.Undo
	switch u.Kind {
	case UndoOptimizer:
		if r.Optimizer == nil {
			return errors.New("chưa có bộ tối ưu")
		}
		p := u.profileOf()
		if u.PrevEnabled != nil && *u.PrevEnabled {
			// Gói đã bật mức khác từ trước: bật lại mức đó, không trả về file trước lần bật đầu.
			if r.Enabler == nil {
				return errors.New("chưa có bộ bật tối ưu")
			}
			_, err := r.Enabler.Enable(p, EnableRequest{Level: u.PrevLevel, RTK: u.PrevRTK, Explicit: true})
			return err
		}
		if u.Backup != "" {
			_, err := r.Optimizer.Restore(p, u.Backup)
			return err
		}
		// Không có bản sao lưu: file chưa có trước khi bật (Disable xoá nó) hoặc bật không đổi gì.
		_, err := r.Optimizer.Disable(p)
		return err
	case UndoScoreFix:
		if r.Fixer == nil {
			return errors.New("chưa có bộ chạy sửa nhanh")
		}
		return r.Fixer.Undo(FixRequest{FixID: s.ID[len(fixPrefix):], Profile: u.Profile, Project: u.Project}, u.Record)
	case UndoMemstore:
		if u.Entry == "" {
			return nil
		}
		_, err := r.Store.Restore(u.Entry)
		return err
	}
	return fmt.Errorf("không biết cách hoàn tác %q", u.Kind)
}
