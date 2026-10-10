// Run under `--conditions=source`: it loads TypeScript source.
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {generateGrammar} from '../../packages/vscode/src/grammar.ts';

const out = join(import.meta.dirname, '..', '..', 'packages', 'vscode', 'dist', 'syntaxes');
// So a grammar the registry no longer generates is not packed.
rmSync(out, {recursive: true, force: true});
mkdirSync(out, {recursive: true});
for (const file of generateGrammar()) writeFileSync(join(out, file.path), `${JSON.stringify(file.grammar, null, 2)}\n`);
