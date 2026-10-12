import {parseSync} from 'oxc-parser';
import type {Expression, JSXAttribute, Node} from 'oxc-parser';
import {walk} from '../ast.ts';
import {CLASS_COMPONENTS, CREATE_CONTEXT, HOOK, USE_CLIENT} from './reactApis.ts';

// `name` or `x.name`: the last name an expression reads.
function lastName(node: Expression | null): string | undefined {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type !== 'MemberExpression' || node.computed) return undefined;
  return node.property.type === 'Identifier' ? node.property.name : undefined;
}

function isString(value: JSXAttribute['value']): boolean {
  if (value?.type === 'Literal') return true;
  if (value?.type !== 'JSXExpressionContainer') return false;
  const {expression} = value;
  if (expression.type === 'Literal') return typeof expression.value === 'string';
  return expression.type === 'TemplateLiteral' && expression.expressions.length === 0;
}

function isClientNode(node: Node): boolean {
  if (node.type === 'CallExpression') {
    const name = lastName(node.callee);
    return name !== undefined && (HOOK.test(name) || name === CREATE_CONTEXT);
  }
  if (node.type === 'JSXAttribute') {
    // A bare `onClick` is the value `true`, not a handler.
    return node.name.type === 'JSXIdentifier' && /^on[A-Z]/.test(node.name.name) && node.value !== null && !isString(node.value);
  }
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    const base = lastName(node.superClass);
    return base !== undefined && CLASS_COMPONENTS.includes(base);
  }
  return false;
}

/** A heuristic: a `<react>` block with a `'use client'` directive, hooks, event handlers, context or a class component. */
export function needsUseClient(code: string, filename: string): boolean {
  // A block with syntax errors fails the build elsewhere: the recovered program is enough here.
  const {program} = parseSync(filename, code, {lang: 'tsx', sourceType: 'module'});
  for (const statement of program.body) {
    if (statement.type !== 'ExpressionStatement' || !statement.directive) break;
    if (statement.directive === USE_CLIENT) return true;
  }
  let found = false;
  walk(program, (node) => {
    found ||= isClientNode(node);
  });
  return found;
}
