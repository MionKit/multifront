#!/usr/bin/env node
// Self-import: dist/ once installed, src/ in the workspace under `--conditions=source`.
import {startServer} from '@multifront/language-tools/server';

startServer();
