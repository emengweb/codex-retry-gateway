#!/usr/bin/env node

import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptsRoot = fileURLToPath(new URL(".", import.meta.url));
const launchScript = path.join(scriptsRoot, "launch-ui.ps1");
const startScript = path.join(scriptsRoot, "start-gateway.ps1");
const stopScript = path.join(scriptsRoot, "stop-gateway.ps1");
const restoreScript = path.join(scriptsRoot, "restore-codex-config.ps1");

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
        "x-upstream-test": "launch-ui-ok",
      });
      res.end(JSON.stringify({ object: "list", data: [{ id: "launch-ui-test-model" }] }));
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
            id: "launch-ui-response",
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

async function runPowerShellScript(scriptPath, args) {
  const child = spawn(
    "powershell",
    ["-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

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
    throw new Error(`PowerShell script failed: ${scriptPath}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return { stdout, stderr };
}

async function run() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-retry-gateway-launch-"));
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
  const waitHealthCheckScript = path.join(tempRoot, "wait-health-wrong-pid.ps1");
  const commonScriptPath = path.join(scriptsRoot, "common.ps1").replaceAll("'", "''");
  await writeFile(
    waitHealthCheckScript,
    [
      `$ErrorActionPreference = "Stop"`,
      `. '${commonScriptPath}'`,
      `$null = Wait-GatewayHealth -ListenHost "127.0.0.1" -ListenPort ${wrongPidHealthPort} -HealthPath "/health" -TimeoutSeconds 1 -ExpectedProcessId ${process.pid}`,
      "",
    ].join("\n"),
    "utf8",
  );
  let wrongPidHealthRejected = false;
  let expectedPidParameterMissing = false;
  try {
    await runPowerShellScript(waitHealthCheckScript, []);
  } catch (error) {
    const errorText = `${error?.message || error}`;
    expectedPidParameterMissing =
      errorText.includes("ExpectedProcessId") &&
      (errorText.includes("cannot be found") || errorText.includes("找不到"));
    wrongPidHealthRejected = !expectedPidParameterMissing;
  } finally {
    wrongPidHealthServer.close();
    await once(wrongPidHealthServer, "close");
  }
  assert(!expectedPidParameterMissing, "PowerShell health wait does not support ExpectedProcessId");
  assert(wrongPidHealthRejected, "PowerShell health wait accepted HTTP 200 from the wrong process_id");

  const canonicalArrayCheckScript = path.join(tempRoot, "canonical-array-check.ps1");
  await writeFile(
    canonicalArrayCheckScript,
    [
      `$ErrorActionPreference = "Stop"`,
      `. '${commonScriptPath}'`,
      `Write-Output ("FORWARD=" + (ConvertTo-CanonicalJson -Value @("/responses", "/v1/responses")))`,
      `Write-Output ("REVERSE=" + (ConvertTo-CanonicalJson -Value @("/v1/responses", "/responses")))`,
      `Write-Output ("SCALARS=" + (ConvertTo-CanonicalJson -Value @(516, 1034, $true, $false)))`,
      "",
    ].join("\n"),
    "utf8",
  );
  const canonicalArrayCheck = await runPowerShellScript(canonicalArrayCheckScript, []);
  assert(
    canonicalArrayCheck.stdout.includes('FORWARD=["/responses","/v1/responses"]') &&
      canonicalArrayCheck.stdout.includes('REVERSE=["/v1/responses","/responses"]') &&
      canonicalArrayCheck.stdout.includes('SCALARS=[516,1034,true,false]'),
    `PowerShell canonical JSON 必须保留基本类型数组的值与顺序: ${canonicalArrayCheck.stdout}`,
  );

  const failedStartProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const failedStartPidPath = path.join(tempRoot, "failed-start.pid");
  await writeFile(failedStartPidPath, `${failedStartProcess.pid}`, "utf8");
  const cleanupCheckScript = path.join(tempRoot, "cleanup-failed-start.ps1");
  const failedStartPidPathPs = failedStartPidPath.replaceAll("'", "''");
  await writeFile(
    cleanupCheckScript,
    [
      `$ErrorActionPreference = "Stop"`,
      `. '${commonScriptPath}'`,
      `Stop-FailedGatewayStart -ProcessId ${failedStartProcess.pid} -PidPath '${failedStartPidPathPs}'`,
      "",
    ].join("\n"),
    "utf8",
  );
  let cleanupHelperSucceeded = false;
  try {
    await runPowerShellScript(cleanupCheckScript, []);
    cleanupHelperSucceeded = true;
  } catch {
    cleanupHelperSucceeded = false;
  }
  const failedStartProcessStopped = !isProcessAlive(failedStartProcess.pid);
  const failedStartPidRemoved = !(await pathExists(failedStartPidPath));
  if (!failedStartProcessStopped) {
    await stopChildProcess(failedStartProcess);
  }
  if (!failedStartPidRemoved) {
    await rm(failedStartPidPath, { force: true });
  }
  assert(cleanupHelperSucceeded, "PowerShell failed-start child cleanup helper is unavailable or failed");
  assert(failedStartProcessStopped, "PowerShell failed-start cleanup left its child process alive");
  assert(failedStartPidRemoved, "PowerShell failed-start cleanup left its child PID file behind");

  const pidWriteFailureProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const pidWriteFailureRoot = path.join(tempRoot, "pid-write-failure");
  const pidWriteFailureConfigDir = path.join(pidWriteFailureRoot, "config");
  const pidWriteFailureConfigPath = path.join(pidWriteFailureConfigDir, "config.json");
  const pidWriteFailureLogPath = path.join(pidWriteFailureRoot, "gateway.log");
  await mkdir(pidWriteFailureConfigDir, { recursive: true });
  await writeFile(
    pidWriteFailureConfigPath,
    `${JSON.stringify(
      {
        listen_host: "127.0.0.1",
        listen_port: await getFreePort(),
        upstream_base_url: upstreamBaseUrl,
        endpoints: ["/responses"],
        health_path: "/__codex_retry_gateway/health",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const pidWriteFailureScript = path.join(tempRoot, "pid-write-failure.ps1");
  const startScriptPathPs = startScript.replaceAll("'", "''");
  const pidWriteFailureRootPs = pidWriteFailureRoot.replaceAll("'", "''");
  const pidWriteFailureConfigPathPs = pidWriteFailureConfigPath.replaceAll("'", "''");
  const pidWriteFailureLogPathPs = pidWriteFailureLogPath.replaceAll("'", "''");
  await writeFile(
    pidWriteFailureScript,
    [
      `$ErrorActionPreference = "Stop"`,
      `function Start-Process {`,
      `  param([string]$FilePath, $ArgumentList, [string]$WorkingDirectory, $WindowStyle, [switch]$PassThru)`,
      `  return [pscustomobject]@{ Id = ${pidWriteFailureProcess.pid}; HasExited = $false }`,
      `}`,
      `function Set-Content {`,
      `  param([string]$LiteralPath, $Value, [switch]$NoNewline)`,
      `  throw "simulated PID write failure"`,
      `}`,
      `& '${startScriptPathPs}' -StateRoot '${pidWriteFailureRootPs}' -ConfigPath '${pidWriteFailureConfigPathPs}' -LogPath '${pidWriteFailureLogPathPs}'`,
      "",
    ].join("\n"),
    "utf8",
  );
  let pidWriteFailureRejected = false;
  try {
    await runPowerShellScript(pidWriteFailureScript, []);
  } catch {
    pidWriteFailureRejected = true;
  }
  const pidWriteFailureChildStopped = !isProcessAlive(pidWriteFailureProcess.pid);
  if (!pidWriteFailureChildStopped) {
    await stopChildProcess(pidWriteFailureProcess);
  }
  assert(pidWriteFailureRejected, "PowerShell start did not report the PID write failure");
  assert(pidWriteFailureChildStopped, "PowerShell PID write failure left the created child running");
  assert(
    !(await pathExists(path.join(pidWriteFailureRoot, "gateway.pid"))),
    "PowerShell PID write failure left a child PID file behind",
  );

  await mkdir(codexDir, { recursive: true });
  await writeFile(
    codexConfigPath,
    [
      'model_provider = "custom"',
      "",
      "[model_providers.custom]",
      'name = "Launch UI Test"',
      `base_url = "${upstreamBaseUrl}"`,
      'wire_api = "responses"',
      "",
    ].join("\n"),
    "utf8",
  );

  const upstream = await startFakeUpstream(upstreamPort);

  try {
    await runPowerShellScript(launchScript, [
      "-CodexConfigPath",
      codexConfigPath,
      "-StateRoot",
      stateRoot,
      "-ListenPort",
      String(gatewayPort),
      "-NoOpen",
    ]);

    const installedConfig = await readFile(codexConfigPath, "utf8");
    assert(
      installedConfig.includes(`base_url = "${gatewayBaseUrl}"`),
      "First launch did not redirect the current provider to the local gateway",
    );

    const uiResponse = await fetch(`${gatewayBaseUrl}/__codex_retry_gateway/ui`);
    assert(uiResponse.status === 200, `UI page was not reachable after first launch: ${uiResponse.status}`);

    const statusResponse = await fetch(`${gatewayBaseUrl}/__codex_retry_gateway/api/status`);
    const statusPayload = await statusResponse.json();
    assert(statusResponse.status === 200, `Status API failed after first launch: ${statusResponse.status}`);
    assert(
      statusPayload.state?.original_base_url === upstreamBaseUrl,
      "First launch did not persist the original upstream base URL",
    );

    const statePath = path.join(stateRoot, "state.json");
    const gatewayConfigPath = path.join(stateRoot, "config", "config.json");
    const gatewayPidPath = path.join(stateRoot, "gateway.pid");
    const backupDir = path.join(stateRoot, "backups");
    const installedGatewayConfig = JSON.parse(await readFile(gatewayConfigPath, "utf8"));
    assert(
      installedGatewayConfig.capacity_error_action === "retry_then_pass_through" &&
        installedGatewayConfig.http_429_action === "pass_through",
      "Windows first launch did not write upstream error policy defaults",
    );
    assert(
      JSON.stringify(installedGatewayConfig.latency_guard) ===
        JSON.stringify({
          enabled: false,
          first_progress_timeout_ms: 0,
          first_progress_action: "return_502",
          total_timeout_ms: 0,
        }),
      "Windows first launch did not write disabled latency_guard defaults",
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
      `Windows layered policy setup failed: ${saveLayeredPolicyResponse.status}`,
    );
    const firstStateRaw = await readFile(statePath, "utf8");
    const firstState = JSON.parse(firstStateRaw);
    const firstCodexConfigRaw = await readFile(codexConfigPath, "utf8");
    const firstGatewayConfig = JSON.parse(await readFile(gatewayConfigPath, "utf8"));
    assert(firstGatewayConfig.intercept_rule_mode === "none", "Windows policy setup did not persist none mode");
    assert(
      firstGatewayConfig.intercept_streaming === false &&
        firstGatewayConfig.intercept_non_streaming === false,
      "Windows policy setup did not persist none mode disabled intercept targets",
    );
    assert(
      firstGatewayConfig.capacity_error_action === "retry_then_502" &&
        firstGatewayConfig.http_429_action === "retry_then_pass_through",
      "Windows policy setup did not persist upstream error actions",
    );
    assert(
      firstGatewayConfig.latency_guard?.enabled === true &&
        firstGatewayConfig.latency_guard?.first_progress_timeout_ms === 1234 &&
        firstGatewayConfig.latency_guard?.first_progress_action === "retry_then_502" &&
        firstGatewayConfig.latency_guard?.total_timeout_ms === 9876,
      "Windows policy setup did not persist latency_guard",
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

    const secondLaunch = await runPowerShellScript(launchScript, [
      "-CodexConfigPath",
      codexConfigPath,
      "-StateRoot",
      stateRoot,
      "-ListenPort",
      String(gatewayPort),
      "-NoOpen",
    ]);

    const secondStateRaw = await readFile(statePath, "utf8");
    const secondState = JSON.parse(secondStateRaw);
    const secondCodexConfigRaw = await readFile(codexConfigPath, "utf8");
    const secondGatewayConfigRaw = await readFile(gatewayConfigPath, "utf8");
    const secondGatewayPid = (await readFile(gatewayPidPath, "utf8")).trim();
    const secondBackups = (await readdir(backupDir)).sort();
    assert(secondLaunch.stdout.includes("mode=reuse"), "Second launch did not report reuse mode");
    assert(
      secondGatewayPid === firstGatewayPid,
      `Second launch restarted an already healthy gateway: ${firstGatewayPid} -> ${secondGatewayPid}`,
    );
    assert(secondCodexConfigRaw === firstCodexConfigRaw, "Second launch rewrote an already configured Codex config");
    assert(secondGatewayConfigRaw === firstGatewayConfigRaw, "Second launch rewrote an unchanged gateway config");
    assert(secondStateRaw === firstStateRaw, "Second launch rewrote unchanged gateway state");
    assert(
      JSON.stringify(secondBackups) === JSON.stringify(firstBackups),
      "Second launch created an unnecessary Codex config backup",
    );
    assert((await mtimeNs(codexConfigPath)) === firstMtimes.codex, "Second launch touched Codex config mtime");
    assert((await mtimeNs(gatewayConfigPath)) === firstMtimes.gatewayConfig, "Second launch touched gateway config mtime");
    assert((await mtimeNs(statePath)) === firstMtimes.state, "Second launch touched state mtime");
    assert((await mtimeNs(gatewayPidPath)) === firstMtimes.pid, "Second launch touched PID mtime");
    assert((await mtimeNs(backupDir)) === firstMtimes.backupDir, "Second launch touched backup directory mtime");
    assert(
      secondState.original_base_url === firstState.original_base_url,
      "Second launch overwrote original_base_url unexpectedly",
    );
    assert(
      secondState.gateway_base_url === gatewayBaseUrl,
      "Second launch did not preserve gateway_base_url",
    );

    const conflictPort = await getFreePort();
    const conflictServer = http.createServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("occupied");
    });
    conflictServer.listen(conflictPort, "127.0.0.1");
    await once(conflictServer, "listening");
    let conflictLaunchFailed = false;
    try {
      await runPowerShellScript(launchScript, [
        "-CodexConfigPath",
        codexConfigPath,
        "-StateRoot",
        stateRoot,
        "-ListenPort",
        String(conflictPort),
        "-NoOpen",
      ]);
    } catch {
      conflictLaunchFailed = true;
    } finally {
      conflictServer.close();
      await once(conflictServer, "close");
    }
    assert(conflictLaunchFailed, "Occupied target port did not fail the migration restart");
    assert((await readFile(codexConfigPath, "utf8")) === firstCodexConfigRaw, "Failed migration did not restore Codex config bytes");
    assert((await readFile(gatewayConfigPath, "utf8")) === firstGatewayConfigRaw, "Failed migration did not restore gateway config bytes");
    assert((await readFile(statePath, "utf8")) === firstStateRaw, "Failed migration rewrote unchanged state");
    assert((await mtimeNs(statePath)) === firstMtimes.state, "Failed migration touched state that was never updated");
    assert(
      JSON.stringify((await readdir(backupDir)).sort()) === JSON.stringify(firstBackups),
      "Failed migration changed recovery backups",
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
    assert(rollbackHealthStatus === 200, "Failed migration did not restore the previously healthy gateway");

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
      await runPowerShellScript(launchScript, [
        "-CodexConfigPath",
        codexConfigPath,
        "-StateRoot",
        stateRoot,
        "-ListenPort",
        String(missingConfigConflictPort),
        "-NoOpen",
      ]);
    } catch {
      missingConfigMigrationFailed = true;
    } finally {
      missingConfigConflictServer.close();
      await once(missingConfigConflictServer, "close");
    }
    assert(missingConfigMigrationFailed, "Missing-config migration to an occupied port did not fail");
    assert(
      (await fetch(`${gatewayBaseUrl}/__codex_retry_gateway/health`)).status === 200,
      "Failed missing-config migration did not preserve the previous healthy gateway",
    );
    assert(
      !(await pathExists(gatewayConfigPath)),
      "Failed missing-config migration did not restore config.json to its original missing state",
    );
    assert(
      (await readFile(codexConfigPath, "utf8")) === codexBeforeMissingConfigMigration,
      "Failed missing-config migration changed Codex config bytes",
    );
    assert(
      (await readFile(statePath, "utf8")) === stateBeforeMissingConfigMigration,
      "Failed missing-config migration changed install state",
    );
    assert(await pathExists(gatewayPidPath), "Failed missing-config migration lost the healthy gateway PID");
    assert(
      isProcessAlive(Number.parseInt((await readFile(gatewayPidPath, "utf8")).trim(), 10)),
      "Failed missing-config migration left a dead gateway PID",
    );
    await writeFile(gatewayConfigPath, firstGatewayConfigRaw, "utf8");

    await runPowerShellScript(stopScript, ["-StateRoot", stateRoot, "-Quiet"]);
    stalePidProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(gatewayPidPath, `${stalePidProcess.pid}`, "utf8");
    await runPowerShellScript(startScript, ["-StateRoot", stateRoot]);
    const directStartedGatewayPid = (await readFile(gatewayPidPath, "utf8")).trim();
    assert(
      directStartedGatewayPid !== `${stalePidProcess.pid}`,
      "Direct start trusted an unrelated live process from a stale PID file",
    );
    assert(isProcessAlive(stalePidProcess.pid), "Direct start terminated the unrelated stale-PID process");
    assert(
      (await fetch(`${gatewayBaseUrl}/__codex_retry_gateway/health`)).status === 200,
      "Direct start did not launch a healthy gateway after discarding stale PID identity",
    );
    await runPowerShellScript(stopScript, ["-StateRoot", stateRoot, "-Quiet"]);
    await writeFile(gatewayPidPath, `${stalePidProcess.pid}`, "utf8");
    const recoveredLaunch = await runPowerShellScript(launchScript, [
      "-CodexConfigPath",
      codexConfigPath,
      "-StateRoot",
      stateRoot,
      "-ListenPort",
      String(gatewayPort),
      "-NoOpen",
    ]);
    const recoveredGatewayPid = (await readFile(gatewayPidPath, "utf8")).trim();
    assert(recoveredLaunch.stdout.includes("mode=reuse"), "Stopped gateway recovery did not reuse install state");
    assert(recoveredGatewayPid !== secondGatewayPid, "Stopped gateway recovery did not start a new process");
    assert(
      recoveredGatewayPid !== `${stalePidProcess.pid}`,
      "Gateway trusted a live stale PID without checking the health endpoint",
    );
    assert(
      isProcessAlive(stalePidProcess.pid),
      "Gateway recovery terminated an unrelated process referenced by a stale PID file",
    );
    assert(
      (await readFile(codexConfigPath, "utf8")) === secondCodexConfigRaw,
      "Stopped gateway recovery rewrote Codex config",
    );
    assert(
      (await readFile(gatewayConfigPath, "utf8")) === secondGatewayConfigRaw,
      "Stopped gateway recovery rewrote unchanged gateway config",
    );
    assert(
      JSON.stringify((await readdir(backupDir)).sort()) === JSON.stringify(secondBackups),
      "Stopped gateway recovery created an unnecessary backup",
    );
    const recoveredStateRaw = await readFile(statePath, "utf8");

    const driftedUpstreamBaseUrl = `${upstreamBaseUrl}/v1`;
    await writeFile(
      codexConfigPath,
      secondCodexConfigRaw.replace(
        `base_url = "${gatewayBaseUrl}"`,
        `base_url = "${driftedUpstreamBaseUrl}"`,
      ),
      "utf8",
    );
    const driftRepair = await runPowerShellScript(launchScript, [
      "-CodexConfigPath",
      codexConfigPath,
      "-StateRoot",
      stateRoot,
      "-ListenPort",
      String(gatewayPort),
      "-NoOpen",
    ]);
    assert(driftRepair.stdout.includes("mode=reuse"), "Provider drift did not reuse the existing install identity");
    assert(
      (await readFile(codexConfigPath, "utf8")).includes(`base_url = "${gatewayBaseUrl}"`),
      "Provider drift repair did not restore gateway takeover",
    );
    assert(
      (await readFile(gatewayConfigPath, "utf8")) === secondGatewayConfigRaw,
      "Provider drift repair changed the existing gateway upstream or settings",
    );
    assert((await readFile(statePath, "utf8")) === recoveredStateRaw, "Provider drift repair rewrote install state");
    assert(
      (await readFile(gatewayPidPath, "utf8")).trim() === recoveredGatewayPid,
      "Provider-only drift repair restarted a healthy gateway",
    );
    assert(
      JSON.stringify((await readdir(backupDir)).sort()) === JSON.stringify(secondBackups),
      "Provider-only drift repair changed the immutable recovery backup",
    );

    await runPowerShellScript(launchScript, [
      "-CodexConfigPath",
      codexConfigPath,
      "-StateRoot",
      stateRoot,
      "-ListenPort",
      String(gatewayPort),
      "-NoOpen",
    ]);
    assert(
      (await readFile(gatewayPidPath, "utf8")).trim() === recoveredGatewayPid,
      "Launch after provider drift repair restarted the healthy gateway again",
    );
    assert((await readFile(gatewayConfigPath, "utf8")) === secondGatewayConfigRaw, "Post-repair launch rewrote gateway config");
    assert((await readFile(statePath, "utf8")) === recoveredStateRaw, "Post-repair launch rewrote gateway state");
    assert(
      JSON.stringify((await readdir(backupDir)).sort()) === JSON.stringify(secondBackups),
      "Post-repair launch created another backup",
    );

    const stateWithoutBackup = {
      ...JSON.parse(recoveredStateRaw),
      latest_backup_path: "",
    };
    const stateWithoutBackupRaw = `${JSON.stringify(stateWithoutBackup, null, 2)}\n`;
    await writeFile(statePath, stateWithoutBackupRaw, "utf8");
    const stateWithoutBackupMtime = await mtimeNs(statePath);
    const backupsBeforeRecoveryPoint = (await readdir(backupDir)).sort();
    await runPowerShellScript(launchScript, [
      "-CodexConfigPath",
      codexConfigPath,
      "-StateRoot",
      stateRoot,
      "-ListenPort",
      String(gatewayPort),
      "-NoOpen",
    ]);
    assert((await readFile(statePath, "utf8")) === stateWithoutBackupRaw, "Gateway-routed provider created a fake recovery state");
    assert((await mtimeNs(statePath)) === stateWithoutBackupMtime, "Gateway-routed provider touched missing-backup state");
    assert(
      JSON.stringify((await readdir(backupDir)).sort()) === JSON.stringify(backupsBeforeRecoveryPoint),
      "Gateway-routed provider created a fake recovery backup",
    );

    const realProviderConfigRaw = (await readFile(codexConfigPath, "utf8")).replace(
      `base_url = "${gatewayBaseUrl}"`,
      `base_url = "${upstreamBaseUrl}"`,
    );
    await writeFile(codexConfigPath, realProviderConfigRaw, "utf8");
    await runPowerShellScript(launchScript, [
      "-CodexConfigPath",
      codexConfigPath,
      "-StateRoot",
      stateRoot,
      "-ListenPort",
      String(gatewayPort),
      "-NoOpen",
    ]);
    const repairedBackupState = JSON.parse(await readFile(statePath, "utf8"));
    const backupsAfterRecoveryPoint = (await readdir(backupDir)).sort();
    assert(repairedBackupState.latest_backup_path, "Real provider drift did not repair the missing recovery backup");
    assert(
      backupsAfterRecoveryPoint.length === backupsBeforeRecoveryPoint.length + 1,
      "Real provider drift did not create exactly one recovery backup",
    );
    assert(
      backupsAfterRecoveryPoint.includes(path.basename(repairedBackupState.latest_backup_path)),
      "Repaired state does not reference the new recovery backup",
    );
    assert(
      (await readFile(repairedBackupState.latest_backup_path, "utf8")) === realProviderConfigRaw,
      "Recovery backup did not preserve the real provider config bytes",
    );
    assert((await readFile(gatewayConfigPath, "utf8")) === secondGatewayConfigRaw, "Backup repair changed gateway settings");
    assert(
      (await readFile(gatewayPidPath, "utf8")).trim() === recoveredGatewayPid,
      "Backup repair restarted the healthy gateway",
    );

    const restoreDefaultPolicyResponse = await fetch(
      `${gatewayBaseUrl}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          intercept_streaming: true,
          intercept_non_streaming: true,
          capacity_error_action: "retry_then_pass_through",
          http_429_action: "pass_through",
          latency_guard: {
            enabled: false,
            first_progress_timeout_ms: 0,
            first_progress_action: "return_502",
            total_timeout_ms: 0,
          },
          retry_upstream_capacity_errors: true,
        }),
      },
    );
    assert(
      restoreDefaultPolicyResponse.status === 200,
      `Restoring Windows default policies failed: ${restoreDefaultPolicyResponse.status}`,
    );

    const proxiedModels = await fetch(`${gatewayBaseUrl}/v1/models`);
    assert(proxiedModels.status === 200, `/v1/models through launch UI flow failed: ${proxiedModels.status}`);
    assert(
      proxiedModels.headers.get("x-upstream-test") === "launch-ui-ok",
      "Gateway did not preserve upstream headers after second launch",
    );

    const blockedResponse = await fetch(`${gatewayBaseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test_reasoning_tokens: 516 }),
    });
    assert(blockedResponse.status === 502, `Default 516 interception was not active: ${blockedResponse.status}`);

    process.stdout.write("PASS launch-ui flow\n");
  } finally {
    await stopChildProcess(stalePidProcess);
    try {
      await runPowerShellScript(stopScript, ["-StateRoot", stateRoot, "-Quiet"]);
    } catch {
      // 测试清理阶段允许忽略停止失败，避免覆盖主失败原因。
    }
    try {
      await runPowerShellScript(restoreScript, [
        "-CodexConfigPath",
        codexConfigPath,
        "-StateRoot",
        stateRoot,
      ]);
    } catch {
      // 测试清理阶段允许忽略恢复失败，避免覆盖主失败原因。
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
