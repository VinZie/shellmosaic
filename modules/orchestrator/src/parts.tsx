// Small pieces the views share: state chips, difficulty, the usage meter.
import { Bot, Crown } from "lucide-react";
import { Chip, cx, formatAgo, type Agent, type AgentState, type Routing, type TaskStatus } from "../../shared";
import { DIFFICULTY_LABEL, SLOW_START_HINT, STATE_HINT, STATE_LABEL, STATE_TONE, TASK_LABEL, TASK_TONE, untilText, usageLevel, type Usage, type UsageWindow } from "./lib";

/** `slow`: it has been starting for a while (see `slowStart`). */
export function StateChip({ state, slow }: { state: AgentState; slow?: boolean }) {
  return (
    <Chip tone={slow ? "warning" : STATE_TONE[state]} title={slow ? SLOW_START_HINT : STATE_HINT[state]}>
      <span className={cx("orc-dot", `orc-dot-${state}`)} />
      {STATE_LABEL[state]}
    </Chip>
  );
}

export function TaskChip({ status }: { status: TaskStatus }) {
  return <Chip tone={TASK_TONE[status]}>{TASK_LABEL[status]}</Chip>;
}

export function AgentName({ agent }: { agent: Agent }) {
  return (
    <span className="orc-agent-name">
      {agent.role === "lead" ? <Crown size={13} className="orc-lead-icon" /> : <Bot size={13} className="orc-worker-icon" />}
      <span className="sm-ellipsis">{agent.name}</span>
    </span>
  );
}

export function Difficulty({ value }: { value: number }) {
  return (
    <span className="orc-difficulty" title={`Difficulty ${value} of 5: ${DIFFICULTY_LABEL[value] ?? ""}`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={cx("orc-pip", i <= value && "on", value >= 4 && i <= value && "hard")} />
      ))}
    </span>
  );
}

function Bar({ label, w, routing, now }: { label: string; w: UsageWindow; routing: Routing; now: number }) {
  const level = usageLevel(w.pct, routing.sonnetAbove, routing.noHireAbove);
  const pct = Math.min(100, Math.max(0, w.pct));
  const resets = w.resetsAt ? `Resets ${untilText(w.resetsAt, now)}` : "";
  const effect =
    level === "critical"
      ? `At ${routing.noHireAbove}% or more no new workers start.`
      : level === "warning"
        ? `At ${routing.sonnetAbove}% or more workers get at most Sonnet.`
        : `Workers are limited to Sonnet from ${routing.sonnetAbove}%, and none start from ${routing.noHireAbove}%.`;
  return (
    <div className={cx("orc-usage-row", level)} title={`${label}: ${Math.round(w.pct)}% used. ${resets}\n${effect}`}>
      <span className="orc-usage-label">{label}</span>
      <span className="orc-usage-track">
        <span className="orc-usage-fill" style={{ width: `${pct}%` }} />
        <span className="orc-usage-mark" style={{ left: `${routing.sonnetAbove}%` }} />
        <span className="orc-usage-mark hard" style={{ left: `${routing.noHireAbove}%` }} />
      </span>
      <span className="orc-usage-pct">{Math.round(w.pct)}%</span>
    </div>
  );
}

/** The plan's 5-hour and weekly use, with the routing thresholds marked. */
export function UsageMeter({ usage, routing, now }: { usage: Usage | null; routing: Routing; now: number }) {
  if (!usage) {
    return (
      <div className="orc-usage empty" title="No agent has reported the plan usage yet">
        <span className="orc-usage-label">Plan usage</span>
        <span className="sm-dim">—</span>
      </div>
    );
  }
  const src = usage.source === "agents" ? `as the agents reported it ${formatAgo(usage.at, now)}` : `from your Claude account, ${formatAgo(usage.at, now)}`;
  return (
    <div className="orc-usage" aria-label={`Plan usage ${src}`}>
      {usage.fiveHour && <Bar label="5 h" w={usage.fiveHour} routing={routing} now={now} />}
      {usage.sevenDay && <Bar label="Week" w={usage.sevenDay} routing={routing} now={now} />}
    </div>
  );
}
