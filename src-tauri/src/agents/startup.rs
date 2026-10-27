//! Claude Code screens that hold a session before it starts. No hook runs while one is up,
//! so Shellmosaic only sees them in what the agent's pane shows.
//!
//! The one that matters is the folder trust prompt: Claude Code asks it once per folder
//! (a parent folder's trust doesn't count; a worktree counts as its repository) before it
//! loads the agent's hooks and MCP server. It asks about the folder the session started in.

/// The trust prompt on screen.
#[derive(Debug, PartialEq)]
pub struct TrustPrompt {
    /// "Yes, I trust this folder" is the selected answer (it starts on "No, exit")
    pub yes_selected: bool,
}

/// Moves a Claude Code menu's selection down one.
pub const DOWN: &str = "\x1b[B";

fn words(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// The trust prompt, if the pane's screen (its lines) shows it.
pub fn trust_prompt(screen: &[String]) -> Option<TrustPrompt> {
    let lines: Vec<String> = screen.iter().map(|l| words(l)).collect();
    // older versions: "Yes, proceed" under "Do you trust the files in this folder?"
    let yes = lines
        .iter()
        .position(|l| l.contains("yes, i trust this folder") || (l.ends_with("yes, proceed") && lines.iter().any(|x| x.contains("trust the files in this folder"))))?;
    if !lines.iter().any(|l| l.contains("enter to confirm")) {
        return None;
    }
    Some(TrustPrompt { yes_selected: matches!(lines[yes].chars().next(), Some('>' | '❯' | '›' | '▶')) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vt::Screen;

    /// What Claude Code 2.1.312 sent through ConPTY for the prompt (folder renamed).
    const PROMPT: &str = "\x1b[6n\x1b[?9001h\x1b[?1004h\x1b[m\x1b]0;claude\x07\x1b[?2004h\x1b[?2031h\x1b[>0q\x1b[?u\x1b[?25l\x1b[38;2;255;193;7m\r\n\
        ────────────────────────────────────────\x1b[1m\x1b[3;2HAccessing\x1b[1Cworkspace:\x1b[m\x1b[1m\x1b[5;2HC:\\work\\Research\x1b[22m\
        \x1b[7;2HQuick\x1b[1Csafety\x1b[1Ccheck:\x1b[1CIs\x1b[1Cthis\x1b[1Ca\x1b[1Cproject\x1b[1Cyou\x1b[1Ccreated\x1b[1Cor\x1b[1Cone\x1b[1Cyou\x1b[1Ctrust?\
        \x1b[38;2;177;185;249m\x1b[14;2H>\x1b[1CNo,\x1b[1Cexit\x1b[m\x1b[15;4HYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder\
        \x1b[38;2;153;153;153m\x1b[17;2HEnter\x1b[1Cto\x1b[1Cconfirm\x1b[1C·\x1b[1CEsc\x1b[1Cto\x1b[1Ccancel\x1b[?9001l\x1b[?1004l\x1b[m";
    /// And after Down.
    const DOWN_DIFF: &str = "\x1b[?2004h\x1b[m\x1b[14;2H \x1b[1CNo, exit\x1b[38;2;177;185;249m\x1b[15;2H>\x1b[1CYes, I trust this folder\x1b[?9001l\x1b[?1004l\x1b[m";

    #[test]
    fn reads_the_trust_prompt_and_its_selection() {
        let mut s = Screen::new(120, 36);
        s.feed(PROMPT.as_bytes());
        assert_eq!(trust_prompt(&s.lines()), Some(TrustPrompt { yes_selected: false }));
        s.feed(DOWN_DIFF.as_bytes());
        assert_eq!(trust_prompt(&s.lines()), Some(TrustPrompt { yes_selected: true }));
    }

    #[test]
    fn other_screens_are_not_the_trust_prompt() {
        let screen: Vec<String> = ["> Is it safe to trust this folder? Explain.", "", "  ? for shortcuts"].map(String::from).to_vec();
        assert_eq!(trust_prompt(&screen), None);
    }
}
