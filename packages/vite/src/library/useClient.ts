import MagicString from 'magic-string';
import {USE_CLIENT} from '@multifront/core';
import type {Plugin, Rolldown} from 'vite';
import type {UcfModuleMeta} from '../types.ts';

type Statement = ReturnType<Rolldown.PluginContext['parse']>['body'][number];

// Directive or not: one Rolldown kept can sit below the CSS import `libraryCss` prepends.
function isUseClient(statement: Statement): boolean {
  return (
    statement.type === 'ExpressionStatement' &&
    statement.expression.type === 'Literal' &&
    statement.expression.value === USE_CLIENT
  );
}

/** `"use client"` as the first line of each output file that needs it, never twice. */
export function libraryUseClient(): Plugin {
  return {
    name: 'multifront:library-use-client',
    // After `libraryCss`, so the directive goes above its CSS import.
    enforce: 'post',
    renderChunk(code, chunk) {
      const {body} = this.parse(code);
      const existing = body.filter(isUseClient);
      const facade = chunk.facadeModuleId;
      const meta = facade ? (this.getModuleInfo(facade)?.meta.multifront as UcfModuleMeta | undefined) : undefined;
      if (existing.length === 0 && !meta?.useClient) return null;
      if (existing.length === 1 && body[0] === existing[0]) return null;
      const magic = new MagicString(code);
      for (const {start, end} of existing) magic.remove(start, code[end] === '\n' ? end + 1 : end);
      magic.prepend(`"${USE_CLIENT}";\n`);
      return {code: magic.toString(), map: magic.generateMap({hires: 'boundary'})};
    },
  };
}
