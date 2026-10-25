//! Pure helpers for untrusted names (no Tauri types, so they can be unit-tested on
//! their own: `rustc --edition 2021 --test src/sanitize.rs`).

/// A file name from a remote server made safe to create on Windows: never empty,
/// never "." or "..", never a path. Separators, drive colons, other reserved
/// characters and control characters become "_", as do trailing dots/spaces
/// (Windows drops those, so "x." would collide with "x"); device names get a "_".
pub fn safe_local_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .take(200)
        .collect();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
        s.push('_');
    }
    if s.chars().all(|c| c == '.' || c == '_') {
        s = format!("_{s}_");
    }
    let stem = s.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        s.insert(0, '_');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::safe_local_name;

    #[test]
    fn hostile_names_stay_inside_the_folder() {
        for hostile in ["..\\..\\evil.exe", "../x", "..", ".", "", "C:x", "a/b", "\\\\host\\share", "CON.txt", "com1", "nul", "x. ", "\u{1b}[31m", "a:stream"] {
            let s = safe_local_name(hostile);
            assert!(!s.is_empty() && s != "." && s != "..", "{hostile:?} -> {s:?}");
            assert!(!s.contains(['/', '\\', ':']), "{hostile:?} -> {s:?}");
            assert!(!s.ends_with('.') && !s.ends_with(' '), "{hostile:?} -> {s:?}");
            assert!(!s.chars().any(char::is_control), "{hostile:?} -> {s:?}");
            let stem = s.split('.').next().unwrap().to_ascii_uppercase();
            assert!(!["CON", "NUL", "COM1"].contains(&stem.as_str()), "{hostile:?} -> {s:?}");
        }
        assert_eq!(safe_local_name("ok.txt"), "ok.txt");
        assert_eq!(safe_local_name("report v2 (final).pdf"), "report v2 (final).pdf");
    }
}
