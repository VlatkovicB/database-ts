// =============================================================================
// SELECT dispatch — port of internal/executor/select.go
// =============================================================================

import {
  SelectStatement,
  SelectExpr,
  ColSelectExpr,
  AggSelectExpr,
  ExprSelectExpr,
  Expression,
  BinaryExpr,
  IdentExpr,
  LiteralExpr,
} from '../parser/ast';
import { Row, Column } from '../storage/storage';
import { Result } from './executor';
import {
  CteEntry,
  EvalCtx,
  evalExpr,
  boolVal,
  exprString,
  hasAggExprs,
} from './expr';
import { materializeDerivedTable } from './subquery';

// ---------------------------------------------------------------------------
// indexPlan — captures a WHERE predicate that can use a B+ tree index
// ---------------------------------------------------------------------------

export interface IndexPlan {
  indexName: string;
  column: string;
  lo: unknown;
  loOp: string;
  hi: unknown;
  hiOp: string;
  residual: Expression | null;
}

export interface IndexSuggestion {
  reason: string;
  sql: string;
}

// ---------------------------------------------------------------------------
// subqueryProj — scalar subquery to be evaluated per row during projection
// ---------------------------------------------------------------------------

interface SubqueryProj {
  colIdx: number;
  expr: Expression;
}

// ---------------------------------------------------------------------------
// execPlan — holds a volcano node tree and projection info for one SELECT
// ---------------------------------------------------------------------------

export interface ExecPlan {
  root: any;        // Node — typed as any to avoid circular import with volcano
  cols: string[];
  keys: string[];
  ctes: Map<string, CteEntry> | null;
  subqueryExprs: SubqueryProj[];
}

// ---------------------------------------------------------------------------
// containsSubquery
// ---------------------------------------------------------------------------

