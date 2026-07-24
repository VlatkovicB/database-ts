// =============================================================================
// EXPLAIN / EXPLAIN ANALYZE — port of internal/executor/explain.go
// =============================================================================

import {
  Statement,
  SelectStatement,
  Expression,
  BinaryExpr,
  IdentExpr,
  LiteralExpr,
  AggFuncExpr,
} from '../parser/ast';
import { Result } from './executor';
import { joinStrings, hasAggExprs, exprString } from './expr';
import {
  estimateSelectivity,
  groupByNDistinct,
  distinctOutputRows,
} from './selectivity';

// PlanNode is one node in the cost-estimate tree used by EXPLAIN.
export interface PlanNode {
  label: string;
  estStartup: number;
  estTotal: number;
  estRows: number;
  width: number;
  extras: string[];
  children: PlanNode[];
}

// Cost constants mirroring volcano.go / explain.go
const cpuTupleCost = 0.01;
export const planWidth = 8; // default average row width in bytes

function exprToSQL(expr: Expression | null): string {
  if (expr == null) return '';
  switch (expr.kind) {
    case 'binary': {
      const e = expr as BinaryExpr;
      return '(' + exprToSQL(e.left) + ' ' + e.op + ' ' + exprToSQL(e.right) + ')';
    }
    case 'ident': {
      const e = expr as IdentExpr;
      return e.table ? e.table + '.' + e.name : e.name;
    }
    case 'literal': {
      const e = expr as LiteralExpr;
      if (e.value === null || e.value === undefined) return 'NULL';
      if (typeof e.value === 'string') return "'" + e.value + "'";
      return String(e.value);
    }
    case 'aggFunc': {
      const e = expr as AggFuncExpr;
      return e.arg == null ? e.func + '(*)' : e.func + '(' + exprToSQL(e.arg) + ')';
    }
    default:
      return '?';
  }
}

