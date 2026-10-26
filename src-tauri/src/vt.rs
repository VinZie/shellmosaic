//! Pure terminal-stream helpers (no Tauri types) so they can be unit-tested on
//! their own: `rustc --edition 2021 --test src/vt.rs`.

/// Append to the ring, trimming the front at a line boundary so a replay never
/// starts in the middle of an escape sequence or UTF-8 character. Returns how many
/// bytes were trimmed off the front.
pub fn push_ring(ring: &mut Vec<u8>, data: &[u8], cap: usize) -> usize {
    ring.extend_from_slice(data);
    if ring.len() <= cap {
        return 0;
    }
    let mut cut = ring.len() - cap * 3 / 4;
    if let Some(nl) = ring[cut..].iter().position(|&b| b == b'\n') {
        cut += nl + 1;
    }
    ring.drain(..cut);
    cut
}

pub fn strip_ansi(data: &[u8]) -> String {
    let text = String::from_utf8_lossy(data);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                Some('[') => {
                    // CSI: parameters until a final byte in @..~
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') | Some('P') | Some('_') | Some('^') => {
                    // OSC/DCS/APC/PM: until BEL or ST
                    while let Some(n) = chars.next() {
                        if n == '\x07' {
                            break;
                        }
                        if n == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(' '..='/') => {
                    // nF escapes such as charset selection (ESC ( B): intermediates, then one final byte
                    for n in chars.by_ref() {
                        if !(' '..='/').contains(&n) {
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\r' => {
                if chars.peek() != Some(&'\n') {
                    // bare CR: the line will be overwritten; keep it simple
                    out.push('\n');
                }
            }
            c if c.is_control() && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

pub enum OscEvent {
    Cwd(String),
    Title(String),
}

/// Incremental scanner for OSC sequences that tell us the cwd (7, 9;9, 633;P;Cwd=)
/// or a window title (0, 2). Survives sequences split across reads.
#[derive(Default)]
pub struct OscScanner {
    state: u8,
    buf: Vec<u8>,
}

impl OscScanner {
    pub fn feed(&mut self, data: &[u8]) -> Vec<OscEvent> {
        let mut events = Vec::new();
        for &b in data {
            match self.state {
                0 => {
                    if b == 0x1b {
                        self.state = 1;
                    }
                }
                1 => {
                    self.state = match b {
                        b']' => {
                            self.buf.clear();
                            2
                        }
                        0x1b => 1,
                        _ => 0,
                    }
                }
                2 => match b {
                    0x07 => {
                        self.finish(&mut events);
                        self.state = 0;
                    }
                    0x1b => self.state = 3,
                    _ if self.buf.len() < 4096 => self.buf.push(b),
                    _ => self.state = 0,
                },
                _ => {
                    if b == b'\\' {
                        self.finish(&mut events);
                    }
                    self.state = if b == 0x1b { 1 } else { 0 };
                }
            }
        }
        events
    }

    fn finish(&mut self, events: &mut Vec<OscEvent>) {
        let s = String::from_utf8_lossy(&self.buf).into_owned();
        let cwd = if let Some(rest) = s.strip_prefix("7;") {
            parse_file_url(rest)
        } else if let Some(rest) = s.strip_prefix("9;9;") {
            Some(rest.trim().trim_matches('"').to_string())
        } else {
            s.strip_prefix("633;P;Cwd=").map(str::to_string)
        };
        if let Some(cwd) = cwd {
            if acceptable_cwd(&cwd) {
                events.push(OscEvent::Cwd(cwd));
            }
        } else if let Some(t) = s.strip_prefix("0;").or_else(|| s.strip_prefix("2;")) {
            events.push(OscEvent::Title(t.chars().take(200).collect()));
        }
    }
}

/// Anything printed in a terminal can claim to be its folder, and the Files, Git and
/// Tasks panes then open that folder on their own. Accept local paths only: touching
/// a \\server\share makes Windows log in to that server (leaking an NTLM hash), and
/// control characters would break out of the commands those panes type.
pub fn acceptable_cwd(p: &str) -> bool {
    // (Windows reads "/" as "\", so "//host" and "/\host" are network paths too)
    let n = p.replace('/', "\\");
    !p.is_empty() && p.len() <= 1024 && !p.chars().any(char::is_control) && !n.starts_with("\\\\") && !n.starts_with("\\??\\")
}

pub fn parse_file_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    let path = &rest[rest.find('/')?..];
    let decoded = percent_decode(path);
    // "/C:/Users/x" -> "C:/Users/x"
    let b = decoded.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        Some(decoded[1..].replace('/', "\\"))
    } else if let Some(unc) = decoded.strip_prefix("///") {
        // "/" + a UNC path as cygpath -m spells it ("//server/share")
        Some(format!("\\\\{}", unc.replace('/', "\\")))
    } else {
        Some(decoded)
    }
}

pub fn percent_decode(s: &str) -> String {
    // byte-wise: slicing the &str here would panic when a '%' is followed by a
    // multi-byte character, and this runs on terminal output (OSC 7)
    fn hex(b: u8) -> Option<u8> {
        (b as char).to_digit(16).map(|d| d as u8)
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc_cwd_split_across_chunks() {
        let mut sc = OscScanner::default();
        assert!(sc.feed(b"hello\x1b]9;9;\"C:\\Us").is_empty());
        let ev = sc.feed(b"ers\\me\"\x1b\\PS> ");
        assert!(matches!(&ev[..], [OscEvent::Cwd(p)] if p == "C:\\Users\\me"));
    }

    #[test]
    fn hostile_cwd_reports_are_ignored() {
        let mut sc = OscScanner::default();
        for bad in [
            &b"\x1b]9;9;\\\\10.0.0.5\\s\\README.md\x1b\\"[..],
            b"\x1b]9;9;//10.0.0.5/s\x07",
            b"\x1b]633;P;Cwd=/\\host\\share\x07",
            b"\x1b]7;file://h//host/share\x07",
            b"\x1b]9;9;C:\\x\rcalc\x07",
        ] {
            assert!(sc.feed(bad).is_empty(), "{:?}", String::from_utf8_lossy(bad));
        }
        assert!(matches!(&sc.feed(b"\x1b]9;9;C:\\work\x07")[..], [OscEvent::Cwd(p)] if p == "C:\\work"));
        assert!(matches!(&sc.feed(b"\x1b]7;file://box/home/me\x07")[..], [OscEvent::Cwd(p)] if p == "/home/me"));
    }

    #[test]
    fn osc7_file_url() {
        assert_eq!(parse_file_url("file://host/C:/Program%20Files").as_deref(), Some("C:\\Program Files"));
        assert_eq!(parse_file_url("file://box/home/me").as_deref(), Some("/home/me"));
        // what the Git Bash PROMPT_COMMAND sends (host + "/" + cygpath -m)
        assert_eq!(parse_file_url("file://PC/D:/src/my app").as_deref(), Some("D:\\src\\my app"));
        assert_eq!(parse_file_url("file://PC///nas/share/dir").as_deref(), Some("\\\\nas\\share\\dir"));
    }

    #[test]
    fn percent_decode_survives_multibyte_after_percent() {
        assert_eq!(percent_decode("/a%é%z%4"), "/a%é%z%4");
        assert_eq!(percent_decode("/%C3%A9"), "/é");
    }

    #[test]
    fn ring_trims_at_newline() {
        let mut ring = Vec::new();
        assert_eq!(push_ring(&mut ring, b"aaaa\n", 10), 0);
        let cut = push_ring(&mut ring, b"bbbb\ncccc\ndddd\n", 10);
        assert!(ring.len() <= 10);
        assert!(ring.starts_with(b"cccc") || ring.starts_with(b"dddd"));
        assert_eq!(cut + ring.len(), 20);
    }

    #[test]
    fn strips_escapes() {
        assert_eq!(strip_ansi(b"\x1b[31mred\x1b[0m \x1b]0;t\x07ok\r\n"), "red ok\n");
        assert_eq!(strip_ansi(b"\x1b(Bplain\x1b)0"), "plain");
    }
}
