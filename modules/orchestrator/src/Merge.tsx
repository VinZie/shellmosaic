// "Merge into <your branch>": what the team's integration branch would bring, what's in
// the way, and the merge itself once you approve it.
import { useEffect, useState } from "react";
import { GitMerge, LoaderCircle, TriangleAlert } from "lucide-react";
import { closeModal, errorText, openModal, pluralize, sm, type AgentRun, type MergePreview } from "../../shared";

export function openMerge(run: AgentRun, canManage: boolean) {
  openModal(() => <MergeDialog run={run} canManage={canManage} />);
}

function MergeDialog({ run, canManage }: { run: AgentRun; canManage: boolean }) {
  const [p, setP] = useState<MergePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sm.agents.mergePreview(run.id).then(setP, (e) => setError(errorText(e)));
  }, [run.id]);

  const merge = async () => {
    setBusy(true);
    setError(null);
    try {
      const msg = await sm.agents.mergeToBase(run.id);
      sm.ui.notify(msg, "success");
      closeModal();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const base = p?.base ?? run.baseBranch ?? "your branch";
  const wrongBranch = !!p && p.current !== p.base;
  const blocked = !p || p.commits === 0 || wrongBranch || p.conflicts.length > 0 || p.dirtyOverlap.length > 0;

  return (
    <div className="sm-dialog orc-dialog-wide orc-merge">
      <h3>
        <GitMerge size={15} /> Merge the team's work into {base}
      </h3>
      {!p && !error && (
        <p className="sm-dim orc-merge-loading">
          <LoaderCircle size={14} className="sm-spin" /> Looking at what it would change…
        </p>
      )}
      {p && (
        <>
          <p>
            {p.commits === 0 ? (
              <>
                {base} already has everything from <code>{p.integration}</code>: nothing to merge.
              </>
            ) : (
              <>
                <code>{p.integration}</code> has {pluralize(p.commits, "commit")} that {base} doesn't: {pluralize(p.files.length, "file")} changed,{" "}
                <span className="orc-plus">+{p.added}</span> <span className="orc-minus">−{p.removed}</span>. Accepted tasks are merged there; this brings them into {base} in your own
                working tree.
              </>
            )}
          </p>
          {wrongBranch && (
            <div className="orc-blocker">
              <TriangleAlert size={14} />
              <span>
                Your repository is on <b>{p.current ?? "a detached HEAD"}</b> now. Switch it back to <b>{p.base}</b> to merge (Shellmosaic never checks out in your working tree).
              </span>
            </div>
          )}
          {p.conflicts.length > 0 && (
            <div className="orc-blocker">
              <TriangleAlert size={14} />
              <span>
                These files conflict with {base}: <span className="mono">{p.conflicts.join(", ")}</span>. Ask the lead for a task that merges {base} into the team's work, then try again.
              </span>
            </div>
          )}
          {p.dirtyOverlap.length > 0 && (
            <div className="orc-blocker">
              <TriangleAlert size={14} />
              <span>
                You have uncommitted changes in files the merge changes: <span className="mono">{p.dirtyOverlap.join(", ")}</span>. Commit or stash them first.
              </span>
            </div>
          )}
          {p.files.length > 0 && (
            <div className="orc-merge-files mono sm-selectable">
              {p.files.slice(0, 300).map((f) => (
                <div key={f} className={p.conflicts.includes(f) || p.dirtyOverlap.includes(f) ? "sm-warning-text" : undefined}>
                  {f}
                </div>
              ))}
              {p.files.length > 300 && <div className="sm-dim">… {p.files.length - 300} more</div>}
            </div>
          )}
        </>
      )}
      {error && <div className="sm-dialog-error">{error}</div>}
      <div className="sm-dialog-buttons">
        <button type="button" className="sm-btn subtle" onClick={closeModal}>
          {p && blocked ? "Close" : "Cancel"}
        </button>
        <button type="button" className="sm-btn primary" disabled={!canManage || blocked || busy} onClick={merge} title={canManage ? "" : "Needs the agents.manage permission"}>
          {busy ? <LoaderCircle size={13} className="sm-spin" /> : <GitMerge size={13} />} Merge into {base}
        </button>
      </div>
    </div>
  );
}
