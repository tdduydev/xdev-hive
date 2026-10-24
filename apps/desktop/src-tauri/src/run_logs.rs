use tauri::AppHandle;

fn read_args(id: &str, offset: u64) -> Result<Vec<String>, String> {
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Mã run không hợp lệ.".into());
    }
    Ok(vec![
        "runs".into(),
        "log".into(),
        id.into(),
        "--json".into(),
        format!("--offset={offset}"),
    ])
}

/// Worker kiểm cùng người dùng qua socket; app không tự mở đường dẫn do hub gửi tới.
#[tauri::command]
pub async fn read_run_log(
    app: AppHandle,
    id: String,
    offset: u64,
) -> Result<serde_json::Value, String> {
    crate::sidecar_json(&app, read_args(&id, offset)?, vec![]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_id_and_keeps_offsets() {
        assert!(read_args("../run", 0).is_err());
        assert!(read_args("--json", 0).is_ok());
        assert_eq!(
            read_args("run-1", 42).unwrap().last().unwrap(),
            "--offset=42"
        );
    }
}
