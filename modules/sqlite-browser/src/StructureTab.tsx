// A schema object's definition: its CREATE statement, columns, indexes, keys and triggers.
import type { ReactNode } from "react";
import { ArrowRight, Check, Copy, Eye, KeyRound, ListTree, Rows3, Sheet, Table2, Zap } from "lucide-react";
import { Button, Chip, IconButton, Message, Section, Toolbar, copy, cx } from "../../shared";
import { highlightSql } from "./cells";
import { TablePicker } from "./DataTab";
import { isSystem, qi } from "./sql";
import { countText, useDb } from "./state";

const ORIGIN: Record<string, string> = { c: "CREATE INDEX", u: "UNIQUE constraint", pk: "PRIMARY KEY" };
const HIDDEN = ["", "hidden", "generated (virtual)", "generated (stored)"];

function Link({ children, onClick, title }: { children: ReactNode; onClick: () => void; title?: string }) {
  return (
    <button type="button" className="sqlb-link" title={title} onClick={onClick}>
      {children}
    </button>
  );
}

export function StructureTab() {
  const { selected, schema, select, narrow, counts, sendToSql } = useDb();
  if (!selected)
    return (
      <Message icon={<ListTree size={22} />} title="Nothing selected">
        Pick a table, view, index or trigger.
      </Message>
    );
  const obj = selected;
  const lower = obj.name.toLowerCase();
  const triggers = schema.filter((o) => o.type === "trigger" && o.tblName.toLowerCase() === lower);
  const indexSql = new Map(schema.filter((o) => o.type === "index").map((o) => [o.name, o.sql]));
  const referencedBy = schema.flatMap((o) => (o.type === "table" ? o.foreignKeys.filter((fk) => fk.table.toLowerCase() === lower).map((fk) => ({ from: o, fk })) : []));
  const Icon = obj.type === "view" ? Eye : obj.type === "index" ? ListTree : obj.type === "trigger" ? Zap : obj.virtual ? Sheet : Table2;
  const count = countText(counts[obj.name]);
  const owner = obj.type === "index" || obj.type === "trigger" ? schema.find((o) => o.name.toLowerCase() === obj.tblName.toLowerCase()) : null;
  const ownIndex = owner?.indexes.find((i) => i.name === obj.name);

  return (
    <div className="sqlb-col">
      {narrow && (
        <Toolbar>
          <TablePicker all />
        </Toolbar>
      )}
      <div className="sm-scroll">
        <div className="sqlb-structure">
          <div className="sqlb-st-head">
            <Icon size={18} className="sqlb-st-icon" />
            <h2 className="sm-selectable">{obj.name}</h2>
            <Chip tone="dim">{obj.virtual ? "virtual table" : obj.type}</Chip>
            {obj.withoutRowid && <Chip tone="dim">WITHOUT ROWID</Chip>}
            {isSystem(obj.name) && (
              <Chip tone="dim" title="Maintained by SQLite itself">
                system
              </Chip>
            )}
            {count && <span className="sqlb-dim">{count} rows</span>}
            <div className="sm-grow" />
            {(obj.type === "table" || obj.type === "view") && (
              <>
                <Button small onClick={() => select(obj.name, "data")}>
                  <Rows3 size={13} /> Browse
                </Button>
                <Button small kind="subtle" onClick={() => sendToSql(`SELECT * FROM ${qi(obj.name)} LIMIT 100;`, true)}>
                  Query
                </Button>
              </>
            )}
            {owner && (
              <Button small onClick={() => select(owner.name, "structure")}>
                {owner.type === "view" ? <Eye size={13} /> : <Table2 size={13} />} {owner.name}
              </Button>
            )}
          </div>

          <Section
            title="CREATE statement"
            actions={
              obj.sql ? (
                <IconButton title="Copy the CREATE statement" onClick={() => copy(obj.sql!, "CREATE statement")}>
                  <Copy size={13} />
                </IconButton>
              ) : undefined
            }
          >
            {obj.sql ? (
              <pre className="sm-code sqlb-sqlblock">{highlightSql(obj.sql)}</pre>
            ) : (
              <div className="sqlb-note">SQLite created this {obj.type} automatically{ownIndex ? ` for a ${ORIGIN[ownIndex.origin] ?? ownIndex.origin}` : ""}; it has no CREATE statement.</div>
            )}
          </Section>

          {obj.type === "index" && ownIndex && (
            <Section title="Index">
              <div className="sqlb-def-wrap">
                <table className="sqlb-def">
                  <tbody>
                    <tr>
                      <th>Columns</th>
                      <td className="mono">{ownIndex.columns.join(", ") || "(expression)"}</td>
                    </tr>
                    <tr>
                      <th>Unique</th>
                      <td>{ownIndex.unique ? "yes" : "no"}</td>
                    </tr>
                    <tr>
                      <th>Made by</th>
                      <td>{ORIGIN[ownIndex.origin] ?? ownIndex.origin}</td>
                    </tr>
                    <tr>
                      <th>Partial</th>
                      <td>{ownIndex.partial ? "yes (has a WHERE clause)" : "no"}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {obj.columns.length > 0 && (
            <Section title={`Columns · ${obj.columns.length}`}>
              <div className="sqlb-def-wrap">
                <table className="sqlb-def">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Not null</th>
                      <th>Default</th>
                      <th className="num">PK</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {obj.columns.map((c) => (
                      <tr key={c.cid}>
                        <td className="num sqlb-dim">{c.cid}</td>
                        <td className="sqlb-def-name">
                          {c.pk > 0 && <KeyRound size={11} className="sqlb-key" />}
                          <span className="sm-selectable">{c.name}</span>
                        </td>
                        <td className="mono">{c.type || <span className="sqlb-dim">—</span>}</td>
                        <td>{c.notNull ? <Check size={13} className="sqlb-ok" /> : null}</td>
                        <td className="mono">{c.default ?? <span className="sqlb-dim">—</span>}</td>
                        <td className="num">{c.pk || ""}</td>
                        <td className="sqlb-dim">{HIDDEN[c.hidden] ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {obj.type === "table" && (
            <Section title={`Indexes · ${obj.indexes.length}`}>
              {obj.indexes.length ? (
                <div className="sqlb-def-wrap">
                  <table className="sqlb-def">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Columns</th>
                        <th>Unique</th>
                        <th>Made by</th>
                      </tr>
                    </thead>
                    <tbody>
                      {obj.indexes.map((ix) => (
                        <tr key={ix.name}>
                          <td title={indexSql.get(ix.name) ?? undefined}>
                            <Link onClick={() => select(ix.name, "structure")}>{ix.name}</Link>
                            {ix.partial && <span className="sqlb-dim"> · partial</span>}
                          </td>
                          <td className="mono">{ix.columns.join(", ") || <span className="sqlb-dim">(expression)</span>}</td>
                          <td>{ix.unique ? <Check size={13} className="sqlb-ok" /> : null}</td>
                          <td className="sqlb-dim">{ORIGIN[ix.origin] ?? ix.origin}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="sqlb-note">No indexes.</div>
              )}
            </Section>
          )}

          {obj.type === "table" && (obj.foreignKeys.length > 0 || referencedBy.length > 0) && (
            <Section title="Foreign keys">
              <div className="sqlb-fks">
                {obj.foreignKeys.map((fk) => (
                  <div key={`${fk.id}:${fk.from}`} className="sqlb-fk">
                    <span className="mono">{fk.from}</span>
                    <ArrowRight size={12} className="sqlb-dim" />
                    <span className="mono">
                      <Link onClick={() => select(fk.table, "structure")}>{fk.table}</Link>({fk.to ?? <span className="sqlb-dim">primary key</span>})
                    </span>
                    <FkActions u={fk.onUpdate} d={fk.onDelete} />
                  </div>
                ))}
                {referencedBy.map(({ from, fk }) => (
                  <div key={`${from.name}:${fk.id}:${fk.from}`} className="sqlb-fk in">
                    <span className="mono">
                      <Link onClick={() => select(from.name, "structure")}>{from.name}</Link>.{fk.from}
                    </span>
                    <ArrowRight size={12} className="sqlb-dim" />
                    <span className="mono">{fk.to ?? <span className="sqlb-dim">primary key</span>}</span>
                    <span className="sqlb-dim">refers to this table</span>
                    <FkActions u={fk.onUpdate} d={fk.onDelete} />
                  </div>
                ))}
              </div>
            </Section>
          )}

          {(obj.type === "table" || obj.type === "view") && triggers.length > 0 && (
            <Section title={`Triggers · ${triggers.length}`}>
              {triggers.map((t) => (
                <div key={t.name} className="sqlb-trigger">
                  <div className="sqlb-trigger-name">
                    <Zap size={12} /> <Link onClick={() => select(t.name, "structure")}>{t.name}</Link>
                    <div className="sm-grow" />
                    {t.sql && (
                      <IconButton title="Copy" onClick={() => copy(t.sql!, "trigger")}>
                        <Copy size={12} />
                      </IconButton>
                    )}
                  </div>
                  {t.sql && <pre className="sm-code sqlb-sqlblock">{highlightSql(t.sql)}</pre>}
                </div>
              ))}
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function FkActions({ u, d }: { u: string; d: string }) {
  const parts = [u && u !== "NO ACTION" ? `on update ${u.toLowerCase()}` : "", d && d !== "NO ACTION" ? `on delete ${d.toLowerCase()}` : ""].filter(Boolean);
  return parts.length ? <span className={cx("sqlb-fk-act", /cascade/i.test(d) && "warn")}>{parts.join(" · ")}</span> : null;
}
