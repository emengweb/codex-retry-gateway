#!/usr/bin/env node

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function waitForListening(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function requestJson(url, body, options = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });
}

async function waitFor(check, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

const upstreamState = {
  requests: [],
  inFlightRetriesByModel: new Map(),
  maxInFlightRetriesByModel: new Map(),
  maxInFlightRetriesOverall: 0,
  byRequest: new Map(),
};
let upstreamServer;
let gatewayChild;
let tempRoot;

try {
  upstreamServer = http.createServer(async (req, res) => {
    if (req.url !== "/responses") {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const requestKey = `${payload.request_id || "unknown"}`;
    const modelKey = `${payload.model || payload.test_response_model || "unknown"}`;
    const sequence = (upstreamState.byRequest.get(requestKey) || 0) + 1;
    upstreamState.byRequest.set(requestKey, sequence);
    const isRetry = sequence > 1;
    upstreamState.requests.push({ requestKey, modelKey, sequence, isRetry, at: Date.now() });
    if (isRetry) {
      const inFlight = (upstreamState.inFlightRetriesByModel.get(modelKey) || 0) + 1;
      upstreamState.inFlightRetriesByModel.set(modelKey, inFlight);
      upstreamState.maxInFlightRetriesByModel.set(
        modelKey,
        Math.max(upstreamState.maxInFlightRetriesByModel.get(modelKey) || 0, inFlight),
      );
      upstreamState.maxInFlightRetriesOverall = Math.max(
        upstreamState.maxInFlightRetriesOverall,
        [...upstreamState.inFlightRetriesByModel.values()].reduce((sum, value) => sum + value, 0),
      );
    }
    if (requestKey === "retry-after-holder" && sequence === 2) {
      if (isRetry) {
        const inFlight = Math.max(0, (upstreamState.inFlightRetriesByModel.get(modelKey) || 1) - 1);
        upstreamState.inFlightRetriesByModel.set(modelKey, inFlight);
      }
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "0.35",
      });
      res.end(JSON.stringify({ error: { message: "retry later" } }));
      return;
    }
    if (requestKey === "transient-holder" && sequence === 2) {
      if (isRetry) {
        const inFlight = Math.max(0, (upstreamState.inFlightRetriesByModel.get(modelKey) || 1) - 1);
        upstreamState.inFlightRetriesByModel.set(modelKey, inFlight);
      }
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "temporary upstream failure" } }));
      return;
    }
    if (sequence === 1) {
      const initialDelayMs = requestKey === "retry-after-holder"
        ? 10
        : requestKey === "retry-after-peer"
          ? 65
          : requestKey === "transient-holder"
            ? 10
            : requestKey === "transient-peer"
              ? 65
          : 40;
      await new Promise((resolve) => setTimeout(resolve, initialDelayMs));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `first-${requestKey}`, model: payload.test_response_model ?? payload.model, usage: { output_tokens_details: { reasoning_tokens: 516 } } }));
      return;
    }
    const retryDelayMs = requestKey === "overflow-holder"
      ? 1000
      : requestKey.startsWith("overflow-")
        ? 5
        : 160;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    if (isRetry) {
      const inFlight = Math.max(0, (upstreamState.inFlightRetriesByModel.get(modelKey) || 1) - 1);
      upstreamState.inFlightRetriesByModel.set(modelKey, inFlight);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `retry-${requestKey}-${sequence}`, model: payload.test_response_model ?? payload.model, usage: { output_tokens_details: { reasoning_tokens: 128 } } }));
  });
  upstreamServer.listen(0, "127.0.0.1");
  const upstreamPort = await waitForListening(upstreamServer);

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-retry-shared-"));
  const configPath = path.join(tempRoot, "config.json");
  const gatewayPortServer = http.createServer();
  gatewayPortServer.listen(0, "127.0.0.1");
  const gatewayPort = await waitForListening(gatewayPortServer);
  await new Promise((resolve) => gatewayPortServer.close(resolve));
  await writeFile(configPath, JSON.stringify({
    listen_host: "127.0.0.1",
    listen_port: gatewayPort,
    upstream_base_url: `http://127.0.0.1:${upstreamPort}`,
    endpoints: ["/responses"],
    intercept_rule_mode: "reasoning_tokens",
    reasoning_match_mode: "manual",
    reasoning_equals: [516],
    intercept_streaming: false,
    intercept_non_streaming: true,
    guard_retry_attempts: 2,
    transient_retry: { enabled: false, initial_delay_ms: 0, max_delay_ms: 0 },
    capacity_error_action: "pass_through",
    http_429_action: "retry_then_pass_through",
    model_unavailable_error_action: "pass_through",
    http_502_503_error_action: "pass_through",
    other_http_4xx_error_action: "pass_through",
    other_http_5xx_error_action: "pass_through",
    error_message_fallback_action: "pass_through",
  }, null, 2));

  gatewayChild = spawn(process.execPath, [path.join(repoRoot, "gateway.mjs"), "--config", configPath], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let gatewayOutput = "";
  gatewayChild.stdout.on("data", (chunk) => { gatewayOutput += chunk; });
  gatewayChild.stderr.on("data", (chunk) => { gatewayOutput += chunk; });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/health`);
      if (response.ok) break;
    } catch {}
    if (gatewayChild.exitCode !== null) {
      throw new Error(`gateway failed to start: ${gatewayOutput}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (gatewayChild.exitCode !== null) {
    throw new Error(`gateway failed to start: ${gatewayOutput}`);
  }

  const [first, second] = await Promise.all([
    requestJson(`http://127.0.0.1:${gatewayPort}/responses`, { request_id: "same-1", model: "gpt-5.6-sol", input: "one" }),
    requestJson(`http://127.0.0.1:${gatewayPort}/responses`, { request_id: "same-2", model: "gpt-5.6-sol", input: "two" }),
  ]);
  assert.equal(first.status, 200, `first request failed: ${gatewayOutput}`);
  assert.equal(second.status, 200, `second request failed: ${gatewayOutput}`);
  assert.equal(
    upstreamState.maxInFlightRetriesByModel.get("gpt-5.6-sol"),
    1,
    "same channel/model retries must not overlap",
  );

  upstreamState.inFlightRetriesByModel.clear();
  upstreamState.maxInFlightRetriesByModel.clear();
  upstreamState.maxInFlightRetriesOverall = 0;
  const [differentModelOne, differentModelTwo] = await Promise.all([
    requestJson(`http://127.0.0.1:${gatewayPort}/responses`, { request_id: "different-1", model: "gpt-5.6-sol", input: "one" }),
    requestJson(`http://127.0.0.1:${gatewayPort}/responses`, { request_id: "different-2", model: "gpt-5.6-terra", input: "two" }),
  ]);
  assert.equal(differentModelOne.status, 200);
  assert.equal(differentModelTwo.status, 200);
  assert.equal(
    upstreamState.maxInFlightRetriesOverall,
    2,
    "different models must remain eligible for parallel retries",
  );

  const retryAfterHolder = requestJson(
    `http://127.0.0.1:${gatewayPort}/responses`,
    { request_id: "retry-after-holder", model: "gpt-5.6-retry-after", input: "holder" },
  ).catch((error) => error);
  const retryAfterPeer = requestJson(
    `http://127.0.0.1:${gatewayPort}/responses`,
    { request_id: "retry-after-peer", model: "gpt-5.6-retry-after", input: "peer" },
  ).catch((error) => error);
  await waitFor(
    () => upstreamState.requests.some(
      (entry) => entry.requestKey === "retry-after-holder" && entry.sequence === 2,
    ),
    "retry-after holder did not reach its 429 retry attempt",
  );
  const holder429Attempt = upstreamState.requests.find(
    (entry) => entry.requestKey === "retry-after-holder" && entry.sequence === 2,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    upstreamState.requests.some(
      (entry) => entry.requestKey === "retry-after-peer" && entry.sequence === 2,
    ),
    false,
    "同键 peer retry 不得绕过上游 Retry-After 共享冷却",
  );
  await waitFor(
    () => upstreamState.requests.some(
      (entry) => entry.requestKey === "retry-after-peer" && entry.sequence === 2,
    ),
    "同键 peer retry 被 holder 的 Retry-After 等待阻塞",
    1500,
  );
  const peerRetryAttempt = upstreamState.requests.find(
    (entry) => entry.requestKey === "retry-after-peer" && entry.sequence === 2,
  );
  const [retryAfterHolderResponse, retryAfterPeerResponse] = await Promise.all([
    retryAfterHolder,
    retryAfterPeer,
  ]);
  assert.equal(retryAfterHolderResponse.status, 200);
  assert.equal(retryAfterPeerResponse.status, 200);
  assert.ok(
    peerRetryAttempt.at - holder429Attempt.at >= 300,
    "同键 peer retry 必须尊重另一请求的 Retry-After 共享冷却",
  );

  const transientConfigResponse = await fetch(
    `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transient_retry: {
          enabled: true,
          initial_delay_ms: 350,
          max_delay_ms: 350,
        },
      }),
    },
  );
  assert.equal(transientConfigResponse.status, 200, "瞬时重试测试配置失败");
  const transientHolder = requestJson(
    `http://127.0.0.1:${gatewayPort}/responses`,
    { request_id: "transient-holder", model: "gpt-5.6-transient", input: "holder" },
  ).catch((error) => error);
  const transientPeer = requestJson(
    `http://127.0.0.1:${gatewayPort}/responses`,
    { request_id: "transient-peer", model: "gpt-5.6-transient", input: "peer" },
  ).catch((error) => error);
  await waitFor(
    () => upstreamState.requests.some(
      (entry) => entry.requestKey === "transient-holder" && entry.sequence === 2,
    ),
    "transient holder did not reach its 503 retry attempt",
  );
  const transientStartedAt = Date.now();
  const transientHolderAttempt = upstreamState.requests.find(
    (entry) => entry.requestKey === "transient-holder" && entry.sequence === 2,
  );
  await waitFor(
    () => upstreamState.requests.some(
      (entry) => entry.requestKey === "transient-peer" && entry.sequence === 2,
    ),
    "同键 peer retry 被 holder 的瞬时退避等待阻塞",
    200,
  );
  const transientPeerAttempt = upstreamState.requests.find(
    (entry) => entry.requestKey === "transient-peer" && entry.sequence === 2,
  );
  const [transientHolderResponse, transientPeerResponse] = await Promise.all([
    transientHolder,
    transientPeer,
  ]);
  assert.equal(transientHolderResponse.status, 200);
  assert.equal(transientPeerResponse.status, 200);
  assert.ok(
    Date.now() - transientStartedAt >= 300,
    "transient_retry.initial_delay_ms 不得因共享协调被缩短",
  );
  assert.ok(
    transientPeerAttempt.at - transientHolderAttempt.at < 200,
    "同键 peer retry 必须在另一请求的瞬时退避等待期间取得 dispatch turn",
  );

  upstreamState.inFlightRetriesByModel.clear();
  upstreamState.maxInFlightRetriesByModel.clear();
  upstreamState.maxInFlightRetriesOverall = 0;
  const [unknownModelOne, unknownModelTwo] = await Promise.all([
    requestJson(`http://127.0.0.1:${gatewayPort}/responses`, { request_id: "unknown-1", input: "one" }),
    requestJson(`http://127.0.0.1:${gatewayPort}/responses`, { request_id: "unknown-2", input: "two" }),
  ]);
  assert.equal(unknownModelOne.status, 200);
  assert.equal(unknownModelTwo.status, 200);
  assert.equal(
    upstreamState.maxInFlightRetriesOverall,
    2,
    "缺少模型身份时不得把不同请求错误合并到 unknown retry 桶",
  );

  upstreamState.inFlightRetriesByModel.clear();
  upstreamState.maxInFlightRetriesByModel.clear();
  upstreamState.maxInFlightRetriesOverall = 0;
  const [inferredModelOne, inferredModelTwo] = await Promise.all([
    requestJson(`http://127.0.0.1:${gatewayPort}/responses`, {
      request_id: "inferred-model-1",
      test_response_model: "gpt-5.6-inferred",
      input: "one",
    }),
    requestJson(`http://127.0.0.1:${gatewayPort}/responses`, {
      request_id: "inferred-model-2",
      test_response_model: "gpt-5.6-inferred",
      input: "two",
    }),
  ]);
  assert.equal(inferredModelOne.status, 200);
  assert.equal(inferredModelTwo.status, 200);
  assert.equal(
    upstreamState.maxInFlightRetriesByModel.get("gpt-5.6-inferred"),
    1,
    "首发未带 model 时，已由上游确认的同模型 retry 也必须串行",
  );

  upstreamState.inFlightRetriesByModel.clear();
  upstreamState.maxInFlightRetriesByModel.clear();
  upstreamState.maxInFlightRetriesOverall = 0;
  const longModelPrefix = "long-model-".repeat(100);
  const longModelA = `${longModelPrefix}-a`;
  const longModelB = `${longModelPrefix}-b`;
  const [longModelOne, longModelTwo] = await Promise.all([
    requestJson(`http://127.0.0.1:${gatewayPort}/responses`, {
      request_id: "long-model-1",
      model: longModelA,
      input: "one",
    }),
    requestJson(`http://127.0.0.1:${gatewayPort}/responses`, {
      request_id: "long-model-2",
      model: longModelB,
      input: "two",
    }),
  ]);
  assert.equal(longModelOne.status, 200);
  assert.equal(longModelTwo.status, 200);
  assert.equal(
    upstreamState.maxInFlightRetriesOverall,
    2,
    "超长但不同的模型身份不得因协调键限长而错误合并",
  );

  const overflowHolder = requestJson(
    `http://127.0.0.1:${gatewayPort}/responses`,
    { request_id: "overflow-holder", model: "gpt-5.6-overflow", input: "holder" },
  );
  await waitFor(
    () => upstreamState.requests.some((entry) => entry.requestKey === "overflow-holder" && entry.isRetry),
    "overflow holder retry did not reach upstream",
  );
  const overflowResponses = await Promise.all(
    Array.from({ length: 17 }, (_, index) => requestJson(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        request_id: `overflow-${index}`,
        model: "gpt-5.6-overflow",
        input: `overflow-${index}`,
      },
    )),
  );
  const overflowHolderResponse = await overflowHolder;
  assert.equal(overflowHolderResponse.status, 200);
  const overloadedResponse = overflowResponses.find((response) => response.status === 503);
  assert.ok(overloadedResponse, "满队列的后台 retry 必须以 503 收口");
  assert.equal(overloadedResponse.headers.get("retry-after"), "1");
  assert.equal(
    overloadedResponse.headers.get("x-codex-retry-gateway-reason"),
    "retry-coordination-overloaded",
  );
  const overloadedBody = await overloadedResponse.json();
  assert.equal(overloadedBody?.error?.code, "retry_coordination_overloaded");

  const held = requestJson(
    `http://127.0.0.1:${gatewayPort}/responses`,
    { request_id: "disconnect-holder", model: "gpt-5.6-luna", input: "holder" },
  );
  await waitFor(
    () => upstreamState.requests.some((entry) => entry.requestKey === "disconnect-holder" && entry.isRetry),
    "holder retry did not reach upstream",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const abortController = new AbortController();
  const cancelled = requestJson(
    `http://127.0.0.1:${gatewayPort}/responses`,
    { request_id: "disconnect-waiter", model: "gpt-5.6-luna", input: "waiter" },
    { signal: abortController.signal },
  ).catch((error) => error);
  await waitFor(
    () => upstreamState.requests.some((entry) => entry.requestKey === "disconnect-waiter" && entry.sequence === 1),
    "waiter first request did not reach upstream",
  );
  abortController.abort();
  await held;
  const cancelledResult = await cancelled;
  assert.equal(cancelledResult?.name, "AbortError", "client cancellation must reach the caller");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    upstreamState.requests.filter((entry) => entry.requestKey === "disconnect-waiter").length,
    1,
    "cancelled queued retry must not be dispatched upstream",
  );
  const statusAfterCancellation = await fetch(
    `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
  ).then((response) => response.json());
  assert.equal(
    statusAfterCancellation.retry_coordination?.queued,
    0,
    "cancelled retry must leave no queued coordinator entry",
  );
  process.stdout.write("shared retry coordination regression passed\n");
} finally {
  await stopChild(gatewayChild);
  if (upstreamServer) await new Promise((resolve) => upstreamServer.close(resolve));
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}
