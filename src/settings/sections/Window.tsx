import { BackgroundLayer } from "../../components/Workspace";
import { Icon } from "../../lib/icons";
import type { Background } from "../../state/model";
import { resetSettings, setSetting, type Settings } from "../../state/settings";
import { ui } from "../../state/ui";
import { Group, pct, Row, Section, Segmented, SliderSetting, ToggleSetting, useSetting } from "./controls";

type Effect = Settings["window"]["effect"];

const EFFECTS: { value: Effect; label: string; desc: string }[] = [
  { value: "none", label: "None", desc: "A solid window. Lightest on the GPU." },
  { value: "mica", label: "Mica", desc: "A soft tint taken from your wallpaper. Needs Windows 11." },
  { value: "acrylic", label: "Acrylic", desc: "Frosted glass that blurs whatever is behind the window." },
  { value: "tabbed", label: "Tabbed", desc: "A stronger wallpaper tint, like File Explorer's tabs. Needs Windows 11." },
  { value: "blur", label: "Blur", desc: "A plain blur of what's behind the window." },
];

function EffectRow() {
  const effect = useSetting<Effect>("window.effect");
  const info = EFFECTS.find((e) => e.value === effect) ?? EFFECTS[0];
  return (
    <Row
      label="Window effect"
      desc={
        <>
          {info.desc} Effects show through wherever surfaces are transparent, so lower the surface opacity below to see more of it.
          {(effect === "mica" || effect === "tabbed") && <span className="note-inline"> On Windows 10 this falls back to a solid window.</span>}
        </>
      }
      keywords="mica acrylic tabbed blur transparency glass material translucent windows 11"
    >
      <Segmented<Effect> value={effect} options={EFFECTS.map(({ value, label }) => ({ value, label }))} onChange={(v) => setSetting("window.effect", v)} />
    </Row>
  );
}

function bgSummary(bg: Background | null): string {
  if (!bg) return "None. Pick an image, a gradient or a color to show behind every workspace.";
  const kind = bg.kind === "image" ? "Image" : "Color / gradient";
  return `${kind} at ${Math.round(bg.opacity * 100)}% opacity${bg.blur ? `, ${bg.blur}px blur` : ""}. Workspaces and tabs can also have their own (right-click them).`;
}

function BackgroundRow() {
  const bg = useSetting<Background | null>("window.background");
  return (
    <Row label="Window background" desc={bgSummary(bg)} keywords="wallpaper image picture gradient photo backdrop">
      <div className="bg-thumb" title={bg ? "Current background" : "No background"}>
        <BackgroundLayer bg={bg} />
        {!bg && <Icon name="image-off" size={14} />}
      </div>
      <button className="btn small" onClick={() => ui.openDialog({ kind: "background", target: { kind: "global" } })}>
        <Icon name="image" size={13} /> {bg ? "Change…" : "Choose…"}
      </button>
      {bg && (
        <button className="btn small subtle" onClick={() => setSetting("window.background", null)}>
          Remove
        </button>
      )}
    </Row>
  );
}

export function WindowSection() {
  return (
    <Section id="window" title="Window" icon="app-window" desc="Window material, transparency and background." onReset={() => resetSettings("window")} resetHint="The window effect, opacity and background go back to their defaults.">
      <Group title="Material">
        <EffectRow />
        <SliderSetting
          path="window.opacity"
          label="Surface opacity"
          desc="How solid panes, tabs and bars are. Lower values let the window effect or background show through; 100% hides them."
          keywords="transparency translucent alpha see-through"
          min={0.3}
          max={1}
          step={0.01}
          format={pct}
        />
      </Group>
      <Group title="Background">
        <BackgroundRow />
      </Group>
      <Group title="Behavior">
        <ToggleSetting path="window.confirmQuit" label="Confirm before quitting" desc="Ask before the main window closes. Sessions are restored either way." keywords="close exit quit prompt" />
      </Group>
    </Section>
  );
}
