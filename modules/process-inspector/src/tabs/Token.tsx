// Token: identity, elevation and integrity, then groups, privileges (the ones useful
// for privilege escalation called out) and AppContainer capabilities.
import { useMemo, useState, type ReactNode } from "react";
import { Copy, KeyRound, ShieldHalf, TriangleAlert } from "lucide-react";
import {
  Chip,
  copy,
  formatNumber,
  hex,
  KeyValues,
  openMenu,
  SearchBox,
  Section,
  sm,
  Table,
  Toolbar,
  useColumnState,
  type Column,
  type KV,
  type ProcToken,
  type TokenGroup,
  type TokenPrivilege,
  type Tone,
} from "../../../shared";
import { ResourceView } from "../components/common";
import type { TabProps } from "../lib/prefs";
import { useResource } from "../lib/resource";
import { integrityTone } from "../lib/util";

const loadToken = (pid: number) => sm.process.token(pid);

/** Privileges that turn a foothold into SYSTEM (or close to it). */
const NOTABLE: Record<string, string> = {
  SeDebugPrivilege: "Open any process, including SYSTEM ones",
  SeImpersonatePrivilege: "Impersonate tokens handed to it (the \"potato\" family)",
  SeAssignPrimaryTokenPrivilege: "Start processes with another token",
  SeTcbPrivilege: "Act as part of the operating system",
  SeLoadDriverPrivilege: "Load kernel drivers",
  SeBackupPrivilege: "Read any file, ignoring its ACL",
  SeRestorePrivilege: "Write any file, ignoring its ACL",
  SeTakeOwnershipPrivilege: "Take ownership of any object",
  SeCreateTokenPrivilege: "Forge tokens",
  SeManageVolumePrivilege: "Raw volume access",
  SeRelabelPrivilege: "Change integrity labels",
  SeTrustedCredManAccessPrivilege: "Read stored credentials",
};

const FLAG_LABEL: Record<string, string> = {
  EnabledByDefault: "Enabled by default",
  DenyOnly: "Deny only",
  IntegrityEnabled: "Integrity enabled",
  LogonId: "Logon ID",
};
const FLAG_TONE: Record<string, Tone | undefined> = {
  Enabled: "success",
  DenyOnly: "warning",
  Owner: "accent",
  Integrity: "accent",
  IntegrityEnabled: "accent",
  LogonId: "accent",
};

const groupKey = (g: TokenGroup) => g.sid;
const privKey = (p: TokenPrivilege) => p.name;
const capKey = (c: { sid: string }) => c.sid;

function privStatus(p: TokenPrivilege): [string, Tone, number] {
  if (p.removed) return ["Removed", "dim", 3];
  if (p.enabled) return p.enabledByDefault ? ["Enabled by default", "success", 1] : ["Enabled", "success", 0];
  return ["Disabled", "dim", 2];
}

export function TokenTab(p: TabProps) {
  const res = useResource(p.pid, loadToken, { ...p.live, active: p.active, onExited: p.onExited });
  return (
    <ResourceView res={res} ctx={p.ctx} what="token" name={p.name}>
      {(t) => <TokenBody token={t} />}
    </ResourceView>
  );
}

/** A Table sized to its rows, inside the scrolling page. */
function StaticTable({ count, children }: { count: number; children: ReactNode }) {
  return (
    <div className="pi-static-table" style={{ height: 40 + Math.max(2, count) * 24 }}>
      {children}
    </div>
  );
}

