#!/usr/bin/env node

import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as adminLib from "./admin-lib.mjs";

const scriptsRoot = fileURLToPath(new URL(".", import.meta.url));
const launchScript = path.join(scriptsRoot, "launch-ui.sh");
const installScript = path.join(scriptsRoot, "install-for-current-provider.sh");
const startScript = path.join(scriptsRoot, "start-gateway.sh");
const stopScript = path.join(scriptsRoot, "stop-gateway.sh");
const restoreScript = path.join(scriptsRoot, "restore-codex-config.sh");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopChildProcess(child) {
  if (!child || !isProcessAlive(child.pid)) {
    return;
  }
  child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

async function stopProcessById(processId) {
  if (!isProcessAlive(processId)) {
    return;
  }
  process.kill(processId);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isProcessAlive(processId)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isProcessAlive(processId)) {
    process.kill(processId, "SIGKILL");
  }
}

async function mtimeNs(filePath) {
  return (await stat(filePath, { bigint: true })).mtimeNs;
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function toUnixPathForBash(inputPath) {
  if (process.platform !== "win32") {
    return inputPath;
  }
  // Git Bash 可以把 Windows 原生路径直接传给 node.exe；/mnt 形式只适用于 WSL。
  return inputPath;
}

async function getFreePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : null;
  server.close();
  await once(server, "close");
  if (!port) {
    throw new Error("Failed to allocate a free port");
  }
  return port;
}

