#!/usr/bin/env node

import {
  DEFAULT_CODEX_CONFIG_PATH,
  DEFAULT_LISTEN_HOST,
  DEFAULT_LISTEN_PORT,
  DEFAULT_STATE_ROOT,
  installForCurrentProvider,
  parseOptions,
} from "./admin-lib.mjs";

async function main() {
  const options = parseOptions(process.argv);
  const result = await installForCurrentProvider({
    codexConfigPath:
      options.codexConfigPath || process.env.CODEX_CONFIG_PATH || DEFAULT_CODEX_CONFIG_PATH,
    stateRoot: options.stateRoot || process.env.STATE_ROOT || DEFAULT_STATE_ROOT,
    listenHost: options.listenHost || process.env.LISTEN_HOST || DEFAULT_LISTEN_HOST,
    listenPort: Number.parseInt(
      `${options.listenPort || process.env.LISTEN_PORT || DEFAULT_LISTEN_PORT}`,
      10,
    ),
  });

  process.stdout.write("Installed Codex Retry Gateway\n");
  process.stdout.write(`provider=${result.provider}\n`);
  process.stdout.write(`upstream=${result.upstream}\n`);
  process.stdout.write(`gateway=${result.gateway}\n`);
  process.stdout.write(`config=${result.configPath}\n`);
  process.stdout.write(`backup=${result.backupPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