// buildExplainTree builds the cost-estimate PlanNode tree for EXPLAIN rendering.
export function buildExplainTree(exec: any, sel: SelectStatement): PlanNode {
  // Use the query planner (volcano / qplanner) through exec to get the physRel
  // and convert it into a planNode tree. Since we don't have the full qplanner
  // ported here, we delegate to exec's internal planner for actual scan/join
  // decisions and build the upper tree here.

  const hasNonLateralJoins = sel.joins.some(j => !j.lateral);
  const hasLateralJoins = sel.joins.some(j => j.lateral);

  // Use exec's physRelToPlanNode helper if available (set by volcano.ts).
  let root: PlanNode;
  if (typeof exec.buildPhysRelPlanNode === 'function') {
    root = exec.buildPhysRelPlanNode(sel);
  } else {
    // Fallback: simple seq scan estimate.
    const [nRows] = exec.db.rowCount ? exec.db.rowCount(sel.table) : [0];
    root = {
      label: `Seq Scan on ${sel.table}`,
      estStartup: 0,
      estTotal: nRows * cpuTupleCost,
      estRows: nRows,
      width: planWidth,
      extras: [],
      children: [],
    };
  }

  // Attach derived table inner trees.
  if (sel.fromSubquery != null) {
    const innerTree = buildExplainTree(exec, sel.fromSubquery);
    root.children.push(innerTree);
  }
  for (const j of sel.joins) {
    if (j.joinSubquery != null && !j.lateral) {
      const innerTree = buildExplainTree(exec, j.joinSubquery);
      attachSubqueryScanChild(root, j.alias, innerTree);
    }
  }

  // Wrap LATERAL joins.
  for (const j of sel.joins) {
    if (!j.lateral || j.joinSubquery == null) continue;
    const algLabel = j.type === 'LEFT'
      ? 'Nested Loop Left Join (LATERAL)'
      : 'Nested Loop (LATERAL)';
    const extras: string[] = [];
    if (j.condition != null) extras.push('Join Filter: ' + exprToSQL(j.condition));
    const innerTree = buildExplainTree(exec, j.joinSubquery);
    root = {
      label: algLabel,
      estTotal: root.estTotal * 10,
      estRows: root.estRows,
      estStartup: 0,
      width: root.width + planWidth,
      extras,
      children: [root, innerTree],
    };
  }

  let mainN: number;
  try {
    const [n] = exec.db.rowCount ? exec.db.rowCount(sel.table) : [root.estRows];
    mainN = n;
  } catch {
    mainN = root.estRows;
  }
  if (sel.fromSubquery != null) mainN = root.estRows;

  // WHERE filter above the join tree (multi-table only).
  if (sel.where != null && (hasNonLateralJoins || hasLateralJoins)) {
    const sel2 = estimateSelectivity(exec.db, sel.table, sel.where);
    const filterRows = Math.max(1, Math.floor(root.estRows * sel2));
    root = {
      label: 'Filter',
      estStartup: 0,
      estTotal: root.estTotal + root.estRows * cpuTupleCost,
      estRows: filterRows,
      width: root.width,
      extras: ['Filter: ' + exprToSQL(sel.where)],
      children: [root],
    };
  }

  // HashAggregate.
  if (sel.groupBy.length > 0 || hasAggExprs(sel.exprs)) {
    const inN = root.estRows;
    let outN = groupByNDistinct(exec.db, sel.table, sel.groupBy, mainN);
    if (outN > inN) outN = inN;
    if (outN < 1) outN = 1;
    const agg: PlanNode = {
      label: 'HashAggregate',
      estStartup: 0,
      estTotal: root.estTotal + inN * cpuTupleCost,
      estRows: outN,
      width: root.width,
      extras: [],
      children: [root],
    };
    if (sel.groupBy.length > 0) {
      agg.extras.push('Group Key: ' + joinStrings(sel.groupBy));
    }
    if (sel.having != null) {
      agg.extras.push('Filter: ' + exprToSQL(sel.having));
      const havingSel = estimateSelectivity(exec.db, sel.table, sel.having);
      agg.estRows = Math.max(1, Math.floor(outN * havingSel));
    }
    root = agg;
  }

  // Sort.
  if (sel.orderBy.length > 0) {
    const inN = root.estRows;
    const sortCost = root.estTotal * 0.3;
    const cols = sel.orderBy.map(ob => ob.col + (ob.desc ? ' DESC' : ' ASC'));
    root = {
      label: 'Sort',
      estStartup: root.estTotal + sortCost,
      estTotal: root.estTotal + sortCost,
      estRows: inN,
      width: root.width,
      extras: ['Sort Key: ' + joinStrings(cols)],
      children: [root],
    };
  }

  // Unique (DISTINCT).
  if (sel.distinct) {
    const inN = root.estRows;
    let uniqN = distinctOutputRows(exec.db, sel.table, sel.exprs, mainN);
    if (uniqN > inN) uniqN = inN;
    if (uniqN < 1) uniqN = 1;
    root = {
      label: 'Unique',
      estStartup: 0,
      estTotal: root.estTotal + inN * cpuTupleCost,
      estRows: uniqN,
      width: root.width,
      extras: [],
      children: [root],
    };
  }

  // Limit.
  if (sel.limit != null) {
    let limitN = Number(sel.limit);
    if (limitN > root.estRows) limitN = root.estRows;
    root = {
      label: 'Limit',
      estStartup: 0,
      estTotal: root.estTotal,
      estRows: limitN,
      width: root.width,
      extras: [],
      children: [root],
    };
  }

  return root;
}

function attachSubqueryScanChild(node: PlanNode, alias: string, inner: PlanNode): boolean {
  if (node.label === 'Subquery Scan on ' + alias) {
    node.children.push(inner);
    return true;
  }
  for (const child of node.children) {
    if (attachSubqueryScanChild(child, alias, inner)) return true;
  }
  return false;
}

