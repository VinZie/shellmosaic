// Host editor: connection details, grouping and credentials of one saved host.
// Typed secrets (password, passphrase, pasted key) stay in uncontrolled inputs and
// are read once on save; the backend never sends saved ones back, only "has…" flags.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useId, useRef, useState } from "react";
import { ipc, type HostAuth, type HostInput, type HostView } from "../../lib/ipc";
import { Icon } from "../../lib/icons";
import { cx, joinPath, toHex6 } from "../../lib/util";
import { WORKSPACE_COLORS } from "../../state/model";
import { ui } from "../../state/ui";
import { useAlive, useFocusWhen } from "./VaultForms";
import { sentence, syncPaneNames, useVault } from "./vault";

const HOST_ICONS = ["server", "database", "cloud", "globe", "router", "container", "box", "monitor", "cpu", "hard-drive", "shield", "flask", "rocket", "bot"];

const AUTH: { value: HostAuth; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Tries the private key (if one is set), then the saved password; anything else is asked when connecting." },
  { value: "password", label: "Password", hint: "Logs in with the saved password, or asks for it when connecting." },
  { value: "key", label: "Private key", hint: "Logs in with the private key only." },
];

export interface EditTarget {
  /** the host to edit (or to copy); none: a new host */
  host?: HostView;
  duplicate?: boolean;
}

interface Draft {
  name: string;
  host: string;
  port: string;
  user: string;
  group: string;
  tags: string[];
  color: string | null;
  icon: string | null;
  notes: string;
  auth: HostAuth;
  keyPath: string;
}

function draftOf(h: HostView | undefined, duplicate: boolean | undefined): Draft {
  if (!h) return { name: "", host: "", port: "22", user: "", group: "", tags: [], color: null, icon: null, notes: "", auth: "auto", keyPath: "" };
  return {
    name: duplicate ? `${h.name} copy` : h.name,
    host: h.host,
    port: String(h.port),
    user: h.user,
    group: h.group,
    tags: [...h.tags],
    color: h.color,
    icon: h.icon,
    notes: h.notes,
    auth: h.auth,
    keyPath: h.keyPath ?? "",
  };
}

async function sshFolder(): Promise<string | undefined> {
  const home = await ipc.fsHome().catch(() => "");
  return home ? joinPath(home, ".ssh") : undefined;
}

