#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const makefilePath = path.join(projectRoot, "Makefile");

assert(fs.existsSync(makefilePath), "Makefile must define lifecycle targets");
const makefile = await readFile(makefilePath, "utf8");
assert.match(makefile, /^\.PHONY:.*\bstop\b.*\brestore\b/m, "Makefile must declare stop and restore targets");
assert.match(makefile, /^stop:\s*\n(?:\t.*\n)+/m, "Makefile must invoke the stop script");
assert.match(makefile, /^restore:\s*\n(?:\t.*\n)+/m, "Makefile must invoke the restore script");
assert.match(makefile, /scripts\/stop-gateway\.mjs/, "stop target must call the Node lifecycle entry");
assert.match(makefile, /scripts\/restore-codex-config\.mjs/, "restore target must call the Node lifecycle entry");

const makeCommandCandidates = process.platform === "win32"
  ? ["make", "mingw32-make"]
  : ["make"];
const makeCommand = makeCommandCandidates.find((candidate) => {
  const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
});

if (makeCommand) {
  for (const target of ["stop", "restore"]) {
    const dryRun = spawnSync(
      makeCommand,
      ["--no-print-directory", "-n", target],
      { cwd: projectRoot, encoding: "utf8" },
    );
    assert.equal(dryRun.status, 0, `${target} dry run failed: ${dryRun.stderr}`);
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-retry-make-"));
  const stateRoot = path.join(tempRoot, "state root");
  const piConfigPath = path.join(tempRoot, "pi config", "models.json");
  const codexConfigPath = path.join(tempRoot, "codex config", "config.toml");
  const gatewayBaseUrl = "http://127.0.0.1:46101";
  const upstreamBaseUrl = "https://upstream.example/v1";

  try {
    await mkdir(path.dirname(piConfigPath), { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      piConfigPath,
      `${JSON.stringify({
        providers: {
          shared: {
            baseUrl: gatewayBaseUrl,
            api: "openai-completions",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(stateRoot, "state.json"),
      `${JSON.stringify({
        gateway_base_url: gatewayBaseUrl,
        client_configs: {
          records: [{
            client: "pi",
            filePath: piConfigPath,
            providerId: "shared",
            fieldPath: ["providers", "shared", "baseUrl"],
            originalBaseUrl: upstreamBaseUrl,
            gatewayBaseUrl,
          }],
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const stop = spawnSync(
      makeCommand,
      ["--no-print-directory", "stop", `STATE_ROOT=${stateRoot}`],
      { cwd: projectRoot, encoding: "utf8" },
    );
    assert.equal(stop.status, 0, `make stop failed: ${stop.stderr}`);
    assert.match(
      `${stop.stdout}\n${stop.stderr}`,
      /No running gateway PID file was found\./,
      "make stop must pass STATE_ROOT to the lifecycle script",
    );
    assert.equal(
      fs.existsSync(path.join(stateRoot, "state.json")),
      true,
      "make stop must not clear install state or restore client config",
    );

    const restore = spawnSync(
      makeCommand,
      [
        "--no-print-directory",
        "restore",
        `STATE_ROOT=${stateRoot}`,
        `CODEX_CONFIG_PATH=${codexConfigPath}`,
      ],
      { cwd: projectRoot, encoding: "utf8" },
    );
    assert.equal(restore.status, 0, `make restore failed: ${restore.stderr}`);
    assert.match(
      `${restore.stdout}\n${restore.stderr}`,
      /Restored Codex config/,
      "make restore must invoke the restore lifecycle entry",
    );
    const restoredPi = JSON.parse(await readFile(piConfigPath, "utf8"));
    assert.equal(
      restoredPi.providers.shared.baseUrl,
      upstreamBaseUrl,
      "make restore must restore the managed client field",
    );
    assert.equal(
      fs.existsSync(path.join(stateRoot, "state.json")),
      false,
      "make restore must clear install state",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

process.stdout.write("PASS make lifecycle targets\n");
