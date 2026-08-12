export interface BrowserOwnershipRecord {
  schemaVersion: 1;
  taskId: string;
  ownershipToken: string;
  rootPid: number;
  processGroupId?: number;
  executablePath: string;
  rootStartTime: string;
  parentPid: number;
  parentStartTime?: string;
  profilePath: string;
  markerPath: string;
  registryPath: string;
  launchedAt: string;
  state: "active" | "root_exited" | "closing" | "closed" | "reclaimed" | "reclaim_pending";
  requiredCommandFragments: string[];
  watchdogPid?: number;
  profileDisposition?: "deleted" | "retained_for_verified_reclaim";
  rootExit?: {
    exitedAt: string;
    code?: number;
    signal?: string;
  };
}

export interface OwnedProcessHandle {
  pid: number;
  processGroupId?: number;
  profilePath: string;
  registryPath: string;
  taskId: string;
  close(): Promise<BrowserOwnershipRecord>;
}

export interface LaunchOwnedProcessOptions {
  taskId: string;
  executablePath: string;
  args: string[] | ((profilePath: string) => string[]);
  registryPath: string;
  profileRoot: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdio?: "ignore" | "inherit" | "pipe";
  watchdog?: boolean;
  gracefulClose?: () => void | Promise<void>;
  gracefulCloseTimeoutMs?: number;
  terminationGraceMs?: number;
  cleanupTimeoutMs?: number;
  requiredCommandFragments?: string[] | ((profilePath: string) => string[]);
}

export interface AdoptOwnedProcessOptions extends Omit<LaunchOwnedProcessOptions, "args" | "profileRoot" | "stdio"> {
  childProcess: {
    pid?: number;
    spawnfile?: string;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    once(event: "spawn", listener: () => void): unknown;
    once(event: "error", listener: (error: Error) => void): unknown;
    once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  };
  profilePath: string;
  emergencyClose?: () => void | Promise<void>;
}

export function launchOwnedProcess(options: LaunchOwnedProcessOptions): Promise<OwnedProcessHandle>;
export function adoptOwnedProcess(options: AdoptOwnedProcessOptions): Promise<OwnedProcessHandle>;
export function reclaimOwnedProcess(
  registryPath: string,
  options?: { terminationGraceMs?: number; cleanupTimeoutMs?: number },
): Promise<BrowserOwnershipRecord>;
export function readOwnershipRecord(registryPath: string): Promise<BrowserOwnershipRecord>;
export function isRecordedParentAlive(record: BrowserOwnershipRecord): Promise<boolean>;
