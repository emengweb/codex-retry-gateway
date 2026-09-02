#!/usr/bin/env node

import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  installClientConfigs,
  restoreClientConfigs,
} from "./client-configs.mjs";

const upstreamBaseUrl = "https://upstream.example/v1";
const gatewayBaseUrl = "http://127.0.0.1:4610";

async function assertFileExists(filePath, message) {
  try {
    await stat(filePath);
  } catch {
    assert.fail(message);
  }
}

async function run() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-retry-client-configs-"));
  const backupDir = path.join(tempRoot, "backups");
  const piPath = path.join(tempRoot, "pi", "models.json");
  const openCodePath = path.join(tempRoot, "opencode", "opencode.jsonc");
  const zcodePath = path.join(tempRoot, "zcode", "config.json");

  const piSource = `{
  "providers": {
    "shared": {
      "baseUrl": "${upstreamBaseUrl}",
      "api": "openai-completions"
    },
    "anthropic": {
      "baseUrl": "${upstreamBaseUrl}",
      "api": "anthropic-messages"
    },
    "native-openai": {
      "baseUrl": "${upstreamBaseUrl}",
      "api": "openai-responses"
    },
    "other": {
      "baseUrl": "https://other.example/v1",
      "api": "openai-completions"
    }
  }
}
`;
  const openCodeSource = `{
  // This comment must survive a gateway install and restore.
  "providers": {
    "shared": {
      "package": "@opencode-ai/ai/providers/openai-compatible",
      "settings": { "baseURL": "${upstreamBaseUrl}" }
    },
    "anthropic": {
      "package": "@opencode-ai/ai/providers/anthropic-compatible",
      "settings": { "baseURL": "${upstreamBaseUrl}" }
    }
  },
  "provider": {
    "legacy-shared": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "${upstreamBaseUrl}" }
    }
  }
}
`;
  const zcodeSource = `{
  "provider": {
    "uuid-openai": {
      "kind": "openai-compatible",
      "options": { "baseURL": "${upstreamBaseUrl}" }
    },
    "uuid-anthropic": {
      "kind": "anthropic-compatible",
      "options": { "baseURL": "${upstreamBaseUrl}" }
    }
  }
}
`;

  try {
    await Promise.all([
      mkdir(path.dirname(piPath), { recursive: true }),
      mkdir(path.dirname(openCodePath), { recursive: true }),
      mkdir(path.dirname(zcodePath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(piPath, piSource, "utf8"),
      writeFile(openCodePath, openCodeSource, "utf8"),
      writeFile(zcodePath, zcodeSource, "utf8"),
    ]);

    const installed = await installClientConfigs({
      clientConfigPaths: {
        pi: piPath,
        opencode: openCodePath,
        zcode: zcodePath,
      },
      upstreamBaseUrl,
      gatewayBaseUrl,
      backupDir,
    });

    assert.equal(installed.records.length, 4, "应只接管三个客户端的四个兼容 provider 字段");
    assert(!installed.records.some((record) => record.providerId === "native-openai"), "原生 OpenAI Responses provider 不应被接管");
    assert(
      (await readFile(piPath, "utf8")).includes('"api": "openai-responses"'),
      "原生 OpenAI Responses provider 配置应保持不变",
    );
    assert.equal(
      (await import("./client-configs.mjs")).areEquivalentUpstreamUrls(
        `${upstreamBaseUrl}?tenant=a`,
        `${upstreamBaseUrl}?tenant=b`,
      ),
      false,
      "不同 query 的 upstream 不应被视为同一地址",
    );
    assert.deepEqual(
      installed.records.map((record) => record.client).sort(),
      ["opencode", "opencode", "pi", "zcode"],
      "接管记录应保留客户端归属",
    );
    assert(
      installed.skipped.some((entry) => entry.reason === "unsupported_api"),
      `非 OpenAI 兼容配置应被跳过: ${JSON.stringify(installed.skipped)}`,
    );
    assert(
      installed.skipped.some((entry) => entry.reason === "upstream_mismatch"),
      `不同 upstream 配置应被跳过: ${JSON.stringify(installed.skipped)}`,
    );
    for (const record of installed.records) {
      await assertFileExists(record.backupPath, `缺少 ${record.client} 的恢复快照`);
    }

    const piInstalled = await readFile(piPath, "utf8");
    const openCodeInstalled = await readFile(openCodePath, "utf8");
    const zcodeInstalled = await readFile(zcodePath, "utf8");
    assert(piInstalled.includes(`"baseUrl": "${gatewayBaseUrl}"`), "pi 兼容 provider 未改到 gateway");
    assert(
      piInstalled.includes(`"baseUrl": "${upstreamBaseUrl}",\n      "api": "anthropic-messages"`),
      "pi 非兼容 provider 不应被改写",
    );
    assert(
      piInstalled.includes('"baseUrl": "https://other.example/v1"'),
      "pi 不同 upstream provider 不应被改写",
    );
    assert(openCodeInstalled.includes("This comment must survive"), "OpenCode JSONC 注释被破坏");
    assert.equal(
      (openCodeInstalled.match(new RegExp(gatewayBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length,
      2,
      "OpenCode 当前和历史 provider 结构都应被接管",
    );
    assert(
      zcodeInstalled.includes(`"baseURL": "${gatewayBaseUrl}"`),
      "ZCode 兼容 provider 未改到 gateway",
    );

    await appendFile(openCodePath, "\n// external change after install\n", "utf8");
    await writeFile(
      zcodePath,
      zcodeInstalled.replace(gatewayBaseUrl, "https://manual.example/v1"),
      "utf8",
    );

    const restored = await restoreClientConfigs({
      records: installed.records,
      gatewayBaseUrl,
    });

    assert.equal(restored.restored.length, 3, "未冲突的字段应恢复原 upstream");
    assert.equal(restored.conflicts.length, 1, "外部改写的字段应被标记为冲突而非覆盖");
    assert.equal(restored.conflicts[0].client, "zcode", "冲突归属应正确");

    const piRestored = await readFile(piPath, "utf8");
    const openCodeRestored = await readFile(openCodePath, "utf8");
    const zcodeRestored = await readFile(zcodePath, "utf8");
    assert.equal(piRestored, piSource, "pi 恢复后应回到原始字节内容");
    assert(openCodeRestored.includes("This comment must survive"), "OpenCode 原注释在恢复后丢失");
    assert(openCodeRestored.includes("external change after install"), "OpenCode 外部改动被恢复过程覆盖");
    assert.equal(
      (openCodeRestored.match(new RegExp(upstreamBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length,
      3,
      "OpenCode 两个已接管 provider 应恢复原 upstream，未接管 Anthropic provider 应保持不变",
    );
    assert(
      zcodeRestored.includes("https://manual.example/v1"),
      "冲突的 ZCode 配置不应被恢复过程覆盖",
    );

    const mismatchedGatewayRestore = await restoreClientConfigs({
      records: installed.records,
      gatewayBaseUrl: "http://127.0.0.1:9999",
    });
    assert.equal(
      mismatchedGatewayRestore.restored.length,
      0,
      "不同 gateway 的恢复记录不得写入客户端配置",
    );
    const missingGatewayRestore = await restoreClientConfigs({
      records: installed.records.map(({ gatewayBaseUrl: _gatewayBaseUrl, ...record }) => record),
      gatewayBaseUrl,
    });
    assert.equal(missingGatewayRestore.restored.length, 0, "缺失 gateway 归属的记录不得恢复");
    assert(
      missingGatewayRestore.conflicts.every((entry) => entry.reason === "gateway_mismatch"),
      "缺失 gateway 归属的记录应统一报告 gateway_mismatch",
    );
    assert(
      mismatchedGatewayRestore.conflicts.every((entry) => entry.reason === "gateway_mismatch"),
      "不同 gateway 的记录应统一报告 gateway_mismatch",
    );

    process.stdout.write("PASS client config adapters\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
