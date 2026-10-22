import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {needsUseClient, splitBlocks} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {LIBRARY_DIR, componentPath, listComponents} from '../../../e2e/fixtures/index.ts';

const CASES: {fixture: string; client: boolean}[] = [
  {fixture: 'react/UseClient.front', client: true},
  {fixture: 'react/Directives.front', client: true},
  {fixture: 'react/use-client/ClientClass.front', client: true},
  {fixture: 'react/use-client/ClientContext.front', client: true},
  {fixture: 'react/use-client/ClientHandler.front', client: true},
  {fixture: 'react/use-client/ClientHook.front', client: true},
  {fixture: 'react/use-client/ClientMemberHook.front', client: true},
  {fixture: 'react/use-client/ClientPureClass.front', client: true},
  {fixture: 'react/use-client/ServerHandlerString.front', client: false},
  {fixture: 'react/use-client/ServerUse.front', client: false},
  {fixture: 'library/Button.front', client: true},
  {fixture: 'library/Counter.front', client: true},
  {fixture: 'library/Tooltip.front', client: true},
  {fixture: 'library/Badge.front', client: false},
  {fixture: 'library/Card.front', client: false},
  {fixture: 'library/Icon.front', client: false},
  {fixture: 'library/Panel.front', client: false},
  {fixture: 'library/forms/Field.front', client: false},
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
