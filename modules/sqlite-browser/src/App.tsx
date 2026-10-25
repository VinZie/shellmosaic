import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, FolderOpen } from "lucide-react";
import { Loading, errorText, openMenu, openModal, sm, useStored, usePane, usePaneState, type DbInfo, type MenuItem, type SchemaObject } from "../../shared";
import { DbView } from "./DbView";
import { StartScreen, type OpenFailure } from "./StartScreen";
import { fileOf, useWidth, type PaneState, type Recent } from "./state";
import "./app.css";

const INITIAL: PaneState = { path: null, copy: false, table: null, tab: "data", sql: "" };
const MAX_RECENT = 12;

export const FILE_FILTERS = [
  { name: "SQLite databases", extensions: ["db", "sqlite", "sqlite3", "db3", "s3db"] },
  { name: "All files", extensions: ["*"] },
];

interface Opened {
  db: DbInfo;
  schema: SchemaObject[];
}

export function App() {
  const ctx = usePane();
  const [pane, setPane] = usePaneState<PaneState>(ctx, INITIAL);
  const [recent, setRecent] = useStored<Recent[]>("recent", []);
  const [asCopy, setAsCopy] = useStored<boolean>("openCopy", false);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [failure, setFailure] = useState<OpenFailure | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useWidth(rootRef);
  const openedRef = useRef(opened);
  openedRef.current = opened;
  const gen = useRef(0);

  const open = useCallback(
    async (path: string, opts: { copy?: boolean; restore?: Pick<PaneState, "table" | "tab"> } = {}) => {
      path = path.trim().replace(/^"(.*)"$/, "$1");
      if (!path) return;
      const my = ++gen.current;
      setOpening(path);
      setFailure(null);
      let info: DbInfo | null = null;
      try {
        // always read-only first: changes only after the user allows them
        info = await sm.sqlite.open(path, { writable: false, copy: !!opts.copy });
        const schema = await sm.sqlite.schema(info.id);
        if (my !== gen.current) {
          sm.sqlite.close(info.id).catch(() => {});
          return;
        }
        const prev = openedRef.current;
        if (prev && prev.db.id !== info.id) sm.sqlite.close(prev.db.id).catch(() => {});
        setOpened({ db: info, schema });
        setPane({ path, copy: !!opts.copy, table: opts.restore?.table ?? null, tab: opts.restore?.tab ?? "data" });
        setRecent((list) => [{ path, file: fileOf(path), at: Date.now() }, ...list.filter((r) => r.path.toLowerCase() !== path.toLowerCase())].slice(0, MAX_RECENT));
        sm.ui.setTitle(`SQLite: ${info.file}`).catch(() => {});
      } catch (e) {
        if (info) sm.sqlite.close(info.id).catch(() => {});
        if (my !== gen.current) return;
        const message = errorText(e);
        if (openedRef.current) showOpenError(path, message);
        else {
          setFailure({ path, message, restoring: !!opts.restore });
          if (opts.restore) setPane({ path: null, table: null });
        }
      } finally {
        if (my === gen.current) setOpening(null);
      }
    },
    [setPane, setRecent],
  );

  // a path from whoever opened the pane (Files → Open in SQLite Browser), or the
  // database this pane had before a restart (read-only again)
  const started = useRef(false);
  useEffect(() => {
    if (!ctx || started.current) return;
    started.current = true;
    const saved = ctx.state as Partial<PaneState> | null;
    const argPath = typeof ctx.args?.path === "string" ? ctx.args.path : null;
    if (saved?.path) open(saved.path, { copy: !!saved.copy, restore: { table: saved.table ?? null, tab: saved.tab ?? "data" } });
    else if (argPath) open(argPath, { copy: ctx.args?.copy === true });
  }, [ctx, open]);

  const pick = useCallback(
    async (copy: boolean) => {
      try {
        const p = await sm.ui.pickFile({ title: copy ? "Open a copy of a SQLite database" : "Open a SQLite database", filters: FILE_FILTERS });
        if (p) open(p, { copy });
      } catch (e) {
        sm.ui.notify(errorText(e), "error");
      }
    },
    [open],
  );

  const close = useCallback(() => {
    const cur = openedRef.current;
    gen.current++;
    setOpened(null);
    setOpening(null);
    setPane({ path: null, table: null });
    sm.ui.setTitle("SQLite Browser").catch(() => {});
    if (cur) sm.sqlite.close(cur.db.id).catch(() => {});
  }, [setPane]);

  const openAnotherMenu = useCallback(
    (anchor: HTMLElement) => {
      const cur = openedRef.current?.db.path.toLowerCase();
      const others = recent.filter((r) => r.path.toLowerCase() !== cur).slice(0, 8);
      const items: MenuItem[] = [
        { label: "Open a database…", icon: <FolderOpen size={14} />, onSelect: () => pick(false) },
        { label: "Open a copy…", icon: <Copy size={14} />, onSelect: () => pick(true) },
      ];
      if (others.length) {
        items.push({ separator: true }, { header: "Recent" });
        for (const r of others) items.push({ label: r.file, hint: shortDir(r.path), onSelect: () => open(r.path) });
      }
      openMenu(anchor, items);
    },
    [recent, pick, open],
  );

  const onDb = useCallback((db: DbInfo) => setOpened((o) => (o && o.db.id === db.id ? { ...o, db } : o)), []);
  const onSchema = useCallback((schema: SchemaObject[]) => setOpened((o) => (o ? { ...o, schema } : o)), []);
  const narrow = width < 700;

  let body;
  if (!ctx) body = <Loading />;
  else if (opening && !opened) body = <Loading label={`Opening ${fileOf(opening)}…`} />;
  else if (opened)
    body = (
      <DbView
        key={opened.db.id}
        db={opened.db}
        schema={opened.schema}
        onDb={onDb}
        onSchema={onSchema}
        pane={pane}
        setPane={setPane}
        narrow={narrow}
        width={width}
        busy={opening}
        onClose={close}
        onOpenMenu={openAnotherMenu}
      />
    );
  else
    body = (
      <StartScreen
        recent={recent}
        asCopy={asCopy}
        setAsCopy={setAsCopy}
        failure={failure}
        onDismiss={() => setFailure(null)}
        onPick={() => pick(asCopy)}
        onOpen={(p, copy) => open(p, { copy: copy ?? asCopy })}
        onForget={(p) => setRecent((list) => list.filter((r) => r.path !== p))}
      />
    );

  return (
    <div className="sm-app sqlb" ref={rootRef}>
      {body}
    </div>
  );
}

function shortDir(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  const dir = parts.join("\\");
  return dir.length > 34 ? "…" + dir.slice(-33) : dir;
}

/** Opening another database failed while one is open: say so without closing it. */
function showOpenError(path: string, message: string) {
  openModal((close) => (
    <div className="sm-dialog sqlb-open-error">
      <h3>Couldn't open {fileOf(path)}</h3>
      <div className="sqlb-path mono sm-selectable">{path}</div>
      <p className="sm-selectable">{message}</p>
      <div className="sm-dialog-buttons">
        <button type="button" className="sm-btn primary" autoFocus onClick={close}>
          OK
        </button>
      </div>
    </div>
  ));
}
