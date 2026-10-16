// exit.spec.ts's font config run: fontconfig, as VS Code's main process sets it up, reads one config file.
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {readFileSync} = require('node:fs');
const {mainProcess, runChecks} = require('./harness.cjs');

const checks = [
  {
    name: "the main process's fontconfig loads one config file, scans no template dir and still finds a font",
    run() {
      const environ = readFileSync(`/proc/${mainProcess()}/environ`, 'utf8').split('\0');
      const sysroot = environ.find((entry) => entry.startsWith('FONTCONFIG_SYSROOT='))?.slice('FONTCONFIG_SYSROOT='.length);
      assert.ok(sysroot, 'the main process has no FONTCONFIG_SYSROOT');
      // FC_DEBUG=1024 logs each config file fontconfig opens.
      const output = execFileSync('fc-match', ['sans'], {
        encoding: 'utf8',
        env: {PATH: process.env.PATH, FONTCONFIG_SYSROOT: sysroot, FC_DEBUG: '1024'},
      });
      const loaded = output.split('\n').filter((line) => line.includes('Loading config file from') && !line.endsWith(' done'));
      assert.deepEqual(loaded.map((line) => line.trim()), [`Loading config file from ${sysroot}//etc/fonts/fonts.conf`], output);
      assert.doesNotMatch(output, /Scanning config/);
      assert.match(output, /^\S+: "[^"]+" "[^"]+"$/m);
    },
  },
];

module.exports = {checks, run: () => runChecks(checks)};
