import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../lib/icons";
import type { Profile } from "../../lib/ipc";
import { cx, uid } from "../../lib/util";
import * as A from "../../state/actions";
import { WORKSPACE_COLORS } from "../../state/model";
import { loadProfiles, useAllProfiles, useProfiles } from "../../state/profiles";
import { resetSettings, setSetting, updateSettings, useSettings } from "../../state/settings";
import { ui, type MenuItem } from "../../state/ui";
import { ColorInput, Group, Hl, Row, Section, Select, TextInput, useMatch, useSetting, type Opt } from "./controls";
import { attempt, formatArgs, formatEnv, guessKind, parseArgs, parseEnv } from "./helpers";

const KINDS: Opt<string>[] = [
  { value: "pwsh", label: "PowerShell 7 (pwsh)" },
  { value: "powershell", label: "Windows PowerShell" },
  { value: "cmd", label: "Command Prompt" },
  { value: "bash", label: "Bash / sh (Git Bash, MSYS…)" },
  { value: "wsl", label: "WSL" },
  { value: "custom", label: "Other program" },
];

const PROFILE_ICONS = [
  "terminal", "square-terminal", "code", "braces", "zap", "server", "cloud", "database", "container", "box", "package",
  "git-branch", "hash", "binary", "cpu", "monitor", "shield", "lock", "key", "rocket", "flame", "star", "heart", "bug",
  "wrench", "hammer", "globe", "network", "leaf", "moon", "sun", "ghost", "skull", "gamepad-2", "coffee",
];

/** Shared with the Terminal section. */
export function DefaultProfileRow() {
  const profiles = useAllProfiles();
  const def = useSetting<string>("terminal.defaultProfile");
  const auto = profiles.find((p) => !p.hidden) ?? profiles[0];
  const options: Opt<string>[] = [
    { value: "auto", label: `Automatic${auto ? ` (${auto.name})` : ""}` },
    ...profiles.map((p) => ({ value: p.id, label: p.name + (p.hidden ? " (hidden)" : "") })),
  ];
  if (def !== "auto" && !profiles.some((p) => p.id === def)) options.push({ value: def, label: `${def} (not found — using automatic)` });
  return (
    <Row label="Default profile" desc="The shell new tabs and splits start with." keywords="shell default new tab profile">
      <Select value={def} options={options} width={240} onChange={(v) => setSetting("terminal.defaultProfile", v)} />
    </Row>
  );
}

function toggleHidden(id: string) {
  updateSettings((s) => {
    const h = s.profiles.hidden;
    s.profiles.hidden = h.includes(id) ? h.filter((x) => x !== id) : [...h, id];
  });
}

function stored(p: Profile): Profile {
  return {
    id: p.id,
    name: p.name,
    command: p.command,
    args: [...(p.args ?? [])],
    kind: p.kind,
    icon: p.icon ?? null,
    color: p.color ?? null,
    cwd: p.cwd ?? null,
    env: { ...(p.env ?? {}) },
  };
}

function addCustom(from?: Profile): string {
  const id = `custom-${uid(6)}`;
  updateSettings((s) => {
    const n = s.profiles.custom.length;
    const base: Profile = from
      ? { ...stored(from), name: `${from.name} (custom)` }
      : { id, name: "New profile", command: "cmd.exe", args: [], kind: "cmd", icon: null, color: WORKSPACE_COLORS[n % WORKSPACE_COLORS.length], cwd: null, env: {} };
    s.profiles.custom.push({ ...base, id });
  });
  return id;
}

async function deleteCustom(p: Profile) {
  const ok = await ui.confirm(`Delete “${p.name}”?`, "The profile is removed. Open terminals keep running.", { okLabel: "Delete", danger: true });
  if (!ok) return;
  updateSettings((s) => {
    s.profiles.custom = s.profiles.custom.filter((c) => c.id !== p.id);
    s.profiles.hidden = s.profiles.hidden.filter((h) => h !== p.id);
    if (s.terminal.defaultProfile === p.id) s.terminal.defaultProfile = "auto";
  });
}