function startFakeUpstream(port) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "x-upstream-test": "unix-launch-ok",
      });
      res.end(JSON.stringify({ object: "list", data: [{ id: "unix-launch-model" }] }));
      return;
    }

    if (req.method === "POST" && (req.url === "/responses" || req.url === "/v1/responses")) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const reasoning = parsed.test_reasoning_tokens ?? 128;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            id: "unix-launch-response",
            usage: {
              output_tokens_details: {
                reasoning_tokens: reasoning,
              },
            },
          }),
        );
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function runBashScript(scriptPath, args) {
  const bashScriptPath =
    process.platform === "win32"
      ? path.relative(process.cwd(), scriptPath).split(path.sep).join("/")
      : scriptPath;

  const bashArgs = [bashScriptPath, ...args];

  const child = spawn("bash", bashArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const [exitCode] = await once(child, "exit");
  if (exitCode !== 0) {
    throw new Error(`Bash script failed: ${scriptPath}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return { stdout, stderr };
}

async function run() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-retry-gateway-unix-"));
  const codexDir = path.join(tempRoot, ".codex");
  const stateRoot = path.join(tempRoot, ".codex-retry-gateway");
  const codexConfigPath = path.join(codexDir, "config.toml");
  const upstreamPort = await getFreePort();
  const gatewayPort = await getFreePort();
  const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
  let stalePidProcess = null;

  const wrongPidHealthPort = await getFreePort();
  const wrongPidHealthServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, process_id: process.pid + 1000 }));
  });
  wrongPidHealthServer.listen(wrongPidHealthPort, "127.0.0.1");
  await once(wrongPidHealthServer, "listening");
  let wrongPidHealthRejected = false;
  try {
    await adminLib.waitGatewayHealth({
      listenHost: "127.0.0.1",
      listenPort: wrongPidHealthPort,
      healthPath: "/health",
      timeoutSeconds: 0.5,
      expectedProcessId: process.pid,
    });
  } catch {
    wrongPidHealthRejected = true;
  } finally {
    wrongPidHealthServer.close();
    await once(wrongPidHealthServer, "close");
  }
  assert(wrongPidHealthRejected, "Node health wait accepted HTTP 200 from the wrong process_id");

  const failedStartProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const failedStartPidPath = path.join(tempRoot, "failed-start.pid");
  await writeFile(failedStartPidPath, `${failedStartProcess.pid}`, "utf8");
  const cleanupHelperAvailable = typeof adminLib.cleanupFailedGatewayStart === "function";
  if (cleanupHelperAvailable) {
    await adminLib.cleanupFailedGatewayStart({
      processId: failedStartProcess.pid,
      pidPath: failedStartPidPath,
    });
  }
  const failedStartProcessStopped = !isProcessAlive(failedStartProcess.pid);
  const failedStartPidRemoved = !(await pathExists(failedStartPidPath));
  if (!failedStartProcessStopped) {
    await stopProcessById(failedStartProcess.pid);
  }
  if (!failedStartPidRemoved) {
    await rm(failedStartPidPath, { force: true });
  }
  assert(cleanupHelperAvailable, "Node admin library does not expose failed-start child cleanup");
  assert(failedStartProcessStopped, "Node failed-start cleanup left its child process alive");
  assert(failedStartPidRemoved, "Node failed-start cleanup left its child PID file behind");

  const pidWriteFailureRoot = path.join(tempRoot, "pid-write-failure");
  const pidWriteFailureConfigDir = path.join(pidWriteFailureRoot, "config");
  const pidWriteFailureConfigPath = path.join(pidWriteFailureConfigDir, "config.json");
  const pidWriteFailureLogPath = path.join(pidWriteFailureRoot, "gateway.log");
  const pidWriteFailurePort = await getFreePort();
  await mkdir(pidWriteFailureConfigDir, { recursive: true });
  await writeFile(
    pidWriteFailureConfigPath,
    `${JSON.stringify(
      {
        listen_host: "127.0.0.1",
        listen_port: pidWriteFailurePort,
        upstream_base_url: upstreamBaseUrl,
        endpoints: ["/responses"],
        health_path: "/__codex_retry_gateway/health",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  let pidWriteFailureRejected = false;
  try {
    await adminLib.startGateway({
      stateRoot: pidWriteFailureRoot,
      configPath: pidWriteFailureConfigPath,
      logPath: pidWriteFailureLogPath,
      writePidFile: async () => {
        throw new Error("simulated PID write failure");
      },
    });
  } catch {
    pidWriteFailureRejected = true;
  }
  let pidWriteFailureOrphanPid = null;
  try {
    const healthPayload = await fetch(
      `http://127.0.0.1:${pidWriteFailurePort}/__codex_retry_gateway/health`,
      { signal: AbortSignal.timeout(1000) },
    ).then((response) => response.json());
    pidWriteFailureOrphanPid = Number(healthPayload?.process_id) || null;
  } catch {
    pidWriteFailureOrphanPid = null;
  }
  if (pidWriteFailureOrphanPid && isProcessAlive(pidWriteFailureOrphanPid)) {
    await stopProcessById(pidWriteFailureOrphanPid);
  }
  assert(pidWriteFailureRejected, "Node start ignored the injected PID write failure");
  assert(!pidWriteFailureOrphanPid, "Node PID write failure left the created gateway child running");
  assert(
    !(await pathExists(path.join(pidWriteFailureRoot, "gateway.pid"))),
    "Node PID write failure left a child PID file behind",
  );

  await mkdir(codexDir, { recursive: true });
  await writeFile(
    codexConfigPath,
    [
      'model_provider = "custom"',
      "",
      "[model_providers.custom]",
      'name = "Unix Launch Test"',
      `base_url = "${upstreamBaseUrl}"`,
      'wire_api = "responses"',
      "",
    ].join("\n"),
    "utf8",
  );

  const upstream = await startFakeUpstream(upstreamPort);

  try {
    await runBashScript(launchScript, [
      "--codex-config-path",
      toUnixPathForBash(codexConfigPath),
      "--state-root",
      toUnixPathForBash(stateRoot),
      "--listen-port",
      String(gatewayPort),
      "--no-open",
    ]);

    const installedConfig = await readFile(codexConfigPath, "utf8");
    assert(
      installedConfig.includes(`base_url = "${gatewayBaseUrl}"`),
      "Unix launch did not redirect the current provider to the local gateway",
    );
    const gatewayConfig = JSON.parse(
      await readFile(path.join(stateRoot, "config", "config.json"), "utf8"),
    );
    assert(
      gatewayConfig.continuation_marker_text === "Continue thinking...",
      "Unix launch did not write default continuation_marker_text",
    );
    assert(
      gatewayConfig.reasoning_match_mode === "formula_518n_minus_2",
      "Unix launch did not write default reasoning_match_mode=formula_518n_minus_2",
    );
    assert(
      gatewayConfig.guard_retry_attempts === 5,
      "Unix launch did not write default guard_retry_attempts=5",
    );
    assert(
      gatewayConfig.stream_action === "continuation_recovery",
      "Unix launch did not write default stream_action=continuation_recovery",
    );
    assert(
      gatewayConfig.capacity_error_action === "retry_then_pass_through" &&
        gatewayConfig.http_429_action === "pass_through",
      "Unix launch did not write upstream error policy defaults",
    );
    assert(
      JSON.stringify(gatewayConfig.latency_guard) ===
        JSON.stringify({
          enabled: false,
          first_progress_timeout_ms: 0,
          first_progress_action: "return_502",
          total_timeout_ms: 0,
        }),
      "Unix launch did not write disabled latency_guard defaults",
    );
    const saveLayeredPolicyResponse = await fetch(
      `${gatewayBaseUrl}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "none",
          intercept_streaming: false,
          intercept_non_streaming: false,
          capacity_error_action: "retry_then_502",
          http_429_action: "retry_then_pass_through",
          latency_guard: {
            enabled: true,
            first_progress_timeout_ms: 1234,
            first_progress_action: "retry_then_502",
            total_timeout_ms: 9876,
          },
          retry_upstream_capacity_errors: false,
        }),
      },
    );
    assert(
      saveLayeredPolicyResponse.status === 200,
      `Unix layered policy setup failed: ${saveLayeredPolicyResponse.status}`,
    );
    const statePath = path.join(stateRoot, "state.json");
    const gatewayConfigPath = path.join(stateRoot, "config", "config.json");
    const gatewayPidPath = path.join(stateRoot, "gateway.pid");
    const backupDir = path.join(stateRoot, "backups");
    const firstStateRaw = await readFile(statePath, "utf8");
    const firstCodexConfigRaw = await readFile(codexConfigPath, "utf8");
    const firstGatewayConfig = JSON.parse(await readFile(gatewayConfigPath, "utf8"));
    assert(firstGatewayConfig.intercept_rule_mode === "none", "Unix policy setup did not persist none mode");
    assert(
      firstGatewayConfig.intercept_streaming === false &&
        firstGatewayConfig.intercept_non_streaming === false,
      "Unix policy setup did not persist none mode disabled intercept targets",
    );
    assert(
      firstGatewayConfig.capacity_error_action === "retry_then_502" &&
        firstGatewayConfig.http_429_action === "retry_then_pass_through",
      "Unix policy setup did not persist upstream error actions",
    );
    assert(
      firstGatewayConfig.latency_guard?.enabled === true &&
        firstGatewayConfig.latency_guard?.first_progress_timeout_ms === 1234 &&
        firstGatewayConfig.latency_guard?.first_progress_action === "retry_then_502" &&
        firstGatewayConfig.latency_guard?.total_timeout_ms === 9876,
      "Unix policy setup did not persist latency_guard",
    );
    firstGatewayConfig.latency_guard = {
      total_timeout_ms: 9876,
      first_progress_action: "retry_then_502",
      first_progress_timeout_ms: 1234,
      enabled: true,
    };
    const firstGatewayConfigRaw = `${JSON.stringify(firstGatewayConfig, null, 2)}\n`;
    await writeFile(gatewayConfigPath, firstGatewayConfigRaw, "utf8");
    const firstGatewayPid = (await readFile(gatewayPidPath, "utf8")).trim();
    const firstBackups = (await readdir(backupDir)).sort();
    const firstMtimes = {
      codex: await mtimeNs(codexConfigPath),
      gatewayConfig: await mtimeNs(gatewayConfigPath),
      state: await mtimeNs(statePath),
      pid: await mtimeNs(gatewayPidPath),
      backupDir: await mtimeNs(backupDir),
    };

    const idempotentLaunch = await runBashScript(launchScript, [
      "--codex-config-path",
      toUnixPathForBash(codexConfigPath),
      "--state-root",
      toUnixPathForBash(stateRoot),
      "--listen-port",
      String(gatewayPort),
      "--no-open",
    ]);
    const secondStateRaw = await readFile(statePath, "utf8");
    const secondCodexConfigRaw = await readFile(codexConfigPath, "utf8");
    const secondGatewayConfigRaw = await readFile(gatewayConfigPath, "utf8");
    const secondGatewayPid = (await readFile(gatewayPidPath, "utf8")).trim();
    const secondBackups = (await readdir(backupDir)).sort();
    assert(idempotentLaunch.stdout.includes("mode=reuse"), "Unix second launch did not report reuse mode");
    assert(
      secondGatewayPid === firstGatewayPid,
      `Unix second launch restarted an already healthy gateway: ${firstGatewayPid} -> ${secondGatewayPid}`,
    );
    assert(secondCodexConfigRaw === firstCodexConfigRaw, "Unix second launch rewrote Codex config");
    assert(secondGatewayConfigRaw === firstGatewayConfigRaw, "Unix second launch rewrote gateway config");
    assert(secondStateRaw === firstStateRaw, "Unix second launch rewrote gateway state");
    assert(
      JSON.stringify(secondBackups) === JSON.stringify(firstBackups),
      "Unix second launch created an unnecessary backup",
    );
    assert((await mtimeNs(codexConfigPath)) === firstMtimes.codex, "Unix second launch touched Codex config mtime");
    assert((await mtimeNs(gatewayConfigPath)) === firstMtimes.gatewayConfig, "Unix second launch touched gateway config mtime");
    assert((await mtimeNs(statePath)) === firstMtimes.state, "Unix second launch touched state mtime");
    assert((await mtimeNs(gatewayPidPath)) === firstMtimes.pid, "Unix second launch touched PID mtime");
    assert((await mtimeNs(backupDir)) === firstMtimes.backupDir, "Unix second launch touched backup directory mtime");

    await runBashScript(installScript, [
      "--codex-config-path",
      toUnixPathForBash(codexConfigPath),
      "--state-root",
      toUnixPathForBash(stateRoot),
      "--listen-port",
      String(gatewayPort),
    ]);
    assert(
      (await readFile(gatewayPidPath, "utf8")).trim() === firstGatewayPid,
      "Unix repeated manual install restarted an already healthy gateway",
    );
    assert((await readFile(codexConfigPath, "utf8")) === firstCodexConfigRaw, "Unix manual install rewrote Codex config");
    assert(
      (await readFile(gatewayConfigPath, "utf8")) === firstGatewayConfigRaw,
      "Unix manual install rewrote gateway config",
    );
    assert((await readFile(statePath, "utf8")) === firstStateRaw, "Unix manual install rewrote gateway state");
    assert(
      JSON.stringify((await readdir(backupDir)).sort()) === JSON.stringify(firstBackups),
      "Unix manual install created or replaced an unnecessary backup",
    );

    const runtimeConfigBeforeDirectRecovery = await fetch(
      `${gatewayBaseUrl}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json()).then((payload) => payload.config);
    await rm(gatewayConfigPath, { force: true });
    await runBashScript(installScript, [
      "--codex-config-path",
      toUnixPathForBash(codexConfigPath),
      "--state-root",
      toUnixPathForBash(stateRoot),
      "--listen-port",
      String(gatewayPort),
    ]);
    assert(
      (await readFile(gatewayPidPath, "utf8")).trim() === firstGatewayPid,
      "Unix direct install restarted a healthy gateway while recovering missing config.json",
    );
    assert(
      JSON.stringify(JSON.parse(await readFile(gatewayConfigPath, "utf8"))) ===
        JSON.stringify(runtimeConfigBeforeDirectRecovery),
      "Unix direct install did not recover the running gateway's complete runtime config",
    );
    assert(
      (await readFile(codexConfigPath, "utf8")) === firstCodexConfigRaw,
      "Unix direct install rewrote Codex config while recovering missing config.json",
    );
    assert(
      (await readFile(statePath, "utf8")) === firstStateRaw,
      "Unix direct install rewrote state while recovering missing config.json",
    );
    await writeFile(gatewayConfigPath, firstGatewayConfigRaw, "utf8");

    const conflictPort = await getFreePort();
    const conflictServer = http.createServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("occupied");
    });
    conflictServer.listen(conflictPort, "127.0.0.1");
    await once(conflictServer, "listening");
    let conflictLaunchFailed = false;
    try {
      await runBashScript(launchScript, [
        "--codex-config-path",
        toUnixPathForBash(codexConfigPath),
        "--state-root",
        toUnixPathForBash(stateRoot),
        "--listen-port",
        String(conflictPort),
        "--no-open",
      ]);
    } catch {
      conflictLaunchFailed = true;
    } finally {
      conflictServer.close();
      await once(conflictServer, "close");
    }
    assert(conflictLaunchFailed, "Unix occupied target port did not fail the migration restart");
    assert((await readFile(codexConfigPath, "utf8")) === firstCodexConfigRaw, "Unix failed migration did not restore Codex config bytes");
    assert((await readFile(gatewayConfigPath, "utf8")) === firstGatewayConfigRaw, "Unix failed migration did not restore gateway config bytes");
    assert((await readFile(statePath, "utf8")) === firstStateRaw, "Unix failed migration rewrote unchanged state");
    assert((await mtimeNs(statePath)) === firstMtimes.state, "Unix failed migration touched state that was never updated");
    assert(
      JSON.stringify((await readdir(backupDir)).sort()) === JSON.stringify(firstBackups),
      "Unix failed migration changed recovery backups",
    );
    let rollbackHealthStatus = null;
    try {
      const rollbackHealth = await fetch(`${gatewayBaseUrl}/__codex_retry_gateway/health`, {
        signal: AbortSignal.timeout(3000),
      });
      rollbackHealthStatus = rollbackHealth.status;
    } catch {
      rollbackHealthStatus = null;
    }
    assert(rollbackHealthStatus === 200, "Unix failed migration did not restore the previous healthy gateway");

    const stateBeforeMissingConfigMigration = await readFile(statePath, "utf8");
    const codexBeforeMissingConfigMigration = await readFile(codexConfigPath, "utf8");
    await rm(gatewayConfigPath, { force: true });
    const missingConfigConflictPort = await getFreePort();
    const missingConfigConflictServer = http.createServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("occupied");
    });
    missingConfigConflictServer.listen(missingConfigConflictPort, "127.0.0.1");
    await once(missingConfigConflictServer, "listening");
    let missingConfigMigrationFailed = false;
    try {
      await runBashScript(launchScript, [
        "--codex-config-path",
        toUnixPathForBash(codexConfigPath),
        "--state-root",
        toUnixPathForBash(stateRoot),
        "--listen-port",
        String(missingConfigConflictPort),
        "--no-open",
      ]);
    } catch {
      missingConfigMigrationFailed = true;
    } finally {
      missingConfigConflictServer.close();
      await once(missingConfigConflictServer, "close");
    }
    assert(missingConfigMigrationFailed, "Unix missing-config migration to an occupied port did not fail");
    assert(
      (await fetch(`${gatewayBaseUrl}/__codex_retry_gateway/health`)).status === 200,
      "Unix failed missing-config migration did not preserve the previous healthy gateway",
    );
    assert(
      !(await pathExists(gatewayConfigPath)),
      "Unix failed missing-config migration did not restore config.json to its original missing state",
    );
    assert(
      (await readFile(codexConfigPath, "utf8")) === codexBeforeMissingConfigMigration,
      "Unix failed missing-config migration changed Codex config bytes",
    );
    assert(
      (await readFile(statePath, "utf8")) === stateBeforeMissingConfigMigration,
      "Unix failed missing-config migration changed install state",
    );
    assert(await pathExists(gatewayPidPath), "Unix failed missing-config migration lost the healthy gateway PID");
    assert(
      isProcessAlive(Number.parseInt((await readFile(gatewayPidPath, "utf8")).trim(), 10)),
      "Unix failed missing-config migration left a dead gateway PID",
    );
    await writeFile(gatewayConfigPath, firstGatewayConfigRaw, "utf8");

    await runBashScript(stopScript, ["--state-root", toUnixPathForBash(stateRoot), "--quiet"]);
    stalePidProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(gatewayPidPath, `${stalePidProcess.pid}`, "utf8");
    await runBashScript(startScript, ["--state-root", toUnixPathForBash(stateRoot)]);
    const directStartedGatewayPid = (await readFile(gatewayPidPath, "utf8")).trim();
    assert(
      directStartedGatewayPid !== `${stalePidProcess.pid}`,
      "Unix direct start trusted an unrelated live process from a stale PID file",
    );
    assert(isProcessAlive(stalePidProcess.pid), "Unix direct start terminated the unrelated stale-PID process");
    assert(
      (await fetch(`${gatewayBaseUrl}/__codex_retry_gateway/health`)).status === 200,
      "Unix direct start did not launch a healthy gateway after discarding stale PID identity",
    );
    await runBashScript(stopScript, ["--state-root", toUnixPathForBash(stateRoot), "--quiet"]);
    await writeFile(gatewayPidPath, `${stalePidProcess.pid}`, "utf8");
    const recoveredLaunch = await runBashScript(launchScript, [
      "--codex-config-path",
      toUnixPathForBash(codexConfigPath),
      "--state-root",
      toUnixPathForBash(stateRoot),
      "--listen-port",
      String(gatewayPort),
      "--no-open",
    ]);
    const recoveredGatewayPid = (await readFile(gatewayPidPath, "utf8")).trim();
    assert(recoveredLaunch.stdout.includes("mode=reuse"), "Unix stopped gateway recovery did not reuse state");
    assert(recoveredGatewayPid !== firstGatewayPid, "Unix stopped gateway recovery did not start a new process");
    assert(
      recoveredGatewayPid !== `${stalePidProcess.pid}`,
      "Unix gateway trusted a live stale PID without checking the health endpoint",
    );
    assert(
      isProcessAlive(stalePidProcess.pid),
      "Unix gateway recovery terminated an unrelated process referenced by a stale PID file",
    );
    assert((await readFile(codexConfigPath, "utf8")) === firstCodexConfigRaw, "Unix recovery rewrote Codex config");
    assert(
      (await readFile(gatewayConfigPath, "utf8")) === firstGatewayConfigRaw,
      "Unix recovery rewrote unchanged gateway config",
    );
    assert(
      JSON.stringify((await readdir(backupDir)).sort()) === JSON.stringify(firstBackups),
      "Unix recovery created an unnecessary backup",
    );
    const recoveredStateRaw = await readFile(statePath, "utf8");

    const driftedUpstreamBaseUrl = `${upstreamBaseUrl}/v1`;
    await writeFile(
      codexConfigPath,
      firstCodexConfigRaw.replace(
        `base_url = "${gatewayBaseUrl}"`,
        `base_url = "${driftedUpstreamBaseUrl}"`,
      ),
      "utf8",
    );
    const driftRepair = await runBashScript(launchScript, [
      "--codex-config-path",
      toUnixPathForBash(codexConfigPath),
      "--state-root",
      toUnixPathForBash(stateRoot),
      "--listen-port",
      String(gatewayPort),
      "--no-open",
    ]);
    assert(driftRepair.stdout.includes("mode=reuse"), "Unix provider drift did not reuse install identity");
    assert(
      (await readFile(codexConfigPath, "utf8")).includes(`base_url = "${gatewayBaseUrl}"`),
      "Unix provider drift repair did not restore gateway takeover",
    );
    assert(
      (await readFile(gatewayConfigPath, "utf8")) === firstGatewayConfigRaw,
      "Unix provider drift repair changed gateway upstream or settings",
    );
    assert((await readFile(statePath, "utf8")) === recoveredStateRaw, "Unix drift repair rewrote install state");
    assert(
      (await readFile(gatewayPidPath, "utf8")).trim() === recoveredGatewayPid,
      "Unix provider-only drift repair restarted a healthy gateway",
    );
    assert(
      JSON.stringify((await readdir(backupDir)).sort()) === JSON.stringify(firstBackups),
      "Unix provider-only drift repair changed the immutable backup",
    );

    await runBashScript(launchScript, [
      "--codex-config-path",
      toUnixPathForBash(codexConfigPath),
      "--state-root",
      toUnixPathForBash(stateRoot),
      "--listen-port",
      String(gatewayPort),
      "--no-open",
    ]);
    assert(
      (await readFile(gatewayPidPath, "utf8")).trim() === recoveredGatewayPid,
      "Unix launch after drift repair restarted the gateway again",
    );
    assert((await readFile(gatewayConfigPath, "utf8")) === firstGatewayConfigRaw, "Unix post-repair launch rewrote config");
    assert((await readFile(statePath, "utf8")) === recoveredStateRaw, "Unix post-repair launch rewrote state");
    assert(
      JSON.stringify((await readdir(backupDir)).sort()) === JSON.stringify(firstBackups),
      "Unix post-repair launch created another backup",
    );

    const stateWithoutBackup = {
      ...JSON.parse(recoveredStateRaw),
      latest_backup_path: backupDir,
    };
    const stateWithoutBackupRaw = `${JSON.stringify(stateWithoutBackup, null, 2)}\n`;
    await writeFile(statePath, stateWithoutBackupRaw, "utf8");
    const stateWithoutBackupMtime = await mtimeNs(statePath);
    const backupsBeforeRecoveryPoint = (await readdir(backupDir)).sort();
    await runBashScript(launchScript, [
      "--codex-config-path",
      toUnixPathForBash(codexConfigPath),
      "--state-root",
      toUnixPathForBash(stateRoot),
      "--listen-port",
      String(gatewayPort),
      "--no-open",
    ]);
    assert((await readFile(statePath, "utf8")) === stateWithoutBackupRaw, "Unix gateway-routed provider created fake recovery state");
    assert((await mtimeNs(statePath)) === stateWithoutBackupMtime, "Unix gateway-routed provider touched missing-backup state");
    assert(
      JSON.stringify((await readdir(backupDir)).sort()) === JSON.stringify(backupsBeforeRecoveryPoint),
      "Unix gateway-routed provider created a fake recovery backup",
    );

    const realProviderConfigRaw = (await readFile(codexConfigPath, "utf8")).replace(
      `base_url = "${gatewayBaseUrl}"`,
      `base_url = "${upstreamBaseUrl}"`,
    );
    await writeFile(codexConfigPath, realProviderConfigRaw, "utf8");
    await runBashScript(launchScript, [
      "--codex-config-path",
      toUnixPathForBash(codexConfigPath),
      "--state-root",
      toUnixPathForBash(stateRoot),
      "--listen-port",
      String(gatewayPort),
      "--no-open",
    ]);
    const repairedBackupState = JSON.parse(await readFile(statePath, "utf8"));
    const backupsAfterRecoveryPoint = (await readdir(backupDir)).sort();
    assert(repairedBackupState.latest_backup_path, "Unix real provider drift did not repair the missing recovery backup");
    assert(
      backupsAfterRecoveryPoint.length === backupsBeforeRecoveryPoint.length + 1,
      "Unix real provider drift did not create exactly one recovery backup",
    );
    assert(
      backupsAfterRecoveryPoint.includes(path.basename(repairedBackupState.latest_backup_path)),
      "Unix repaired state does not reference the new recovery backup",
    );
    assert(
      (await readFile(repairedBackupState.latest_backup_path, "utf8")) === realProviderConfigRaw,
      "Unix recovery backup did not preserve the real provider config bytes",
    );
    assert((await readFile(gatewayConfigPath, "utf8")) === firstGatewayConfigRaw, "Unix backup repair changed gateway settings");
    assert(
      (await readFile(gatewayPidPath, "utf8")).trim() === recoveredGatewayPid,
      "Unix backup repair restarted the healthy gateway",
    );

    await writeFile(
      gatewayConfigPath,
      `${JSON.stringify(
        {
          ...gatewayConfig,
          intercept_rule_mode: "  Continuation_Recovery  ",
          reasoning_match_mode: "manual",
          continuation_marker_text: "  Unix custom marker  ",
          stream_action: undefined,
          retry_upstream_capacity_errors: false,
          capacity_error_action: undefined,
          http_429_action: undefined,
          latency_guard: undefined,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await runBashScript(launchScript, [
      "--codex-config-path",
      toUnixPathForBash(codexConfigPath),
      "--state-root",
      toUnixPathForBash(stateRoot),
      "--listen-port",
      String(gatewayPort),
      "--no-open",
    ]);
    const reusedGatewayConfig = JSON.parse(await readFile(gatewayConfigPath, "utf8"));
    assert(
      reusedGatewayConfig.intercept_rule_mode === "reasoning_tokens",
      "Unix launch reuse did not migrate legacy continuation_recovery intercept_rule_mode",
    );
    assert(
      reusedGatewayConfig.stream_action === "continuation_recovery",
      "Unix launch reuse did not migrate legacy continuation_recovery rule mode into stream_action",
    );
    assert(
      reusedGatewayConfig.reasoning_match_mode === "manual",
      "Unix launch reuse did not preserve manual reasoning_match_mode",
    );
    assert(
      reusedGatewayConfig.continuation_marker_text === "  Unix custom marker  ",
      "Unix launch reuse did not preserve custom continuation_marker_text",
    );
    assert(
      reusedGatewayConfig.capacity_error_action === "pass_through",
      "Unix launch reuse did not map legacy Capacity false to pass_through",
    );
    assert(
      reusedGatewayConfig.http_429_action === "pass_through",
      "Unix launch reuse did not default missing HTTP 429 action to pass through",
    );
    assert(
      JSON.stringify(reusedGatewayConfig.latency_guard) ===
        JSON.stringify({
          enabled: false,
          first_progress_timeout_ms: 0,
          first_progress_action: "return_502",
          total_timeout_ms: 0,
        }),
      "Unix launch reuse did not add disabled latency_guard defaults",
    );

    const uiResponse = await fetch(`${gatewayBaseUrl}/__codex_retry_gateway/ui`);
    assert(uiResponse.status === 200, `Unix UI page was not reachable: ${uiResponse.status}`);

    const proxiedModels = await fetch(`${gatewayBaseUrl}/v1/models`);
    assert(proxiedModels.status === 200, `/v1/models through unix launch flow failed: ${proxiedModels.status}`);
    assert(
      proxiedModels.headers.get("x-upstream-test") === "unix-launch-ok",
      "Unix launch gateway did not preserve upstream headers",
    );

    const stateBeforeDirectoryRestore = await readFile(statePath, "utf8");
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          ...JSON.parse(stateBeforeDirectoryRestore),
          latest_backup_path: backupDir,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    let directoryRestoreFailed = false;
    try {
      await runBashScript(restoreScript, [
        "--codex-config-path",
        toUnixPathForBash(codexConfigPath),
        "--state-root",
        toUnixPathForBash(stateRoot),
      ]);
    } catch {
      directoryRestoreFailed = true;
    }
    assert(directoryRestoreFailed, "Unix directory recovery point was accepted as a restorable file");
    const healthAfterDirectoryRestore = await fetch(
      `${gatewayBaseUrl}/__codex_retry_gateway/health`,
    );
    assert(
      healthAfterDirectoryRestore.status === 200,
      "Unix invalid directory recovery point stopped the running gateway before validation",
    );
    await writeFile(statePath, stateBeforeDirectoryRestore, "utf8");

    await runBashScript(restoreScript, [
      "--codex-config-path",
      toUnixPathForBash(codexConfigPath),
      "--state-root",
      toUnixPathForBash(stateRoot),
    ]);

    const restoredConfig = await readFile(codexConfigPath, "utf8");
    assert(
      restoredConfig.includes(`base_url = "${upstreamBaseUrl}"`),
      "Unix restore did not preserve the immutable first-install recovery point",
    );

    const backupsBeforeMissingConfigRecovery = (await readdir(backupDir)).sort();
    await writeFile(codexConfigPath, firstCodexConfigRaw, "utf8");
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          ...JSON.parse(firstStateRaw),
          latest_backup_path: "",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await rm(gatewayConfigPath, { force: true });
    await runBashScript(launchScript, [
      "--codex-config-path",
      toUnixPathForBash(codexConfigPath),
      "--state-root",
      toUnixPathForBash(stateRoot),
      "--listen-port",
      String(gatewayPort),
      "--no-open",
    ]);
    const rebuiltState = JSON.parse(await readFile(statePath, "utf8"));
    const rebuiltGatewayConfig = JSON.parse(await readFile(gatewayConfigPath, "utf8"));
    assert(rebuiltState.latest_backup_path === "", "Unix missing config recovery created a fake gateway-routed backup");
    assert(
      JSON.stringify((await readdir(backupDir)).sort()) === JSON.stringify(backupsBeforeMissingConfigRecovery),
      "Unix missing config recovery changed the backup directory",
    );
    assert(
      rebuiltGatewayConfig.upstream_base_url === upstreamBaseUrl,
      "Unix missing config recovery did not rebuild the original upstream",
    );

    const providerABackupPath = JSON.parse(firstStateRaw).latest_backup_path;
    await writeFile(
      statePath,
      `${JSON.stringify({ ...rebuiltState, latest_backup_path: providerABackupPath }, null, 2)}\n`,
      "utf8",
    );
    const providerBUpstreamBaseUrl = `${upstreamBaseUrl}/provider-b`;
    const providerBConfigRaw = [
      'model_provider = "provider-b"',
      "",
      "[model_providers.provider-b]",
      'name = "Unix Provider B"',
      `base_url = "${providerBUpstreamBaseUrl}"`,
      'wire_api = "responses"',
      "",
    ].join("\n");
    const backupsBeforeProviderSwitch = (await readdir(backupDir)).sort();
    await writeFile(codexConfigPath, providerBConfigRaw, "utf8");
    await runBashScript(launchScript, [
      "--codex-config-path",
      toUnixPathForBash(codexConfigPath),
      "--state-root",
      toUnixPathForBash(stateRoot),
      "--listen-port",
      String(gatewayPort),
      "--no-open",
    ]);
    const providerBState = JSON.parse(await readFile(statePath, "utf8"));
    const backupsAfterProviderSwitch = (await readdir(backupDir)).sort();
    assert(providerBState.provider_name === "provider-b", "Unix Provider B launch did not replace provider identity");
    assert(
      providerBState.latest_backup_path !== providerABackupPath,
      "Unix Provider B reused Provider A's recovery backup",
    );
    assert(
      backupsAfterProviderSwitch.length === backupsBeforeProviderSwitch.length + 1,
      "Unix Provider B launch did not create exactly one provider-specific backup",
    );
    assert(
      (await readFile(providerBState.latest_backup_path, "utf8")) === providerBConfigRaw,
      "Unix Provider B recovery backup did not preserve Provider B config bytes",
    );

    const mismatchedProviderConfigRaw = [
      'model_provider = "provider-c"',
      "",
      "[model_providers.provider-c]",
      'name = "Unix Mismatched Provider"',
      `base_url = "${gatewayBaseUrl}"`,
      'wire_api = "responses"',
      "",
    ].join("\n");
    await writeFile(codexConfigPath, mismatchedProviderConfigRaw, "utf8");
    const stateBeforeMismatchedProvider = await readFile(statePath, "utf8");
    let mismatchedProviderLaunchFailed = false;
    try {
      await runBashScript(launchScript, [
        "--codex-config-path",
        toUnixPathForBash(codexConfigPath),
        "--state-root",
        toUnixPathForBash(stateRoot),
        "--listen-port",
        String(gatewayPort),
        "--no-open",
      ]);
    } catch {
      mismatchedProviderLaunchFailed = true;
    }
    assert(mismatchedProviderLaunchFailed, "Unix mismatched provider reused another provider's original upstream");
    assert(
      (await readFile(statePath, "utf8")) === stateBeforeMismatchedProvider,
      "Unix mismatched provider attempt changed install state",
    );

    const gatewayPidBeforeMissingConfigRestore = Number.parseInt(
      (await readFile(gatewayPidPath, "utf8")).trim(),
      10,
    );
    await rm(gatewayConfigPath, { force: true });
    await runBashScript(restoreScript, [
      "--codex-config-path",
      toUnixPathForBash(codexConfigPath),
      "--state-root",
      toUnixPathForBash(stateRoot),
    ]);
    const gatewayStoppedByMissingConfigRestore = !isProcessAlive(gatewayPidBeforeMissingConfigRestore);
    if (!gatewayStoppedByMissingConfigRestore) {
      await stopProcessById(gatewayPidBeforeMissingConfigRestore);
    }
    assert(
      gatewayStoppedByMissingConfigRestore,
      "Unix restore with missing config.json left the verified gateway process running without state",
    );

    process.stdout.write("PASS unix launch-ui flow\n");
  } finally {
    await stopChildProcess(stalePidProcess);
    try {
      await runBashScript(stopScript, ["--state-root", toUnixPathForBash(stateRoot), "--quiet"]);
    } catch {
      // 测试清理阶段允许忽略停止失败，避免覆盖主失败原因。
    }
    try {
      await runBashScript(restoreScript, [
        "--codex-config-path",
        toUnixPathForBash(codexConfigPath),
        "--state-root",
        toUnixPathForBash(stateRoot),
      ]);
    } catch {
      // 测试可能在首次安装前失败，此时没有可恢复备份。
    }
    upstream.close();
    await once(upstream, "close");
    await rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
