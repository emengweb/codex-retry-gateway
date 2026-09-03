#!/usr/bin/env node

import {
  DEFAULT_STATE_ROOT,
  parseOptions,
  stopGateway,
} from "./admin-lib.mjs";

async function main() {
  const options = parseOptions(process.argv, { booleanFlags: ["quiet"] });
  const message = await stopGateway({
    stateRoot: options.stateRoot || process.env.STATE_ROOT || DEFAULT_STATE_ROOT,
    quiet: Boolean(options.quiet),
  });

  if (message) {
    process.stdout.write(`${message}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
