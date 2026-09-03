#!/usr/bin/env node

import {
  DEFAULT_CODEX_CONFIG_PATH,
  DEFAULT_LISTEN_HOST,
  DEFAULT_LISTEN_PORT,
  DEFAULT_STATE_ROOT,
  launchUi,
  parseOptions,
} from "./admin-lib.mjs";

async function main() {
  const options = parseOptions(process.argv, { booleanFlags: ["no-open"] });
  const result = await launchUi({
    codexConfigPath:
      options.codexConfigPath || process.env.CODEX_CONFIG_PATH || DEFAULT_CODEX_CONFIG_PATH,
    stateRoot: options.stateRoot || process.env.STATE_ROOT || DEFAULT_STATE_ROOT,
    listenHost: options.listenHost || process.env.LISTEN_HOST || DEFAULT_LISTEN_HOST,
    listenPort: Number.parseInt(
      `${options.listenPort || process.env.LISTEN_PORT || DEFAULT_LISTEN_PORT}`,
      10,
    ),
    noOpen: Boolean(options.noOpen),
  });

  process.stdout.write("Codex Retry Gateway UI is ready\n");
  process.stdout.write(`mode=${result.mode}\n`);
  process.stdout.write(`ui=${result.uiUrl}\n`);
  process.stdout.write(`gateway=${result.gatewayBaseUrl}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
