#!/usr/bin/env node

// Makefile 跨平台统一入口的契约测试。
// 静态断言保证所有目标存在且 recipe 指向 scripts/ 下的跨平台 mjs 核心；
// 在能找到 GNU Make 的环境里，再用 dry-run（make -n）验证真实展开与 ARGS 透传。

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const makefilePath = path.join(repoRoot, "Makefile");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// 目标 -> 该目标 recipe 必须引用的脚本路径片段
const REQUIRED_TARGETS = new Map([
  ["launch", "./scripts/launch-ui.mjs"],
  ["install", "./scripts/install-for-current-provider.mjs"],
  ["start", "./scripts/start-gateway.mjs"],
  ["restart", "./scripts/start-gateway.mjs"],
  ["stop", "./scripts/stop-gateway.mjs"],
  ["restore", "./scripts/restore-codex-config.mjs"],
  ["help", "./scripts/help.mjs"],
]);

function findMakeBinary() {
  for (const candidate of ["make", "mingw32-make", "gmake"]) {
    const probe = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (probe.status === 0 && /GNU Make/i.test(`${probe.stdout}`)) {
      return candidate;
    }
  }
  return null;
}

function dryRun(makeBinary, args) {
  const result = spawnSync(makeBinary, ["-C", repoRoot, "-n", ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert(result.status === 0, `make -n ${args.join(" ")} 执行失败：${result.stderr || result.stdout}`);
  return `${result.stdout}\n${result.stderr}`;
}

function runMake(makeBinary, args) {
  return spawnSync(makeBinary, ["-C", repoRoot, "--no-print-directory", ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const content = await readFile(makefilePath, "utf8");
  const adminLibContent = await readFile(path.join(repoRoot, "scripts", "admin-lib.mjs"), "utf8");
  const entryScripts = {
    "launch-ui.mjs": ["CODEX_CONFIG_PATH", "STATE_ROOT", "LISTEN_HOST", "LISTEN_PORT"],
    "install-for-current-provider.mjs": ["CODEX_CONFIG_PATH", "STATE_ROOT", "LISTEN_HOST", "LISTEN_PORT"],
    "start-gateway.mjs": ["STATE_ROOT", "CONFIG_PATH", "LOG_PATH"],
    "stop-gateway.mjs": ["STATE_ROOT"],
    "restore-codex-config.mjs": ["STATE_ROOT", "CODEX_CONFIG_PATH"],
  };

  assert(
    !adminLibContent.includes("import.meta.dirname"),
    "Node.js 18 不支持 admin-lib.mjs 使用 import.meta.dirname",
  );

  for (const [scriptName, variables] of Object.entries(entryScripts)) {
    const entryContent = await readFile(path.join(repoRoot, "scripts", scriptName), "utf8");
    for (const variable of variables) {
      assert(
        entryContent.includes(`process.env.${variable}`),
        `${scriptName} 未读取 Make 导出的 ${variable}`,
      );
    }
  }

  assert(content.includes("export CODEX_CONFIG_PATH STATE_ROOT LISTEN_HOST LISTEN_PORT CONFIG_PATH LOG_PATH"), "Makefile 未导出路径变量");
  assert(content.includes('"$(NODE)"'), "Makefile 未引用 NODE，可执行文件路径含空格时会被拆分");
  assert(
    content.includes('"$(NODE)" --check gateway.mjs'),
    "make check 未检查 gateway.mjs 语法",
  );
  assert(content.includes('"$(NODE)" --check scripts/test-makefile.mjs'), "make check 未检查 Makefile 测试语法");
  assert(content.includes('"$(NODE)" ./scripts/test-sqlite-runtime.mjs'), "make check 未运行 SQLite runtime 合同测试");

  // 1. 所有必需目标都要声明为 .PHONY，避免同名文件干扰
  const phonyMatch = content.match(/\.PHONY:\s*([^\n]+)/);
  assert(phonyMatch !== null, "Makefile 缺少 .PHONY 声明");
  const phonyTargets = new Set(phonyMatch[1].trim().split(/\s+/));
  for (const target of REQUIRED_TARGETS.keys()) {
    assert(phonyTargets.has(target), `.PHONY 缺少目标 ${target}`);
  }

  // 2. 每个运维目标的 recipe 必须直接调用对应跨平台 mjs 核心并透传 $(ARGS)
  const recipeBlocks = content.split(/^([a-zA-Z_-]+):/m);
  const targetRecipes = new Map();
  for (let index = 1; index + 1 < recipeBlocks.length; index += 2) {
    targetRecipes.set(recipeBlocks[index].trim(), recipeBlocks[index + 1]);
  }
  for (const [target, scriptPath] of REQUIRED_TARGETS) {
    const recipe = targetRecipes.get(target);
    assert(recipe !== undefined, `Makefile 缺少目标 ${target}`);
    if (scriptPath === null) {
      continue;
    }
    assert(recipe.includes(scriptPath), `目标 ${target} 未调用 ${scriptPath}`);
    if (target === "restart") {
      assert(
        recipe.includes("--restart-if-running"),
        "目标 restart 必须以 --restart-if-running 调用 start-gateway",
      );
    }
    if (target !== "help") {
      assert(recipe.includes("$(ARGS)"), `目标 ${target} 必须透传 \$(ARGS)`);
    }
  }

  // 3. 能找到 GNU Make 时做 dry-run 实测
  const makeBinary = findMakeBinary();
  if (makeBinary === null) {
    process.stdout.write("未找到 GNU Make，跳过 dry-run 断言（静态契约已通过）\n");
    return;
  }
  process.stdout.write(`使用 ${makeBinary} 进行 dry-run 验证\n`);

  const launchPlan = dryRun(makeBinary, ["launch"]);
  assert(launchPlan.includes("launch-ui.mjs"), "make -n launch 未展开 launch-ui.mjs");
  assert(!launchPlan.includes("--no-open"), "make -n launch 不应默认携带 --no-open");

  const launchNoOpenPlan = dryRun(makeBinary, ["launch", "ARGS=--no-open"]);
  assert(
    launchNoOpenPlan.includes("--no-open"),
    "ARGS=--no-open 未透传到 launch 目标",
  );

  const pathWithSpacesPlan = dryRun(makeBinary, [
    "launch",
    "STATE_ROOT=D:/codex retry gateway",
    "CODEX_CONFIG_PATH=D:/codex configs/config.toml",
  ]);
  assert(
    !pathWithSpacesPlan.includes("--state-root"),
    "STATE_ROOT 不应被拼接进命令行，避免 shell 重新拆分路径",
  );
  assert(
    !pathWithSpacesPlan.includes("--codex-config-path"),
    "CODEX_CONFIG_PATH 不应被拼接进命令行，避免 shell 重新拆分路径",
  );

  const nodeWithSpacesPlan = dryRun(makeBinary, [
    "help",
    "NODE=C:/Program Files/nodejs/node.exe",
  ]);
  assert(
    nodeWithSpacesPlan.includes('"C:/Program Files/nodejs/node.exe"'),
    "带空格的 NODE 路径未被安全引用",
  );

  const nodeWithSpacesRun = runMake(makeBinary, ["-s", "help", `NODE=${process.execPath}`]);
  assert(
    nodeWithSpacesRun.status === 0 && nodeWithSpacesRun.stdout.includes("Usage:"),
    `带空格的 NODE 路径实际执行失败：${nodeWithSpacesRun.stderr || nodeWithSpacesRun.stdout}`,
  );

  const envProbeRoot = await mkdtemp(path.join(os.tmpdir(), "codex-make-env-"));
  const stateRootWithSpaces = path.join(envProbeRoot, "state with spaces");
  const missingConfigWithSpaces = path.join(envProbeRoot, "config with spaces.toml");
  try {
    const envProbe = runMake(makeBinary, [
      "-s",
      "launch",
      `STATE_ROOT=${stateRootWithSpaces}`,
      `CODEX_CONFIG_PATH=${missingConfigWithSpaces}`,
      "ARGS=--no-open",
    ]);
    const envProbeOutput = `${envProbe.stdout}\n${envProbe.stderr}`;
    assert(envProbe.status !== 0, "缺失 Codex 配置的环境变量探针意外成功");
    assert(
      envProbeOutput.includes(missingConfigWithSpaces),
      "CODEX_CONFIG_PATH 含空格时没有完整到达 Node 入口",
    );
    assert(
      await pathExists(stateRootWithSpaces),
      "STATE_ROOT 含空格时没有完整到达 Node 入口",
    );
  } finally {
    await rm(envProbeRoot, { recursive: true, force: true });
  }

  const restartPlan = dryRun(makeBinary, ["restart"]);
  assert(restartPlan.includes("--restart-if-running"), "make -n restart 未携带 --restart-if-running");

  const stopPlan = dryRun(makeBinary, ["stop"]);
  assert(stopPlan.includes("stop-gateway.mjs"), "make -n stop 未展开 stop-gateway.mjs");

  const restorePlan = dryRun(makeBinary, ["restore"]);
  assert(restorePlan.includes("restore-codex-config.mjs"), "make -n restore 未展开 restore-codex-config.mjs");

  process.stdout.write("Makefile 契约测试全部通过\n");
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
