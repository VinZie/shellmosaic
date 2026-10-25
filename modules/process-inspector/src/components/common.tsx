// Pieces every tab uses: states (loading, denied, failed), addresses, notices.
import type { ReactNode } from "react";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import { AdminBanner, Banner, Button, Loading, Message, Switch, type PaneContext } from "../../../shared";
import type { Resource } from "../lib/resource";
import { isExited } from "../lib/util";

/** A hex address with its leading zeros dimmed: 0x00007ff6a1b20000. */
export function Addr({ value }: { value: string | null | undefined }) {
  if (!value) return null;
  const m = /^(0x)(0*)([0-9a-f]*)$/i.exec(value);
  if (!m) return <span>{value}</span>;
  let zeros = m[2];
  let rest = m[3];
  if (!rest) {
    zeros = zeros.slice(0, -1);
    rest = "0";
  }
  return (
    <span className="pi-addr">
      <span className="pi-addr-zero">
        {m[1]}
        {zeros}
      </span>
      {rest}
    </span>
  );
}

/**
 * "Reading {what} needs administrator rights" with Restart as administrator; when
 * Shellmosaic already runs elevated, a plain notice instead (protected processes refuse even that).
 */
export function DeniedBanner({ ctx, what }: { ctx: PaneContext; what: ReactNode }) {
  if (!ctx.elevated) return <AdminBanner ctx={ctx}>Reading {what} needs administrator rights.</AdminBanner>;
  return (
    <Banner tone="warning" icon={<ShieldAlert size={15} />}>
      Windows denies access to {what} even to administrators, which usually means a protected process.
    </Banner>
  );
}

/**
 * The usual life of a tab's data: loading, then the content (with a notice when a
 * refresh failed), or a full-size message when there's nothing to show.
 */
export function ResourceView<T>({
  res,
  ctx,
  what,
  name,
  children,
}: {
  res: Resource<T>;
  ctx: PaneContext;
  /** "handles", "memory map", … */
  what: string;
  /** process name */
  name: string;
  children: (data: T) => ReactNode;
}) {
  if (res.data !== null) {
    let notice: ReactNode = null;
    if (res.error && res.denied) notice = <DeniedBanner ctx={ctx} what={`the ${what} of ${name}`} />;
    else if (res.error && !isExited(res.error))
      notice = (
        <Banner
          tone="danger"
          icon={<TriangleAlert size={15} />}
          actions={
            <Button small onClick={() => res.refresh()}>
              Retry
            </Button>
          }
        >
          Couldn't refresh the {what}: {res.error}
        </Banner>
      );
    return (
      <>
        {notice}
        {children(res.data)}
      </>
    );
  }
  if (res.error && res.denied)
    return (
      <>
        <DeniedBanner ctx={ctx} what={`the ${what} of ${name}`} />
        <Message
          icon={<ShieldAlert size={24} />}
          tone="warning"
          title={`Can't read the ${what}`}
          actions={
            <Button small onClick={() => res.refresh()}>
              Try again
            </Button>
          }
        >
          <p>{res.error}</p>
        </Message>
      </>
    );
  if (res.error)
    return (
      <Message
        icon={<TriangleAlert size={24} />}
        tone="danger"
        title={`Couldn't read the ${what}`}
        actions={
          <Button small onClick={() => res.refresh()}>
            Retry
          </Button>
        }
      >
        <p>{res.error}</p>
      </Message>
    );
  return <Loading label={`Reading the ${what}…`} />;
}

/** A labelled switch for tab toolbars. */
export function Toggle({ label, value, onChange, title }: { label: string; value: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="pi-toggle" title={title}>
      <Switch value={value} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}
