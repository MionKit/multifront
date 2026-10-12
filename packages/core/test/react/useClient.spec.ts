import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {needsUseClient, splitBlocks} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {LIBRARY_DIR, componentPath, listComponents} from '../../../e2e/fixtures/index.ts';

const CASES: {fixture: string; client: boolean}[] = [
  {fixture: 'react/UseClient.ucf', client: true},
  {fixture: 'react/Directives.ucf', client: true},
  {fixture: 'react/use-client/ClientClass.ucf', client: true},
  {fixture: 'react/use-client/ClientContext.ucf', client: true},
  {fixture: 'react/use-client/ClientHandler.ucf', client: true},
  {fixture: 'react/use-client/ClientHook.ucf', client: true},
  {fixture: 'react/use-client/ClientMemberHook.ucf', client: true},
  {fixture: 'react/use-client/ClientPureClass.ucf', client: true},
  {fixture: 'react/use-client/ServerHandlerString.ucf', client: false},
  {fixture: 'react/use-client/ServerUse.ucf', client: false},
  {fixture: 'library/Button.ucf', client: true},
  {fixture: 'library/Counter.ucf', client: true},
  {fixture: 'library/Tooltip.ucf', client: true},
  {fixture: 'library/Badge.ucf', client: false},
  {fixture: 'library/Card.ucf', client: false},
  {fixture: 'library/Icon.ucf', client: false},
  {fixture: 'library/Panel.ucf', client: false},
  {fixture: 'library/forms/Field.ucf', client: false},
];

const LIBRARY = 'library/';

function reactBlock(fixture: string): {content: string; filename: string} {
  const filename = fixture.startsWith(LIBRARY) ? join(LIBRARY_DIR, 'src', fixture.slice(LIBRARY.length)) : componentPath(fixture);
  const block = splitBlocks(readFileSync(filename, 'utf8'), filename).targets.react;
  if (!block) throw new Error(`${fixture} has no <react> block`);
  return {content: block.content, filename};
}

describe('needsUseClient()', () => {
  it('has a row for every use-client fixture', () => {
    const rows = CASES.map((row) => row.fixture).filter((name) => name.startsWith('react/use-client/'));
    expect(rows).toEqual(listComponents('react/use-client'));
  });

  it.each(CASES)('$fixture: $client', ({fixture, client}) => {
    const {content, filename} = reactBlock(fixture);
    expect(needsUseClient(content, filename)).toBe(client);
  });
});
