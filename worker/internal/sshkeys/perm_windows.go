//go:build windows

package sshkeys

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

// restrictPrivate đặt DACL được bảo vệ (không kế thừa) cho người dùng hiện tại, SYSTEM và Administrators: OpenSSH của
// Windows từ chối khoá riêng mà tài khoản khác đọc được, và chỉ chấp nhận ba chủ thể này.
func restrictPrivate(path string) error {
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		return err
	}
	sid := user.User.Sid.String()
	sd, err := windows.SecurityDescriptorFromString(fmt.Sprintf("O:%sD:P(A;;FA;;;%s)(A;;FA;;;SY)(A;;FA;;;BA)", sid, sid))
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		owner, nil, dacl, nil)
}

// newFileMode: file mới trên Windows nhận ACL kế thừa từ ~/.ssh, giống file ssh tự tạo.
func newFileMode(string, os.FileMode) error { return nil }

// copySecurity chép owner và DACL của file cũ sang file tạm. Đổi tên đè giữ ACL của file tạm, nên không chép thì file
// mới mất ACL riêng của file cũ (người dùng có thể đã siết lại để OpenSSH chấp nhận config).
func copySecurity(from, to string) error {
	sd, err := windows.GetNamedSecurityInfo(from, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	control, _, err := sd.Control()
	if err != nil {
		return err
	}
	info := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION | windows.UNPROTECTED_DACL_SECURITY_INFORMATION)
	if control&windows.SE_DACL_PROTECTED != 0 {
		info = windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION
	}
	if owner, _, err := sd.Owner(); err == nil && owner != nil {
		// Đặt owner khác người dùng hiện tại cần quyền SeRestorePrivilege: thử, không được thì giữ owner mặc định.
		_ = windows.SetNamedSecurityInfo(to, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION, owner, nil, nil, nil)
	}
	return windows.SetNamedSecurityInfo(to, windows.SE_FILE_OBJECT, info, nil, nil, dacl, nil)
}
