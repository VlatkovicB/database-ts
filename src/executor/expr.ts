// Expression evaluation — mirrors internal/executor/expr.go
// This is a stub that volcano.ts imports. Full implementation lives here.

import {
  Expression,
  IdentExpr,
  LiteralExpr,
  BinaryExpr,
  AggFuncExpr,
  AggSelectExpr,
  SelectExpr,
} from '../parser/ast';
import { Row, compareVals } from '../storage/storage';

// ---------------------------------------------------------------------------
// EvalCtx — carries subquery execution context
// ---------------------------------------------------------------------------

export interface EvalCtx {
  // Forward-declared; full Executor type is in executor.ts to avoid circular deps
  exec: SubqueryExecutor | null;
  outer: Row | null;
  ctes: Map<string, CteEntry> | null;
}

/** Minimal interface for materializing subqueries — avoids circular import. */
export interface SubqueryExecutor {
  materializeSubquery(q: import('../parser/ast').SelectStatement, ctx: EvalCtx): Row[];
}

export interface CteEntry {
  rows: Row[];
  cols: string[];
  keys: string[];
  derived: boolean;
}

// ---------------------------------------------------------------------------
// aggSpec
// ---------------------------------------------------------------------------

export interface AggSpec {
  fn: string;
  arg: string;
}

// ---------------------------------------------------------------------------
// evalExpr
// ---------------------------------------------------------------------------

/**
 * Evaluates an expression against a row and returns the result value.
 * ctx is null for simple (non-subquery) expressions.
 */
export function evalExpr(expr: Expression, row: Row, ctx: EvalCtx | null): unknown {
  switch (expr.kind) {
    case 'ident': {
      const e = expr as IdentExpr;
      if (e.table !== '') {
        const key = e.table + '.' + e.name;
        if (row.has(key)) return row.get(key);
        if (ctx?.outer?.has(key)) return ctx.outer.get(key);
        throw new Error(`column "${e.table}"."${e.name}" not found`);
      }
      // Unqualified: try bare key first (aggregate rows), then suffix search
      if (row.has(e.name)) return row.get(e.name);
      const suffix = '.' + e.name;
      for (const [k, v] of row) {
        if (k.endsWith(suffix)) return v;
      }
      // Correlated: fall back to outer row
      if (ctx?.outer) {
        if (ctx.outer.has(e.name)) return ctx.outer.get(e.name);
        for (const [k, v] of ctx.outer) {
          if (k.endsWith(suffix)) return v;
        }
      }
      throw new Error(`column "${e.name}" not found`);
    }

    case 'literal': {
      const e = expr as LiteralExpr;
      return e.value;
    }

    case 'binary': {
      const e = expr as BinaryExpr;
      return evalBinary(e, row, ctx);
    }

    case 'aggFunc': {
      const e = expr as AggFuncExpr;
      const arg = e.arg === null ? '*' : exprString(e.arg);
      const key = e.func + '(' + arg + ')';
      if (row.has(key)) return row.get(key);
      throw new Error(`aggregate ${key} not computed (use in HAVING after GROUP BY)`);
    }

    case 'subquery': {
      if (!ctx?.exec) throw new Error('scalar subquery requires execution context');
      const e = expr as import('../parser/ast').SubqueryExpr;
      const subCtx: EvalCtx = { exec: ctx.exec, outer: row, ctes: ctx.ctes };
      const rows = ctx.exec.materializeSubquery(e.query, subCtx);
      if (rows.length === 0) return null;
      if (rows.length > 1) throw new Error('scalar subquery returned more than one row');
      for (const v of rows[0].values()) return v;
      return null;
    }

    case 'inSubquery': {
      if (!ctx?.exec) throw new Error('IN subquery requires execution context');
      const e = expr as import('../parser/ast').InSubqueryExpr;
      const leftVal = evalExpr(e.left, row, ctx);
      let matches = false;
      if (e.query != null) {
        const subCtx: EvalCtx = { exec: ctx.exec, outer: row, ctes: ctx.ctes };
        const rows = ctx.exec.materializeSubquery(e.query, subCtx);
        outer: for (const r of rows) {
          for (const v of r.values()) {
            if (compareVals(leftVal, v) === 0) { matches = true; break outer; }
          }
        }
      } else if (e.values != null) {
        for (const valExpr of e.values) {
          const v = evalExpr(valExpr, row, ctx);
          if (compareVals(leftVal, v) === 0) { matches = true; break; }
        }
      }
      return e.not ? !matches : matches;
    }

    case 'exists': {
      if (!ctx?.exec) throw new Error('EXISTS requires execution context');
      const e = expr as import('../parser/ast').ExistsExpr;
      const subCtx: EvalCtx = { exec: ctx.exec, outer: row, ctes: ctx.ctes };
      const rows = ctx.exec.materializeSubquery(e.query, subCtx);
      const exists = rows.length > 0;
      return e.not ? !exists : exists;
    }

    default:
      throw new Error(`unknown expression kind: ${(expr as any).kind}`);
  }
}