async function browseProgram(): Promise<string | null> {
  const file = await open({
    multiple: false,
    title: "Choose a shell or program",
    filters: [
      { name: "Programs", extensions: ["exe", "bat", "cmd", "com"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return typeof file === "string" ? file : null;
}

async function browseFolder(): Promise<string | null> {
  const dir = await open({ directory: true, multiple: false, title: "Starting folder" });
  return typeof dir === "string" ? dir : null;
}

function Field({ label, hint, full, children }: { label: string; hint?: ReactNode; full?: boolean; children: ReactNode }) {
  return (
    <>
      <label className={cx("pe-label", full && "full")}>{label}</label>
      <div className={cx("pe-field", full && "full")}>
        {children}
        {hint && <div className="pe-hint">{hint}</div>}
      </div>
    </>
  );
}

function IconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="icon-picker">
      {PROFILE_ICONS.map((n) => (
        <button key={n} type="button" className={cx("icon-choice", n === value && "selected")} title={n} onClick={() => onChange(n)}>
          <Icon name={n} size={15} />
        </button>
      ))}
    </div>
  );
}

function FolderInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="row">
      <TextInput value={value} onChange={onChange} placeholder={placeholder} width="100%" />
      <button
        className="btn small"
        onClick={async () => {
          const d = await browseFolder();
          if (d) onChange(d);
        }}
      >
        Browse…
      </button>
    </div>
  );
}

/** Detected shells: only cosmetic overrides + starting folder (copy it as custom to change the command). */
function OverrideEditor({ p, raw, onOpen }: { p: Profile; raw?: Profile; onOpen: (id: string) => void }) {
  const ov = useSettings((s) => s.settings.profiles.overrides[p.id]);
  const set = (patch: Partial<Profile>) =>
    updateSettings((s) => {
      const cur: Record<string, unknown> = { ...(s.profiles.overrides[p.id] ?? {}), ...patch };
      for (const k of Object.keys(cur)) if (cur[k] === undefined || cur[k] === "") delete cur[k];
      if (Object.keys(cur).length) s.profiles.overrides[p.id] = cur as Partial<Profile>;
      else delete s.profiles.overrides[p.id];
    });
  const hasOverrides = !!ov && Object.keys(ov).length > 0;
  return (
    <div className="profile-editor">
      <Field label="Name">
        <TextInput value={ov?.name ?? ""} placeholder={raw?.name ?? p.name} onChange={(v) => set({ name: v || undefined })} width="100%" />
      </Field>
      <Field label="Color">
        <ColorInput value={p.color} swatches={WORKSPACE_COLORS} allowNone noneLabel="No color" onChange={(c) => set({ color: c })} />
      </Field>
      <Field label="Icon">
        <IconPicker value={p.icon ?? "terminal"} onChange={(icon) => set({ icon })} />
      </Field>
      <Field label="Starting folder">
        <FolderInput value={ov?.cwd ?? ""} onChange={(v) => set({ cwd: v || undefined })} placeholder={raw?.cwd ?? "Default"} />
      </Field>
      <Field label="Command" hint="Detected automatically. To change the program or its arguments, make a custom copy.">
        <code className="pe-code">{[p.command, formatArgs(p.args)].filter(Boolean).join(" ")}</code>
      </Field>
      <div className="pe-foot">
        <button className="btn small" onClick={() => onOpen(addCustom(p))}>
          <Icon name="copy" size={13} /> Copy as custom profile
        </button>
        <span className="grow" />
        <button className="btn small subtle" disabled={!hasOverrides} onClick={() => updateSettings((s) => void delete s.profiles.overrides[p.id])}>
          <Icon name="undo" size={13} /> Reset to detected
        </button>
      </div>
    </div>
  );
}

function CustomEditor({ id }: { id: string }) {
  const p = useSettings((s) => s.settings.profiles.custom.find((c) => c.id === id));
  // drafts so typing spaces/quotes isn't reformatted under the cursor
  const [args, setArgs] = useState(() => formatArgs(p?.args));
  const [env, setEnv] = useState(() => formatEnv(p?.env));
  if (!p) return null;
  const set = (patch: Partial<Profile>) =>
    updateSettings((s) => {
      const c = s.profiles.custom.find((x) => x.id === id);
      if (c) Object.assign(c, patch);
    });
  const parsed = parseArgs(args);
  return (
    <div className="profile-editor">
      <Field label="Name">
        <TextInput value={p.name} onChange={(v) => set({ name: v })} width="100%" />
      </Field>
      <Field label="Program" hint="An .exe on your PATH (e.g. pwsh.exe) or a full path.">
        <div className="row">
          <TextInput value={p.command} onChange={(v) => set({ command: v })} mono width="100%" placeholder="pwsh.exe" />
          <button
            className="btn small"
            onClick={async () => {
              const f = await browseProgram();
              if (f) set({ command: f, kind: guessKind(f) });
            }}
          >
            Browse…
          </button>
        </div>
      </Field>
      <Field
        label="Arguments"
        hint={
          parsed.length ? (
            <span className="arg-chips">
              {parsed.map((a, i) => (
                <code key={i}>{a || '""'}</code>
              ))}
            </span>
          ) : (
            "Separate with spaces; use double quotes for arguments that contain spaces."
          )
        }
      >
        <input
          className="input mono wide"
          value={args}
          spellCheck={false}
          placeholder='-NoLogo -Command "…"'
          onChange={(e) => {
            setArgs(e.target.value);
            set({ args: parseArgs(e.target.value) });
          }}
        />
      </Field>
      <Field label="Shell type" hint="Tells Shellmosaic how to set up shell integration.">
        <Select value={p.kind} options={KINDS} width={240} onChange={(kind) => set({ kind })} />
      </Field>
      <Field label="Starting folder">
        <FolderInput value={p.cwd ?? ""} onChange={(v) => set({ cwd: v || null })} placeholder="Default" />
      </Field>
      <Field label="Environment" hint="One KEY=VALUE per line.">
        <textarea
          className="input mono wide"
          rows={3}
          value={env}
          spellCheck={false}
          placeholder={"NODE_ENV=development\nPATH=C:\\tools;%PATH%"}
          onChange={(e) => {
            setEnv(e.target.value);
            set({ env: parseEnv(e.target.value) });
          }}
        />
      </Field>
      <Field label="Color">
        <ColorInput value={p.color} swatches={WORKSPACE_COLORS} allowNone noneLabel="No color" onChange={(c) => set({ color: c })} />
      </Field>
      <Field label="Icon">
        <IconPicker value={p.icon ?? "terminal"} onChange={(icon) => set({ icon })} />
      </Field>
      <div className="pe-foot">
        <button
          className="btn small"
          onClick={() => {
            A.newTab("terminal", { profile: p.id });
            ui.closeSettings();
          }}
        >
          <Icon name="play" size={13} /> Try it in a new tab
        </button>
        <span className="grow" />
        <button className="btn small danger subtle" onClick={() => deleteCustom(p)}>
          <Icon name="trash" size={13} /> Delete profile
        </button>
      </div>
    </div>
  );
}

function profileMenu(p: Profile, edit: () => void, onOpen: (id: string) => void): MenuItem[] {
  return [
    {
      label: "Open in new tab",
      icon: "plus",
      onSelect: () => {
        A.newTab("terminal", { profile: p.id });
        ui.closeSettings();
      },
    },
    { label: "Make default", icon: "star", onSelect: () => setSetting("terminal.defaultProfile", p.id) },
    { label: p.hidden ? "Show in menus" : "Hide from menus", icon: p.hidden ? "eye" : "eye-off", onSelect: () => toggleHidden(p.id) },
    { label: "Edit…", icon: "pencil", onSelect: edit },
    { label: p.custom ? "Duplicate" : "Copy as custom profile", icon: "copy", onSelect: () => onOpen(addCustom(p)) },
    ...(p.custom ? ([{ type: "separator" }, { label: "Delete", icon: "trash", danger: true, onSelect: () => deleteCustom(p) }] as MenuItem[]) : []),
  ];
}

function ProfileItem({
  p,
  raw,
  isDefault,
  isAuto,
  open,
  onToggle,
  onOpen,
}: {
  p: Profile;
  raw?: Profile;
  isDefault: boolean;
  isAuto: boolean;
  open: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open]);
  const match = useMatch(p.name, p.command, p.kind, p.custom ? "custom" : "detected");
  if (!match) return null;
  const color = p.color ?? undefined;
  return (
    <div ref={ref} className={cx("profile-item setting-hit", p.hidden && "is-hidden", open && "open")}>
      <div
        className="profile-row"
        onContextMenu={(e) => {
          e.preventDefault();
          ui.openMenu(e, profileMenu(p, onToggle, onOpen));
        }}
      >
        <span className="profile-icon" style={color ? { color, background: `color-mix(in srgb, ${color} 16%, transparent)` } : undefined}>
          <Icon name={p.icon ?? "terminal"} size={16} />
        </span>
        <div className="profile-info" onClick={onToggle}>
          <div className="profile-name">
            <span className="ellipsis">
              <Hl text={p.name} />
            </span>
            {isDefault && <span className="chip accent">{isAuto ? "default (auto)" : "default"}</span>}
            {p.custom && <span className="chip">custom</span>}
            {p.hidden && <span className="chip">hidden</span>}
          </div>
          <div className="profile-cmd ellipsis">{[p.command, formatArgs(p.args)].filter(Boolean).join(" ")}</div>
        </div>
        <div className="profile-actions">
          <button className={cx("icon-btn", isDefault && !isAuto && "on")} title={isDefault && !isAuto ? "This is the default profile" : "Make default"} onClick={() => setSetting("terminal.defaultProfile", p.id)}>
            <Icon name="star" size={14} />
          </button>
          <button className="icon-btn" title={p.hidden ? "Hidden from menus — click to show" : "Shown in menus — click to hide"} onClick={() => toggleHidden(p.id)}>
            <Icon name={p.hidden ? "eye-off" : "eye"} size={14} />
          </button>
          <button className={cx("icon-btn", open && "on")} title={open ? "Close editor" : "Edit"} onClick={onToggle}>
            <Icon name={open ? "chevron-up" : "pencil"} size={14} />
          </button>
        </div>
      </div>
      {open && (p.custom ? <CustomEditor id={p.id} /> : <OverrideEditor p={p} raw={raw} onOpen={onOpen} />)}
    </div>
  );
}

