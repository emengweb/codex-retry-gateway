#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const gatewayEntry = path.resolve(new URL("../gateway.mjs", import.meta.url).pathname);
const TRANSIENT_RETRY_MAX_ATTEMPTS = 16;
const STRICT_STREAM_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024;

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(port, child) {
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`gateway exited before health: ${child.exitCode}\n${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__codex_retry_gateway/health`, {
        signal: AbortSignal.timeout(250),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // 启动窗口内暂时不可用，继续轮询。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`gateway health timeout\n${stderr}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 1500);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitFor(condition, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function startGateway(config) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-retry-memory-"));
  const configPath = path.join(root, "config.json");
  const logPath = path.join(root, "gateway.log");
  await writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");
  const child = spawn(process.execPath, [gatewayEntry, "--config", configPath, "--log", logPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    await waitForHealth(config.listen_port, child);
  } catch (error) {
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    child,
    async close() {
      await stopChild(child);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function startUpstream(mode) {
  let requestCount = 0;
  const upstream = createServer((req, res) => {
    requestCount += 1;
    req.resume();
    req.once("end", () => {
      const respond429 = () => {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "rate_limit_error", message: "busy" } }));
      };
      if (mode === "429") {
        respond429();
        return;
      }
      if (mode === "delayed-429") {
        setTimeout(respond429, 25);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunkText = "x".repeat(64 * 1024);
      for (let index = 0; index < 140; index += 1) {
        res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: chunkText })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: "response.completed", response: { usage: {} } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${upstream.address().port}/v1`,
    get requestCount() {
      return requestCount;
    },
    async close() {
      await new Promise((resolve) => upstream.close(resolve));
    },
  };
}

async function testGuardBudgetRejectsUnboundedValue() {
  const port = await getFreePort();
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-retry-memory-invalid-"));
  const configPath = path.join(root, "config.json");
  await writeFile(
    configPath,
    `${JSON.stringify({
      listen_host: "127.0.0.1",
      listen_port: port,
      upstream_base_url: "http://127.0.0.1:1/v1",
      guard_retry_attempts: 9999,
    })}\n`,
    "utf8",
  );
  const child = spawn(process.execPath, [gatewayEntry, "--config", configPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(null);
    }, 1000);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  await rm(root, { recursive: true, force: true });
  assert.notEqual(exitCode, null, "超过硬上限的 guard_retry_attempts 不应启动 gateway");
  assert.notEqual(exitCode, 0, `非法重试预算应启动失败: ${stderr}`);
}

async function testTransientRetryHasAttemptCap() {
  const upstream = await startUpstream("429");
  const gatewayPort = await getFreePort();
  const gateway = await startGateway({
    listen_host: "127.0.0.1",
    listen_port: gatewayPort,
    upstream_base_url: upstream.url,
    intercept_rule_mode: "none",
    guard_retry_attempts: 0,
    transient_retry: { enabled: true, initial_delay_ms: 0, max_delay_ms: 0 },
    http_429_action: "pass_through",
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: false, model: "memory-test" }),
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 429);
    await response.arrayBuffer();
    assert.equal(
      upstream.requestCount,
      TRANSIENT_RETRY_MAX_ATTEMPTS,
      "瞬态重试必须在硬上限处收口",
    );
  } finally {
    await gateway.close();
    await upstream.close();
  }
}

async function testStrictStreamBufferHasHardLimit() {
  const upstream = await startUpstream("large-stream");
  const gatewayPort = await getFreePort();
  const gateway = await startGateway({
    listen_host: "127.0.0.1",
    listen_port: gatewayPort,
    upstream_base_url: upstream.url,
    intercept_rule_mode: "reasoning_tokens",
    guard_retry_attempts: 0,
    transient_retry: { enabled: false, initial_delay_ms: 0, max_delay_ms: 0 },
    stream_action: "strict_502",
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true, model: "memory-test" }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.text();
    assert.equal(response.status, 502, `严格流式超限应返回 502: ${body.slice(0, 200)}`);
    assert.match(body, /response_inspection_limit_exceeded/);
    assert.match(body, new RegExp(`"inspection_limit_bytes":${STRICT_STREAM_BUFFER_LIMIT_BYTES}`));
  } finally {
    await gateway.close();
    await upstream.close();
  }
}

async function testAnalyticsFlushReleasesDailyBuffer() {
  const upstream = await startUpstream("429");
  const gatewayPort = await getFreePort();
  const gateway = await startGateway({
    listen_host: "127.0.0.1",
    listen_port: gatewayPort,
    upstream_base_url: upstream.url,
    intercept_rule_mode: "none",
    guard_retry_attempts: 0,
    transient_retry: { enabled: false, initial_delay_ms: 0, max_delay_ms: 0 },
    http_429_action: "pass_through",
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: false, model: "memory-test" }),
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 429);
    await response.arrayBuffer();
    await waitFor(async () => {
      const statusResponse = await fetch(
        `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
        { signal: AbortSignal.timeout(500) },
      );
      const status = await statusResponse.json();
      return (
        status.reasoning_behavior?.analytics_buffered_sample_count === 0 &&
        typeof status.reasoning_behavior?.analytics_last_flush_at === "string"
      );
    }, "分析样本落盘后不应继续保留在 daily_buffers");
  } finally {
    await gateway.close();
    await upstream.close();
  }
}

async function testEmergencyConfigStopsActiveRetries() {
  const upstream = await startUpstream("delayed-429");
  const gatewayPort = await getFreePort();
  const gateway = await startGateway({
    listen_host: "127.0.0.1",
    listen_port: gatewayPort,
    upstream_base_url: upstream.url,
    intercept_rule_mode: "none",
    guard_retry_attempts: 0,
    transient_retry: { enabled: true, initial_delay_ms: 20, max_delay_ms: 20 },
    http_429_action: "pass_through",
  });
  try {
    const pendingResponse = fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: false, model: "memory-test" }),
      signal: AbortSignal.timeout(5000),
    });
    await waitFor(
      () => upstream.requestCount >= 1,
      "应急配置测试未派发首个上游请求",
    );
    const configResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transient_retry: { enabled: false } }),
        signal: AbortSignal.timeout(2000),
      },
    );
    assert.equal(configResponse.status, 200);
    const response = await pendingResponse;
    assert.equal(response.status, 429);
    await response.arrayBuffer();
    assert(
      upstream.requestCount <= 2,
      `紧急关闭重试后不应继续沿用旧配置循环: ${upstream.requestCount}`,
    );
  } finally {
    await gateway.close();
    await upstream.close();
  }
}

await testGuardBudgetRejectsUnboundedValue();
await testTransientRetryHasAttemptCap();
await testStrictStreamBufferHasHardLimit();
await testAnalyticsFlushReleasesDailyBuffer();
await testEmergencyConfigStopsActiveRetries();
process.stdout.write("memory guard red tests passed\n");
