// A task branch's changes: per-file summary and the unified diff, colored.
import { useEffect, useMemo, useState } from "react";
import { FileDiff, LoaderCircle, RefreshCw } from "lucide-react";
import { Button, cx, errorText, IconButton, pluralize, sm, type TaskDiff } from "../../shared";

interface FileStat {
  path: string;
  added: number;
  removed: number;
  /** first line of this file's section in the diff */
  line: number;
}

function filesOf(lines: string[]): FileStat[] {
  const out: FileStat[] = [];
  let cur: FileStat | null = null;
  lines.forEach((l, i) => {
    if (l.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(l);
      cur = { path: m ? m[1] : l.slice(11), added: 0, removed: 0, line: i };
      out.push(cur);
    } else if (cur && l.startsWith("+") && !l.startsWith("+++")) cur.added++;
    else if (cur && l.startsWith("-") && !l.startsWith("---")) cur.removed++;
  });
  return out;
}

const LIMIT = 4000;

export function DiffView({ taskId, branch, auto }: { taskId: string; branch: string; auto: boolean }) {
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [all, setAll] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setDiff(await sm.agents.taskDiff(taskId));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setDiff(null);
    setAll(false);
    setError(null);
    if (auto) load();
    // a different task (or branch) is a different diff
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, branch]);

  const lines = useMemo(() => (diff?.diff ? diff.diff.replace(/\r/g, "").split("\n") : []), [diff]);
  const files = useMemo(() => filesOf(lines), [lines]);

  if (!diff) {
    return (
      <div className="orc-diff-empty">
        {error ? <span className="sm-danger-text">{error}</span> : <span className="sm-dim">Changes on {branch} compared with orch/integration.</span>}
        <Button small onClick={load} disabled={loading}>
          {loading ? <LoaderCircle size={13} className="sm-spin" /> : <FileDiff size={13} />} Show changes
        </Button>
      </div>
    );
  }

  const shown = all ? lines : lines.slice(0, LIMIT);
  const jump = (line: number) => document.getElementById(`orc-diff-${taskId}-${line}`)?.scrollIntoView({ block: "start" });
  return (
    <div className="orc-diff">
      <div className="orc-diff-summary">
        <span>
          {pluralize(diff.commits, "commit")} · {pluralize(diff.files, "file")}
        </span>
        <span className="orc-plus">+{diff.added}</span>
        <span className="orc-minus">−{diff.removed}</span>
        <span className="sm-grow" />
        <IconButton title="Reload" onClick={load} disabled={loading}>
          <RefreshCw size={13} className={cx(loading && "sm-spin")} />
        </IconButton>
      </div>
      {files.length > 0 && (
        <div className="orc-diff-files">
          {files.map((f) => (
            <button key={f.path + f.line} type="button" className="orc-diff-file" onClick={() => jump(f.line)} title={`Go to ${f.path}`}>
              <span className="sm-ellipsis mono">{f.path}</span>
              <span className="orc-plus">+{f.added}</span>
              <span className="orc-minus">−{f.removed}</span>
            </button>
          ))}
        </div>
      )}
      {lines.length === 0 || (lines.length === 1 && !lines[0]) ? (
        <p className="sm-dim orc-none">No changes: the branch has nothing that orch/integration doesn't have.</p>
      ) : (
        <pre className="orc-diff-code sm-selectable">
          {shown.map((l, i) => (
            <div
              key={i}
              id={l.startsWith("diff --git ") ? `orc-diff-${taskId}-${i}` : undefined}
              className={cx(
                "orc-dl",
                l.startsWith("diff --git ") ? "file" : l.startsWith("@@") ? "hunk" : l.startsWith("+++") || l.startsWith("---") || /^(index|new file|deleted file|similarity|rename) /.test(l) ? "meta" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "",
              )}
            >
              {l || " "}
            </div>
          ))}
        </pre>
      )}
      {(lines.length > LIMIT && !all) || diff.truncated ? (
        <div className="orc-diff-more">
          {lines.length > LIMIT && !all && (
            <Button small kind="subtle" onClick={() => setAll(true)}>
              Show all {lines.length.toLocaleString()} lines
            </Button>
          )}
          {diff.truncated && <span className="sm-dim">The diff is longer than 400 KB; the rest isn't shown. Look at {branch} in git for all of it.</span>}
        </div>
      ) : null}
    </div>
  );
}
