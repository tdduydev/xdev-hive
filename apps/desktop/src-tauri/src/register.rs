//! Tách lệnh `hive-worker register --hub … --token …` mà admin đội dán từ web, và kiểm địa chỉ hub.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RegisterArgs {
    pub hub: String,
    pub token: String,
    pub machine: Option<String>,
}

/// Tách lệnh như shell: nháy đơn, nháy kép, dấu `\` thoát ký tự, và dòng nối bằng `\` (bash), `` ` `` (PowerShell),
/// `^` (cmd) để lệnh copy từ web chạy được trên mọi hệ điều hành dán vào cũng được.
fn split_words(input: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut has_word = false;
    let mut chars = input.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        match quote {
            Some('\'') => {
                if c == '\'' {
                    quote = None;
                } else {
                    cur.push(c);
                }
            }
            Some(_) => match c {
                '"' => quote = None,
                '\\' if matches!(chars.peek(), Some('"' | '\\')) => {
                    cur.push(chars.next().unwrap_or('\\'))
                }
                _ => cur.push(c),
            },
            None => match c {
                '\'' | '"' => {
                    quote = Some(c);
                    has_word = true;
                }
                '\\' | '`' | '^' if matches!(chars.peek(), Some('\n' | '\r')) => {
                    while matches!(chars.peek(), Some('\n' | '\r')) {
                        chars.next();
                    }
                }
                '\\' => {
                    if let Some(next) = chars.next() {
                        cur.push(next);
                        has_word = true;
                    }
                }
                c if c.is_whitespace() => {
                    if has_word {
                        words.push(std::mem::take(&mut cur));
                        has_word = false;
                    }
                }
                _ => {
                    cur.push(c);
                    has_word = true;
                }
            },
        }
    }
    if quote.is_some() {
        return Err("Lệnh thiếu dấu nháy đóng.".into());
    }
    if has_word {
        words.push(cur);
    }
    Ok(words)
}

/// Địa chỉ hub hợp lệ: http hoặc https, có host, không có user/mật khẩu, query hay fragment. Trả địa chỉ đã bỏ `/` cuối.
pub fn normalize_hub(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let url = url::Url::parse(raw).map_err(|_| format!("Địa chỉ hub không hợp lệ: {raw}"))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("Địa chỉ hub phải bắt đầu bằng https:// hoặc http://".into());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("Địa chỉ hub thiếu tên máy chủ.".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Địa chỉ hub không được có tài khoản, query hay #.".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn valid_machine(name: &str) -> bool {
    let mut chars = name.chars();
    let first_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    first_ok
        && name.len() <= 63
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Kiểm đủ trường như lúc nhập tay vào form.
pub fn validate(hub: &str, token: &str, machine: Option<&str>) -> Result<RegisterArgs, String> {
    let hub = normalize_hub(hub)?;
    let token = token.trim();
    if token.is_empty() {
        return Err("Nhập token đăng ký.".into());
    }
    if token.chars().any(char::is_whitespace) || token.len() > 500 {
        return Err("Token đăng ký không hợp lệ.".into());
    }
    let machine = machine.map(str::trim).filter(|m| !m.is_empty());
    if let Some(m) = machine
        && !valid_machine(m)
    {
        return Err("Tên máy chỉ gồm chữ thường, số và gạch ngang, tối đa 63 ký tự.".into());
    }
    Ok(RegisterArgs {
        hub,
        token: token.to_string(),
        machine: machine.map(str::to_string),
    })
}

/// Lấy `--hub`, `--token`, `--machine` từ lệnh dán vào (nhận cả `--hub=…` và một gạch như cờ của Go).
pub fn parse_register_command(input: &str) -> Result<RegisterArgs, String> {
    let words = split_words(input)?;
    let (mut hub, mut token, mut machine) = (None, None, None);
    let mut i = 0;
    while i < words.len() {
        let word = &words[i];
        let flag = word.trim_start_matches('-');
        if word.starts_with('-') {
            let (name, inline) = match flag.split_once('=') {
                Some((n, v)) => (n, Some(v.to_string())),
                None => (flag, None),
            };
            let slot = match name {
                "hub" => Some(&mut hub),
                "token" => Some(&mut token),
                "machine" => Some(&mut machine),
                _ => None,
            };
            if let Some(slot) = slot {
                let value = match inline {
                    Some(v) => v,
                    None => {
                        i += 1;
                        words
                            .get(i)
                            .cloned()
                            .ok_or_else(|| format!("Lệnh thiếu giá trị sau --{name}."))?
                    }
                };
                *slot = Some(value);
            }
        }
        i += 1;
    }
    let hub = hub.ok_or("Lệnh không có --hub.")?;
    let token = token.ok_or("Lệnh không có --token.")?;
    validate(&hub, &token, machine.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(hub: &str, token: &str, machine: Option<&str>) -> RegisterArgs {
        RegisterArgs {
            hub: hub.into(),
            token: token.into(),
            machine: machine.map(Into::into),
        }
    }

    #[test]
    fn lenh_thuong() {
        let got = parse_register_command(
            "hive-worker register --hub https://hive.example.com/ --token hwr_abc123",
        );
        assert_eq!(
            got,
            Ok(args("https://hive.example.com", "hwr_abc123", None))
        );
    }

    #[test]
    fn dau_bang_mot_gach_va_ten_may() {
        let got = parse_register_command(
            "./hive-worker register -hub=http://10.0.0.5:7780 --token=hwr_x --machine may-lan",
        );
        assert_eq!(
            got,
            Ok(args("http://10.0.0.5:7780", "hwr_x", Some("may-lan")))
        );
    }

    #[test]
    fn dau_nhay_va_dong_noi() {
        let bash =
            "hive-worker register \\\n  --hub 'https://hive.example.com' \\\n  --token \"hwr_q\"";
        let powershell =
            "hive-worker.exe register `\r\n --hub https://hive.example.com `\r\n --token hwr_q";
        let cmd = "hive-worker register ^\r\n --hub https://hive.example.com ^\r\n --token hwr_q";
        for input in [bash, powershell, cmd] {
            assert_eq!(
                parse_register_command(input),
                Ok(args("https://hive.example.com", "hwr_q", None)),
                "{input}"
            );
        }
    }

    #[test]
    fn bao_loi_ro_rang() {
        assert_eq!(
            parse_register_command("hive-worker register --hub https://h.example"),
            Err("Lệnh không có --token.".into())
        );
        assert_eq!(
            parse_register_command("--token abc"),
            Err("Lệnh không có --hub.".into())
        );
        assert_eq!(
            parse_register_command("--hub https://h.example --token"),
            Err("Lệnh thiếu giá trị sau --token.".into())
        );
        assert_eq!(
            parse_register_command("--hub 'https://h.example --token x"),
            Err("Lệnh thiếu dấu nháy đóng.".into())
        );
        assert!(parse_register_command("--hub ftp://h.example --token x").is_err());
        assert!(parse_register_command("--hub https://u:p@h.example --token x").is_err());
        assert!(
            parse_register_command("--hub https://h.example --token x --machine Máy_Lan").is_err()
        );
    }

    #[test]
    fn kiem_form_nhap_tay() {
        assert_eq!(
            validate(" https://h.example/ ", " hwr_1 ", Some(" ")),
            Ok(args("https://h.example", "hwr_1", None))
        );
        assert!(validate("https://h.example", "", None).is_err());
        assert!(validate("https://h.example", "co khoang trang", None).is_err());
        assert!(validate("hive.example.com", "x", None).is_err());
    }
}
