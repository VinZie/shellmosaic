// The "New task" form (also used for follow-ups of a finished task).
import { useState } from "react";
import { closeModal, cx, errorText, openModal, Select, sm, Switch, type AgentRun, type AgentSnapshot, type AgentTask } from "../../../shared";
import { DIFFICULTY_LABEL, modelLabel, runTasks } from "../lib";

export function openNewTask(snap: AgentSnapshot, run: AgentRun, opts: { followUpOf?: AgentTask; onCreated?: (t: AgentTask) => void } = {}) {
  openModal(() => <NewTaskForm snap={snap} run={run} followUpOf={opts.followUpOf} onCreated={opts.onCreated} />);
}

function NewTaskForm({ snap, run, followUpOf, onCreated }: { snap: AgentSnapshot; run: AgentRun; followUpOf?: AgentTask; onCreated?: (t: AgentTask) => void }) {
  const [title, setTitle] = useState(followUpOf ? `Follow-up: ${followUpOf.title}` : "");
  const [description, setDescription] = useState("");
  const [difficulty, setDifficulty] = useState(followUpOf?.difficulty ?? 2);
  const [parent, setParent] = useState(followUpOf?.id ?? "");
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parents = runTasks(snap, run).filter((t) => ["done", "review", "failed"].includes(t.status));
  const level = snap.routing.levels[difficulty - 1];
  const ok = !!title.trim() && !busy;

  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const t = await sm.agents.createTask(run.id, { title: title.trim(), description: description.trim(), difficulty, followUpOf: parent || undefined });
      if (start) {
        try {
          await sm.agents.assign(t.id);
        } catch (e) {
          // the task exists: say why it didn't start, it stays queued
          sm.ui.notify(`${t.id} was created but didn't start: ${errorText(e)}`, "warning");
        }
      }
      onCreated?.(t);
      closeModal();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <form
      className="sm-dialog orc-dialog-wide orc-newtask"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3>{followUpOf ? `Follow-up of ${followUpOf.id}` : "New task"}</h3>
      <label className="sm-field-label">Title</label>
      <input className="sm-input wide" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should be done, in a few words" maxLength={200} />
      <label className="sm-field-label">Description</label>
      <textarea
        className="sm-input wide orc-textarea"
        rows={7}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Everything a fresh session needs: the goal, where in the code, constraints, and how to check it works."
      />
      <label className="sm-field-label">Difficulty</label>
      <div className="orc-segmented" role="radiogroup" aria-label="Difficulty">
        {[1, 2, 3, 4, 5].map((d) => (
          <button key={d} type="button" role="radio" aria-checked={difficulty === d} className={cx("orc-seg", difficulty === d && "on")} onClick={() => setDifficulty(d)} title={DIFFICULTY_LABEL[d]}>
            {d} <span className="orc-seg-sub">{DIFFICULTY_LABEL[d]}</span>
          </button>
        ))}
      </div>
      <p className="orc-dialog-hint">
        Runs on {modelLabel(level?.model)} with {level?.effort} effort
        {followUpOf ? " (a follow-up keeps the worker's model and conversation)" : ""} — see Routing.
      </p>
      {parents.length > 0 && (
        <>
          <label className="sm-field-label">Follow-up of</label>
          <Select
            value={parent}
            onChange={setParent}
            options={[{ value: "", label: "Nothing: a fresh session" }, ...parents.map((t) => ({ value: t.id, label: `${t.id} · ${t.title}` }))]}
            title="A follow-up continues in the same worker's conversation"
          />
        </>
      )}
      <label className="orc-check">
        <Switch value={start} onChange={setStart} />
        <span>Start it right away (an idle worker, or a new one while there's room)</span>
      </label>
      {error && <div className="sm-dialog-error">{error}</div>}
      <div className="sm-dialog-buttons">
        <button type="button" className="sm-btn subtle" onClick={closeModal}>
          Cancel
        </button>
        <button type="submit" className="sm-btn primary" disabled={!ok} title="Ctrl+Enter in the description">
          {start ? "Create and start" : "Create"}
        </button>
      </div>
    </form>
  );
}
