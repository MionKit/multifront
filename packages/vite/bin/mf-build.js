#!/usr/bin/env node
// The package's own `#cli` import: dist/ once installed, src/ in the workspace under `--conditions=source`.
import {runMfBuild} from '#cli';

process.exitCode = await runMfBuild(process.argv.slice(2));
