import type { CSSProperties } from "react";
import { cx } from "../../lib/util";
import { resetSettings, setSetting, useSettings } from "../../state/settings";
import { activeTheme, useThemes } from "../../state/themes";
import {
  FontField,
  Group,
  NumberSetting,
  px,
  Row,
  Searchable,
  Section,
  SegmentedSetting,
  SelectSetting,
  SliderSetting,
  ToggleSetting,
  useSetting,
  type Opt,
} from "./controls";
import { DefaultProfileRow } from "./Profiles";

const MONO_FONTS = [
  { label: "Cascadia Code", value: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace' },
  { label: "Cascadia Mono", value: '"Cascadia Mono", Consolas, "Courier New", monospace' },
  { label: "Consolas", value: 'Consolas, "Courier New", monospace' },
  { label: "JetBrains Mono", value: '"JetBrains Mono", Consolas, monospace' },
  { label: "Fira Code", value: '"Fira Code", Consolas, monospace' },
  { label: "Courier New", value: '"Courier New", monospace' },
];

const WEIGHTS: Opt<string>[] = [
  { value: "100", label: "Thin (100)" },
  { value: "200", label: "Extra light (200)" },
  { value: "300", label: "Light (300)" },
  { value: "normal", label: "Normal (400)" },
  { value: "500", label: "Medium (500)" },
  { value: "600", label: "Semi-bold (600)" },
  { value: "bold", label: "Bold (700)" },
  { value: "800", label: "Extra bold (800)" },
  { value: "900", label: "Black (900)" },
];

/** A fake terminal drawn with the active theme's terminal colors and the font settings. */
function TerminalPreview() {
  const s = useSettings((st) => st.settings);
  useThemes((st) => st.preview);
  useThemes((st) => st.user);
  const theme = activeTheme(s);
  const c = theme.terminal;
  const t = s.terminal;
  const bright = t.drawBoldTextInBrightColors;
  const style: CSSProperties = {
    background: c.background,
    color: c.foreground,
    fontFamily: t.fontFamily,
    fontSize: t.fontSize,
    lineHeight: t.lineHeight,
    letterSpacing: t.letterSpacing,
    fontWeight: t.fontWeight as CSSProperties["fontWeight"],
    padding: Math.max(4, t.padding),
  };
  const bold: CSSProperties = { fontWeight: t.fontWeightBold as CSSProperties["fontWeight"] };
  const cursor: CSSProperties =
    t.cursorStyle === "block"
      ? { background: c.cursor, color: c.cursorAccent }
      : t.cursorStyle === "bar"
        ? { boxShadow: `inset 2px 0 0 ${c.cursor}` }
        : { boxShadow: `inset 0 -2px 0 ${c.cursor}` };
  const prompt = (
    <>
      <span style={{ color: c.green }}>PS</span> <span style={{ color: c.blue }}>C:\dev\shellmosaic</span>
      <span style={{ color: c.brightBlack }}>&gt;</span>{" "}
    </>
  );
  return (
    <div className="term-preview" aria-label="Terminal preview">
      <div className="term-preview-bar">
        <span>Preview</span>
        <span className="grow" />
        <span className="ellipsis">
          {theme.name} · {t.fontSize}px
        </span>
      </div>
      <div className="term-preview-body" style={style}>
        <div>
          {prompt}
          <span style={{ color: c.yellow }}>git</span> status
        </div>
        <div>
          On branch <span style={{ ...bold, color: bright ? c.brightCyan : c.cyan }}>main</span>
        </div>
        <div>
          {"  "}
          <span style={{ color: c.red }}>modified:</span> src/app.ts
        </div>
        <div>
          {"  "}
          <span style={{ color: c.green }}>new file:</span> <span style={{ background: c.selectionBackground }}>README.md</span>
        </div>
        <div>
          {prompt}
          <span style={{ color: c.yellow }}>npm</span> run build
        </div>
        <div>
          <span style={{ ...bold, color: bright ? c.brightGreen : c.green }}>✓ built</span> in 1.24s{" "}
          <span style={{ color: c.magenta }}>(12 modules)</span>
        </div>
        <div>
          <span style={{ ...bold, color: bright ? c.brightYellow : c.yellow }}>warning</span> 2 packages are deprecated
        </div>
        <div>
          {prompt}
          <span className={cx("tp-cursor-big", t.cursorBlink && "blink")} style={cursor}>
            {" "}
          </span>
        </div>
        <div className="term-preview-palette">
          {[c.black, c.red, c.green, c.yellow, c.blue, c.magenta, c.cyan, c.white].map((x, i) => (
            <i key={i} style={{ background: x }} />
          ))}
          {[c.brightBlack, c.brightRed, c.brightGreen, c.brightYellow, c.brightBlue, c.brightMagenta, c.brightCyan, c.brightWhite].map((x, i) => (
            <i key={`b${i}`} style={{ background: x }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function FontFamilyRow() {
  const v = useSetting<string>("terminal.fontFamily");
  return (
    <Row label="Font family" desc="Must be installed on this PC. List fallbacks with commas; quote names with spaces." keywords="typeface monospace font nerd" stack>
      <FontField value={v} onChange={(x) => setSetting("terminal.fontFamily", x)} picks={MONO_FONTS} />
    </Row>
  );
}

export function TerminalSection() {
  return (
    <Section id="terminal" title="Terminal" icon="square-terminal" desc="Fonts, cursor, clipboard and behavior of every terminal." onReset={() => resetSettings("terminal")} resetHint="Font, cursor, clipboard and other terminal settings go back to their defaults (including the default profile).">
      <Searchable label="Preview" keywords="font sample terminal colors">
        <TerminalPreview />
      </Searchable>

      <Group title="Font">
        <FontFamilyRow />
        <SliderSetting path="terminal.fontSize" label="Font size" desc="Ctrl+= and Ctrl+- change it on the fly." min={8} max={32} step={1} format={px} keywords="text size zoom" />
        <SliderSetting path="terminal.lineHeight" label="Line height" min={1} max={2} step={0.05} format={(v) => v.toFixed(2)} keywords="spacing rows" />
        <SliderSetting path="terminal.letterSpacing" label="Letter spacing" min={-2} max={8} step={1} format={px} keywords="character spacing tracking" />
        <SelectSetting path="terminal.fontWeight" label="Font weight" options={WEIGHTS} keywords="thin light regular" />
        <SelectSetting path="terminal.fontWeightBold" label="Bold font weight" desc="Weight used for bold text." options={WEIGHTS} keywords="bold heavy" />
      </Group>

      <Group title="Cursor">
        <SegmentedSetting
          path="terminal.cursorStyle"
          label="Cursor shape"
          keywords="caret"
          options={[
            { value: "bar", label: "Bar" },
            { value: "block", label: "Block" },
            { value: "underline", label: "Underline" },
          ]}
        />
        <ToggleSetting path="terminal.cursorBlink" label="Blinking cursor" keywords="caret blink" />
      </Group>

      <Group title="Scrolling">
        <NumberSetting path="terminal.scrollback" label="Scrollback" desc="Lines of history kept per terminal. More lines use more memory." min={0} max={500000} step={1000} suffix="lines" width={110} keywords="history buffer lines" />
      </Group>

      <Group title="Clipboard & mouse">
        <ToggleSetting path="terminal.copyOnSelect" label="Copy on select" desc="Selecting text copies it right away." keywords="clipboard selection" />
        <ToggleSetting path="terminal.trimSelection" label="Trim trailing spaces when copying" keywords="whitespace clipboard copy" />
        <ToggleSetting
          path="terminal.ctrlCCopies"
          label="Ctrl+C copies the selection"
          desc="Only while text is selected. Without a selection Ctrl+C still interrupts the running program."
          keywords="clipboard interrupt shortcut"
        />
        <ToggleSetting path="terminal.ctrlVPastes" label="Ctrl+V pastes" desc="Turn off to send Ctrl+V to the program instead. The Paste shortcut (Keybindings) keeps working." keywords="clipboard shortcut" />
        <SegmentedSetting
          path="terminal.rightClick"
          label="Right-click"
          desc="What a right-click inside a terminal does. “Copy or paste” works like Windows Terminal."
          keywords="mouse context menu paste"
          options={[
            { value: "menu", label: "Menu" },
            { value: "paste", label: "Paste" },
            { value: "copyPaste", label: "Copy or paste", title: "Copies the selection if there is one, otherwise pastes" },
          ]}
        />
        <ToggleSetting path="terminal.confirmMultilinePaste" label="Confirm multi-line pastes" desc="Ask before pasting text with line breaks, which may run several commands at once." keywords="paste safety newline" />
      </Group>

      <Group title="Bell">
        <SegmentedSetting
          path="terminal.bell"
          label="Bell"
          desc="When a program rings the bell (BEL). Background tabs also get a badge."
          keywords="beep sound flash notification alert"
          options={[
            { value: "none", label: "Off" },
            { value: "visual", label: "Flash" },
            { value: "sound", label: "Sound" },
            { value: "both", label: "Both" },
          ]}
        />
      </Group>

      <Group title="Rendering">
        <ToggleSetting path="terminal.webgl" label="GPU rendering (WebGL)" desc="Faster drawing for busy output. Turn off if you see glitches." keywords="webgl performance gpu acceleration renderer" />
        <SliderSetting
          path="terminal.minimumContrastRatio"
          label="Minimum contrast"
          desc="Adjusts text colors that are too close to their background. 4.5 meets WCAG AA."
          min={1}
          max={21}
          step={0.5}
          format={(v) => (v <= 1 ? "Off" : `${v.toFixed(1)} : 1`)}
          keywords="accessibility readability colors"
        />
        <ToggleSetting path="terminal.drawBoldTextInBrightColors" label="Bold text in bright colors" desc="Show bold colored text in the bright variant of its color." keywords="ansi bright bold" />
        <SliderSetting path="terminal.padding" label="Padding" desc="Space between the terminal text and the pane edge." min={0} max={24} step={1} format={px} keywords="margin inset" />
      </Group>

      <Group title="Shell & links">
        <DefaultProfileRow />
        <ToggleSetting
          path="terminal.shellIntegration"
          label="Shell integration"
          desc="Lets Shellmosaic follow the current folder and command results in PowerShell, cmd and bash. Applies to new terminals."
          keywords="cwd folder osc prompt tracking"
        />
        <ToggleSetting path="terminal.inheritCwd" label="New splits open in the same folder" desc="A new terminal split starts in the folder of the terminal you split from." keywords="cwd directory inherit split" />
        <ToggleSetting
          path="terminal.freshEnvironment"
          label="Fresh Windows environment for new shells"
          desc="Like Windows Terminal: new shells get your system and user variables from Windows, not whatever launched Shellmosaic. Keeps stray variables (e.g. NO_COLOR) out and picks up PATH changes without restarting."
          keywords="env variables path no_color inherit environment"
        />
        <SegmentedSetting
          path="terminal.links"
          label="Open links in"
          desc="Where a clicked URL in a terminal opens."
          keywords="url browser hyperlink web"
          options={[
            { value: "browser", label: "Browser" },
            { value: "webPane", label: "Web pane", title: "Opens next to the terminal in a Web module pane" },
          ]}
        />
      </Group>
    </Section>
  );
}
