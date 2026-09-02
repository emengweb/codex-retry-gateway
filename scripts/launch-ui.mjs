#!/usr/bin/env node

import {
  DEFAULT_CODEX_CONFIG_PATH,
  DEFAULT_LISTEN_HOST,
  DEFAULT_LISTEN_PORT,
  DEFAULT_STATE_ROOT,
  launchUi,
  parseOptions,
} from "./admin-lib.mjs";
import { getDefaultClientConfigPaths } from "./client-configs.mjs";

function resolveClientConfigPaths(options) {
  const paths = getDefaultClientConfigPaths();
  if (options.piConfigPath) {
    paths.pi = options.piConfigPath;
  }
  if (options.opencodeConfigPath) {
    paths.opencode = options.opencodeConfigPath;
  }
  if (options.zcodeConfigPath) {
    paths.zcode = options.zcodeConfigPath;
  }
  return paths;
}

async function main() {
  const options = parseOptions(process.argv, { booleanFlags: ["no-open"] });
  const result = await launchUi({
    codexConfigPath: options.codexConfigPath || DEFAULT_CODEX_CONFIG_PATH,
    clientConfigPaths: resolveClientConfigPaths(options),
    stateRoot: options.stateRoot || DEFAULT_STATE_ROOT,
    listenHost: options.listenHost || DEFAULT_LISTEN_HOST,
    listenPort: options.listenPort ? Number.parseInt(`${options.listenPort}`, 10) : DEFAULT_LISTEN_PORT,
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
