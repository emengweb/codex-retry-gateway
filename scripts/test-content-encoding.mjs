#!/usr/bin/env node

import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const gatewayEntry = path.join(root, "gateway.mjs");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
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
    throw new Error("无法分配空闲端口");
  }
  return port;
}

function startUpstream(port) {
  const state = { requests: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    state.requests.push({
      headers: { ...req.headers },
      body: Buffer.concat(chunks),
      path: req.url,
    });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(port, "127.0.0.1");
  return { server, state };
}

function startGateway(configPath, logPath) {
  const child = execFile(process.execPath, [gatewayEntry, "--config", configPath, "--log", logPath]);
  return child;
}

async function waitForHealth(port, child, logPath) {
  let lastError = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__codex_retry_gateway/health`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (child.exitCode !== null) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  let log = "";
  try {
    log = await readFile(logPath, "utf8");
  } catch {
    // preserve the original startup error below
  }
  throw new Error(`gateway health 未就绪: ${lastError?.message || lastError}; ${log}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill();
  await Promise.race([
    once(child, "close"),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

async function postRaw(port, body, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/responses",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

async function zstdStreamCompress(body) {
  const compressor = zlib.createZstdCompress();
  return new Promise((resolve, reject) => {
    const chunks = [];
    compressor.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    compressor.once("error", reject);
    compressor.once("end", () => resolve(Buffer.concat(chunks)));
    compressor.end(body);
  });
}

async function run() {
  assert(
    typeof zlib.zstdCompressSync === "function" &&
      typeof zlib.createZstdCompress === "function",
    "当前 Node 运行时缺少 zstd 测试能力",
  );
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-retry-gateway-content-encoding-"));
  const upstreamPort = await getFreePort();
  const gatewayPort = await getFreePort();
  const configPath = path.join(tempRoot, "config.json");
  const logPath = path.join(tempRoot, "gateway.log");
  const upstream = startUpstream(upstreamPort);
  const config = {
    listen_host: "127.0.0.1",
    listen_port: gatewayPort,
    upstream_base_url: `http://127.0.0.1:${upstreamPort}`,
    request_body_limit_bytes: 4096,
    endpoints: ["/responses"],
    intercept_rule_mode: "none",
    transient_retry: { enabled: false, initial_delay_ms: 0, max_delay_ms: 0 },
    guard_retry_attempts: 0,
    log_match: false,
  };
  await writeFile(configPath, JSON.stringify(config), "utf8");
  const gateway = startGateway(configPath, logPath);

  try {
    await waitForHealth(gatewayPort, gateway, logPath);
    const payload = {
      model: "gpt-5.5",
      stream: false,
      input: [{ role: "user", content: "encoding regression" }],
    };
    const sourceBody = Buffer.from(JSON.stringify(payload), "utf8");
    const compressedBody = await zstdStreamCompress(sourceBody);
    const response = await postRaw(gatewayPort, compressedBody, {
      "content-encoding": "zstd",
    });
    assert(response.status === 200, `zstd 请求状态异常: ${response.status}; ${response.body}`);
    assert(upstream.state.requests.length === 1, "zstd 请求应只到达上游一次");
    const received = upstream.state.requests[0];
    assert(
      received.body.equals(sourceBody),
      `上游应收到解压后的 JSON body: ${received.body.toString("hex")}`,
    );
    assert(
      !received.headers["content-encoding"],
      `规范化后不应继续携带 content-encoding: ${JSON.stringify(received.headers)}`,
    );

    const compressedCases = [
      ["gzip", zlib.gzipSync(sourceBody)],
      ["br", zlib.brotliCompressSync(sourceBody)],
      ["deflate", zlib.deflateSync(sourceBody)],
      [
        "gzip, zstd",
        zlib.zstdCompressSync(zlib.gzipSync(sourceBody)),
      ],
    ];
    for (const [contentEncoding, encodedBody] of compressedCases) {
      const encodedResponse = await postRaw(gatewayPort, encodedBody, {
        "content-encoding": contentEncoding,
      });
      assert(
        encodedResponse.status === 200,
        `${contentEncoding} 请求状态异常: ${encodedResponse.status}`,
      );
      const encodedReceived = upstream.state.requests.at(-1);
      assert(
        encodedReceived.body.equals(sourceBody),
        `${contentEncoding} 请求未按逆序解压`,
      );
      assert(
        !encodedReceived.headers["content-encoding"],
        `${contentEncoding} 规范化后仍携带 content-encoding`,
      );
    }

    const beforeMalformed = upstream.state.requests.length;
    const malformed = await postRaw(gatewayPort, Buffer.from("not-zstd"), {
      "content-encoding": "zstd",
    });
    assert(malformed.status === 400, `malformed zstd 应返回 400: ${malformed.status}`);
    assert(
      upstream.state.requests.length === beforeMalformed,
      "malformed zstd 不应转发到上游",
    );
    const malformedBody = JSON.parse(malformed.body.toString("utf8"));
    assert(
      malformedBody?.error?.code === "request_content_encoding_invalid",
      `malformed zstd 错误码异常: ${malformed.body}`,
    );

    const beforeDecodedLimit = upstream.state.requests.length;
    const oversizedSource = Buffer.from(JSON.stringify({ data: "x".repeat(5000) }), "utf8");
    const oversizedCompressed = zlib.zstdCompressSync(oversizedSource);
    const oversizedResponse = await postRaw(gatewayPort, oversizedCompressed, {
      "content-encoding": "zstd",
    });
    assert(oversizedResponse.status === 413, `解压后超限应返回 413: ${oversizedResponse.status}`);
    assert(
      upstream.state.requests.length === beforeDecodedLimit,
      "解压后超限请求不应转发到上游",
    );
    process.stdout.write("PASS content-encoding regression\n");
  } finally {
    await stopProcess(gateway);
    upstream.server.close();
    await once(upstream.server, "close");
    await rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