export function containsSubquery(expr: Expression | null): boolean {
  if (expr == null) return false;
  switch (expr.kind) {
    case 'subquery':
    case 'inSubquery':
    case 'exists':
      return true;
    case 'binary': {
      const b = expr as BinaryExpr;
      return containsSubquery(b.left) || containsSubquery(b.right);
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// extractSingleBound — extracts a single col op literal bound
// ---------------------------------------------------------------------------

function extractSingleBound(expr: Expression): {
  col: string; lo: unknown; loOp: string; hi: unknown; hiOp: string;
} | null {
  if (expr.kind !== 'binary') return null;
  const bin = expr as BinaryExpr;

  let ident: IdentExpr | null = null;
  let lit: LiteralExpr | null = null;
  let op = bin.op;

  if (bin.left.kind === 'ident' && bin.right.kind === 'literal') {
    ident = bin.left as IdentExpr;
    lit = bin.right as LiteralExpr;
  } else if (bin.right.kind === 'ident' && bin.left.kind === 'literal') {
    ident = bin.right as IdentExpr;
    lit = bin.left as LiteralExpr;
    const flip: Record<string, string> = { '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
    op = flip[op] ?? op;
  }

  if (!ident || !lit) return null;

  const col = ident.name;
  switch (op) {
    case '=':  return { col, lo: lit.value, loOp: '=', hi: null, hiOp: '' };
    case '>':  return { col, lo: lit.value, loOp: '>', hi: null, hiOp: '' };
    case '>=': return { col, lo: lit.value, loOp: '>=', hi: null, hiOp: '' };
    case '<':  return { col, lo: null, loOp: '', hi: lit.value, hiOp: '<' };
    case '<=': return { col, lo: null, loOp: '', hi: lit.value, hiOp: '<=' };
    default:   return null;
  }
}

// extractRangeBounds — extracts index-compatible bounds from a WHERE expression.
export function extractRangeBounds(where: Expression): {
  col: string;
  lo: unknown; loOp: string;
  hi: unknown; hiOp: string;
  residual: Expression | null;
} | null {
  const single = extractSingleBound(where);
  if (single) {
    return { ...single, residual: null };
  }
  if (where.kind !== 'binary') return null;
  const bin = where as BinaryExpr;
  if (bin.op !== 'AND') return null;

  const left = extractSingleBound(bin.left);
  const right = extractSingleBound(bin.right);

  if (left && right && left.col === right.col) {
    let lo = left.lo, loOp = left.loOp;
    let hi = left.hi, hiOp = left.hiOp;
    if (lo == null) { lo = right.lo; loOp = right.loOp; }
    if (hi == null) { hi = right.hi; hiOp = right.hiOp; }
    return { col: left.col, lo, loOp, hi, hiOp, residual: null };
  }
  if (left) return { ...left, residual: bin.right };
  if (right) return { ...right, residual: bin.left };
  return null;
}

// findIndexPlan — returns an IndexPlan if the WHERE clause can use an index.
export function findIndexPlan(db: any, tableName: string, where: Expression | null): IndexPlan | null {
  if (where == null) return null;
  const bounds = extractRangeBounds(where);
  if (!bounds) return null;
  const [indexName, found] = db.findIndexForColumn(tableName, bounds.col);
  if (!found) return null;
  return {
    indexName,
    column: bounds.col,
    lo: bounds.lo,
    loOp: bounds.loOp,
    hi: bounds.hi,
    hiOp: bounds.hiOp,
    residual: bounds.residual,
  };
}

// ---------------------------------------------------------------------------
// collectIndexableCols / collectJoinInnerCols
// ---------------------------------------------------------------------------

export function collectIndexableCols(expr: Expression | null): string[] {
  if (expr == null) return [];
  if (expr.kind !== 'binary') return [];
  const bin = expr as BinaryExpr;
  if (bin.op === 'AND' || bin.op === 'OR') {
    return [...collectIndexableCols(bin.left), ...collectIndexableCols(bin.right)];
  }
  const single = extractSingleBound(expr);
  return single ? [single.col] : [];
}

export function collectJoinInnerCols(
  expr: Expression | null,
  innerTable: string,
  innerAlias: string
): string[] {
  if (expr == null) return [];
  if (expr.kind !== 'binary') return [];
  const bin = expr as BinaryExpr;
  if (bin.op === 'AND' || bin.op === 'OR') {
    return [
      ...collectJoinInnerCols(bin.left, innerTable, innerAlias),
      ...collectJoinInnerCols(bin.right, innerTable, innerAlias),
    ];
  }
  if (bin.op !== '=') return [];
  const cols: string[] = [];
  const check = (id: IdentExpr) => {
    if (id.table === innerAlias || id.table === innerTable || id.table === '') {
      cols.push(id.name);
    }
  };
  if (bin.left.kind === 'ident') check(bin.left as IdentExpr);
  if (bin.right.kind === 'ident') check(bin.right as IdentExpr);
  return cols;
}

// ---------------------------------------------------------------------------
// suggestIndexes
// ---------------------------------------------------------------------------

export function suggestIndexes(exec: any, sel: SelectStatement): IndexSuggestion[] {
  const suggestions: IndexSuggestion[] = [];
  const seen = new Set<string>();

  if (sel.where != null && sel.joins.length === 0) {
    if (findIndexPlan(exec.db, sel.table, sel.where) == null) {
      for (const col of collectIndexableCols(sel.where)) {
        const key = sel.table + '.' + col;
        if (seen.has(key)) continue;
        seen.add(key);
        const [, found] = exec.db.findIndexForColumn(sel.table, col);
        if (!found) {
          suggestions.push({
            reason: `SeqScan on ${sel.table} with predicate on ${col} — index enables Index Scan`,
            sql: `CREATE INDEX idx_${sel.table}_${col} ON ${sel.table}(${col});`,
          });
        }
      }
    }
  }

  for (const j of sel.joins) {
    const innerAlias = j.alias !== '' ? j.alias : j.table;
    for (const col of collectJoinInnerCols(j.condition, j.table, innerAlias)) {
      const key = j.table + '.' + col;
      if (seen.has(key)) continue;
      seen.add(key);
      const [, found] = exec.db.findIndexForColumn(j.table, col);
      if (!found) {
        suggestions.push({
          reason: `Nested Loop Join probes ${j.table} on ${col} — index speeds inner lookups`,
          sql: `CREATE INDEX idx_${j.table}_${col} ON ${j.table}(${col});`,
        });
      }
    }
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// nodeTrace — collects node names bottom-up (innermost first)
// ---------------------------------------------------------------------------

export function nodeTrace(node: any): string[] {
  if (node == null) return [];
  const lines: string[] = [];
  for (const child of (node.nodeChildren?.() ?? [])) {
    lines.push(...nodeTrace(child));
  }
  lines.push(node.nodeName?.() ?? '');
  return lines;
}

// ---------------------------------------------------------------------------
// planSelect / execSelect — main entry points
// ---------------------------------------------------------------------------

export function planSelect(exec: any, sel: SelectStatement): ExecPlan {
  let ctes: Map<string, CteEntry> | null = null;

  if (sel.with.length > 0) {
    ctes = new Map();
    for (const cteDef of sel.with) {
      const sub = planSelectWithCTEs(exec, cteDef.query, null);
      sub.root.open();
      const cteRows: Row[] = [];
      for (;;) {
        const row = sub.root.next();
        if (row === null) break;
        const projected: Row = new Map();
        for (let i = 0; i < sub.keys.length; i++) {
          projected.set(sub.cols[i], row.get(sub.keys[i]));
        }
        cteRows.push(projected);
      }
      sub.root.close();
      ctes.set(cteDef.name, { rows: cteRows, cols: sub.cols, keys: sub.cols, derived: false });
    }
  }

  return planSelectWithCTEs(exec, sel, ctes);
}

export function planSelectWithCTEs(
  exec: any,
  sel: SelectStatement,
  ctes: Map<string, CteEntry> | null
): ExecPlan {
  // Materialize derived tables (FROM/JOIN subqueries).
  if (sel.fromSubquery != null) {
    if (ctes == null) ctes = new Map();
    const entry = materializeDerivedTable(exec, sel.fromSubquery, ctes);
    ctes.set(sel.table, entry);
  }
  for (const j of sel.joins) {
    if (j.joinSubquery != null && !j.lateral) {
      if (ctes == null) ctes = new Map();
      const entry = materializeDerivedTable(exec, j.joinSubquery, ctes);
      ctes.set(j.table, entry);
    }
  }

  const alias = sel.alias !== '' ? sel.alias : sel.table;

  type AliasInfo = { alias: string; cols: Column[] };

  // Base table columns — check CTEs first.
  let baseTableCols: Column[] = [];
  if (ctes?.has(sel.table)) {
    const entry = ctes.get(sel.table)!;
    baseTableCols = entry.cols.map(col => ({ name: col, type: 'TEXT' as Column['type'], primary: false }));
  }
  if (baseTableCols.length === 0) {
    const [baseTable, baseTableErr] = exec.db.getTable(sel.table);
    if (baseTableErr) throw baseTableErr;
    baseTableCols = baseTable!.columns;
  }

  const aliasOrder: AliasInfo[] = [{ alias, cols: baseTableCols }];
  for (const j of sel.joins) {
    const ja = j.alias !== '' ? j.alias : j.table;
    if (j.lateral && j.joinSubquery != null) {
      const latCols = lateralColsFromAST(j.joinSubquery).map(col => ({
        name: col, type: 'TEXT' as Column['type'], primary: false,
      }));
      aliasOrder.push({ alias: ja, cols: latCols });
      continue;
    }
    if (ctes?.has(j.table)) {
      const entry = ctes.get(j.table)!;
      const jCols = entry.cols.map(col => ({ name: col, type: 'TEXT' as Column['type'], primary: false }));
      aliasOrder.push({ alias: ja, cols: jCols });
      continue;
    }
    const [jt, jtErr] = exec.db.getTable(j.table);
    if (jtErr) throw jtErr;
    aliasOrder.push({ alias: ja, cols: jt!.columns });
  }

  const snap = exec.currentSnapshot();
  const xid = exec.currentXID();

  const hasNonLateralJoins = sel.joins.some(j => !j.lateral);
  const hasLateralJoins = sel.joins.some(j => j.lateral);

  // Pass WHERE to planner only for single-table queries without subqueries.
  const singleWhere: Expression | null =
    !hasNonLateralJoins && !hasLateralJoins && !containsSubquery(sel.where)
      ? sel.where
      : null;

  // Build root from exec's physRel planner (bridges to volcano.ts).
  let root = exec.buildVolcanoRoot(sel, ctes, singleWhere, snap, xid);

  // Wrap with LATERAL join nodes.
  for (const j of sel.joins) {
    if (!j.lateral || j.joinSubquery == null) continue;
    root = exec.newLateralJoinNode(root, j, ctes);
  }

  // Apply WHERE filter for multi-table or subquery-in-WHERE queries.
  if (sel.where != null && (hasNonLateralJoins || hasLateralJoins || containsSubquery(sel.where))) {
    const sqCtx: EvalCtx = { exec, outer: null, ctes };
    root = exec.newFilterNode(root, sel.where, sqCtx);
  }

  const isAgg = sel.groupBy.length > 0 || hasAggExprs(sel.exprs);

  if (isAgg) {
    root = exec.newHashAggregateNode(root, sel.groupBy, sel.exprs, sel.having);
  }

  if (sel.orderBy.length > 0) {
    root = exec.newSortNode(root, sel.orderBy);
  }

  if (sel.limit != null || sel.offset != null) {
    root = exec.newLimitNode(root, sel.limit, sel.offset);
  }

  const plan: ExecPlan = { root, cols: [], keys: [], ctes, subqueryExprs: [] };

  // ---- Projection: map output column names to row keys ----
  if (isAgg) {
    if (sel.exprs == null) {
      for (const col of sel.groupBy) {
        plan.cols.push(col);
        plan.keys.push(col);
      }
    } else {
      for (const expr of sel.exprs) {
        if (expr.kind === 'col') {
          const ex = expr as ColSelectExpr;
          plan.cols.push(ex.col);
          plan.keys.push(ex.col);
        } else if (expr.kind === 'agg') {
          const ex = expr as AggSelectExpr;
          const k = ex.func + '(' + ex.arg + ')';
          plan.cols.push(k);
          plan.keys.push(k);
        }
      }
    }
  } else if (sel.joins.length === 0) {
    // Single-table query.
    if (sel.exprs == null) {
      for (const c of aliasOrder[0].cols) {
        plan.cols.push(c.name);
        plan.keys.push(alias + '.' + c.name);
      }
    } else {
      for (const expr of sel.exprs) {
        if (expr.kind === 'col') {
          const ex = expr as ColSelectExpr;
          const col = ex.col;
          const dotIdx = col.indexOf('.');
          if (dotIdx >= 0) {
            plan.cols.push(col.substring(dotIdx + 1));
            plan.keys.push(col);
          } else {
            plan.cols.push(col);
            plan.keys.push(alias + '.' + col);
          }
        } else if (expr.kind === 'expr') {
          const ex = expr as ExprSelectExpr;
          const colAlias = ex.alias !== '' ? ex.alias : 'subquery';
          const syntheticKey = '__sqexpr__' + colAlias;
          plan.cols.push(colAlias);
          plan.keys.push(syntheticKey);
          plan.subqueryExprs.push({ colIdx: plan.keys.length - 1, expr: ex.expr });
        }
      }
    }
  } else {
    // Join query.
    if (sel.exprs == null) {
      for (const ai of aliasOrder) {
        for (const c of ai.cols) {
          plan.cols.push(ai.alias + '.' + c.name);
          plan.keys.push(ai.alias + '.' + c.name);
        }
      }
    } else {
      for (const expr of sel.exprs) {
        if (expr.kind === 'col') {
          const ex = expr as ColSelectExpr;
          const col = ex.col;
          if (col.endsWith('.*')) {
            const a = col.slice(0, -2);
            const ai = aliasOrder.find(x => x.alias === a);
            if (ai) {
              for (const c of ai.cols) {
                plan.cols.push(c.name);
                plan.keys.push(a + '.' + c.name);
              }
            }
          } else {
            const dotIdx = col.indexOf('.');
            if (dotIdx >= 0) {
              plan.cols.push(col.substring(dotIdx + 1));
              plan.keys.push(col);
            } else {
              // Unqualified: search across all aliases.
              let found = false;
              for (const ai of aliasOrder) {
                for (const c of ai.cols) {
                  if (c.name === col) {
                    plan.cols.push(col);
                    plan.keys.push(ai.alias + '.' + col);
                    found = true;
                    break;
                  }
                }
                if (found) break;
              }
              if (!found) throw new Error(`column "${col}" not found in any joined table`);
            }
          }
        } else if (expr.kind === 'expr') {
          const ex = expr as ExprSelectExpr;
          const colAlias = ex.alias !== '' ? ex.alias : 'subquery';
          const syntheticKey = '__sqexpr__' + colAlias;
          plan.cols.push(colAlias);
          plan.keys.push(syntheticKey);
          plan.subqueryExprs.push({ colIdx: plan.keys.length - 1, expr: ex.expr });
        }
      }
    }
  }

  return plan;
}

// execSelect — runs the plan and collects results.
export function execSelect(exec: any, s: SelectStatement): Result {
  const plan = planSelect(exec, s);
  plan.root.open();
  const result: Result = { columns: plan.cols, rows: [], message: '', trace: [] };
  const seen = s.distinct ? new Set<string>() : null;

  for (;;) {
    const row: Row | null = plan.root.next();
    if (row === null) break;

    const r: unknown[] = plan.keys.map(key => row.get(key));

    // Evaluate scalar subquery projections.
    if (plan.subqueryExprs.length > 0) {
      const sqCtx: EvalCtx = { exec, outer: row, ctes: plan.ctes };
      for (const sp of plan.subqueryExprs) {
        try {
          r[sp.colIdx] = evalExpr(sp.expr, row, sqCtx);
        } catch {
          r[sp.colIdx] = null;
        }
      }
    }

    if (seen != null) {
      const key = JSON.stringify(r);
      if (seen.has(key)) continue;
      seen.add(key);
    }

    result.rows.push(r);
  }

  plan.root.close();
  result.trace = nodeTrace(plan.root);
  result.indexSuggestions = suggestIndexes(exec, s);
  return result;
}

// lateralColsFromAST extracts output column names from a subquery AST (for LATERAL join schema).
export function lateralColsFromAST(q: SelectStatement): string[] {
  if (q.exprs == null) return [];
  const cols: string[] = [];
  for (const expr of q.exprs) {
    if (expr.kind === 'col') {
      const col = (expr as ColSelectExpr).col;
      const dotIdx = col.indexOf('.');
      cols.push(dotIdx >= 0 ? col.substring(dotIdx + 1) : col);
    } else if (expr.kind === 'agg') {
      const agg = expr as AggSelectExpr;
      cols.push(agg.func + '(' + agg.arg + ')');
    } else if (expr.kind === 'expr') {
      const ex = expr as ExprSelectExpr;
      cols.push(ex.alias !== '' ? ex.alias : 'expr');
    }
  }
  return cols;
}
