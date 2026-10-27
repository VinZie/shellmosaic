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

/// What a terminal shows, rebuilt from its output: enough of what ConPTY sends (text,
/// cursor moves, erases, scrolling) to read a full-screen prompt. One cell per character;
/// no colors, attributes or scrollback.
pub struct Screen {
    cols: usize,
    rows: usize,
    cells: Vec<Vec<char>>,
    x: usize,
    y: usize,
    /// the last column was written: the next character goes on a new line
    wrap: bool,
    saved: (usize, usize),
}

impl Screen {
    pub fn new(cols: u16, rows: u16) -> Self {
        let (cols, rows) = (cols.max(1) as usize, rows.max(1) as usize);
        Self { cols, rows, cells: vec![vec![' '; cols]; rows], x: 0, y: 0, wrap: false, saved: (0, 0) }
    }

    /// The screen's lines, without trailing spaces.
    pub fn lines(&self) -> Vec<String> {
        self.cells.iter().map(|r| r.iter().collect::<String>().trim_end().to_string()).collect()
    }

    pub fn feed(&mut self, data: &[u8]) {
        let text = String::from_utf8_lossy(data);
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '\x1b' => match chars.next() {
                    Some('[') => {
                        let mut params = String::new();
                        for n in chars.by_ref() {
                            if ('@'..='~').contains(&n) {
                                self.csi(&params, n);
                                break;
                            }
                            params.push(n);
                        }
                    }
                    Some(']') | Some('P') | Some('_') | Some('^') => {
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
                        for n in chars.by_ref() {
                            if !(' '..='/').contains(&n) {
                                break;
                            }
                        }
                    }
                    Some('7') => self.saved = (self.x, self.y),
                    Some('8') => {
                        (self.x, self.y) = self.saved;
                        self.wrap = false;
                    }
                    Some('D') => self.linefeed(),
                    Some('E') => {
                        self.x = 0;
                        self.linefeed();
                    }
                    Some('M') => self.reverse_index(),
                    Some('c') => *self = Self::new(self.cols as u16, self.rows as u16),
                    _ => {}
                },
                '\r' => {
                    self.x = 0;
                    self.wrap = false;
                }
                '\n' | '\x0b' | '\x0c' => self.linefeed(),
                '\x08' => {
                    self.x = self.x.saturating_sub(1);
                    self.wrap = false;
                }
                '\t' => {
                    self.x = ((self.x / 8 + 1) * 8).min(self.cols - 1);
                    self.wrap = false;
                }
                c if c.is_control() => {}
                c => self.print(c),
            }
        }
    }

    fn print(&mut self, c: char) {
        if self.wrap {
            self.x = 0;
            self.linefeed();
        }
        self.cells[self.y][self.x] = c;
        if self.x + 1 < self.cols {
            self.x += 1;
        } else {
            self.wrap = true;
        }
    }

    fn linefeed(&mut self) {
        self.wrap = false;
        if self.y + 1 < self.rows {
            self.y += 1;
        } else {
            self.scroll_up(1);
        }
    }

    fn reverse_index(&mut self) {
        self.wrap = false;
        if self.y > 0 {
            self.y -= 1;
        } else {
            self.scroll_down(1);
        }
    }

    fn scroll_up(&mut self, n: usize) {
        let (n, cols) = (n.min(self.rows), self.cols);
        self.cells.drain(..n);
        self.cells.extend((0..n).map(|_| vec![' '; cols]));
    }

    fn scroll_down(&mut self, n: usize) {
        let (n, cols) = (n.min(self.rows), self.cols);
        self.cells.truncate(self.rows - n);
        for _ in 0..n {
            self.cells.insert(0, vec![' '; cols]);
        }
    }

    fn clear(&mut self, y: usize, from: usize, to: usize) {
        let to = to.min(self.cols);
        for x in from.min(to)..to {
            self.cells[y][x] = ' ';
        }
    }

    fn csi(&mut self, params: &str, f: char) {
        if params.starts_with(['?', '>', '<', '=']) {
            // private modes: only the alternate screen matters (it starts out blank)
            if (f == 'h' || f == 'l') && params[1..].split(';').any(|p| matches!(p, "47" | "1047" | "1049")) {
                for y in 0..self.rows {
                    self.clear(y, 0, self.cols);
                }
            }
            return;
        }
        let nums: Vec<usize> = params.split(';').map(|p| p.parse().unwrap_or(0)).collect();
        let arg = |i: usize| nums.get(i).copied().unwrap_or(0);
        let n = arg(0).max(1);
        let (cols, rows) = (self.cols, self.rows);
        match f {
            'H' | 'f' => {
                self.y = (arg(0).max(1) - 1).min(rows - 1);
                self.x = (arg(1).max(1) - 1).min(cols - 1);
            }
            'A' => self.y = self.y.saturating_sub(n),
            'B' | 'e' => self.y = (self.y + n).min(rows - 1),
            'C' | 'a' => self.x = (self.x + n).min(cols - 1),
            'D' => self.x = self.x.saturating_sub(n),
            'E' => {
                self.y = (self.y + n).min(rows - 1);
                self.x = 0;
            }
            'F' => {
                self.y = self.y.saturating_sub(n);
                self.x = 0;
            }
            'G' | '`' => self.x = (n - 1).min(cols - 1),
            'd' => self.y = (n - 1).min(rows - 1),
            'J' => match arg(0) {
                0 => {
                    self.clear(self.y, self.x, cols);
                    for y in self.y + 1..rows {
                        self.clear(y, 0, cols);
                    }
                }
                1 => {
                    for y in 0..self.y {
                        self.clear(y, 0, cols);
                    }
                    self.clear(self.y, 0, self.x + 1);
                }
                _ => {
                    for y in 0..rows {
                        self.clear(y, 0, cols);
                    }
                }
            },
            'K' => match arg(0) {
                0 => self.clear(self.y, self.x, cols),
                1 => self.clear(self.y, 0, self.x + 1),
                _ => self.clear(self.y, 0, cols),
            },
            'X' => self.clear(self.y, self.x, self.x + n),
            '@' => {
                let (x, row) = (self.x, &mut self.cells[self.y]);
                for _ in 0..n.min(cols - x) {
                    row.pop();
                    row.insert(x, ' ');
                }
            }
            'P' => {
                let (x, row) = (self.x, &mut self.cells[self.y]);
                for _ in 0..n.min(cols - x) {
                    row.remove(x);
                    row.push(' ');
                }
            }
            'L' => {
                for _ in 0..n.min(rows - self.y) {
                    self.cells.pop();
                    self.cells.insert(self.y, vec![' '; cols]);
                }
            }
            'M' => {
                for _ in 0..n.min(rows - self.y) {
                    self.cells.remove(self.y);
                    self.cells.push(vec![' '; cols]);
                }
            }
            'S' => self.scroll_up(n),
            'T' => self.scroll_down(n),
            // colors and the rest: nothing to draw
            _ => return,
        }
        self.wrap = false;
    }
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

    #[test]
    fn screen_draws_what_conpty_sends() {
        // ConPTY's way: absolute positions, cursor-forward for spaces, then diffs
        let mut s = Screen::new(40, 6);
        s.feed(b"\x1b[?25l\x1b]0;claude\x07\x1b[38;2;1;2;3m\x1b[1;1H>\x1b[1CNo\x1b[m\x1b[2;3HYes,\x1b[1CI\x1b[1Ctrust");
        assert_eq!(s.lines()[..2], ["> No", "  Yes, I trust"]);
        s.feed(b"\x1b[1;1H \x1b[2;1H>");
        assert_eq!(s.lines()[..2], ["  No", "> Yes, I trust"]);
    }

    #[test]
    fn screen_wraps_scrolls_and_erases() {
        let mut s = Screen::new(5, 2);
        s.feed(b"abcdefg");
        assert_eq!(s.lines(), ["abcde", "fg"]);
        s.feed(b"\r\nxy");
        assert_eq!(s.lines(), ["fg", "xy"]);
        s.feed(b"\x1b[1;2H\x1b[K\x1b[2;1H\x1b[1P");
        assert_eq!(s.lines(), ["f", "y"]);
        s.feed(b"\x1b[2J");
        assert_eq!(s.lines(), ["", ""]);
    }
}
