#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-retry-watchdog-"));
const stateRoot = path.join(tempRoot, "state");
const fakeLauncher = path.join(tempRoot, "fake-launcher.mjs");
const runPath = path.join(root, "run.sh");

try {
  await writeFile(
    fakeLauncher,
    `import { mkdir, rm, writeFile } from "node:fs/promises";\n` +
      `const stateRoot = process.argv[process.argv.indexOf("--state-root") + 1];\n` +
      `const marker = process.env.WATCHDOG_TEST_MARKER;\n` +
      `await mkdir(stateRoot, { recursive: true });\n` +
      `await writeFile(marker, "launched\\n", { flag: "a" });\n` +
      `if (process.env.WATCHDOG_TEST_REMOVE_STATE === "1") await rm(stateRoot + "/state.json", { force: true });\n` +
      `else await writeFile(stateRoot + "/state.json", "{}\\n");\n`,
    "utf8",
  );
  const marker = path.join(tempRoot, "launches.log");
  const child = spawn("bash", [runPath, "--state-root", stateRoot], {
    cwd: root,
    env: {
      ...process.env,
      HOME: tempRoot,
      LAUNCH_UI_BIN: process.execPath,
      LAUNCH_UI_SCRIPT: fakeLauncher,
      WATCHDOG_TEST_MARKER: marker,
      WATCHDOG_TEST_REMOVE_STATE: "1",
    },
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`exit=${code}`)));
  });
  const launches = (await readFile(marker, "utf8")).trim().split("\n").filter(Boolean);
  assert.equal(launches.length, 1, "删除 state.json 后守护不应再次启动");
  console.log("PASS run watchdog state stop");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
