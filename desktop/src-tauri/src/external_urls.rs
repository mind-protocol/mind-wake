//! Only explicit HTTP(S) clicks can leave the conversation webview.
pub fn checked_url(value: &str) -> Result<String, String> {
    if value.len() > 8192 || value.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\\')
        || !(value.to_ascii_lowercase().starts_with("https://") || value.to_ascii_lowercase().starts_with("http://")) {
        return Err("Lien HTTP(S) invalide".into());
    }
    let url = tauri::Url::parse(value).map_err(|_| "Lien HTTP(S) invalide")?;
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("Lien HTTP(S) invalide".into());
    }
    Ok(url.to_string())
}

pub fn open(value: &str) -> Result<(), String> {
    let url = checked_url(value)?;
    #[cfg(windows)]
    {
        #[link(name = "shell32")]
        unsafe extern "system" {
            fn ShellExecuteW(window: *mut std::ffi::c_void, operation: *const u16, file: *const u16,
                parameters: *const u16, directory: *const u16, show: i32) -> isize;
        }
        let operation: Vec<u16> = "open\0".encode_utf16().collect();
        let target: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        // No shell command, interpolation or file opening: only the validated URL is passed.
        let result = unsafe { ShellExecuteW(std::ptr::null_mut(), operation.as_ptr(), target.as_ptr(),
            std::ptr::null(), std::ptr::null(), 1) };
        if result <= 32 { return Err("Impossible d’ouvrir le navigateur".into()); }
        Ok(())
    }
    #[cfg(not(windows))]
    { let _ = url; Err("Ouverture du navigateur disponible sous Windows".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_web_urls_without_credentials_or_shell_interpretation() {
        assert_eq!(checked_url("https://example.org/a?x=1&y=2#source").unwrap(), "https://example.org/a?x=1&y=2#source");
        assert!(checked_url("http://localhost:3000/page").is_ok());
        for value in ["javascript:alert(1)", "file:///C:/secret", "ms-settings:display", "https://", "https://a@host/", "https://host/\nattack", "https://host/\\attack", " https://host/", "//host/path"] {
            assert!(checked_url(value).is_err(), "{value}");
        }
    }
}
