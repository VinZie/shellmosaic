// Built-in modules. Third-party modules are plugins (see ./plugin/loader.ts).
import { filesModule } from "./files/FilesPane";
import { gitModule } from "./git/GitPane";
import { hostsModule } from "./hosts/HostsPane";
import { logsModule } from "./logs/LogsPane";
import { notesModule } from "./notes/NotesPane";
import { portsModule } from "./ports/PortsPane";
import { processesModule } from "./processes/ProcessesPane";
import { registerModule } from "./registry";
import { sftpModule } from "./sftp/SftpPane";
import { sysinfoModule } from "./sysinfo/SysinfoPane";
import { tasksModule } from "./tasks/TasksPane";
import { terminalModule } from "./terminal/TerminalPane";
import { webModule } from "./web/WebPane";

export function registerBuiltinModules() {
  [
    terminalModule,
    hostsModule,
    sftpModule,
    filesModule,
    webModule,
    sysinfoModule,
    processesModule,
    notesModule,
    gitModule,
    portsModule,
    tasksModule,
    logsModule,
  ].forEach(registerModule);
}
