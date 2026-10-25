// Who the process is at a glance: parent, image path, and the chips people look for
// first (bitness, integrity, elevation, protection, suspended, debugged, signature).
import { Bug, FolderOpen, Pause, Shield, ShieldHalf } from "lucide-react";
import { Chip, IconButton, type ProcOverview } from "../../../shared";
import { SigChip, useSignature } from "../lib/signatures";
import { integrityTone } from "../lib/util";
import { reveal } from "./actions";

export function Header({ ov, error, onInspect }: { ov: ProcOverview | null; error: string | null; onInspect: (pid: number) => void }) {
  const sig = useSignature(ov?.path, true);
  if (!ov) {
    return (
      <div className="pi-head">
        <div className="pi-head-line">{error ? <span className="sm-danger-text sm-ellipsis">{error}</span> : <span className="pi-skeleton" />}</div>
      </div>
    );
  }
  const protectedProc = !!ov.protection && ov.protection !== "None";
  return (
    <div className="pi-head">
      <div className="pi-head-line">
        {ov.ppid !== null && (
          <span className="pi-head-parent">
            <span>Parent</span>
            {ov.parentName ? (
              <button type="button" className="pi-link" title={`Inspect ${ov.parentName} (${ov.ppid})`} onClick={() => onInspect(ov.ppid!)}>
                {ov.parentName} ({ov.ppid})
              </button>
            ) : (
              <span className="pi-head-gone" title="The parent has exited, or its PID now belongs to a younger process">
                exited ({ov.ppid})
              </span>
            )}
          </span>
        )}
        {ov.path ? (
          <span className="pi-head-path">
            <span className="pi-path sm-selectable" title={ov.path}>
              {ov.path}
            </span>
            <IconButton title="Open file location" onClick={() => reveal(ov.path)}>
              <FolderOpen size={13} />
            </IconButton>
          </span>
        ) : (
          <span className="pi-head-gone">{ov.denied.includes("path") ? "Image path needs administrator" : "No image path"}</span>
        )}
      </div>
      <div className="pi-chips">
        {ov.architecture && <Chip title="Architecture">{ov.architecture}</Chip>}
        {ov.integrity && (
          <Chip tone={integrityTone(ov.integrity)} title="Integrity level">
            {ov.integrity} integrity
          </Chip>
        )}
        {ov.elevated && (ov.elevationType === "full" || ov.integrity === "High") && (
          <Chip tone="warning" icon={<ShieldHalf size={12} />} title={`Elevated (${ov.elevationType ?? "full"} token)`}>
            Elevated
          </Chip>
        )}
        {protectedProc && (
          <Chip tone="accent" icon={<Shield size={12} />} title="Protected process: even administrators get limited access">
            {ov.protection}
          </Chip>
        )}
        {ov.suspended && (
          <Chip tone="warning" icon={<Pause size={11} />} title="Every thread is suspended">
            Suspended
          </Chip>
        )}
        {ov.debugged && (
          <Chip tone="danger" icon={<Bug size={12} />} title="A debugger is attached">
            Being debugged
          </Chip>
        )}
        {ov.path && <SigChip entry={sig} />}
      </div>
    </div>
  );
}