function evalBinary(e: BinaryExpr, row: Row, ctx: EvalCtx | null): unknown {
  const op = e.op.toUpperCase();

  // Short-circuit logical operators
  if (op === 'AND') {
    const l = evalExpr(e.left, row, ctx);
    if (!boolVal(l)) return false;
    return boolVal(evalExpr(e.right, row, ctx));
  }
  if (op === 'OR') {
    const l = evalExpr(e.left, row, ctx);
    if (boolVal(l)) return true;
    return boolVal(evalExpr(e.right, row, ctx));
  }
  if (op === 'NOT') {
    return !boolVal(evalExpr(e.left, row, ctx));
  }

  const lv = evalExpr(e.left, row, ctx);
  const rv = evalExpr(e.right, row, ctx);

  switch (op) {
    case '=':  return lv === rv || compareVals(lv, rv) === 0;
    case '!=': return lv !== rv && compareVals(lv, rv) !== 0;
    case '<':  return compareVals(lv, rv) < 0;
    case '>':  return compareVals(lv, rv) > 0;
    case '<=': return compareVals(lv, rv) <= 0;
    case '>=': return compareVals(lv, rv) >= 0;
    case '+':  return toNumber(lv) + toNumber(rv);
    case '-':  return toNumber(lv) - toNumber(rv);
    case '*':  return toNumber(lv) * toNumber(rv);
    case '/': {
      const d = toNumber(rv);
      if (d === 0) throw new Error('division by zero');
      return toNumber(lv) / d;
    }
    case 'LIKE': return likeMatch(String(lv ?? ''), String(rv ?? ''));
    case 'ILIKE': return likeMatch(String(lv ?? '').toLowerCase(), String(rv ?? '').toLowerCase());
    case 'IS': {
      // IS NULL / IS NOT NULL — right side is LiteralExpr(null)
      return lv === null || lv === undefined;
    }
    case 'IS NOT': return lv !== null && lv !== undefined;
    default:
      throw new Error(`unknown operator: ${e.op}`);
  }
}

function likeMatch(text: string, pattern: string): boolean {
  // Convert SQL LIKE pattern to regex
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped.replace(/%/g, '.*').replace(/_/g, '.') + '$');
  return re.test(text);
}

export function boolVal(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'bigint') return v !== 0n;
  if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1';
  return Boolean(v);
}

export function toFloat(v: unknown): [number, boolean] {
  if (typeof v === 'number') return [v, true];
  if (typeof v === 'bigint') return [Number(v), true];
  if (typeof v === 'string') {
    const n = Number(v);
    if (!isNaN(n)) return [n, true];
  }
  return [0, false];
}

function toNumber(v: unknown): number {
  const [n, ok] = toFloat(v);
  if (!ok) throw new Error(`value "${v}" is not numeric`);
  return n;
}

/** Stringifies an expression for use as a map key (e.g. aggregate key). */
export function exprString(expr: Expression): string {
  switch (expr.kind) {
    case 'ident': {
      const e = expr as IdentExpr;
      return e.table ? e.table + '.' + e.name : e.name;
    }
    case 'literal': return String((expr as LiteralExpr).value);
    case 'aggFunc': {
      const e = expr as AggFuncExpr;
      const arg = e.arg === null ? '*' : exprString(e.arg);
      return e.func + '(' + arg + ')';
    }
    case 'binary': {
      const e = expr as BinaryExpr;
      return `(${exprString(e.left)} ${e.op} ${exprString(e.right)})`;
    }
    default: return `<expr:${(expr as any).kind}>`;
  }
}

// ---------------------------------------------------------------------------
// collectAggFuncs — walks an expression tree collecting needed aggregate specs
// ---------------------------------------------------------------------------

