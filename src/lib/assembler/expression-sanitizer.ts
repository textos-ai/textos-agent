// Expression sanitizer for Calculator preview + calculation expressions.
// AST-based — uses acorn to parse the expression as a JavaScript expression
// (not a full program), then walks the tree and rejects every node that
// isn't on the whitelist.
//
// Whitelist (exact):
//   - Identifier referring to an input id (caller passes the allowed set)
//   - MemberExpression on the global `Math` object where the property name
//     is one of {min, max, round, floor, ceil, abs, sqrt, pow}
//   - CallExpression whose callee is one of the Math.* members above
//   - Literal of type 'number' (positive or negative, int or float)
//   - UnaryExpression with operator '+' or '-' applied to a numeric literal
//   - BinaryExpression with operator '+' '-' '*' '/' or '%'
//   - LogicalExpression with operator '&&' '||' (used in ternaries)
//   - ConditionalExpression (the ternary)
//   - ParenthesizedExpression — acorn doesn't have this; parens collapse
//     into their wrapped expression naturally.
//
// Anything else throws ExpressionSanitizerError. The sanitizer is the
// last line of defense before tx-bind.js runs `new Function(expression)`
// in the visitor's browser.

import { parseExpressionAt } from 'acorn';
import { ExpressionSanitizerError } from './types';

const ALLOWED_MATH_METHODS = new Set([
  'min', 'max', 'round', 'floor', 'ceil', 'abs', 'sqrt', 'pow',
]);

const ALLOWED_BINARY = new Set(['+', '-', '*', '/', '%']);
const ALLOWED_LOGICAL = new Set(['&&', '||']);
const ALLOWED_UNARY = new Set(['+', '-']);
// Comparison ops needed for ternary conditionals like `x > 0 ? a : b`.
const ALLOWED_COMPARISON = new Set(['<', '<=', '>', '>=', '==', '===', '!=', '!==']);

