// =============================================================================
// Selectivity estimation — port of internal/executor/selectivity.go
// =============================================================================

import {
  Expression,
  BinaryExpr,
  IdentExpr,
  LiteralExpr,
  SelectExpr,
  ColSelectExpr,
} from '../parser/ast';
import { TableStats, ColumnStats } from '../storage/stats';

// Selectivity defaults mirror PostgreSQL's hardcoded fractions.
const defaultEqSel = 0.005;
const defaultNeqSel = 0.995;
const defaultRangeSel = 1.0 / 3.0;

// estimateSelectivity returns the fraction of rows expected to pass the WHERE clause.
export function estimateSelectivity(
  db: any,
  tableName: string,
  where: Expression | null
): number {
  if (where == null) return 1.0;
  const ts: TableStats | null = db.getTableStats(tableName);
  return selectivityExpr(where, tableName, ts);
}

export function selectivityExpr(
  expr: Expression,
  tableName: string,
  ts: TableStats | null
): number {
  if (expr.kind !== 'binary') return defaultRangeSel;
  const b = expr as BinaryExpr;
  switch (b.op) {
    case 'AND': {
      const s1 = selectivityExpr(b.left, tableName, ts);
      const s2 = selectivityExpr(b.right, tableName, ts);
      return s1 * s2;
    }
    case 'OR': {
      const s1 = selectivityExpr(b.left, tableName, ts);
      const s2 = selectivityExpr(b.right, tableName, ts);
      return 1.0 - (1.0 - s1) * (1.0 - s2);
    }
    case '=':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=':
      return selectivityCmp(b, tableName, ts);
    default:
      return defaultRangeSel;
  }
}

function selectivityCmp(
  b: BinaryExpr,
  tableName: string,
  ts: TableStats | null
): number {
  const result = extractIdentLit(b);
  if (!result) return defaultRangeSel;
  const { ident, lit, op } = result;

  if (ts == null) {
    switch (op) {
      case '=':  return defaultEqSel;
      case '!=': return defaultNeqSel;
      default:   return defaultRangeSel;
    }
  }

  const colName = ident.name;
  const cs: ColumnStats | undefined = ts.columns.get(colName);
  if (!cs) {
    switch (op) {
      case '=':  return defaultEqSel;
      case '!=': return defaultNeqSel;
      default:   return defaultRangeSel;
    }
  }

  switch (op) {
    case '=':  return cs.equalitySelectivity(lit.value);
    case '!=': return 1.0 - cs.equalitySelectivity(lit.value);
    case '<': case '<=': case '>': case '>=': {
      const [sel, ok] = cs.histogramSelectivity(op, lit.value);
      return ok ? sel : defaultRangeSel;
    }
    default:
      return defaultRangeSel;
  }
}

// extractIdentLit returns the column identifier and literal from a simple comparison,
// normalizing flipped forms like "10 < level" into "level > 10".
function extractIdentLit(
  b: BinaryExpr
): { ident: IdentExpr; lit: LiteralExpr; op: string } | null {
  if (b.left.kind === 'ident' && b.right.kind === 'literal') {
    return { ident: b.left as IdentExpr, lit: b.right as LiteralExpr, op: b.op };
  }
  if (b.right.kind === 'ident' && b.left.kind === 'literal') {
    const flipped: Record<string, string> = {
      '>': '<', '>=': '<=', '<': '>', '<=': '>=', '=': '=', '!=': '!=',
    };
    const op = flipped[b.op];
    if (!op) return null;
    return { ident: b.right as IdentExpr, lit: b.left as LiteralExpr, op };
  }
  return null;
}

// groupByNDistinct returns the estimated number of distinct values for the GROUP BY columns.
export function groupByNDistinct(
  db: any,
  tableName: string,
  groupByCols: string[],
  nRows: number
): number {
  if (groupByCols.length === 0) return 1;
  const ts: TableStats | null = db.getTableStats(tableName);
  if (ts == null) return Math.max(Math.floor(nRows / 5), 1);
  let total = 1.0;
  for (const col of groupByCols) {
    const cs = ts.columns.get(col);
    if (!cs) {
      total *= Math.max(Math.floor(nRows / 5), 1);
      continue;
    }
    let nd = cs.nDistinct;
    if (nd < 0) nd = nRows; // all distinct — cap at row count
    total *= nd;
  }
  let n = Math.floor(total);
  if (n < 1) n = 1;
  if (n > nRows) n = nRows;
  return n;
}

// distinctOutputRows estimates SELECT DISTINCT output rows using column stats.
export function distinctOutputRows(
  db: any,
  tableName: string,
  exprs: SelectExpr[] | null,
  nRows: number
): number {
  const ts: TableStats | null = db.getTableStats(tableName);
  if (ts == null) return Math.max(Math.floor(nRows / 2), 1);
  if (exprs != null) {
    for (const ex of exprs) {
      if (ex.kind === 'col') {
        const col = (ex as ColSelectExpr).col;
        if (col === '*') continue;
        const cs = ts.columns.get(col);
        if (cs) {
          let nd = cs.nDistinct;
          if (nd < 0) nd = nRows;
          let n = Math.floor(nd);
          if (n < 1) n = 1;
          if (n > nRows) n = nRows;
          return n;
        }
      }
    }
  }
  return Math.max(Math.floor(nRows / 2), 1);
}