export function HostEditor({
  target,
  groups,
  tags,
  autoFocus,
  onClose,
  onDelete,
}: {
  target: EditTarget;
  /** existing groups and tags, offered as suggestions */
  groups: string[];
  tags: string[];
  autoFocus?: boolean;
  onClose: (saved?: HostView) => void;
  onDelete?: (host: HostView) => void;
}) {
  const editId = target.duplicate ? undefined : target.host?.id;
  // the live host: its keys may be forgotten, or it may be deleted from another window
  const live = useVault((s) => (editId ? s.hosts?.find((h) => h.id === editId) : undefined));
  const gone = !!editId && !live;
  const [d, setD] = useState<Draft>(() => draftOf(target.host, target.duplicate));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const [clear, setClear] = useState({ password: false, passphrase: false, keyData: false });
  const pwRef = useRef<HTMLInputElement>(null);
  const ppRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useAlive();
  const groupList = useId();
  useFocusWhen(target.host ? nameRef : hostRef, autoFocus);

  const wipeSecrets = () => {
    if (pwRef.current) pwRef.current.value = "";
    if (ppRef.current) ppRef.current.value = "";
    if (keyRef.current) keyRef.current.value = "";
  };
  const cancel = () => {
    wipeSecrets();
    onClose();
  };

  const browseKey = async () => {
    const start = d.keyPath.trim() || (await sshFolder());
    const picked = await openDialog({ multiple: false, directory: false, defaultPath: start, title: "Choose a private key" }).catch(() => null);
    if (typeof picked === "string") set("keyPath", picked);
  };

  const forgetKeys = async () => {
    if (!live) return;
    const ok = await ui.confirm(
      `Forget the trusted host keys of "${live.name}"?`,
      "The next connection shows the server's key fingerprint and asks you to trust it again. Do this when the server's key legitimately changed (reinstalled, new machine).",
      { okLabel: "Forget host keys" },
    );
    if (!ok) return;
    try {
      await ipc.hostForgetKeys(live.id);
      ui.toast("Host keys forgotten", "success", 2000);
    } catch (e) {
      ui.toast(sentence(e), "error");
    }
  };

  const save = async () => {
    if (busy || gone) return;
    const host = d.host.trim();
    if (!host || /\s/.test(host)) {
      setError("Enter a host name or address (no spaces).");
      hostRef.current?.focus();
      return;
    }
    const port = Number(d.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError("The port must be a number between 1 and 65535.");
      return;
    }
    const input: HostInput = {
      id: editId,
      name: d.name.trim(),
      host,
      port,
      user: d.user.trim(),
      group: d.group.trim(),
      tags: d.tags,
      color: d.color,
      icon: d.icon,
      notes: d.notes,
      auth: d.auth,
      keyPath: d.keyPath.trim() || null,
    };
    if (target.duplicate && target.host) input.copySecretsFrom = target.host.id;
    // secrets: only what was typed now; untouched ones stay as saved
    const pw = pwRef.current?.value ?? "";
    const pp = ppRef.current?.value ?? "";
    const key = keyRef.current?.value.trim() ?? "";
    if (clear.password) input.clearPassword = true;
    else if (pw) input.password = pw;
    if (clear.passphrase) input.clearPassphrase = true;
    else if (pp) input.passphrase = pp;
    if (clear.keyData) input.clearKeyData = true;
    else if (key) input.keyData = key;
    setBusy(true);
    setError(null);
    try {
      const saved = await ipc.hostSave(input);
      wipeSecrets();
      syncPaneNames(saved);
      if (alive.current) onClose(saved);
    } catch (e) {
      if (alive.current) setError(sentence(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.key === "Escape") {
      e.stopPropagation();
      cancel();
    } else if (e.key === "Enter" && t.tagName === "INPUT" && !(t as HTMLInputElement).list && !e.nativeEvent.isComposing) {
      e.preventDefault();
      save();
    }
  };

  // a duplicate starts with the original's saved secrets (copied in the backend)
  const secretsOf = live ?? (target.duplicate ? target.host : undefined);
  const hasPassword = !!secretsOf?.hasPassword;
  const hasPassphrase = !!secretsOf?.hasPassphrase;
  const hasKeyData = !!secretsOf?.hasKeyData;
  const title = target.duplicate ? "Duplicate host" : editId ? "Edit host" : "Add host";
  const authHint = AUTH.find((a) => a.value === d.auth)?.hint;
  const pubKey = /\.pub$/i.test(d.keyPath.trim());

  return (
    <div className="hosts-editor" onKeyDown={onKeyDown}>
      <div className="toolbar hosts-editor-head">
        <button className="icon-btn" title="Back to the list (Esc)" onClick={cancel}>
          <Icon name="arrow-left" size={15} />
        </button>
        <span className="hosts-editor-title">{title}</span>
        {editId && live && <span className="dim ellipsis">{live.name}</span>}
      </div>

      <div className="module-scroll hosts-editor-body">
        {gone && (
          <div className="hosts-note warn">
            <Icon name="warning" size={13} /> This host was deleted (maybe from another window). It can't be saved any more.
          </div>
        )}
        {target.duplicate && (
          <div className="hosts-note">
            <Icon name="info" size={13} /> Saved passwords and keys are copied too; type new ones to replace them. Trusted host keys aren't.
          </div>
        )}

        <section className="hosts-section">
          <div className="hosts-grid">
            <div className="hosts-field wide">
              <label className="field-label">Name</label>
              <input ref={nameRef} className="input wide" value={d.name} placeholder={d.host.trim() || "e.g. web01"} spellCheck={false} onChange={(e) => set("name", e.target.value)} />
            </div>
            <div className="hosts-field hosts-host">
              <label className="field-label">Host</label>
              <input
                ref={hostRef}
                className="input wide mono"
                value={d.host}
                placeholder="server.example.com or 10.0.0.5"
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => set("host", e.target.value)}
              />
            </div>
            <div className="hosts-field hosts-port">
              <label className="field-label">Port</label>
              <input className="input wide mono" type="number" min={1} max={65535} value={d.port} onChange={(e) => set("port", e.target.value)} />
            </div>
            <div className="hosts-field">
              <label className="field-label">User</label>
              <input className="input wide mono" value={d.user} placeholder="asked when connecting" spellCheck={false} onChange={(e) => set("user", e.target.value)} />
            </div>
          </div>
        </section>

        <section className="hosts-section">
          <h4>Organize</h4>
          <div className="hosts-grid">
            <div className="hosts-field">
              <label className="field-label">Group</label>
              <input className="input wide" list={groupList} value={d.group} placeholder="e.g. Production" onChange={(e) => set("group", e.target.value)} />
              <datalist id={groupList}>
                {groups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </div>
            <div className="hosts-field">
              <label className="field-label">Tags</label>
              <TagInput tags={d.tags} suggestions={tags} onChange={(t) => set("tags", t)} />
            </div>
          </div>
          <label className="field-label">Color</label>
          <div className="swatch-row">
            <button type="button" className={cx("swatch big none", !d.color && "selected")} title="No color" onClick={() => set("color", null)}>
              <Icon name="x" size={12} />
            </button>
            {WORKSPACE_COLORS.map((c) => (
              <button type="button" key={c} className={cx("swatch big", d.color?.toLowerCase() === c && "selected")} style={{ background: c }} title={c} onClick={() => set("color", c)} />
            ))}
            <label
              className={cx("swatch big custom", d.color && !WORKSPACE_COLORS.includes(d.color.toLowerCase()) && "selected")}
              title="Custom color…"
              style={d.color && !WORKSPACE_COLORS.includes(d.color.toLowerCase()) ? { background: d.color } : undefined}
            >
              <input type="color" value={toHex6(d.color ?? "#808080")} onChange={(e) => set("color", e.target.value)} />
              <Icon name="palette" size={13} />
            </label>
          </div>
          <label className="field-label">Icon</label>
          <div className="hosts-icons">
            {HOST_ICONS.map((n) => (
              <button
                type="button"
                key={n}
                className={cx("icon-choice", (d.icon ?? "server") === n && "selected")}
                title={n}
                style={d.color ? { color: d.color } : undefined}
                onClick={() => set("icon", n === "server" ? null : n)}
              >
                <Icon name={n} size={16} />
              </button>
            ))}
          </div>
        </section>

        <section className="hosts-section">
          <h4>Authentication</h4>
          <div className="segmented hosts-auth">
            {AUTH.map((a) => (
              <button type="button" key={a.value} className={cx(d.auth === a.value && "on")} onClick={() => set("auth", a.value)}>
                {a.label}
              </button>
            ))}
          </div>
          <p className="hosts-hint">{authHint}</p>

          {/* hidden, not unmounted: switching modes must not lose what was typed */}
          <div hidden={d.auth === "key"}>
            <label className="field-label">Password</label>
            <SecretRow
              inputRef={pwRef}
              saved={hasPassword}
              cleared={clear.password}
              savedText="saved — type to replace"
              emptyText="not saved — asked when connecting"
              onClear={(v) => setClear((c) => ({ ...c, password: v }))}
            />
          </div>

          <div hidden={d.auth === "password"}>
            <label className="field-label">Private key file</label>
            <div className="row">
              <input
                className="input wide mono"
                value={d.keyPath}
                placeholder="e.g. ~\.ssh\id_ed25519"
                spellCheck={false}
                onChange={(e) => set("keyPath", e.target.value)}
              />
              <button type="button" className="btn" onClick={browseKey}>
                <Icon name="folder-open" size={14} /> Browse…
              </button>
            </div>
            {pubKey && <p className="hosts-hint warn-text">That's a public key: choose the private key (the same name without .pub).</p>}

            <label className="field-label">…or paste a private key</label>
            {hasKeyData && (
              <div className={cx("hosts-saved", clear.keyData && "cleared")}>
                <Icon name="key-round" size={13} />
                <span className="grow">{clear.keyData ? "The saved key will be removed" : "A pasted key is saved (it's used instead of the key file)"}</span>
                <button type="button" className="btn small subtle" onClick={() => setClear((c) => ({ ...c, keyData: !c.keyData }))}>
                  {clear.keyData ? "Keep it" : "Remove"}
                </button>
              </div>
            )}
            <textarea
              ref={keyRef}
              className="input wide mono hosts-keydata"
              rows={4}
              spellCheck={false}
              autoComplete="off"
              disabled={clear.keyData}
              placeholder={hasKeyData ? "Paste a key here to replace the saved one" : "-----BEGIN OPENSSH PRIVATE KEY-----"}
            />

            <label className="field-label">Key passphrase</label>
            <SecretRow
              inputRef={ppRef}
              saved={hasPassphrase}
              cleared={clear.passphrase}
              savedText="saved — type to replace"
              emptyText="none saved — asked if the key needs one"
              onClear={(v) => setClear((c) => ({ ...c, passphrase: v }))}
            />
          </div>
        </section>

        <section className="hosts-section">
          <h4>Notes</h4>
          <textarea className="input wide hosts-notes" rows={3} value={d.notes} placeholder="Anything worth remembering about this server" onChange={(e) => set("notes", e.target.value)} />
        </section>

        {editId && live && (
          <section className="hosts-section">
            <h4>Trusted host keys</h4>
            {live.knownKeys.length ? (
              <>
                {live.knownKeys.map((k, i) => (
                  <div key={i} className="hosts-fp selectable">
                    <Icon name="fingerprint" size={14} />
                    <span className="mono ellipsis" title={k}>
                      {k}
                    </span>
                  </div>
                ))}
                <div className="row hosts-fp-actions">
                  <button type="button" className="btn small" onClick={forgetKeys}>
                    Forget host keys…
                  </button>
                  <span className="hosts-hint">Changing the host or port forgets them too.</span>
                </div>
              </>
            ) : (
              <p className="hosts-hint">None yet: the server's key fingerprint is shown and confirmed on the first connection.</p>
            )}
          </section>
        )}
      </div>

      <div className="hosts-editor-foot">
        {error && (
          <div className="vault-error hosts-editor-error" role="alert">
            {error}
          </div>
        )}
        <div className="row">
          {editId && live && onDelete && (
            <button type="button" className="btn subtle danger" onClick={() => onDelete(live)} disabled={busy}>
              <Icon name="trash" size={14} /> Delete
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy || gone}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A secret input whose saved value can't be shown: "saved" placeholder plus Clear. */
function SecretRow({
  inputRef,
  saved,
  cleared,
  savedText,
  emptyText,
  onClear,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  saved: boolean;
  cleared: boolean;
  savedText: string;
  emptyText: string;
  onClear: (cleared: boolean) => void;
}) {
  return (
    <div className="row">
      <input
        ref={inputRef}
        className="input wide"
        type="password"
        autoComplete="off"
        spellCheck={false}
        disabled={cleared}
        placeholder={cleared ? "will be removed" : saved ? savedText : emptyText}
      />
      {saved && (
        <button
          type="button"
          className="btn subtle"
          title={cleared ? "Keep the saved one" : "Remove the saved one"}
          onClick={() => {
            if (inputRef.current) inputRef.current.value = "";
            onClear(!cleared);
          }}
        >
          {cleared ? "Keep" : "Clear"}
        </button>
      )}
    </div>
  );
}

function TagInput({ tags, suggestions, onChange }: { tags: string[]; suggestions: string[]; onChange: (tags: string[]) => void }) {
  const [text, setText] = useState("");
  const listId = useId();
  const clean = (raw: string) => raw.trim().replace(/^#/, "");
  const add = (...raw: string[]) => {
    const next = [...tags];
    for (const t of raw.map(clean)) if (t && !next.includes(t)) next.push(t);
    if (next.length !== tags.length) onChange(next);
  };
  return (
    <div className="hosts-taginput input" onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}>
      {tags.map((t) => (
        <span key={t} className="chip">
          {t}
          <button type="button" title={`Remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
      <input
        list={listId}
        value={text}
        placeholder={tags.length ? "" : "Add a tag, then Enter"}
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value;
          // a suggestion picked from the list completes the tag, and so does a comma
          if ((e.nativeEvent as InputEvent).inputType === "insertReplacementText" || !(e.nativeEvent instanceof InputEvent)) {
            add(v);
            setText("");
          } else if (v.includes(",")) {
            const parts = v.split(",");
            const rest = parts.pop() ?? "";
            add(...parts);
            setText(rest);
          } else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim()) {
            e.preventDefault();
            e.stopPropagation();
            add(text);
            setText("");
          } else if (e.key === "Backspace" && !text && tags.length) {
            onChange(tags.slice(0, -1));
          } else if (e.key === "Escape" && text) {
            e.stopPropagation();
            setText("");
          }
        }}
        onBlur={() => {
          if (!text.trim()) return;
          add(text);
          setText("");
        }}
      />
      <datalist id={listId}>
        {suggestions
          .filter((s) => !tags.includes(s))
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
    </div>
  );
}
