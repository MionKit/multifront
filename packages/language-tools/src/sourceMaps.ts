// A v3 source map has no lengths: a segment only says where a generated position came from.
import {decode} from '@jridgewell/sourcemap-codec';
import type {SourceMap} from '@multifront/core';
import type {CodeInformation, CodeMapping} from '@volar/language-core';

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  return starts;
}

// Only diagnostics: a span in generated code maps to the point its run came from (svelte2tsx's `"label"` → `label`).
const POINT_FEATURES: CodeInformation = {verification: true};

const isPoint = (mapping: CodeMapping): boolean => mapping.lengths[0] === 0;

/** Each segment runs to the next one: 1:1 with `data` where source and generated text match, the rest a point. */
export function sourceMapMappings(
  map: Pick<SourceMap, 'mappings'>,
  source: string,
  generated: string,
  data: CodeInformation
): CodeMapping[] {
  const sourceLines = lineStarts(source);
  const generatedLines = lineStarts(generated);
  const mappings: CodeMapping[] = [];
  let last: CodeMapping | undefined;
  for (const [line, segments] of decode(map.mappings).entries()) {
    const lineStart = generatedLines[line];
    if (lineStart === undefined) break;
    const lineEnd = generatedLines[line + 1] ?? generated.length;
    for (const [index, segment] of segments.entries()) {
      const sourceLine = segment.length >= 4 ? sourceLines[segment[2]!] : undefined;
      if (sourceLine === undefined) continue;
      const from = sourceLine + segment[3]!;
      const at = lineStart + segment[0];
      const next = segments[index + 1];
      const runEnd = next ? lineStart + next[0] : lineEnd;
      let length = 0;
      while (at + length < runEnd && source[from + length] !== undefined && source[from + length] === generated[at + length]) {
        length++;
      }
      if (length > 0) {
        const lastEnd = last && !isPoint(last) ? last.generatedOffsets[0]! + last.lengths[0]! : -1;
        if (last && lastEnd === at && last.sourceOffsets[0]! + last.lengths[0]! === from) last.lengths[0]! += length;
        else {
          last = {sourceOffsets: [from], generatedOffsets: [at], lengths: [length], data};
          mappings.push(last);
        }
      }
      if (at + length >= runEnd) continue;
      last = {
        sourceOffsets: [from + length],
        generatedOffsets: [at + length],
        lengths: [0],
        generatedLengths: [runEnd - at - length],
        data: POINT_FEATURES,
      };
      mappings.push(last);
    }
  }
  return mappings;
}

/** The 1:1 mappings only, with no diagnostics-only points. */
export function exactMappings(mappings: CodeMapping[]): CodeMapping[] {
  return mappings.filter((mapping) => !isPoint(mapping));
}

/** `outer` (generated ↔ middle) through `inner` (middle ↔ source); a rename in `inner` comes through whole or not at all. */
export function composeMappings(outer: CodeMapping[], inner: CodeMapping[]): CodeMapping[] {
  const composed: CodeMapping[] = [];
  for (const {generatedOffsets, sourceOffsets, lengths, generatedLengths, data} of outer) {
    const [generated, middle, length] = [generatedOffsets[0]!, sourceOffsets[0]!, lengths[0]!];
    if (length === 0) {
      const point = intoSource(inner, middle);
      if (point !== undefined) {
        composed.push({sourceOffsets: [point], generatedOffsets: [generated], lengths: [0], generatedLengths, data});
      }
      continue;
    }
    for (const mapping of inner) {
      const [innerMiddle, source, innerLength] = [mapping.generatedOffsets[0]!, mapping.sourceOffsets[0]!, mapping.lengths[0]!];
      const renamed = mapping.generatedLengths?.[0];
      if (renamed !== undefined) {
        if (innerMiddle >= middle && innerMiddle + renamed <= middle + length) {
          composed.push({
            sourceOffsets: [source],
            generatedOffsets: [generated + innerMiddle - middle],
            lengths: [innerLength],
            generatedLengths: [renamed],
            data,
          });
        }
        continue;
      }
      const start = Math.max(middle, innerMiddle);
      const end = Math.min(middle + length, innerMiddle + innerLength);
      if (start >= end) continue;
      composed.push({
        sourceOffsets: [source + start - innerMiddle],
        generatedOffsets: [generated + start - middle],
        lengths: [end - start],
        data,
      });
    }
  }
  return composed;
}

// A middle offset in source terms; inside a rename, its start.
function intoSource(inner: CodeMapping[], middle: number): number | undefined {
  for (const {generatedOffsets, sourceOffsets, lengths, generatedLengths} of inner) {
    const start = generatedOffsets[0]!;
    if (middle < start || middle > start + (generatedLengths?.[0] ?? lengths[0]!)) continue;
    return sourceOffsets[0]! + (generatedLengths ? 0 : middle - start);
  }
  return undefined;
}
