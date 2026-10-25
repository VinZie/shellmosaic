// Overview: image, security, performance, memory/I-O and exploit mitigations, as label/value sections.
import { useMemo, type ReactNode } from "react";
import { FolderOpen } from "lucide-react";
import { Chip, formatBytes, formatDateTime, formatDuration, formatNumber, IconButton, KeyValues, Section, type KV, type ProcOverview } from "../../../shared";
import { reveal } from "../components/actions";
import { DeniedBanner, ResourceView } from "../components/common";
import type { TabProps } from "../lib/prefs";
import type { Resource } from "../lib/resource";
import { SigChip, useSignature } from "../lib/signatures";
import { affinityText, integrityTone, priorityLabel } from "../lib/util";

const NEEDS_ADMIN = "Needs administrator";


const VIRTUALIZATION: Record<string, string> = { enabled: "Enabled", disabled: "Disabled", notAllowed: "Not allowed" };

export function OverviewTab({ ctx, name, res }: TabProps & { res: Resource<ProcOverview> }) {
  return (
    <ResourceView res={res} ctx={ctx} what="process details" name={name}>
      {(ov) => (
        <>
          {ov.denied.length > 0 && !res.error && <DeniedBanner ctx={ctx} what={`some details of ${ov.name}`} />}
          <div className="pi-page">
            <OverviewBody ov={ov} />
          </div>
        </>
      )}
    </ResourceView>
  );
}

