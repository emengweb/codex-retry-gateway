#!/usr/bin/env node

import {
  DEFAULT_STATE_ROOT,
  getGatewayStatePaths,
  parseOptions,
  startGateway,
} from "./admin-lib.mjs";

async function main() {
  const options = parseOptions(process.argv, { booleanFlags: ["restart-if-running"] });
  const stateRoot = options.stateRoot || process.env.STATE_ROOT || DEFAULT_STATE_ROOT;
  const paths = getGatewayStatePaths(stateRoot);

  const message = await startGateway({
    stateRoot,
    configPath: options.configPath || process.env.CONFIG_PATH || paths.configPath,
    logPath: options.logPath || process.env.LOG_PATH || paths.logPath,
    restartIfRunning: Boolean(options.restartIfRunning),
  });

  process.stdout.write(`${message}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
