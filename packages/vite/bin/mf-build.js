#!/usr/bin/env node
// `#cli` (package.json `imports`): dist/ once installed, src/ under `--conditions=source`.
import {runMfBuild} from '#cli';

process.exitCode = await runMfBuild(process.argv.slice(2));
