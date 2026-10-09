// Agent instructions are read whole into every session, so they stay short and narrow.
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {REPO_ROOT} from './env.mjs';

export const AGENT_DOC_MAX_LINES = 100;
export const AGENT_DOC_MAX_WIDTH = 120;
export const AGENT_DOC = /(^|\/)(AGENTS|CLAUDE)\.md$|(^|\/)skills\/|^\.agents\//;
const AGENT_DOC_EXEMPT = /(^|\/)node_modules\//;

// Pure over (path, text) so the rule is testable without a checkout; width counts characters, not bytes.
export const agentDocOffenders = (entries) =>
  entries
    .filter(({file}) => AGENT_DOC.test(file) && !AGENT_DOC_EXEMPT.test(file))
    .flatMap(({file, text}) => {
      const lines = text.replace(/\n$/, '').split('\n');
      const wide = lines.map((line, i) => ({at: i + 1, width: [...line].length})).filter(({width}) => width > AGENT_DOC_MAX_WIDTH);
      const problems = [];
      if (lines.length > AGENT_DOC_MAX_LINES) problems.push(`${lines.length} lines (max ${AGENT_DOC_MAX_LINES})`);
      if (wide.length > 0) problems.push(`${wide.length} line(s) over ${AGENT_DOC_MAX_WIDTH} chars, first at line ${wide[0].at}`);
      return problems.length > 0 ? [`${file}: ${problems.join(', ')}`] : [];
    });

export function agentDocs() {
  const listed = spawnSync('git', ['ls-files', '-z', '--stage', '--cached', '--others', '--exclude-standard'], {cwd: REPO_ROOT, encoding: 'utf8'});
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
  // Mode 120000 is a symlink: .claude/skills points at .agents/skills, which is already listed.
  const files = listed.stdout
    .split('\0')
    .filter((row) => row && !row.startsWith('120000 '))
    .map((row) => (row.includes('\t') ? row.slice(row.indexOf('\t') + 1) : row))
    .filter((file) => AGENT_DOC.test(file) && existsSync(join(REPO_ROOT, file)));
  if (files.length < 10) throw new Error(`the agent doc sweep listed only ${files.length} files, so its pattern stopped matching`);
  return agentDocOffenders(files.map((file) => ({file, text: readFileSync(join(REPO_ROOT, file), 'utf8')})));
}