export function renderPlanTree(
  node: PlanNode,
  depth: number,
  analyze: boolean,
  actualRows: number,
  totalMs: number
): string[] {
  const lines: string[] = [];

  let nodePrefix: string;
  let extraIndent: string;
  if (depth === 0) {
    nodePrefix = '';
    extraIndent = '  ';
  } else {
    nodePrefix = ' '.repeat(6 * depth - 4) + '->  ';
    extraIndent = ' '.repeat(6 * depth + 2);
  }

  const costPart = `(cost=${node.estStartup.toFixed(2)}..${node.estTotal.toFixed(2)} rows=${node.estRows} width=${node.width})`;

  let analyzePart = '';
  if (analyze) {
    let frac = 1.0;
    for (let i = 0; i < depth; i++) frac *= 0.80;
    const nodeMs = totalMs * frac;
    const startMs = nodeMs * 0.75;
    const actRows = depth === 0 ? actualRows : node.estRows;
    analyzePart = ` (actual time=${startMs.toFixed(3)}..${nodeMs.toFixed(3)} rows=${actRows} loops=1)`;
  }

  lines.push(`${nodePrefix}${node.label}  ${costPart}${analyzePart}`);

  for (const ex of node.extras) {
    lines.push(extraIndent + ex);
  }

  for (const child of node.children) {
    lines.push(...renderPlanTree(child, depth + 1, analyze, actualRows, totalMs));
  }

  return lines;
}

function planToResult(lines: string[]): Result {
  return {
    columns: ['QUERY PLAN'],
    rows: lines.map(l => [l]),
    message: '',
    trace: lines,
  };
}

export function execExplainPlan(exec: any, stmt: Statement): Result {
  const planStart = performance.now();
  let lines: string[];
  if (stmt.kind === 'select') {
    lines = renderPlanTree(buildExplainTree(exec, stmt as SelectStatement), 0, false, 0, 0);
  } else {
    lines = [`${stmt.kind}  (cost=0.00..0.00 rows=0 width=0)`];
  }
  const planMs = performance.now() - planStart;
  lines.push(`Planning Time: ${planMs.toFixed(3)} ms`);
  return planToResult(lines);
}

export function execExplainAnalyze(exec: any, stmt: Statement): Result {
  const planStart = performance.now();
  let tree: PlanNode | null = null;
  if (stmt.kind === 'select') {
    tree = buildExplainTree(exec, stmt as SelectStatement);
  }
  const planMs = performance.now() - planStart;

  const execStart = performance.now();

  if (stmt.kind === 'select') {
    const sel = stmt as SelectStatement;
    const volcanoPlan = exec.planSelect(sel);
    volcanoPlan.root.open();
    let actualRows = 0;
    for (;;) {
      const row = volcanoPlan.root.next();
      if (row === null) break;
      actualRows++;
    }
    volcanoPlan.root.close();
    const execMs = performance.now() - execStart;

    let lines: string[];
    if (tree != null) {
      lines = renderPlanTree(tree, 0, true, actualRows, execMs);
    } else {
      lines = [`${stmt.kind}  (cost=0.00..0.00 rows=0 width=0) (actual time=${(execMs * 0.75).toFixed(3)}..${execMs.toFixed(3)} rows=${actualRows} loops=1)`];
    }
    lines.push(`Planning Time: ${planMs.toFixed(3)} ms`);
    lines.push(`Execution Time: ${execMs.toFixed(3)} ms`);
    return planToResult(lines);
  }

  // Non-SELECT fallback.
  const inner = exec.execute(stmt);
  const execMs = performance.now() - execStart;
  const actualRows = inner.rows.length;
  const lines = [
    `${stmt.kind}  (cost=0.00..0.00 rows=0 width=0) (actual time=${(execMs * 0.75).toFixed(3)}..${execMs.toFixed(3)} rows=${actualRows} loops=1)`,
    `Planning Time: ${planMs.toFixed(3)} ms`,
    `Execution Time: ${execMs.toFixed(3)} ms`,
  ];
  return planToResult(lines);
}
