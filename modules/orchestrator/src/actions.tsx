// What the user can do to a team, an agent or a task, with the confirmations and the
// notices on failure. Every call goes through the host's agents.* methods.
import { Ban, Check, CircleStop, Eye, ListPlus, MessageSquare, Pause, Play, RotateCw, Square, Undo2, UserMinus, Users } from "lucide-react";
import { errorText, sm, type Agent, type AgentRun, type AgentTask, type MenuItem, type Routing } from "../../shared";
import { askText } from "./dialogs";
import { DIFFICULTY_LABEL, isBusy, isLive, modelLabel } from "./lib";

/** Run an action; a failure is shown as a notice. Resolves to whether it worked. */
export async function act<T>(fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<boolean> {
  try {
    const r = await fn();
    const msg = typeof success === "function" ? success(r) : success;
    if (msg) sm.ui.notify(msg, "success");
    return true;
  } catch (e) {
    sm.ui.notify(errorText(e), "error");
    return false;
  }
}

export async function stopTeam(run: AgentRun): Promise<boolean> {
  const ok = await sm.ui.confirm(
    `Stop the ${run.name} team?`,
    "The lead and every worker end their Claude Code sessions and their panes close. Work that isn't merged stays on its branches, and the task list is kept here.",
    { okLabel: "Stop team", danger: true },
  );
  return ok && act(() => sm.agents.stopRun(run.id), `Stopped the ${run.name} team`);
}

export async function forgetTeam(run: AgentRun): Promise<boolean> {
  const ok = await sm.ui.confirm(
    `Forget the ${run.name} team?`,
    "Its tasks, requests and activity are removed from this list. Its branches (orch/…) and any worktree with unmerged work stay in the repository.",
    { okLabel: "Forget", danger: true },
  );
  return ok && act(() => sm.agents.forgetRun(run.id));
}

export async function removeWorker(a: Agent): Promise<boolean> {
  const ok = await sm.ui.confirm(
    `Remove ${a.name}?`,
    "Its Claude Code session ends and its pane closes. Its current task goes back to the queue; what it committed stays on its branch.",
    { okLabel: "Remove", danger: true },
  );
  return ok && act(() => sm.agents.remove(a.id), `Removed ${a.name}`);
}

export async function messageAgent(a: Agent): Promise<boolean> {
  const text = await askText({
    title: `Message to ${a.name}`,
    placeholder: a.role === "lead" ? "What the team should do, or a change of plan…" : "A note, an answer, a change of direction…",
    hint: isBusy(a) ? `${a.name} is busy: it reads this after its current step.` : "Typed into its session as if you wrote it in its pane.",
    okLabel: "Send",
  });
  return !!text?.trim() && act(() => sm.agents.send(a.id, text.trim()), `Sent to ${a.name}`);
}

export const resumeAgent = (a: Agent) => act(() => sm.agents.resume(a.id));
export const pauseAgent = (a: Agent) => act(() => sm.agents.interrupt(a.id, { pause: true }), `Paused ${a.name}`);
export const interruptAgent = (a: Agent) => act(() => sm.agents.interrupt(a.id));
export const revealAgent = (a: Agent) => act(() => sm.agents.reveal(a.id));

export function agentMenu(a: Agent, run: AgentRun, canManage: boolean, opts: { onShowTask?: (taskId: string) => void } = {}): MenuItem[] {
  const active = run.status === "active";
  const live = isLive(a);
  const items: MenuItem[] = [
    { header: `${a.name} · ${a.slot}` },
    { label: "Show its pane", icon: <Eye size={14} />, disabled: !live, onSelect: () => revealAgent(a) },
  ];
  if (a.taskId && opts.onShowTask) items.push({ label: `Open task ${a.taskId}`, icon: <ListPlus size={14} />, onSelect: () => opts.onShowTask!(a.taskId!) });
  if (canManage && active) {
    items.push({ separator: true });
    if (!live || a.state === "paused") items.push({ label: "Resume", icon: <Play size={14} />, onSelect: () => resumeAgent(a) });
    if (isBusy(a)) {
      items.push({ label: "Interrupt (Esc)", icon: <Square size={14} />, onSelect: () => interruptAgent(a) });
      items.push({ label: "Pause", icon: <Pause size={14} />, onSelect: () => pauseAgent(a) });
    }
    items.push({ label: "Send a message…", icon: <MessageSquare size={14} />, disabled: !live, onSelect: () => messageAgent(a) });
    items.push({ separator: true });
    items.push(
      a.role === "lead"
        ? { label: "Stop the team…", icon: <CircleStop size={14} />, danger: true, onSelect: () => stopTeam(run) }
        : { label: "Remove worker…", icon: <UserMinus size={14} />, danger: true, onSelect: () => removeWorker(a) },
    );
  }
  return items;
}

// ── tasks ───────────────────────────────────────────────────────────────

export const assignTask = (t: AgentTask, agentId?: string) => act(() => sm.agents.assign(t.id, agentId), `Started ${t.id}`);

/** From two failures on, a retry runs one difficulty level up: what that means for this task (null: it doesn't). */
export function retryLevel(t: AgentTask, routing: Routing): string | null {
  if (t.failures < 2) return null;
  const d = Math.min(5, t.difficulty + 1);
  const c = routing.levels[d - 1];
  if (d === t.difficulty) return `It failed ${t.failures} times; it's already at the top difficulty (${modelLabel(c?.model)}).`;
  return `It failed ${t.failures} times, so a retry runs one level up: difficulty ${d} (${DIFFICULTY_LABEL[d]}), ${modelLabel(c?.model)} with ${c?.effort} effort.`;
}
export const acceptTask = (t: AgentTask) => act(() => sm.agents.review(t.id, true), (msg) => msg);

export async function sendBack(t: AgentTask, worker: Agent | undefined): Promise<boolean> {
  const note = await askText({
    title: `Send ${t.id} back`,
    label: "What should change",
    placeholder: "Be specific: what's wrong or missing, and how to check it's fixed.",
    hint: worker ? `${worker.name} continues in the same conversation.` : undefined,
    okLabel: "Send back",
  });
  return !!note?.trim() && act(() => sm.agents.review(t.id, false, note.trim()), (msg) => msg);
}

export async function cancelTask(t: AgentTask): Promise<boolean> {
  const ok = await sm.ui.confirm(`Cancel ${t.id}?`, `"${t.title}" is cancelled; a worker on it is interrupted. What it committed stays on its branch.`, {
    okLabel: "Cancel task",
    danger: true,
  });
  return ok && act(() => sm.agents.cancelTask(t.id));
}

/** Who a queued task can go to: any worker without a task, or a new one while there's room. */
export function assignItems(t: AgentTask, workers: Agent[], maxWorkers: number): MenuItem[] {
  const free = workers.filter((w) => !w.taskId && w.state !== "paused");
  return [
    { label: "Let Shellmosaic pick", icon: <Users size={14} />, hint: "idle or new", onSelect: () => assignTask(t) },
    ...(workers.length ? [{ separator: true } as MenuItem] : []),
    ...workers.map(
      (w): MenuItem => ({
        label: w.name,
        hint: w.taskId ? `on ${w.taskId}` : w.state,
        disabled: !free.includes(w),
        onSelect: () => assignTask(t, w.id),
      }),
    ),
    ...(workers.length < maxWorkers
      ? [{ separator: true } as MenuItem, { label: "A new worker", icon: <ListPlus size={14} />, onSelect: () => assignTask(t, nextSlot(workers)) }]
      : []),
  ];
}

/** The first free worker slot ("w2"): assigning to it starts a new worker there. */
export function nextSlot(workers: Agent[]): string {
  for (let i = 1; i <= 3; i++) if (!workers.some((w) => w.slot === `w${i}`)) return `w${i}`;
  return "w1";
}

export function taskMenu(
  t: AgentTask,
  ctx: { run: AgentRun; workers: Agent[]; canManage: boolean; routing: Routing; worker?: Agent; onFollowUp: (t: AgentTask) => void; onShowWorker?: (a: Agent) => void },
): MenuItem[] {
  const { run, canManage, worker } = ctx;
  const active = run.status === "active";
  const items: MenuItem[] = [{ header: `${t.id} · ${t.title}` }];
  if (worker && ctx.onShowWorker) items.push({ label: `Show ${worker.name}`, icon: <Eye size={14} />, onSelect: () => ctx.onShowWorker!(worker) });
  if (canManage && active) {
    if (t.status === "queued") items.push({ label: "Assign", icon: <Play size={14} />, submenu: assignItems(t, ctx.workers, ctx.routing.maxWorkers) });
    if (t.status === "failed") {
      items.push({ label: t.failures >= 2 ? "Retry one level up" : "Retry", icon: <RotateCw size={14} />, submenu: assignItems(t, ctx.workers, ctx.routing.maxWorkers) });
    }
    if (t.status === "review" || t.status === "failed") {
      items.push({ label: "Accept and merge", icon: <Check size={14} />, onSelect: () => acceptTask(t) });
      items.push({ label: "Send back…", icon: <Undo2 size={14} />, disabled: !t.assignee, onSelect: () => sendBack(t, worker) });
    }
    if (t.status === "done" || t.status === "review" || t.status === "failed") {
      items.push({ label: "Follow-up task…", icon: <ListPlus size={14} />, onSelect: () => ctx.onFollowUp(t) });
    }
    if (["queued", "assigned", "working", "review"].includes(t.status)) {
      items.push({ separator: true }, { label: "Cancel task…", icon: <Ban size={14} />, danger: true, onSelect: () => cancelTask(t) });
    }
  }
  return items;
}
