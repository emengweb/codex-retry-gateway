#!/usr/bin/env node

import {
  DEFAULT_CODEX_CONFIG_PATH,
  DEFAULT_STATE_ROOT,
  parseOptions,
  restoreCodexConfig,
} from "./admin-lib.mjs";

async function main() {
  const options = parseOptions(process.argv);
  const result = await restoreCodexConfig({
    stateRoot: options.stateRoot || process.env.STATE_ROOT || DEFAULT_STATE_ROOT,
    codexConfigPath:
      options.codexConfigPath || process.env.CODEX_CONFIG_PATH || DEFAULT_CODEX_CONFIG_PATH,
  });

  process.stdout.write("Restored Codex config\n");
  process.stdout.write(`config=${result.configPath}\n`);
  process.stdout.write(`restored_from=${result.restoredFrom}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
