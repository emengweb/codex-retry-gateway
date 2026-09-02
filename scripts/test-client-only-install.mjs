#!/usr/bin/env node

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getGatewayStatePaths,
  launchUi,
  restoreCodexConfig,
  stopGateway,
} from "./admin-lib.mjs";

async function getFreePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : null;
  server.close();
  await once(server, "close");
  assert(port, "无法分配临时端口");
  return port;
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function startFakeUpstream(port) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "x-upstream-test": "client-only-install",
      });
      res.end(JSON.stringify({ object: "list", data: [{ id: "client-only-model" }] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server;
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
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-retry-client-install-"));
  const stateRoot = path.join(tempRoot, "state");
  const piConfigPath = path.join(tempRoot, "pi", "models.json");
  const openCodeConfigPath = path.join(tempRoot, "opencode", "opencode.jsonc");
  const missingCodexConfigPath = path.join(tempRoot, "codex", "config.toml");
  const upstreamPort = await getFreePort();
  const gatewayPort = await getFreePort();
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;
  const piSource = `{
  "providers": {
    "shared": {
      "baseUrl": "${upstreamBaseUrl}",
      "api": "openai-completions",
      "models": [{ "id": "client-only-model" }]
    }
  }
}
`;
  const openCodeSource = `{
  // Added after the initial client-only install.
  "providers": {
    "shared": {
      "package": "@opencode-ai/ai/providers/openai-compatible",
      "settings": { "baseURL": "${upstreamBaseUrl}" }
    }
  }
}
`;
  let upstream = null;

  try {
    await mkdir(path.dirname(piConfigPath), { recursive: true });
    await writeFile(piConfigPath, piSource, "utf8");
    upstream = await startFakeUpstream(upstreamPort);

    const launched = await launchUi({
      codexConfigPath: missingCodexConfigPath,
      clientConfigPaths: { pi: piConfigPath },
      stateRoot,
      listenHost: "127.0.0.1",
      listenPort: gatewayPort,
      noOpen: true,
    });

    assert.equal(launched.mode, "install", "无 Codex 时应以发现到的客户端完成首次安装");
    assert.equal(launched.gatewayBaseUrl, gatewayBaseUrl, "启动结果应返回临时 gateway 地址");
    assert(
      (await readFile(piConfigPath, "utf8")).includes(`"baseUrl": "${gatewayBaseUrl}"`),
      "pi 配置未接管到 gateway",
    );

    const paths = getGatewayStatePaths(stateRoot);
    const state = JSON.parse(await readFile(paths.statePath, "utf8"));
    assert.equal(state.client_configs?.records?.length, 1, "安装状态缺少 pi 接管记录");
    assert.equal(state.client_configs.records[0].client, "pi", "接管记录客户端错误");
    assert.equal(state.original_base_url, upstreamBaseUrl, "gateway upstream 未从 pi 配置推断");

    await rm(paths.configPath, { force: true });
    const recoveredConfig = await launchUi({
      codexConfigPath: missingCodexConfigPath,
      clientConfigPaths: { pi: piConfigPath },
      stateRoot,
      listenHost: "127.0.0.1",
      listenPort: gatewayPort,
      noOpen: true,
    });
    assert.equal(recoveredConfig.mode, "reuse", "缺少 config.json 时应复用健康的 client-only gateway");
    assert.equal(await pathExists(paths.configPath), true, "健康 gateway 的运行时配置未恢复到 config.json");

    const proxiedModels = await fetch(`${gatewayBaseUrl}/v1/models`);
    assert.equal(proxiedModels.status, 200, "client-only gateway 未正常代理请求");
    assert.equal(
      proxiedModels.headers.get("x-upstream-test"),
      "client-only-install",
      "gateway 未转发到从 pi 推断的 upstream",
    );

    await mkdir(path.dirname(openCodeConfigPath), { recursive: true });
    await writeFile(openCodeConfigPath, openCodeSource, "utf8");
    const reused = await launchUi({
      codexConfigPath: missingCodexConfigPath,
      clientConfigPaths: {
        pi: piConfigPath,
        opencode: openCodeConfigPath,
      },
      stateRoot,
      listenHost: "127.0.0.1",
      listenPort: gatewayPort,
      noOpen: true,
    });
    assert.equal(reused.mode, "reuse", "已有 client-only 安装时应复用 gateway 并补接管新客户端");
    assert(
      (await readFile(openCodeConfigPath, "utf8")).includes(`"baseURL": "${gatewayBaseUrl}"`),
      "复用启动未接管新增 OpenCode 配置",
    );
    const reusedState = JSON.parse(await readFile(paths.statePath, "utf8"));
    assert.equal(reusedState.client_configs?.records?.length, 2, "复用启动未保留已有并新增客户端接管记录");

    await restoreCodexConfig({
      stateRoot,
      codexConfigPath: missingCodexConfigPath,
    });

    assert.equal(await readFile(piConfigPath, "utf8"), piSource, "恢复未还原 pi 原始配置");
    assert.equal(await readFile(openCodeConfigPath, "utf8"), openCodeSource, "恢复未还原 OpenCode 原始配置");
    assert.equal(await pathExists(paths.statePath), false, "恢复后安装状态未清除");

    await launchUi({
      codexConfigPath: missingCodexConfigPath,
      clientConfigPaths: { pi: piConfigPath },
      stateRoot,
      listenHost: "127.0.0.1",
      listenPort: gatewayPort,
      noOpen: true,
    });
    const uiRestoreResponse = await fetch(`${gatewayBaseUrl}/__codex_retry_gateway/api/restore`, {
      method: "POST",
    });
    assert.equal(uiRestoreResponse.status, 202, "管理页恢复入口未接受 client-only 安装状态");
    const restoreDeadline = Date.now() + 5000;
    while (Date.now() < restoreDeadline) {
      if (
        (await readFile(piConfigPath, "utf8")) === piSource &&
        !(await pathExists(paths.statePath))
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(await readFile(piConfigPath, "utf8"), piSource, "管理页恢复未还原 pi 原始配置");
    assert.equal(await pathExists(paths.statePath), false, "管理页恢复后安装状态未清除");

    await new Promise((resolve) => setTimeout(resolve, 250));
    const scriptsRoot = import.meta.dirname;
    const powerShellLaunch = await runPowerShellScript(path.join(scriptsRoot, "launch-ui.ps1"), [
      "-CodexConfigPath",
      missingCodexConfigPath,
      "-PiConfigPath",
      piConfigPath,
      "-StateRoot",
      stateRoot,
      "-ListenPort",
      String(gatewayPort),
      "-NoOpen",
    ]);
    assert(powerShellLaunch.stdout.includes("mode=install"), "PowerShell 启动入口未进入 client-only 安装模式");
    assert(
      (await readFile(piConfigPath, "utf8")).includes(`"baseUrl": "${gatewayBaseUrl}"`),
      "PowerShell 启动入口未接管 pi 配置",
    );
    await runPowerShellScript(path.join(scriptsRoot, "restore-codex-config.ps1"), [
      "-CodexConfigPath",
      missingCodexConfigPath,
      "-StateRoot",
      stateRoot,
    ]);
    assert.equal(await readFile(piConfigPath, "utf8"), piSource, "PowerShell 恢复入口未还原 pi 配置");

    process.stdout.write("PASS client-only install flow\n");
  } finally {
    try {
      await stopGateway({ stateRoot, quiet: true });
    } catch {
      // 测试失败前可能尚未写入有效状态。
    }
    if (upstream) {
      upstream.close();
      await once(upstream, "close");
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
