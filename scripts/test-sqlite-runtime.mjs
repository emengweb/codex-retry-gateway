#!/usr/bin/env node

// SQLite 运行时合同测试：现代 Node 优先使用内置 node:sqlite，
// 因而历史导入不再要求开发机全局安装 sqlite3 CLI。

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { executeSqliteScript, sqliteJsonRows } from "./sqlite-runtime.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatewayEntry = path.join(repoRoot, "gateway.mjs");

async function getFreePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  server.close();
  await once(server, "close");
  assert.ok(port, "无法分配临时 gateway 端口");
  return port;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`临时 gateway 提前退出，exitCode=${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // 进程尚未监听，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`临时 gateway 健康检查超时：${url}`);
}

async function waitForImport(baseUrl, jobId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/analytics/imports/jobs/${encodeURIComponent(jobId)}`);
    assert.equal(response.status, 200, "历史导入任务查询失败");
    const payload = await response.json();
    if (payload.import_job?.status === "completed") {
      return payload.import_job;
    }
    if (payload.import_job?.status === "failed") {
      throw new Error(`历史导入任务失败：${payload.import_job.error_message || "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("历史导入任务超时");
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill();
  await Promise.race([
    once(child, "close"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

async function main() {
  const nodeSqlite = await import("node:sqlite").catch(() => null);
  if (typeof nodeSqlite?.DatabaseSync !== "function") {
    const sqliteCli = spawnSync(process.env.SQLITE3_EXE || "sqlite3", ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (sqliteCli.status !== 0) {
      process.stdout.write("SQLite runtime contract skipped: Node lacks node:sqlite and sqlite3 CLI\n");
      return;
    }
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-sqlite-runtime-"));
  let gatewayChild = null;
  try {
    const databasePath = path.join(tempRoot, "fixture.sqlite");
    const logsDatabasePath = path.join(tempRoot, "logs.sqlite");
    const sessionsRoot = path.join(tempRoot, "sessions");
    await executeSqliteScript(
      databasePath,
      "CREATE TABLE proxy_request_logs (status_code INTEGER, input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER, latency_ms INTEGER); INSERT INTO proxy_request_logs VALUES (200, 10, 4, 20, 20); INSERT INTO proxy_request_logs VALUES (502, 7, 1, 30, 30);",
      { cwd: tempRoot, sqlite3Path: path.join(tempRoot, "sqlite3-not-used") },
    );
    await executeSqliteScript(
      logsDatabasePath,
      "CREATE TABLE logs (level TEXT, target TEXT, feedback_log_body TEXT); INSERT INTO logs VALUES ('INFO', 'codex', 'reasoning_tokens=516');",
      { cwd: tempRoot, sqlite3Path: path.join(tempRoot, "sqlite3-not-used") },
    );
    const rows = await sqliteJsonRows(
      databasePath,
      "SELECT count(*) AS row_count FROM proxy_request_logs;",
    );
    assert.deepEqual(rows.map((row) => ({ ...row })), [{ row_count: 2 }]);

    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(path.join(sessionsRoot, "session.jsonl"), "{}\n", "utf8");
    const port = await getFreePort();
    const config = JSON.parse(await readFile(path.join(repoRoot, "config.example.json"), "utf8"));
    Object.assign(config, {
      listen_host: "127.0.0.1",
      listen_port: port,
      upstream_base_url: "http://127.0.0.1:9",
      active_probe: { enabled: false },
    });
    const configPath = path.join(tempRoot, "config.json");
    await writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");

    gatewayChild = spawn(process.execPath, [gatewayEntry, "--config", configPath], {
      cwd: repoRoot,
      stdio: "ignore",
      windowsHide: true,
    });
    const baseUrl = `http://127.0.0.1:${port}/__codex_retry_gateway`;
    await waitForHealth(`${baseUrl}/health`, gatewayChild);

    const runResponse = await fetch(`${baseUrl}/api/analytics/imports/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_paths: {
          cc_switch_db: databasePath,
          codex_logs_db: logsDatabasePath,
          codex_sessions_root: sessionsRoot,
        },
      }),
    });
    assert.equal(runResponse.status, 202, "历史导入应接受临时 SQLite 数据源");
    const runPayload = await runResponse.json();
    const job = await waitForImport(baseUrl, runPayload.import_job?.job_id);
    assert.equal(job.summary?.total_requests, 2, "历史导入未读取 SQLite 请求数");
    assert.equal(job.summary?.failed_requests, 1, "历史导入未读取 SQLite 失败请求数");
    assert.equal(job.summary?.codex_log_rows, 1, "历史导入未读取 SQLite 日志数");
  } finally {
    await stopChild(gatewayChild);
    await rm(tempRoot, { recursive: true, force: true });
  }

  process.stdout.write("SQLite runtime contract passed without global CLI\n");
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