function OverviewBody({ ov }: { ov: ProcOverview }) {
  const sig = useSignature(ov.path, true);
  const denied = useMemo(() => new Set(ov.denied), [ov.denied]);

  /** A row that shows "Needs administrator" when any of `keys` was denied and "—" when there's no value. */
  const row = (label: string, keys: string | string[], value: ReactNode, extra?: Partial<KV>): KV => {
    const ks = Array.isArray(keys) ? keys : [keys];
    if (ks.some((k) => denied.has(k))) return { label, value: NEEDS_ADMIN, muted: true, copyText: null, title: "Shellmosaic couldn't read this without administrator rights" };
    if (value === null || value === undefined || value === "") return { label, value: "—", muted: true, copyText: null };
    return { label, value, ...extra };
  };

  const now = Date.now();
  const cpuTotal = ov.cpuKernelMs + ov.cpuUserMs;
  const protectedProc = !!ov.protection && ov.protection !== "None";

  const image: KV[] = [
    row(
      "Path",
      "path",
      ov.path && (
        <>
          {ov.path}
          <IconButton title="Open file location" onClick={() => reveal(ov.path)}>
            <FolderOpen size={13} />
          </IconButton>
        </>
      ),
      { copyText: ov.path },
    ),
    row("Command line", "commandLine", ov.commandLine, { mono: true }),
    row("Current directory", "currentDirectory", ov.currentDirectory),
    row("Architecture", "architecture", ov.architecture),
    ...(ov.packageName ? [row("Package", "packageName", ov.packageName, { mono: true })] : []),
    row(
      "Signature",
      [],
      ov.path ? (
        <span className="pi-kv-inline">
          <SigChip entry={sig} />
          {sig?.state === "done" && sig.sig.catalog && <span className="sm-dim">catalog</span>}
        </span>
      ) : null,
      { copyText: sig?.state === "done" ? [sig.sig.detail, sig.sig.signer].filter(Boolean).join(" · ") : null },
    ),
  ];

  const security: KV[] = [
    row("User", "user", ov.user),
    row("User SID", ["user", "userSid"], ov.userSid, { mono: true }),
    row("Integrity", "integrity", ov.integrity && <Chip tone={integrityTone(ov.integrity)}>{ov.integrity}</Chip>, { copyText: ov.integrity }),
    row("Elevation", ["elevation", "elevated"], ov.elevated === null ? null : `${ov.elevated ? "Elevated" : "Not elevated"}${ov.elevationType ? ` (${ov.elevationType} token)` : ""}`),
    row(
      "Protection",
      "protection",
      ov.protection && (protectedProc ? <Chip tone="accent">{ov.protection}</Chip> : ov.protection),
      { copyText: ov.protection },
    ),
    row("Session", "session", ov.sessionId),
    row("Virtualization", "virtualization", ov.virtualization && VIRTUALIZATION[ov.virtualization]),
    row(
      "Being debugged",
      "debugged",
      ov.debugged === null ? null : ov.debugged ? <span className="sm-danger-text">Yes, a debugger is attached</span> : "No",
      { copyText: ov.debugged === null ? null : ov.debugged ? "Yes" : "No" },
    ),
  ];

  const perf: KV[] = [
    row("Started", "startTime", ov.startTime && formatDateTime(ov.startTime)),
    row("Running for", "startTime", ov.startTime && formatDuration(now - ov.startTime)),
    row("CPU time", "cpu", cpuTotal ? `${formatDuration(cpuTotal)}  ·  kernel ${formatDuration(ov.cpuKernelMs)}, user ${formatDuration(ov.cpuUserMs)}` : "0 ms"),
    row("Priority class", "priority", priorityLabel(ov.priorityClass)),
    row("Base priority", "priority", String(ov.basePriority)),
    row("Affinity", "affinity", affinityText(ov.affinity, ov.systemAffinity), { title: ov.affinity ? `Mask ${ov.affinity}` : undefined }),
    row("Handles", "handles", formatNumber(ov.handleCount)),
    row("Threads", "threads", formatNumber(ov.threadCount)),
  ];

  const mem: KV[] = [
    row("Working set", "memory", formatBytes(ov.workingSet), { title: `${formatNumber(ov.workingSet)} bytes` }),
    row("Peak working set", "memory", formatBytes(ov.peakWorkingSet), { title: `${formatNumber(ov.peakWorkingSet)} bytes` }),
    row("Private bytes", "memory", formatBytes(ov.privateBytes), { title: `${formatNumber(ov.privateBytes)} bytes` }),
    row("Virtual size", "memory", formatBytes(ov.virtualSize), { title: `${formatNumber(ov.virtualSize)} bytes` }),
    row("I/O read", "io", formatBytes(ov.ioReadBytes)),
    row("I/O write", "io", formatBytes(ov.ioWriteBytes)),
    row("I/O other", "io", formatBytes(ov.ioOtherBytes)),
  ];

  const mitigations: KV[] = denied.has("mitigations")
    ? [row("Policies", "mitigations", null)]
    : ov.mitigations.length
      ? ov.mitigations.map((m) => ({
          label: m.name,
          value: (
            <span className="pi-kv-inline">
              <Chip tone={m.enabled ? "success" : "dim"}>{m.enabled ? "On" : "Off"}</Chip>
              {m.details.length > 0 && <span className="sm-dim">{m.details.join(", ")}</span>}
            </span>
          ),
          copyText: `${m.name}: ${m.enabled ? "on" : "off"}${m.details.length ? ` (${m.details.join(", ")})` : ""}`,
        }))
      : [{ label: "Policies", value: "None reported", muted: true, copyText: null }];

  const enabledCount = ov.mitigations.filter((m) => m.enabled).length;

  return (
    <div className="pi-overview">
      <Section title="Image">
        <KeyValues rows={image} labelWidth={128} />
      </Section>
      <Section title="Security">
        <KeyValues rows={security} labelWidth={128} />
      </Section>
      <Section title="Performance">
        <KeyValues rows={perf} labelWidth={128} />
      </Section>
      <Section title="Memory and I/O">
        <KeyValues rows={mem} labelWidth={128} />
      </Section>
      <Section title="Mitigations" actions={!denied.has("mitigations") && ov.mitigations.length > 0 && <span className="pi-section-note">{enabledCount} of {ov.mitigations.length} on</span>}>
        <KeyValues rows={mitigations} labelWidth={158} />
      </Section>
    </div>
  );
}
