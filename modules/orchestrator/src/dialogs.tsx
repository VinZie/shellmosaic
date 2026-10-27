// Modals the Orchestrator needs beyond the shared kit's one-line prompt.
import { useState } from "react";
import { cx, openModal } from "../../shared";

/** A modal asking for text (several lines); resolves null when cancelled. */
export function askText(opts: {
  title: string;
  label?: string;
  hint?: string;
  value?: string;
  placeholder?: string;
  okLabel?: string;
  /** an empty answer is allowed */
  optional?: boolean;
  danger?: boolean;
  rows?: number;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    openModal(
      (close) => (
        <TextBody
          {...opts}
          onCancel={() => {
            finish(null);
            close();
          }}
          onOk={(v) => {
            finish(v);
            close();
          }}
        />
      ),
      () => finish(null),
    );
  });
}

function TextBody({
  title,
  label,
  hint,
  value = "",
  placeholder,
  okLabel = "OK",
  optional,
  danger,
  rows = 5,
  onOk,
  onCancel,
}: {
  title: string;
  label?: string;
  hint?: string;
  value?: string;
  placeholder?: string;
  okLabel?: string;
  optional?: boolean;
  danger?: boolean;
  rows?: number;
  onOk: (v: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(value);
  const ok = optional || !!v.trim();
  return (
    <form
      className="sm-dialog orc-dialog-wide"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onOk(v);
      }}
    >
      <h3>{title}</h3>
      {label && <label className="sm-field-label">{label}</label>}
      <textarea
        className="sm-input wide orc-textarea"
        autoFocus
        rows={rows}
        value={v}
        placeholder={placeholder}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && ok) {
            e.preventDefault();
            onOk(v);
          }
        }}
      />
      {hint && <p className="orc-dialog-hint">{hint}</p>}
      <div className="sm-dialog-buttons">
        <button type="button" className="sm-btn subtle" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={cx("sm-btn", danger ? "danger" : "primary")} disabled={!ok} title="Ctrl+Enter">
          {okLabel}
        </button>
      </div>
    </form>
  );
}
