#!/usr/bin/env node

import { main } from '../src/cli.js';

try {
  const result = await main(process.argv.slice(2));
  if (Number.isInteger(result?.exitCode)) process.exitCode = result.exitCode;
} catch (error) {
  const payload = { code: error?.code ?? 'PATCHPOOL_FAILED', message: error?.message ?? String(error) };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
}
