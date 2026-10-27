// A list with the selected row's details beside it (wide panes) or under it.
import type { ReactNode } from "react";
import { Split, useStored } from "../../shared";
import { useWidth } from "./data";
import { DEFAULT_LAYOUT, type DetailsSide, type Layout } from "./prefs";

export function MasterDetails({ side, list, details, open }: { side: DetailsSide; list: ReactNode; details: ReactNode; open: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [layout, setLayout] = useStored<Layout>("layout", DEFAULT_LAYOUT);
  const right = side === "right" || (side === "auto" && width >= 820);
  const height = ref.current?.clientHeight ?? 600;
  return (
    <div className="orc-master" ref={ref}>
      <Split
        direction={right ? "horizontal" : "vertical"}
        sizeOf="second"
        size={right ? Math.min(layout.detailsW, Math.max(280, width - 360)) : Math.min(layout.detailsH, Math.max(140, height - 160))}
        onSize={(px) => setLayout((l) => (right ? { ...l, detailsW: px } : { ...l, detailsH: px }))}
        min={right ? 280 : 140}
        collapsed={!open}
        first={list}
        second={<div className="orc-details">{details}</div>}
      />
    </div>
  );
}
