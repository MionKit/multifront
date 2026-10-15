// Run in its own process by command.spec.ts, which reads its exit code and output.
import type {CommandOption, CommandSpec} from '@multifront/core';
import {runCommand} from '../src/index.ts';

const name: CommandOption = {type: 'string', short: 'n', value: '<name>', description: 'who to greet'};
const spec: CommandSpec = {
  name: 'greet',
  summary: ['Greets someone.'],
  paths: 'Paths are files or folders to greet too.',
  options: {name},
  example: 'greet --name Ada',
};

process.exitCode = await runCommand(spec, process.argv.slice(2), async (values, paths) => ({
  findings: [],
  summary: [`hello ${String(values.name)}`, ...paths].join(' '),
  data: {},
}));
