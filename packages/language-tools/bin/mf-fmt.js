#!/usr/bin/env node
// `#fmt` (package.json `imports`): dist/ once installed, src/ under `--conditions=source`.
import {runMfFmt} from '#fmt';

process.exitCode = await runMfFmt(process.argv.slice(2));
