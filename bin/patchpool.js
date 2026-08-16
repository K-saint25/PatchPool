#!/usr/bin/env node

import { main } from '../src/cli.js';

try {
  await main(process.argv.slice(2));
} catch (error) {
  const payload = { code: error?.code ?? 'PATCHPOOL_FAILED', message: error?.message ?? String(error) };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
}
