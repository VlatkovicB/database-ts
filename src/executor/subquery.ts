// =============================================================================
// Subquery materialization — port of internal/executor/subquery.go
// =============================================================================

import { SelectStatement, AggSelectExpr, ExprSelectExpr } from '../parser/ast';
import { Row } from '../storage/storage';
import {
  CteEntry,
  EvalCtx,
  evalExpr,
  boolVal,
  hasAggExprs,
  computeAggFromRows,
  exprString,
} from './expr';

// Re-export CteEntry so other files can import from one place.
export type { CteEntry };

// ctesFrom extracts the ctes map from an EvalCtx (null-safe).
export function ctesFrom(ctx: EvalCtx | null): Map<string, CteEntry> | null {
  return ctx?.ctes ?? null;
}

// materializeDerivedTable executes subq and returns a CteEntry for use as a derived table.
export function materializeDerivedTable(
  exec: any,
  subq: SelectStatement,
  outerCTEs: Map<string, CteEntry> | null
): CteEntry {
  const sub = exec.planSelectWithCTEs(subq, outerCTEs);
  sub.root.open();
  const rows: Row[] = [];
  for (;;) {
    const row = sub.root.next();
    if (row === null) break;
    const projected: Row = new Map();
    for (let i = 0; i < sub.keys.length; i++) {
      projected.set(sub.cols[i], row.get(sub.keys[i]));
    }
    rows.push(projected);
  }
  sub.root.close();
  return { rows, cols: sub.cols, keys: sub.cols, derived: true };
}

// materializeSubquery executes subquery q and returns matching rows.
export function materializeSubquery(
  exec: any,
  q: SelectStatement,
  ctx: EvalCtx | null
): Row[] {
  const hasAgg = hasAggExprs(q.exprs) || q.groupBy.length > 0;
  const hasJoins = q.joins.length > 0;

  if (!hasAgg && !hasJoins) {
    return materializeSubquerySimple(exec, q, ctx);
  }

  if (hasAgg && !hasJoins) {
    return materializeAggSubquery(exec, q, ctx);
  }

  // For join subqueries (non-aggregate): use full pipeline.
  const plan = exec.planSelectWithCTEs(q, ctesFrom(ctx));
  let root = plan.root;
  if (q.where != null && ctx?.outer != null) {
    root = exec.newFilterNodeWithCtx(root, q.where, ctx);
  }

  root.open();
  const results: Row[] = [];
  for (;;) {
    const row = root.next();
    if (row === null) break;
    const out: Row = new Map();
    for (const key of plan.keys) {
      out.set(key, row.get(key));
    }
    results.push(out);
  }
  root.close();
  return results;
}

// materializeAggSubquery handles aggregate subqueries with correlated WHERE.
function materializeAggSubquery(
  exec: any,
  q: SelectStatement,
  ctx: EvalCtx | null
): Row[] {
  const snap = exec.currentSnapshot();
  const xid = exec.currentXID();

  const alias = q.alias !== '' ? q.alias : q.table;

  // Collect all filtered rows.
  const filteredRows: Row[] = [];

  // CTE table reference?
  if (ctx?.ctes?.has(q.table)) {
    const entry = ctx.ctes.get(q.table)!;
    for (const row of entry.rows) {
      if (q.where != null) {
        const ok = evalExpr(q.where, row, ctx);
        if (!boolVal(ok)) continue;
      }
      filteredRows.push(row);
    }
  } else {
    const scan = exec.newSeqScan(exec.db, q.table, alias, snap, xid);
    scan.open();
    for (;;) {
      const row = scan.next();
      if (row === null) break;
      if (q.where != null) {
        const ok = evalExpr(q.where, row, ctx);
        if (!boolVal(ok)) continue;
      }
      filteredRows.push(row);
    }
    scan.close();
  }

  // Compute aggregates on the filtered rows.
  const sr: Row = new Map();

  // Collect needed aggregate specs.
  const needed = new Map<string, { fn: string; arg: string }>();
  if (q.exprs != null) {
    for (const expr of q.exprs) {
      if (expr.kind === 'agg') {
        const agg = expr as AggSelectExpr;
        const k = agg.func + '(' + agg.arg + ')';
        needed.set(k, { fn: agg.func, arg: agg.arg });
      }
    }
  }

  for (const [key, spec] of needed) {
    const val = computeAggFromRows(spec.fn, spec.arg, filteredRows);
    sr.set(key, val);
  }

  // Handle ExprSelectExpr literals (like SELECT 1).
  let hasExprExprs = false;
  if (q.exprs != null) {
    for (const expr of q.exprs) {
      if (expr.kind === 'expr') { hasExprExprs = true; break; }
    }
  }
  if (hasExprExprs && needed.size === 0) {
    if (q.exprs != null) {
      for (const expr of q.exprs) {
        if (expr.kind === 'expr') {
          const ex = expr as ExprSelectExpr;
          try {
            const val = evalExpr(ex.expr, new Map(), ctx);
            sr.set(ex.alias, val);
          } catch {
            // ignore
          }
        }
      }
    }
  }

  if (sr.size === 0) return [];
  return [sr];
}

// materializeSubquerySimple handles simple (non-aggregate, non-join) subqueries.
function materializeSubquerySimple(
  exec: any,
  q: SelectStatement,
  ctx: EvalCtx | null
): Row[] {
  const snap = exec.currentSnapshot();
  const xid = exec.currentXID();

  const alias = q.alias !== '' ? q.alias : q.table;

  // CTE table reference?
  if (ctx?.ctes?.has(q.table)) {
    const entry = ctx.ctes.get(q.table)!;
    const results: Row[] = [];
    for (const row of entry.rows) {
      if (q.where != null) {
        const ok = evalExpr(q.where, row, ctx);
        if (!boolVal(ok)) continue;
      }
      results.push(row);
    }
    return results;
  }

  // Regular table scan.
  const scan = exec.newSeqScan(exec.db, q.table, alias, snap, xid);
  scan.open();
  const results: Row[] = [];
  for (;;) {
    const row = scan.next();
    if (row === null) break;
    if (q.where != null) {
      const ok = evalExpr(q.where, row, ctx);
      if (!boolVal(ok)) continue;
    }
    results.push(row);
  }
  scan.close();
  return results;
}