export function ProfilesSection() {
  const profiles = useAllProfiles();
  const detected = useProfiles((s) => s.detected);
  const def = useSetting<string>("terminal.defaultProfile");
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const auto = profiles.find((p) => !p.hidden) ?? profiles[0];
  const effectiveDefault = def !== "auto" && profiles.some((p) => p.id === def) ? def : auto?.id;

  const redetect = async () => {
    setBusy(true);
    const ok = await attempt(async () => {
      await loadProfiles(true);
      return true;
    });
    setBusy(false);
    if (ok) ui.toast(`Found ${useProfiles.getState().detected.length} shells`, "success", 2200);
  };

  return (
    <Section
      id="profiles"
      title="Profiles"
      icon="layers"
      desc="The shells you can open: detected automatically, plus your own."
      onReset={() => {
        resetSettings("profiles");
        setSetting("terminal.defaultProfile", "auto");
      }}
      resetHint="This deletes your custom profiles, clears name/color overrides and the hidden list, and sets the default back to automatic."
    >
      <Group title="Default">
        <DefaultProfileRow />
      </Group>
      <Group
        title="Profiles"
        desc="Click a profile to edit it. Hidden profiles stay usable but don't appear in menus."
        actions={
          <>
            <button className="btn small" onClick={redetect} disabled={busy} title="Look again for installed shells (PowerShell, Git Bash, WSL distros…)">
              <Icon name={busy ? "loader" : "refresh"} size={13} className={busy ? "spin" : undefined} /> Re-detect shells
            </button>
            <button className="btn small primary" onClick={() => setOpenId(addCustom())}>
              <Icon name="plus" size={13} /> Add profile
            </button>
          </>
        }
      >
        {profiles.map((p) => (
          <ProfileItem
            key={p.id}
            p={p}
            raw={detected.find((d) => d.id === p.id)}
            isDefault={p.id === effectiveDefault}
            isAuto={def === "auto" || !profiles.some((x) => x.id === def)}
            open={openId === p.id}
            onToggle={() => setOpenId((o) => (o === p.id ? null : p.id))}
            onOpen={setOpenId}
          />
        ))}
        {profiles.length === 0 && <div className="settings-empty small">No shells found. Try “Re-detect shells”, or add a profile.</div>}
      </Group>
    </Section>
  );
}