function TokenBody({ token }: { token: ProcToken }) {
  const [q, setQ] = useState("");
  const [gcols, setGcols] = useColumnState("token-groups");
  const [pcols, setPcols] = useColumnState("token-privileges");
  const [ccols, setCcols] = useColumnState("token-capabilities");

  const s = q.trim().toLowerCase();
  const groups = useMemo(
    () => (s ? token.groups.filter((g) => g.name?.toLowerCase().includes(s) || g.sid.toLowerCase().includes(s) || g.flags.some((f) => f.toLowerCase().includes(s))) : token.groups),
    [token.groups, s],
  );
  const privs = useMemo(() => (s ? token.privileges.filter((p) => p.name.toLowerCase().includes(s) || p.description?.toLowerCase().includes(s)) : token.privileges), [token.privileges, s]);
  const caps = useMemo(() => (s ? token.capabilities.filter((c) => c.name?.toLowerCase().includes(s) || c.sid.toLowerCase().includes(s)) : token.capabilities), [token.capabilities, s]);

  const info: KV[] = [
    { label: "User", value: token.user ?? token.userSid },
    { label: "User SID", value: token.userSid, mono: true },
    { label: "Owner", value: token.owner ?? "—", muted: !token.owner },
    { label: "Primary group", value: token.primaryGroup ?? "—", muted: !token.primaryGroup },
    {
      label: "Integrity",
      value: token.integrity ? (
        <span className="pi-kv-inline">
          <Chip tone={integrityTone(token.integrity)}>{token.integrity}</Chip>
          {token.integrityRid !== null && <span className="sm-dim mono">RID {hex(token.integrityRid)}</span>}
        </span>
      ) : (
        "—"
      ),
      copyText: token.integrity,
    },
    { label: "Session", value: token.sessionId },
    { label: "Elevation", value: `${token.elevated ? "Elevated" : "Not elevated"} (${token.elevationType} token)` },
    { label: "Token type", value: token.tokenType === "primary" ? "Primary" : `Impersonation${token.impersonationLevel ? ` (${token.impersonationLevel})` : ""}` },
    { label: "Logon ID", value: token.logonId, mono: true },
    { label: "Token ID", value: token.tokenId, mono: true },
    { label: "Source", value: token.source ?? "—", muted: !token.source },
    { label: "Virtualization", value: token.virtualizationEnabled ? "Enabled" : token.virtualizationAllowed ? "Allowed, not enabled" : "Not allowed" },
    {
      label: "UI access",
      value: token.uiAccess ? <span className="sm-warning-text">Yes: may drive windows of higher integrity</span> : "No",
      copyText: token.uiAccess ? "Yes" : "No",
    },
    {
      label: "AppContainer",
      value: token.appContainer ? <span className="mono">{token.appContainerSid ?? "Yes"}</span> : "No",
      copyText: token.appContainer ? (token.appContainerSid ?? "Yes") : "No",
    },
  ];

  const groupCols = useMemo<Column<TokenGroup>[]>(
    () => [
      {
        id: "name",
        label: "Name",
        width: 280,
        sort: (g) => g.name ?? g.sid,
        text: (g) => g.name ?? g.sid,
        render: (g) => (
          <>
            {g.flags.includes("Integrity") && (
              <span className="pi-flag-icon accent" title="Integrity level">
                <ShieldHalf size={12} />
              </span>
            )}
            {g.flags.includes("LogonId") && (
              <span className="pi-flag-icon accent" title="Logon session">
                <KeyRound size={12} />
              </span>
            )}
            <span className="sm-cell-text">{g.name ?? g.sid}</span>
          </>
        ),
      },
      { id: "sid", label: "SID", width: 300, mono: true, sort: (g) => g.sid, text: (g) => g.sid },
      {
        id: "flags",
        label: "Flags",
        width: 300,
        sort: (g) => g.flags.join(","),
        text: (g) => g.flags.map((f) => FLAG_LABEL[f] ?? f).join(", "),
        render: (g) => (
          <span className="pi-flags">
            {g.flags.map((f) => (
              <Chip key={f} tone={FLAG_TONE[f]}>
                {FLAG_LABEL[f] ?? f}
              </Chip>
            ))}
          </span>
        ),
      },
      { id: "attributes", label: "Attributes", width: 100, mono: true, hidden: true, sort: (g) => g.attributes, text: (g) => hex(g.attributes) },
    ],
    [],
  );

  const privCols = useMemo<Column<TokenPrivilege>[]>(
    () => [
      {
        id: "name",
        label: "Name",
        width: 236,
        sort: (p) => p.name,
        text: (p) => p.name,
        render: (p) =>
          NOTABLE[p.name] && !p.removed ? (
            <span className={p.enabled ? "pi-cell-flag sm-warning-text" : "pi-cell-flag"} title={`Notable for privilege escalation: ${NOTABLE[p.name]}`}>
              <TriangleAlert size={12} className={p.enabled ? undefined : "pi-icon-dim"} />
              <span className="sm-cell-text">{p.name}</span>
            </span>
          ) : (
            <span className="sm-cell-text">{p.name}</span>
          ),
      },
      {
        id: "status",
        label: "Status",
        width: 136,
        sort: (p) => privStatus(p)[2],
        text: (p) => privStatus(p)[0],
        render: (p) => {
          const [label, tone] = privStatus(p);
          return <Chip tone={tone}>{label}</Chip>;
        },
      },
      { id: "description", label: "Description", width: 260, sort: (p) => p.description, text: (p) => p.description ?? "" },
    ],
    [],
  );

  const capCols = useMemo<Column<{ name: string | null; sid: string }>[]>(
    () => [
      { id: "name", label: "Name", width: 260, sort: (c) => c.name ?? c.sid, text: (c) => c.name ?? "" },
      { id: "sid", label: "SID", width: 420, mono: true, sort: (c) => c.sid, text: (c) => c.sid },
    ],
    [],
  );

  const enabledPrivs = token.privileges.filter((p) => p.enabled && !p.removed).length;

  return (
    <>
      <Toolbar className="pi-subbar">
        <SearchBox value={q} onChange={setQ} placeholder="Filter groups and privileges" width={260} />
      </Toolbar>
      <div className="pi-page">
        <div className="pi-token">
          <Section title="Token">
            <KeyValues rows={info} labelWidth={118} />
          </Section>
          <Section title="Privileges" actions={<span className="pi-section-note">{enabledPrivs} of {token.privileges.length} enabled</span>}>
            <StaticTable count={privs.length}>
              
                <Table
                  columns={privCols}
                  rows={privs}
                  rowKey={privKey}
                  columnState={pcols}
                  onColumnState={setPcols}
                  rowClass={(p) => (p.removed ? "pi-muted" : null)}
                  defaultSort={{ id: "status", desc: false }}
                  onContextMenu={(at, sel) =>
                    openMenu(at, [
                      { label: "Copy name", icon: <Copy size={14} />, onSelect: () => copy(sel.map((p) => p.name).join("\n"), "name") },
                      { label: "Copy description", icon: <Copy size={14} />, disabled: !sel[0]?.description, onSelect: () => copy(sel.map((p) => p.description ?? "").join("\n"), "description") },
                    ])
                  }
                  multi
                  empty={s ? "No privilege matches" : "No privileges"}
                />
            </StaticTable>
          </Section>
          <Section className="pi-wide" title="Groups" actions={<span className="pi-section-note">{formatNumber(token.groups.length)}</span>}>
            <StaticTable count={groups.length}>
              
                <Table
                  columns={groupCols}
                  rows={groups}
                  rowKey={groupKey}
                  columnState={gcols}
                  onColumnState={setGcols}
                  rowClass={(g) => (g.flags.includes("DenyOnly") ? "pi-muted" : null)}
                  onContextMenu={(at, sel) =>
                    openMenu(at, [
                      { label: "Copy name", icon: <Copy size={14} />, onSelect: () => copy(sel.map((g) => g.name ?? g.sid).join("\n"), "name") },
                      { label: "Copy SID", icon: <Copy size={14} />, onSelect: () => copy(sel.map((g) => g.sid).join("\n"), "SID") },
                    ])
                  }
                  multi
                  empty={s ? "No group matches" : "No groups"}
                />
            </StaticTable>
          </Section>
          {token.capabilities.length > 0 && (
            <Section className="pi-wide" title="Capabilities" actions={<span className="pi-section-note">{formatNumber(token.capabilities.length)}</span>}>
              <StaticTable count={caps.length}>
                
                  <Table
                    columns={capCols}
                    rows={caps}
                    rowKey={capKey}
                    columnState={ccols}
                    onColumnState={setCcols}
                    onContextMenu={(at, sel) => openMenu(at, [{ label: "Copy SID", icon: <Copy size={14} />, onSelect: () => copy(sel.map((c) => c.sid).join("\n"), "SID") }])}
                    multi
                    empty="No capability matches"
                  />
              </StaticTable>
            </Section>
          )}
        </div>
      </div>
    </>
  );
}
