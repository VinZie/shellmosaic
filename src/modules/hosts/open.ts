// Opening saved hosts: an SSH terminal is the terminal module with meta.ssh (the
// backend dials out instead of starting a local shell); SFTP is its own module.
import type { HostView } from "../../lib/ipc";
import { addModule } from "../../state/actions";
import type { Id } from "../../state/model";

interface Where {
  tabId?: Id;
  /** split next to this pane */
  near?: Id;
  newTab?: boolean;
}

/** "user@host" (just the host without a user), for copying and labels. */
export const userAtHost = (h: Pick<HostView, "user" | "host">) => (h.user ? `${h.user}@${h.host}` : h.host);

/** "user@host:port", the port only when it isn't 22. */
export const hostAddress = (h: Pick<HostView, "user" | "host" | "port">) => `${userAtHost(h)}${h.port && h.port !== 22 ? `:${h.port}` : ""}`;

export function connectHost(host: Pick<HostView, "id" | "name">, where: Where = {}) {
  return addModule("terminal", {
    tabId: where.tabId,
    target: where.near,
    side: "bottom",
    newTab: where.newTab,
    // no local folder: panes that follow the tab's terminal (files, git, tasks) must skip it
    meta: { ssh: host.id, sshName: host.name, cwd: null },
  });
}

export function openSftp(hostId: string, hostName: string, where: Where = {}) {
  return addModule("sftp", { tabId: where.tabId, target: where.near, side: "right", newTab: where.newTab, meta: { hostId, hostName } });
}

export function openHosts(where: Where = {}) {
  return addModule("hosts", { tabId: where.tabId, target: where.near, side: "right", newTab: where.newTab });
}
