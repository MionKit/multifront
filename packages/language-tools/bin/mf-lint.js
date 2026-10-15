#!/usr/bin/env node
// `#lint` (package.json `imports`): dist/ once installed, src/ under `--conditions=source`.
import {runMfLint} from '#lint';

process.exitCode = await runMfLint(process.argv.slice(2));
