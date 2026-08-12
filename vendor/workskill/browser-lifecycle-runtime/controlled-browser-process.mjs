import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const activeHandles = new Set();
const signalHandlers = new Map();
let signalShutdownStarted = false;

export async function launchOwnedProcess(options) {
  assertDeterministicProcessTreeSupport();
  const profileRoot = options.profileRoot;
  await mkdir(profileRoot, { recursive: true });
  const profilePath = await mkdtemp(join(profileRoot, "playwright-controlled-"));
  let prepared;
  let args;
  try {
    prepared = await prepareOwnership(options, profilePath);
    args = typeof options.args === "function" ? options.args(profilePath) : options.args;
  } catch (error) {
    await rm(profilePath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let child;
  try {
    child = spawn(options.executablePath, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: process.platform !== "win32",
      stdio: options.stdio ?? "ignore",
      windowsHide: true,
    });
    await waitForSpawn(child);
  } catch (error) {
    await rm(profilePath, { recursive: true, force: true });
    throw error;
  }
  return finalizeOwnedProcess(options, child, prepared);
}

export async function adoptOwnedProcess(options) {
  try {
    assertDeterministicProcessTreeSupport();
    const prepared = await prepareOwnership(options, options.profilePath);
    await waitForSpawn(options.childProcess);
    return await finalizeOwnedProcess(options, options.childProcess, prepared);
  } catch (error) {
    await Promise.resolve().then(options.emergencyClose).catch(() => {});
    await terminateFreshProcess(options.childProcess?.pid).catch(() => {});
    await rm(options.profilePath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function assertDeterministicProcessTreeSupport() {
  if (process.platform === "win32") {
    throw new Error("Controlled browser launch on Windows requires a per-task Job Object adapter and is not enabled by this runtime");
  }
}

async function prepareOwnership(options, profilePath) {
  const ownershipToken = randomUUID();
  const taskId = options.taskId;
  const launchedAt = new Date().toISOString();
  const markerPath = join(profilePath, ".workskill-browser-owner.json");
  const parentIdentity = await inspectProcess(process.pid);
  await mkdir(profilePath, { recursive: true });
  await mkdir(dirname(options.registryPath), { recursive: true });
  await atomicWriteJson(markerPath, { taskId, ownershipToken, profilePath, launchedAt, parentPid: process.pid });
  return { ownershipToken, taskId, launchedAt, markerPath, parentIdentity, profilePath };
}

async function finalizeOwnedProcess(options, child, prepared) {
  const { ownershipToken, taskId, launchedAt, markerPath, parentIdentity, profilePath } = prepared;

  let rootIdentity;
  try {
    rootIdentity = await waitForProcessIdentity(child.pid);
  } catch (error) {
    await terminateFreshProcess(child.pid);
    await rm(profilePath, { recursive: true, force: true });
    throw error;
  }
  const processGroupId = process.platform === "win32" ? undefined : rootIdentity.processGroupId;
  if (process.platform !== "win32" && processGroupId !== child.pid) {
    await terminateFreshProcess(child.pid);
    await rm(profilePath, { recursive: true, force: true });
    throw new Error(`Launched browser PID ${child.pid} did not create its task-exclusive process group`);
  }
  const record = {
    schemaVersion: 1,
    taskId,
    ownershipToken,
    rootPid: child.pid,
    processGroupId,
    executablePath: options.executablePath ?? child.spawnfile,
    rootStartTime: rootIdentity.startTime,
    parentPid: process.pid,
    parentStartTime: parentIdentity?.startTime,
    profilePath,
    markerPath,
    registryPath: options.registryPath,
    launchedAt,
    state: "active",
    requiredCommandFragments: typeof options.requiredCommandFragments === "function"
      ? options.requiredCommandFragments(profilePath)
      : options.requiredCommandFragments ?? [],
  };
  try {
    await atomicWriteJson(options.registryPath, record);
  } catch (error) {
    await terminateFreshProcess(child.pid);
    await rm(profilePath, { recursive: true, force: true });
    throw new Error(`Unable to persist browser ownership for task ${taskId}`, { cause: error });
  }

  let closing;
  const close = (rootExit) => {
    if (closing) {
      if (!rootExit) return closing;
      return recordUnexpectedRootExit(record, rootExit).then(() => closing);
    }
    closing = (async () => {
      if (rootExit) await recordUnexpectedRootExit(record, rootExit);
      return closeOwnedProcess(record, {
        gracefulClose: options.gracefulClose,
        gracefulCloseTimeoutMs: options.gracefulCloseTimeoutMs ?? 2_000,
        terminationGraceMs: options.terminationGraceMs ?? 2_000,
        cleanupTimeoutMs: options.cleanupTimeoutMs ?? 2_000,
        finalState: "closed",
      });
    })().finally(() => {
      activeHandles.delete(handle);
      uninstallSignalHandlersWhenIdle();
    });
    return closing;
  };
  const handle = {
    pid: child.pid,
    processGroupId,
    profilePath,
    registryPath: options.registryPath,
    taskId,
    async close() {
      return close();
    },
  };

  activeHandles.add(handle);
  installSignalHandlers();
  if (options.watchdog !== false) {
    try {
      const watchdog = spawn(process.execPath, [
        fileURLToPath(new URL("./controlled-browser-watchdog.mjs", import.meta.url)),
        options.registryPath,
        String(options.terminationGraceMs ?? 2_000),
        String(options.cleanupTimeoutMs ?? 2_000),
      ], { detached: true, stdio: "ignore", windowsHide: true });
      watchdog.unref();
      await atomicWriteJson(options.registryPath, { ...record, watchdogPid: watchdog.pid });
    } catch (error) {
      await handle.close().catch(() => {});
      throw new Error(`Unable to start browser ownership watchdog: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  const closeAfterUnexpectedRootExit = (code, signal) => {
    void close({
      exitedAt: new Date().toISOString(),
      ...(typeof code === "number" ? { code } : {}),
      ...(signal ? { signal } : {}),
    }).catch(() => {});
  };
  child.once("exit", closeAfterUnexpectedRootExit);
  if (child.exitCode !== null || child.signalCode !== null) {
    closeAfterUnexpectedRootExit(child.exitCode, child.signalCode);
  }
  return handle;
}

export async function reclaimOwnedProcess(registryPath, options = {}) {
  const record = await readOwnershipRecord(registryPath);
  if (!isReclaimableState(record.state)) return record;
  return closeOwnedProcess(record, {
    terminationGraceMs: options.terminationGraceMs ?? 2_000,
    cleanupTimeoutMs: options.cleanupTimeoutMs ?? 2_000,
    gracefulCloseTimeoutMs: 0,
    finalState: "reclaimed",
  });
}

export async function readOwnershipRecord(registryPath) {
  return JSON.parse(await readFile(registryPath, "utf8"));
}

export async function isRecordedParentAlive(record) {
  const identity = await inspectProcess(record.parentPid);
  return Boolean(identity && identity.startTime === record.parentStartTime);
}

async function closeOwnedProcess(initialRecord, options) {
  const registryPath = initialRecord.registryPath;
  let record;
  try {
    record = await readOwnershipRecord(registryPath);
  } catch (error) {
    throw new Error(`Browser ownership record is unavailable: ${registryPath}`, { cause: error });
  }
  if (!sameOwnership(initialRecord, record)) {
    await markReclaimPending(record, "persisted ownership changed before cleanup");
    throw new Error(`Browser identity verification failed for task ${initialRecord.taskId}: persisted ownership changed`);
  }
  if (!isReclaimableState(record.state)) return record;
  await atomicWriteJson(registryPath, { ...record, state: "closing", closeStartedAt: new Date().toISOString() });

  let gracefulError;
  if (options.gracefulClose) {
    try {
      await withTimeout(Promise.resolve().then(options.gracefulClose), options.gracefulCloseTimeoutMs, "browser API close");
    } catch (error) {
      gracefulError = error;
    }
  }

  const target = record.processGroupId ?? record.rootPid;
  if (!(await waitForTargetExit(target, options.gracefulCloseTimeoutMs))) {
    const verification = await verifyOwnedTarget(record);
    if (!verification.ok) {
      const reason = `identity verification failed: ${verification.reason}`;
      await markReclaimPending(record, reason, gracefulError);
      throw new Error(`Browser ${reason} for task ${record.taskId}`);
    }
    await terminateTarget(record, "SIGTERM");
    if (!(await waitForTargetExit(target, options.terminationGraceMs))) {
      const forcedVerification = await verifyOwnedTarget(record);
      if (!forcedVerification.ok) {
        const reason = `identity verification failed before SIGKILL: ${forcedVerification.reason}`;
        await markReclaimPending(record, reason, gracefulError);
        throw new Error(`Browser ${reason} for task ${record.taskId}`);
      }
      await terminateTarget(record, "SIGKILL");
      if (!(await waitForTargetExit(target, options.cleanupTimeoutMs))) {
        const reason = `process target ${target} remained alive after forced cleanup`;
        await markReclaimPending(record, reason, gracefulError);
        throw new Error(reason);
      }
    }
  }

  try {
    await rm(record.profilePath, { recursive: true, force: true });
  } catch (error) {
    await markReclaimPending(record, `profile cleanup failed: ${error instanceof Error ? error.message : String(error)}`, gracefulError);
    throw error;
  }
  let recordedRootExit;
  try {
    const latest = await readOwnershipRecord(registryPath);
    if (sameOwnership(record, latest)) recordedRootExit = latest.rootExit;
  } catch {}
  const finalRecord = {
    ...record,
    state: options.finalState,
    closedAt: new Date().toISOString(),
    profileDisposition: "deleted",
    ...(recordedRootExit ? { rootExit: recordedRootExit } : {}),
    ...(gracefulError ? { gracefulCloseError: formatError(gracefulError) } : {}),
  };
  await atomicWriteJson(registryPath, finalRecord);
  return finalRecord;
}

async function verifyOwnedTarget(record) {
  let persisted;
  let marker;
  try {
    [persisted, marker] = await Promise.all([
      readOwnershipRecord(record.registryPath),
      readOwnershipRecord(record.markerPath),
    ]);
  } catch (error) {
    return { ok: false, reason: `ownership record or marker unavailable (${formatError(error)})` };
  }
  if (!sameOwnership(record, persisted)) return { ok: false, reason: "persisted ownership record mismatch" };
  if (marker.taskId !== record.taskId || marker.ownershipToken !== record.ownershipToken || marker.profilePath !== record.profilePath) {
    return { ok: false, reason: "profile marker mismatch" };
  }
  const identity = await inspectProcess(record.rootPid);
  if (!identity) return verifyRootExitedProcessGroup(record);
  if (identity.startTime !== record.rootStartTime) return { ok: false, reason: "root process start time mismatch" };
  if (record.processGroupId && identity.processGroupId !== record.processGroupId) return { ok: false, reason: "root process group mismatch" };
  const executableName = basename(record.executablePath);
  if (!identity.command.includes(record.executablePath) && !identity.command.includes(executableName)) {
    return { ok: false, reason: "root executable mismatch" };
  }
  for (const fragment of record.requiredCommandFragments ?? []) {
    if (!identity.command.includes(fragment)) return { ok: false, reason: `root command is missing ${fragment}` };
  }
  return { ok: true };
}

async function verifyRootExitedProcessGroup(record) {
  if (process.platform === "win32" || !record.processGroupId) {
    return { ok: false, reason: "registered root process is unavailable" };
  }
  const members = (await inspectProcessTable()).filter((row) => (
    row.processGroupId === record.processGroupId && !row.state.startsWith("Z")
  ));
  if (members.length === 0) return { ok: true };

  // The process group was created exclusively for this launch. Once its root has
  // exited, every surviving member must still prove ownership through the exact
  // profile path before the group can receive a signal.
  const profileArgument = `--user-data-dir=${record.profilePath}`;
  if (!members.every((member) => member.command.includes(profileArgument))) {
    return { ok: false, reason: "root exited and surviving process-group members do not all reference the owned profile" };
  }
  return { ok: true };
}

async function terminateTarget(record, signal) {
  if (process.platform === "win32") {
    await runTaskkill(record.rootPid, signal === "SIGKILL");
    return;
  }
  try {
    process.kill(-record.processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function runTaskkill(pid, force) {
  await new Promise((resolve, reject) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 || code === 128 ? resolve() : reject(new Error(`taskkill exited with ${code}`)));
  });
}

async function waitForTargetExit(target, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    if (!(await targetIsAlive(target))) return true;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  } while (true);
}

async function targetIsAlive(target) {
  if (process.platform === "win32") return Boolean(await inspectProcess(target));
  const rows = await inspectProcessTable();
  return rows.some((row) => row.processGroupId === target && !row.state.startsWith("Z"));
}

async function inspectProcess(pid) {
  if (process.platform === "win32") return inspectWindowsProcess(pid);
  const rows = await inspectProcessTable();
  return rows.find((row) => row.pid === pid);
}

async function inspectProcessTable() {
  const output = await runCapture("ps", ["-axo", "pid=,pgid=,stat=,lstart=,command="]);
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/);
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      processGroupId: Number(match[2]),
      state: match[3],
      startTime: match[4].replace(/\s+/g, " "),
      command: match[5],
    }];
  });
}

async function inspectWindowsProcess(pid) {
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${Number(pid)}\"`,
    "if ($null -eq $process) { exit 3 }",
    "$created = $process.CreationDate.ToUniversalTime().ToString('o')",
    "[Console]::Out.Write(($process | Select-Object ProcessId,ExecutablePath,CommandLine,@{Name='StartTime';Expression={$created}} | ConvertTo-Json -Compress))",
  ].join("; ");
  try {
    const output = await runCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    const value = JSON.parse(output);
    return {
      pid: Number(value.ProcessId),
      processGroupId: Number(value.ProcessId),
      state: "",
      startTime: String(value.StartTime),
      command: String(value.CommandLine ?? value.ExecutablePath ?? ""),
    };
  } catch (error) {
    if (String(error).includes("exited with 3")) return undefined;
    throw error;
  }
}

async function terminateFreshProcess(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    await runTaskkill(pid, true).catch(() => {});
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
}

async function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited with ${code}`)));
  });
}

async function waitForSpawn(child) {
  if (child.pid) return;
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function waitForProcessIdentity(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const identity = await inspectProcess(pid);
    if (identity) return identity;
    await delay(10);
  }
  throw new Error(`Unable to inspect launched browser root PID ${pid}`);
}

async function atomicWriteJson(path, value) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function markReclaimPending(record, reason, gracefulError) {
  await atomicWriteJson(record.registryPath, {
    ...record,
    state: "reclaim_pending",
    reclaimPendingAt: new Date().toISOString(),
    reclaimReason: reason,
    profileDisposition: "retained_for_verified_reclaim",
    ...(gracefulError ? { gracefulCloseError: formatError(gracefulError) } : {}),
  });
}

async function recordUnexpectedRootExit(record, rootExit) {
  let persisted;
  try {
    persisted = await readOwnershipRecord(record.registryPath);
  } catch {
    return;
  }
  if (!sameOwnership(record, persisted) || !isReclaimableState(persisted.state)) return;
  await atomicWriteJson(record.registryPath, {
    ...persisted,
    state: "root_exited",
    rootExit,
  });
}

function sameOwnership(expected, actual) {
  return expected.taskId === actual.taskId
    && expected.ownershipToken === actual.ownershipToken
    && expected.rootPid === actual.rootPid
    && expected.processGroupId === actual.processGroupId
    && expected.executablePath === actual.executablePath
    && expected.rootStartTime === actual.rootStartTime
    && expected.parentPid === actual.parentPid
    && expected.parentStartTime === actual.parentStartTime
    && expected.profilePath === actual.profilePath
    && expected.markerPath === actual.markerPath
    && expected.registryPath === actual.registryPath
    && JSON.stringify(expected.requiredCommandFragments ?? []) === JSON.stringify(actual.requiredCommandFragments ?? []);
}

function isReclaimableState(state) {
  return state === "active" || state === "closing" || state === "root_exited";
}

function installSignalHandlers() {
  if (signalHandlers.size > 0) return;
  const signals = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGHUP", "SIGINT", "SIGTERM"];
  for (const signal of signals) {
    const handler = () => handleShutdownSignal(signal);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
}

function uninstallSignalHandlersWhenIdle() {
  if (activeHandles.size > 0 || signalShutdownStarted) return;
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  signalHandlers.clear();
}

function handleShutdownSignal(signal) {
  if (signalShutdownStarted) return;
  signalShutdownStarted = true;
  for (const [registeredSignal, handler] of signalHandlers) process.removeListener(registeredSignal, handler);
  signalHandlers.clear();
  Promise.allSettled([...activeHandles].map((handle) => handle.close()))
    .finally(() => process.exit(signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : 143));
}

async function withTimeout(promise, timeoutMs, label) {
  if (timeoutMs <= 0) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
