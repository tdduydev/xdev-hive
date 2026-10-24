; Bộ cài của Tauri chỉ dừng app chính trước khi chép. Sidecar còn chạy (worker chưa thoát hẳn, terminal bọc
; `secrets exec`, lệnh `hive`) thì Windows khoá file, bản cập nhật passive bỏ qua lỗi ghi: app lên bản mới nhưng worker
; vẫn bản cũ và không hiểu lệnh mới. Dừng đúng các file trong thư mục cài (Restart Manager theo đường dẫn), không đụng
; worker chạy từ chỗ khác.

!macro HIVE_STOP_SIDECARS
  !insertmacro CheckIfAppIsRunning "$INSTDIR\hive-worker.exe" "${PRODUCTNAME}"
  !insertmacro CheckIfAppIsRunning "$INSTDIR\hive.exe" "${PRODUCTNAME}"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro HIVE_STOP_SIDECARS
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro HIVE_STOP_SIDECARS
!macroend
