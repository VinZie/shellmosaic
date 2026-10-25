import { CircleX, Info, KeyRound, LockKeyhole, MessageSquareText, OctagonX, TriangleAlert } from "lucide-react";
import { KIND_LABEL, type Ev, type LevelKind } from "./parse";

export const LEVELS: { level: number; kind: LevelKind; label: string }[] = [
  { level: 1, kind: "critical", label: "Critical" },
  { level: 2, kind: "error", label: "Error" },
  { level: 3, kind: "warning", label: "Warning" },
  { level: 4, kind: "info", label: "Information" },
  { level: 5, kind: "verbose", label: "Verbose" },
];

export function LevelIcon({ kind, size = 14 }: { kind: LevelKind; size?: number }) {
  const p = { size, className: `ev-lv-icon ev-lv-${kind}`, "aria-hidden": true } as const;
  switch (kind) {
    case "critical":
      return <OctagonX {...p} />;
    case "error":
      return <CircleX {...p} />;
    case "warning":
      return <TriangleAlert {...p} />;
    case "verbose":
      return <MessageSquareText {...p} />;
    case "auditSuccess":
      return <KeyRound {...p} />;
    case "auditFailure":
      return <LockKeyhole {...p} />;
    default:
      return <Info {...p} />;
  }
}

export function levelLabel(e: Ev): string {
  return e.kind === "auditSuccess" || e.kind === "auditFailure" ? KIND_LABEL[e.kind] : e.levelName;
}

export function LevelCell({ e, iconOnly }: { e: Ev; iconOnly?: boolean }) {
  return (
    <span className={`ev-level ev-lv-${e.kind}`}>
      <LevelIcon kind={e.kind} size={13} />
      {!iconOnly && <span className="sm-ellipsis">{levelLabel(e)}</span>}
    </span>
  );
}
