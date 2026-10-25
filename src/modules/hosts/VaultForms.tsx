// Master-password forms: create the vault, unlock it, change its password.
// Typed passwords live only in their (uncontrolled) inputs: read once on submit,
// then cleared — they never sit in React state.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ipc } from "../../lib/ipc";
import { Icon } from "../../lib/icons";
import { cx } from "../../lib/util";
import { ui } from "../../state/ui";
import { MIN_MASTER_PASSWORD, refreshVault, resetVault, sentence } from "./vault";

type InputRef = RefObject<HTMLInputElement | null>;

export function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

/** Focus a field when asked (the pane got focus), unless a dialog or the palette is up. */
export function useFocusWhen(ref: RefObject<HTMLElement | null>, when: boolean | undefined) {
  useEffect(() => {
    if (!when || ui.get().dialog || ui.get().palette.open) return;
    ref.current?.focus({ preventScroll: true });
  }, [when, ref]);
}

const valueOf = (r: InputRef) => r.current?.value ?? "";
const wipe = (...refs: InputRef[]) => refs.forEach((r) => r.current && (r.current.value = ""));
const length = (s: string) => [...s].length;

function SecretField({ inputRef, label, placeholder, disabled }: { inputRef: InputRef; label?: string; placeholder?: string; disabled?: boolean }) {
  return (
    <>
      {label && <label className="field-label">{label}</label>}
      <input ref={inputRef} className="input wide" type="password" autoComplete="off" spellCheck={false} placeholder={placeholder} disabled={disabled} />
    </>
  );
}

function Gate({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <div className="module-scroll vault-gate">
      <div className="vault-card">
        <div className="vault-badge">
          <Icon name={icon} size={22} />
        </div>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function CreateVaultForm({ autoFocus }: { autoFocus?: boolean }) {
  const pw = useRef<HTMLInputElement>(null);
  const again = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useAlive();
  useFocusWhen(pw, autoFocus);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const a = valueOf(pw);
    if (length(a) < MIN_MASTER_PASSWORD) {
      setError(`Use at least ${MIN_MASTER_PASSWORD} characters.`);
      pw.current?.focus();
      return;
    }
    if (a !== valueOf(again)) {
      setError("The two passwords don't match.");
      again.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await ipc.vaultCreate(a);
      wipe(pw, again);
      void refreshVault();
    } catch (err) {
      if (alive.current) setError(sentence(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <Gate icon="key-round" title="Create a vault for your hosts">
      <p className="dim">
        Saved hosts, their passwords and private keys are encrypted with a master password. You enter it once per session; the vault locks
        itself when you haven't used it for a while.
      </p>
      <p className="vault-warn">
        <Icon name="warning" size={13} />
        <span>The master password can't be recovered. If you forget it, the vault has to be reset and everything in it is lost.</span>
      </p>
      <form onSubmit={submit} autoComplete="off">
        <SecretField inputRef={pw} label="Master password" placeholder={`At least ${MIN_MASTER_PASSWORD} characters`} disabled={busy} />
        <SecretField inputRef={again} label="Repeat it" disabled={busy} />
        {error && (
          <div className="vault-error" role="alert">
            {error}
          </div>
        )}
        <div className="row vault-actions">
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create vault"}
          </button>
        </div>
      </form>
    </Gate>
  );
}

export function UnlockVaultForm({ autoFocus, message, extra }: { autoFocus?: boolean; message?: string; extra?: ReactNode }) {
  const pw = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useAlive();
  useFocusWhen(pw, autoFocus);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const a = valueOf(pw);
    if (!a) return pw.current?.focus();
    setBusy(true);
    setError(null);
    try {
      await ipc.vaultUnlock(a);
      wipe(pw);
      void refreshVault();
    } catch (err) {
      if (!alive.current) return;
      setError(sentence(err));
      requestAnimationFrame(() => pw.current?.select());
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <Gate icon="lock" title="Vault locked">
      <p className="dim">{message ?? "Enter the master password to use your saved hosts."}</p>
      <form onSubmit={submit} autoComplete="off">
        <SecretField inputRef={pw} placeholder="Master password" disabled={busy} />
        {error && (
          <div className="vault-error" role="alert">
            {error}
          </div>
        )}
        <div className="row vault-actions">
          <button className="btn primary" type="submit" disabled={busy}>
            <Icon name="lock-open" size={14} /> {busy ? "Unlocking…" : "Unlock"}
          </button>
          {extra}
        </div>
      </form>
      <button type="button" className="btn subtle small danger vault-forgot" onClick={() => void resetVault()}>
        Forgot it? Reset vault…
      </button>
    </Gate>
  );
}

/** `card`: a full-pane form (Hosts module); `inline`: fields only (Settings). */
export function ChangePasswordForm({ onDone, autoFocus, variant = "card" }: { onDone: () => void; autoFocus?: boolean; variant?: "card" | "inline" }) {
  const current = useRef<HTMLInputElement>(null);
  const next = useRef<HTMLInputElement>(null);
  const again = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useAlive();
  useFocusWhen(current, autoFocus);

  const cancel = () => {
    wipe(current, next, again);
    onDone();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const cur = valueOf(current);
    const a = valueOf(next);
    if (!cur) return current.current?.focus();
    if (length(a) < MIN_MASTER_PASSWORD) {
      setError(`Use at least ${MIN_MASTER_PASSWORD} characters for the new password.`);
      next.current?.focus();
      return;
    }
    if (a !== valueOf(again)) {
      setError("The new passwords don't match.");
      again.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await ipc.vaultChangePassword(cur, a);
      wipe(current, next, again);
      // (no vault://changed for this one: it may have unlocked the vault)
      void refreshVault();
      ui.toast("Master password changed", "success");
      if (alive.current) onDone();
    } catch (err) {
      if (!alive.current) return;
      setError(sentence(err));
      requestAnimationFrame(() => current.current?.select());
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const form = (
    <form
      className={cx(variant === "inline" && "vault-inline")}
      onSubmit={submit}
      autoComplete="off"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        cancel();
      }}
    >
      <SecretField inputRef={current} label="Current master password" disabled={busy} />
      <SecretField inputRef={next} label="New master password" placeholder={`At least ${MIN_MASTER_PASSWORD} characters`} disabled={busy} />
      <SecretField inputRef={again} label="Repeat the new password" disabled={busy} />
      {error && (
        <div className="vault-error" role="alert">
          {error}
        </div>
      )}
      <div className="row vault-actions">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Changing…" : "Change password"}
        </button>
        <button className="btn subtle" type="button" onClick={cancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
  if (variant === "inline") return form;
  return (
    <Gate icon="key-round" title="Change master password">
      <p className="dim">Everything in the vault is re-encrypted with the new password. Terminals that are connected stay connected.</p>
      {form}
    </Gate>
  );
}