export function collectAggFuncs(expr: Expression | null, needed: Map<string, AggSpec>): void {
  if (!expr) return;
  switch (expr.kind) {
    case 'aggFunc': {
      const e = expr as AggFuncExpr;
      const arg = e.arg === null ? '*' : exprString(e.arg);
      const key = e.func + '(' + arg + ')';
      needed.set(key, { fn: e.func, arg });
      break;
    }
    case 'binary': {
      const e = expr as BinaryExpr;
      collectAggFuncs(e.left, needed);
      collectAggFuncs(e.right, needed);
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// collectAggFuncsFromSelectExprs
// ---------------------------------------------------------------------------

export function collectAggFuncsFromSelectExprs(exprs: SelectExpr[], needed: Map<string, AggSpec>): void {
  for (const expr of exprs) {
    if (expr.kind === 'agg') {
      const agg = expr as AggSelectExpr;
      const key = agg.func + '(' + agg.arg + ')';
      needed.set(key, { fn: agg.func, arg: agg.arg });
    }
  }
}

// ---------------------------------------------------------------------------
// resolveCol — looks up column value handling both bare and alias.col key formats
// ---------------------------------------------------------------------------

export function resolveCol(row: Row, col: string): unknown {
  if (row.has(col)) return row.get(col);
  const sfx = '.' + col;
  for (const [k, v] of row) {
    if (k.endsWith(sfx)) return v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// hasAggExprs — checks if any SelectExpr in the list is an aggregate
// ---------------------------------------------------------------------------

export function hasAggExprs(exprs: SelectExpr[] | null): boolean {
  if (!exprs) return false;
  return exprs.some(ex => ex.kind === 'agg');
}

// ---------------------------------------------------------------------------
// compare — boolean comparison with numeric coercion
// ---------------------------------------------------------------------------

export function compare(left: unknown, op: string, right: unknown): [boolean, Error | null] {
  const [lf, lok] = toFloat(left);
  const [rf, rok] = toFloat(right);
  if (lok && rok) {
    switch (op) {
      case '=':  return [lf === rf, null];
      case '!=': return [lf !== rf, null];
      case '<':  return [lf < rf, null];
      case '>':  return [lf > rf, null];
      case '<=': return [lf <= rf, null];
      case '>=': return [lf >= rf, null];
    }
  }
  const ls = String(left ?? 'null');
  const rs = String(right ?? 'null');
  switch (op) {
    case '=':  return [ls === rs, null];
    case '!=': return [ls !== rs, null];
  }
  return [false, new Error(`cannot apply operator "${op}" to types ${typeof left} and ${typeof right}`)];
}

// ---------------------------------------------------------------------------
// joinStrings — join a list of strings with ", "
// ---------------------------------------------------------------------------

export function joinStrings(ss: string[]): string {
  return ss.join(', ');
}

// ---------------------------------------------------------------------------
// computeAggFromRows — computes fn(arg) over a set of rows
// ---------------------------------------------------------------------------

export function computeAggFromRows(fn: string, arg: string, rows: Row[]): unknown {
  switch (fn.toUpperCase()) {
    case 'COUNT': {
      if (arg === '*') return rows.length;
      const count = rows.filter(r => {
        const v = resolveCol(r, arg);
        return v !== null && v !== undefined;
      }).length;
      return count;
    }
    case 'SUM': {
      let sum = 0;
      for (const r of rows) {
        const [f, ok] = toFloat(resolveCol(r, arg));
        if (ok) sum += f;
      }
      return sum;
    }
    case 'AVG': {
      let sum = 0;
      let count = 0;
      for (const r of rows) {
        const [f, ok] = toFloat(resolveCol(r, arg));
        if (ok) { sum += f; count++; }
      }
      return count === 0 ? null : sum / count;
    }
    case 'MIN': {
      let min: number | null = null;
      for (const r of rows) {
        const [f, ok] = toFloat(resolveCol(r, arg));
        if (ok && (min === null || f < min)) min = f;
      }
      return min;
    }
    case 'MAX': {
      let max: number | null = null;
      for (const r of rows) {
        const [f, ok] = toFloat(resolveCol(r, arg));
        if (ok && (max === null || f > max)) max = f;
      }
      return max;
    }
    default:
      throw new Error(`unknown aggregate function: ${fn}`);
  }
}
