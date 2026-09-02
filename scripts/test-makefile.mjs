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
const makefile = (await readFile(makefilePath, "utf8")).replace(/\r\n/g, "\n");
assert.match(makefile, /^\.PHONY:.*\bhelp\b.*\bstop\b.*\bstop-only\b.*\brestore\b/m, "Makefile must declare lifecycle targets");
assert.match(makefile, /^stop:\s*\n(?:\t.*\n)+/m, "stop target must invoke restore");
assert.match(makefile, /^stop-only:\s*\n(?:\t.*\n)+/m, "stop-only target must invoke stop script");
assert.match(makefile, /^restore:\s*\n(?:\t.*\n)+/m, "restore target must invoke restore script");
assert.match(makefile, /stop:\s*\n\t.*scripts\/restore-codex-config\.mjs/m, "stop target must restore configuration");
assert.match(makefile, /stop-only:\s*\n\t.*scripts\/stop-gateway\.mjs/m, "stop-only target must only stop the gateway");
assert.match(makefile, /restore:\s*\n\t.*scripts\/restore-codex-config\.mjs/m, "restore target must call the restore lifecycle entry");

const makeCommandCandidates = process.platform === "win32"
  ? ["make", "mingw32-make"]
  : ["make"];
const makeCommand = makeCommandCandidates.find((candidate) => {
  const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
});

if (makeCommand) {
  for (const target of ["stop", "stop-only", "restore"]) {
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

    const help = spawnSync(
      makeCommand,
      ["--no-print-directory"],
      { cwd: projectRoot, encoding: "utf8" },
    );
    assert.equal(help.status, 0, `make help failed: ${help.stderr}`);
    for (const command of ["make stop", "make stop-only", "make restore"]) {
      assert.match(help.stdout, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `make help must document ${command}`);
    }

    const stopOnly = spawnSync(
      makeCommand,
      ["--no-print-directory", "stop-only", `STATE_ROOT=${stateRoot}`],
      { cwd: projectRoot, encoding: "utf8" },
    );
    assert.equal(stopOnly.status, 0, `make stop-only failed: ${stopOnly.stderr}`);
    assert.match(
      `${stopOnly.stdout}\n${stopOnly.stderr}`,
      /No running gateway PID file was found\./,
      "make stop-only must pass STATE_ROOT to the lifecycle script",
    );
    assert.equal(
      fs.existsSync(path.join(stateRoot, "state.json")),
      true,
      "make stop-only must not clear install state or restore client config",
    );

    const stop = spawnSync(
      makeCommand,
      ["--no-print-directory", "stop", `STATE_ROOT=${stateRoot}`],
      { cwd: projectRoot, encoding: "utf8" },
    );
    assert.equal(stop.status, 0, `make stop failed: ${stop.stderr}`);
    assert.match(
      `${stop.stdout}\n${stop.stderr}`,
      /Restored Codex config/,
      "make stop must restore configuration and close the gateway",
    );
    const restoredPi = JSON.parse(await readFile(piConfigPath, "utf8"));
    assert.equal(
      restoredPi.providers.shared.baseUrl,
      upstreamBaseUrl,
      "make stop must restore the managed client field",
    );
    assert.equal(
      fs.existsSync(path.join(stateRoot, "state.json")),
      false,
      "make stop must clear install state after restore",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

process.stdout.write("PASS make lifecycle targets\n");