/** Walk an AST node and assert every descendant is on the whitelist. */
function walk(node: any, allowedIds: Set<string>, expression: string): void {
  if (!node || typeof node !== 'object') {
    throw new ExpressionSanitizerError(expression, 'unexpected null AST node');
  }

  switch (node.type) {
    case 'Literal': {
      if (typeof node.value !== 'number') {
        throw new ExpressionSanitizerError(
          expression,
          `non-numeric literal: ${typeof node.value} (${JSON.stringify(node.value)})`,
        );
      }
      return;
    }

    case 'Identifier': {
      const name = node.name as string;
      if (name === 'Math') return; // only valid in a MemberExpression context, validated there
      if (allowedIds.has(name)) return;
      throw new ExpressionSanitizerError(
        expression,
        `unknown identifier "${name}" (allowed: ${[...allowedIds].join(', ')} or Math.*)`,
      );
    }

    case 'UnaryExpression': {
      if (!ALLOWED_UNARY.has(node.operator)) {
        throw new ExpressionSanitizerError(expression, `unary operator "${node.operator}" not allowed`);
      }
      walk(node.argument, allowedIds, expression);
      return;
    }

    case 'BinaryExpression': {
      if (
        !ALLOWED_BINARY.has(node.operator) &&
        !ALLOWED_COMPARISON.has(node.operator)
      ) {
        throw new ExpressionSanitizerError(expression, `binary operator "${node.operator}" not allowed`);
      }
      walk(node.left, allowedIds, expression);
      walk(node.right, allowedIds, expression);
      return;
    }

    case 'LogicalExpression': {
      if (!ALLOWED_LOGICAL.has(node.operator)) {
        throw new ExpressionSanitizerError(expression, `logical operator "${node.operator}" not allowed`);
      }
      walk(node.left, allowedIds, expression);
      walk(node.right, allowedIds, expression);
      return;
    }

    case 'ConditionalExpression': {
      walk(node.test, allowedIds, expression);
      walk(node.consequent, allowedIds, expression);
      walk(node.alternate, allowedIds, expression);
      return;
    }

    case 'MemberExpression': {
      // Only Math.<allowedMethod> permitted. Reject computed access,
      // anything chained (Math.foo.bar), and any other object.
      if (node.computed) {
        throw new ExpressionSanitizerError(expression, 'computed member access (e.g., obj[k]) not allowed');
      }
      if (node.object.type !== 'Identifier' || node.object.name !== 'Math') {
        throw new ExpressionSanitizerError(expression, `member access on non-Math object "${node.object.name ?? node.object.type}"`);
      }
      if (node.property.type !== 'Identifier' || !ALLOWED_MATH_METHODS.has(node.property.name)) {
        throw new ExpressionSanitizerError(
          expression,
          `Math.${node.property.name ?? '?'} not allowed (allowed: Math.${[...ALLOWED_MATH_METHODS].join('/')})`,
        );
      }
      return;
    }

    case 'CallExpression': {
      // Callee must be a whitelisted Math member.
      if (node.callee.type !== 'MemberExpression') {
        throw new ExpressionSanitizerError(expression, `call to non-Math function: ${node.callee.type}`);
      }
      walk(node.callee, allowedIds, expression); // re-uses MemberExpression check
      for (const arg of node.arguments) {
        if (arg.type === 'SpreadElement') {
          throw new ExpressionSanitizerError(expression, 'spread arguments not allowed');
        }
        walk(arg, allowedIds, expression);
      }
      return;
    }

    // Explicit reject list (more informative than a generic fallthrough).
    case 'AssignmentExpression':
      throw new ExpressionSanitizerError(expression, 'assignment expressions not allowed');
    case 'UpdateExpression':
      throw new ExpressionSanitizerError(expression, '++/-- not allowed');
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      throw new ExpressionSanitizerError(expression, 'function expressions not allowed');
    case 'TemplateLiteral':
      throw new ExpressionSanitizerError(expression, 'template literals not allowed');
    case 'TaggedTemplateExpression':
      throw new ExpressionSanitizerError(expression, 'tagged template literals not allowed');
    case 'NewExpression':
      throw new ExpressionSanitizerError(expression, '`new` expressions not allowed');
    case 'SequenceExpression':
      throw new ExpressionSanitizerError(expression, 'sequence (comma) expressions not allowed');
    case 'ArrayExpression':
      throw new ExpressionSanitizerError(expression, 'array literals not allowed');
    case 'ObjectExpression':
      throw new ExpressionSanitizerError(expression, 'object literals not allowed');
    case 'SpreadElement':
      throw new ExpressionSanitizerError(expression, 'spread syntax not allowed');
    case 'AwaitExpression':
    case 'YieldExpression':
      throw new ExpressionSanitizerError(expression, `${node.type} not allowed`);
    case 'ThisExpression':
      throw new ExpressionSanitizerError(expression, '`this` not allowed');

    default:
      throw new ExpressionSanitizerError(expression, `disallowed node type: ${node.type}`);
  }
}

/**
 * Parse and validate a single calculator expression. Throws
 * ExpressionSanitizerError on any violation. Returns the original
 * expression string unchanged on success (callers store the original
 * source — the sanitizer doesn't rewrite).
 *
 * @param expression  The expression source from the LLM payload.
 * @param allowedIds  Set of input ids the expression may reference.
 */
export function sanitizeExpression(
  expression: string,
  allowedIds: ReadonlySet<string>,
): string {
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    throw new ExpressionSanitizerError(expression, 'empty or non-string expression');
  }
  // Forbid comments + semicolons before we hand to acorn. Both are
  // syntactically valid in a JS program but signal multi-statement intent
  // we don't want to entertain.
  if (expression.includes('//') || expression.includes('/*') || expression.includes(';')) {
    throw new ExpressionSanitizerError(expression, 'comments or semicolons not allowed');
  }
  let ast: any;
  try {
    ast = parseExpressionAt(expression, 0, {
      ecmaVersion: 2020,
      sourceType: 'script',
    });
  } catch (e) {
    throw new ExpressionSanitizerError(
      expression,
      `parse error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // After parsing one expression, ensure no trailing text remains.
  if (typeof ast.end === 'number' && ast.end < expression.length) {
    const trailing = expression.slice(ast.end).trim();
    if (trailing.length > 0) {
      throw new ExpressionSanitizerError(expression, `trailing input after expression: "${trailing.slice(0, 40)}"`);
    }
  }
  walk(ast, new Set(allowedIds), expression);
  return expression;
}
