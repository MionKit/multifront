#!/usr/bin/env node
// `#tsc` (package.json `imports`): dist/ once installed, src/ under `--conditions=source`.
import {runMfTsc} from '#tsc';

process.exitCode = await runMfTsc(process.argv.slice(2));
