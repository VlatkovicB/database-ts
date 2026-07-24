// =============================================================================
// Cost-based query planner — port of internal/executor/planner.go
// =============================================================================
//
// Separates planning from execution: the planner produces a PhysRelation tree
// that captures the cheapest physical operators, then physRelToVolcano converts
// it into a live volcano node tree. This mirrors PostgreSQL's plan/execute split.
//
// Cost model (PG-style constants):
//   Seq Scan:   pages * seqPageCost + rows * cpuTupleCost
//   Index Scan: depth * randPageCost + matchRows * (randPageCost + cpuIndexCost)
//   Nested Loop: left.total + left.rows * right.total + output * cpuTupleCost
//   Hash Join:  (right.total + right.rows * cpuOpCost)   <- build phase
//             + (left.total  + left.rows  * cpuOpCost)   <- probe phase
//             + output * cpuTupleCost

import {
  SelectStatement,
  Expression,
  BinaryExpr,
  IdentExpr,
  JoinType,
} from '../parser/ast';
import { Database, Snapshot } from '../storage/storage';
import {
  VolcanoNode,
  newSeqScan,
  newParallelSeqScan,
  newIndexScan,
  newBitmapIndexScan,
  newFilterNode,
  newNestedLoopJoin,
  newHashJoin,
  newIndexNestedLoopJoin,
  newCteSeqScan,
  newSubqueryScan,
  ExecLogger,
} from './volcano';
import { CteEntry } from './expr';
import { IndexPlan, findIndexPlan } from './select';
import { selectivityExpr } from './selectivity';
import { PlanNode, exprToSQL, planWidth as explainPlanWidth } from './explain';

// =============================================================================
// Cost constants (PG-style)
// =============================================================================

const seqPageCost      = 1.0;
const randPageCost     = 4.0;
const cpuTupleCost     = 0.01;
const cpuOperatorCost  = 0.0025;
const cpuIndexCost     = 0.005;
export const planWidth = 64;
const parallelSetupCost  = 10.0;
const parallelMinRows    = 1000.0;
const maxParallelWorkers = 4;

// Number of logical CPUs — JS is single-threaded but we model parallelism for cost
const numCPU = 4;

// =============================================================================
// Enums
// =============================================================================

export const enum PhysScanType {
  physSeqScan    = 0,
  physIndexScan  = 1,
  physBitmapScan = 2,
}

export const enum PhysJoinAlg {
  physNestedLoop      = 0,
  physHashJoin        = 1,
  physIndexNestedLoop = 2,
}

// =============================================================================
// PhysRelation — one node in the physical plan tree
// =============================================================================

export interface PhysRelation {
  // Leaf (scan) fields — set when left == null
  table:    string;
  alias:    string;
  scanType: PhysScanType;
  idxPlan:  IndexPlan | null;
  filter:   Expression | null;

  // Join fields — set when left != null
  joinAlg:  PhysJoinAlg;
  joinType: JoinType;
  joinCond: Expression | null;
  left:     PhysRelation | null;
  right:    PhysRelation | null;

  // Index Nested Loop fields — set when joinAlg == physIndexNestedLoop
  innerIndexName: string;
  innerIndexCol:  string;
  outerJoinKey:   string;

  // Cost estimates
  startupCost:     number;
  totalCost:       number;
  estRows:         number;
  width:           number;
  parallelWorkers: number;
}

function isJoin(rel: PhysRelation): boolean {
  return rel.left !== null;
}

// =============================================================================
// TableRef — describes one table participating in a query
// =============================================================================

export interface TableRef {
  table:    string;
  alias:    string;
  joinType: JoinType;
  cond:     Expression | null;
}

// =============================================================================
// Qplanner — holds state for one planning session
// =============================================================================

export class Qplanner {
  private db: Database;
  private ctes: Map<string, CteEntry> | null;

  constructor(exec: { db: Database }, ctes: Map<string, CteEntry> | null) {
    this.db = exec.db;
    this.ctes = ctes;
  }

  // planScan returns the cheapest physical access path for a single table.
  planScan(table: string, alias: string, where: Expression | null): PhysRelation {
    // CTE table reference — return a lightweight estimate
    if (this.ctes !== null) {
      const entry = this.ctes.get(table);
      if (entry !== undefined) {
        const estRows = Math.max(1, entry.rows.length);
        return {
          table, alias,
          scanType: PhysScanType.physSeqScan,
          idxPlan: null,
          filter: where,
          joinAlg: PhysJoinAlg.physNestedLoop,
          joinType: 'INNER',
          joinCond: null,
          left: null, right: null,
          innerIndexName: '', innerIndexCol: '', outerJoinKey: '',
          startupCost: 0,
          totalCost: estRows * cpuTupleCost,
          estRows,
          width: planWidth,
          parallelWorkers: 0,
        };
      }
    }

    const [rows] = this.db.rowCount(table);
    let [pages] = this.db.pageCount(table);
    if (pages < 1) pages = 1;
    const stats = this.db.getTableStats(table);

    let sel = 1.0;
    if (where !== null) {
      sel = selectivityExpr(where, table, stats);
    }
    const estRows = Math.max(1, rows * sel);
    const seqCost = pages * seqPageCost + rows * cpuTupleCost;

    // Default: Seq Scan with a filter node on top if there's a WHERE predicate.
    let best: PhysRelation = {
      table, alias,
      scanType: PhysScanType.physSeqScan,
      idxPlan: null,
      filter: where,
      joinAlg: PhysJoinAlg.physNestedLoop,
      joinType: 'INNER',
      joinCond: null,
      left: null, right: null,
      innerIndexName: '', innerIndexCol: '', outerJoinKey: '',
      startupCost: 0,
      totalCost: seqCost,
      estRows,
      width: planWidth,
      parallelWorkers: 0,
    };

    // Index Scan vs Bitmap Scan: only considered when WHERE clause is indexable.
    if (where !== null) {
      const ip = findIndexPlan(this.db, table, where);
      if (ip !== null) {
        const depth = this.db.getIndexDepth(table, ip.indexName);
        const idxSel = selectivityExpr(where, table, stats);
        const idxRows = Math.max(1, rows * idxSel);
        const selectivityRatio = idxRows / Math.max(1, rows);
        const matchPages = pages * selectivityRatio;

        const indexCost =
          depth * seqPageCost * 0.1 +
          matchPages * seqPageCost +
          idxRows * cpuIndexCost;

        if (indexCost < best.totalCost) {
          // Point lookup → Index Scan; range query → Bitmap Scan
          const scanType = ip.loOp === '=' && ip.hi == null
            ? PhysScanType.physIndexScan
            : PhysScanType.physBitmapScan;
          best = {
            table, alias,
            scanType,
            idxPlan: ip,
            filter: ip.residual,
            joinAlg: PhysJoinAlg.physNestedLoop,
            joinType: 'INNER',
            joinCond: null,
            left: null, right: null,
            innerIndexName: '', innerIndexCol: '', outerJoinKey: '',
            startupCost: 0,
            totalCost: indexCost,
            estRows: idxRows,
            width: planWidth,
            parallelWorkers: 0,
          };
        }
      }
    }

    // Parallel SeqScan: cheaper than serial when table is large enough.
    if (best.scanType === PhysScanType.physSeqScan && best.estRows > parallelMinRows) {
      let nWorkers = numCPU;
      if (nWorkers > maxParallelWorkers) nWorkers = maxParallelWorkers;
      const parallelTotal = parallelSetupCost + seqCost / nWorkers;
      if (parallelTotal < best.totalCost) {
        best = {
          ...best,
          startupCost: parallelSetupCost,
          totalCost: parallelTotal,
          parallelWorkers: nWorkers,
        };
      }
    }

    return best;
  }

  // planJoinPair returns the cheaper of Nested Loop Join and Hash Join.
  planJoinPair(
    left: PhysRelation,
    right: PhysRelation,
    joinType: JoinType,
    cond: Expression | null,
  ): PhysRelation {
    const joinSel = 0.1;
    const outRows = Math.max(1, left.estRows * right.estRows * joinSel);

    // Nested Loop
    const nlTotal = left.totalCost + left.estRows * right.totalCost + outRows * cpuTupleCost;
    const nl: PhysRelation = {
      table: '', alias: '',
      scanType: PhysScanType.physSeqScan,
      idxPlan: null,
      filter: null,
      joinAlg: PhysJoinAlg.physNestedLoop,
      joinType,
      joinCond: cond,
      left, right,
      innerIndexName: '', innerIndexCol: '', outerJoinKey: '',
      startupCost: left.startupCost,
      totalCost: nlTotal,
      estRows: outRows,
      width: left.width + right.width,
      parallelWorkers: 0,
    };

    // Hash Join
    const buildCost = right.totalCost + right.estRows * cpuOperatorCost;
    const probeCost = left.totalCost + left.estRows * cpuOperatorCost;
    const hjTotal = buildCost + probeCost + outRows * cpuTupleCost;
    const hj: PhysRelation = {
      table: '', alias: '',
      scanType: PhysScanType.physSeqScan,
      idxPlan: null,
      filter: null,
      joinAlg: PhysJoinAlg.physHashJoin,
      joinType,
      joinCond: cond,
      left, right,
      innerIndexName: '', innerIndexCol: '', outerJoinKey: '',
      startupCost: buildCost,
      totalCost: hjTotal,
      estRows: outRows,
      width: left.width + right.width,
      parallelWorkers: 0,
    };

    let best = nl.totalCost <= hj.totalCost ? nl : hj;

    // Index Nested Loop: only for INNER JOIN when inner is a leaf with an index
    if (joinType === 'INNER' && cond !== null && !isJoin(right)) {
      const [outerKey, innerCol, ok] = extractJoinColForInner(cond, right.alias);
      if (ok) {
        const [indexName, found] = this.db.findIndexForColumn(right.table, innerCol);
        if (found) {
          const depth = this.db.getIndexDepth(right.table, indexName);
          const [innerRows] = this.db.rowCount(right.table);
          let avgMatchRows: number;
          if (innerRows > 0) {
            avgMatchRows = Math.max(1, right.estRows / Math.max(1, innerRows));
          } else {
            avgMatchRows = 1;
          }
          const idxNLCost =
            left.totalCost +
            left.estRows * (depth * seqPageCost * 0.1 + avgMatchRows * cpuIndexCost);
          if (idxNLCost < best.totalCost) {
            best = {
              table: '', alias: '',
              scanType: PhysScanType.physSeqScan,
              idxPlan: null,
              filter: null,
              joinAlg: PhysJoinAlg.physIndexNestedLoop,
              joinType,
              joinCond: cond,
              left, right,
              innerIndexName: indexName,
              innerIndexCol:  innerCol,
              outerJoinKey:   outerKey,
              startupCost: left.startupCost,
              totalCost: idxNLCost,
              estRows: outRows,
              width: left.width + right.width,
              parallelWorkers: 0,
            };
          }
        }
      }
    }

    return best;
  }

  // planRelations chooses the cheapest join order and algorithm for a list of tables.
  planRelations(refs: TableRef[], singleTableWhere: Expression | null): PhysRelation {
    if (refs.length === 0) {
      // Should not happen; return a dummy
      return {
        table: '', alias: '',
        scanType: PhysScanType.physSeqScan,
        idxPlan: null, filter: null,
        joinAlg: PhysJoinAlg.physNestedLoop, joinType: 'INNER', joinCond: null,
        left: null, right: null,
        innerIndexName: '', innerIndexCol: '', outerJoinKey: '',
        startupCost: 0, totalCost: 0, estRows: 1, width: planWidth, parallelWorkers: 0,
      };
    }

    const scans: PhysRelation[] = refs.map((ref, i) => {
      const w = (i === 0 && refs.length === 1) ? singleTableWhere : null;
      return this.planScan(ref.table, ref.alias, w);
    });

    if (refs.length === 1) {
      return scans[0];
    }

    let result = scans[0];
    for (let i = 1; i < refs.length; i++) {
      const ref = refs[i];
      const right = scans[i];

      let opt = this.planJoinPair(result, right, ref.joinType, ref.cond);

      // For INNER JOINs, also price the reversed order
      if (ref.joinType === 'INNER') {
        const swap = this.planJoinPair(right, result, ref.joinType, ref.cond);
        if (swap.totalCost < opt.totalCost) {
          opt = swap;
        }
      }
      result = opt;
    }
    return result;
  }
}

// =============================================================================
// extractJoinColForInner
// =============================================================================

export function extractJoinColForInner(
  cond: Expression,
  innerAlias: string,
): [outerKey: string, innerCol: string, ok: boolean] {
  if (cond.kind !== 'binary') return ['', '', false];
  const bin = cond as BinaryExpr;
  if (bin.op !== '=') return ['', '', false];
  if (bin.left.kind !== 'ident' || bin.right.kind !== 'ident') return ['', '', false];
  const leftId  = bin.left  as IdentExpr;
  const rightId = bin.right as IdentExpr;
  if (rightId.table === innerAlias) {
    return [leftId.table + '.' + leftId.name, rightId.name, true];
  }
  if (leftId.table === innerAlias) {
    return [rightId.table + '.' + rightId.name, leftId.name, true];
  }
  return ['', '', false];
}

// =============================================================================
// buildTableRefs — converts SelectStatement into a flat TableRef slice,
//                  excluding LATERAL joins (handled separately).
// =============================================================================

export function buildTableRefs(sel: SelectStatement): TableRef[] {
  const alias = sel.alias !== '' ? sel.alias : sel.table;
  const refs: TableRef[] = [{ table: sel.table, alias, joinType: 'INNER', cond: null }];
  for (const j of sel.joins) {
    if (j.lateral) continue;
    const ja = j.alias !== '' ? j.alias : j.table;
    refs.push({ table: j.table, alias: ja, joinType: j.type, cond: j.condition });
  }
  return refs;
}

// =============================================================================
// physRelToVolcano — converts a PhysRelation tree into a live volcano node tree
// =============================================================================

export function physRelToVolcano(
  rel: PhysRelation,
  db: Database,
  snap: Snapshot | null,
  xid: bigint,
  ctes: Map<string, CteEntry> | null,
): VolcanoNode {
  if (!isJoin(rel)) {
    // CTE / derived table check
    if (ctes !== null) {
      const entry = ctes.get(rel.table);
      if (entry !== undefined) {
        let n: VolcanoNode = entry.derived
          ? newSubqueryScan(entry.rows, rel.alias)
          : newCteSeqScan(entry.rows, rel.alias);
        if (rel.filter !== null) {
          n = newFilterNode(n, rel.filter);
        }
        return n;
      }
    }

    let n: VolcanoNode;
    switch (rel.scanType) {
      case PhysScanType.physIndexScan: {
        const ip = rel.idxPlan!;
        n = newIndexScan(
          db, rel.table, rel.alias,
          ip.indexName, ip.column,
          ip.lo, ip.loOp, ip.hi, ip.hiOp,
          snap, xid,
        );
        break;
      }
      case PhysScanType.physBitmapScan: {
        const ip = rel.idxPlan!;
        n = newBitmapIndexScan(
          db, rel.table, rel.alias,
          ip.indexName, ip.column,
          ip.lo, ip.loOp, ip.hi, ip.hiOp,
          snap, xid,
        );
        break;
      }
      default: {
        // physSeqScan
        if (rel.parallelWorkers > 0) {
          n = newParallelSeqScan(db, rel.table, rel.alias, snap, xid, rel.parallelWorkers);
        } else {
          n = newSeqScan(db, rel.table, rel.alias, snap, xid);
        }
        break;
      }
    }
    if (rel.filter !== null) {
      n = newFilterNode(n, rel.filter);
    }
    return n;
  }

  const left = physRelToVolcano(rel.left!, db, snap, xid, ctes);

  // Index Nested Loop: don't create a right volcano node; index is probed per outer row
  if (rel.joinAlg === PhysJoinAlg.physIndexNestedLoop) {
    return newIndexNestedLoopJoin(
      db, left,
      rel.right!.table, rel.right!.alias,
      rel.innerIndexName, rel.innerIndexCol, rel.outerJoinKey,
      rel.joinCond, rel.joinType,
      snap, xid,
    );
  }

  const right = physRelToVolcano(rel.right!, db, snap, xid, ctes);

  const innerAlias = !isJoin(rel.right!) ? rel.right!.alias : '';

  if (rel.joinAlg === PhysJoinAlg.physHashJoin) {
    return newHashJoin(left, right, innerAlias, rel.joinCond, rel.joinType);
  }
  return newNestedLoopJoin(left, right, rel.joinCond, rel.joinType);
}

// =============================================================================
// physRelToPlanNode — converts a PhysRelation tree into a PlanNode for EXPLAIN
// =============================================================================

export function physRelToPlanNode(
  rel: PhysRelation,
  db: Database,
  ctes: Map<string, CteEntry> | null,
): PlanNode {
  if (!isJoin(rel)) {
    // CTE / derived table label for EXPLAIN
    if (ctes !== null) {
      const entry = ctes.get(rel.table);
      if (entry !== undefined) {
        const label = entry.derived
          ? 'Subquery Scan on ' + rel.table
          : 'CTE Scan on ' + rel.table;
        return {
          label,
          estStartup: 0,
          estTotal: rel.totalCost,
          estRows: Math.max(1, Math.floor(rel.estRows)),
          width: rel.width,
          extras: [],
          children: [],
        };
      }
    }

    let label = 'Seq Scan on ' + rel.table;
    const extras: string[] = [];

    switch (rel.scanType) {
      case PhysScanType.physIndexScan: {
        label = `Index Scan using ${rel.idxPlan!.indexName} on ${rel.table}`;
        extras.push(`Index Cond: (${rel.table}.${rel.idxPlan!.column})`);
        if (rel.filter !== null) {
          extras.push('Filter: ' + exprToSQL(rel.filter));
        }
        break;
      }
      case PhysScanType.physBitmapScan: {
        const bisNode: PlanNode = {
          label: `Bitmap Index Scan on ${rel.idxPlan!.indexName}`,
          estStartup: 0,
          estTotal: rel.totalCost * 0.3,
          estRows: Math.max(1, Math.floor(rel.estRows)),
          width: 0,
          extras: [`Index Cond: (${rel.table}.${rel.idxPlan!.column})`],
          children: [],
        };
        const bhsExtras: string[] = [];
        if (rel.filter !== null) {
          bhsExtras.push('Recheck Cond: ' + exprToSQL(rel.filter));
        }
        return {
          label: `Bitmap Heap Scan on ${rel.table}`,
          estStartup: 0,
          estTotal: rel.totalCost,
          estRows: Math.max(1, Math.floor(rel.estRows)),
          width: rel.width,
          extras: bhsExtras,
          children: [bisNode],
        };
      }
      default: {
        // physSeqScan
        let [pc] = db.pageCount(rel.table);
        if (pc < 1) pc = 1;
        if (rel.parallelWorkers > 0) {
          const innerExtras: string[] = [`Heap Pages: ${pc}`];
          if (rel.filter !== null) {
            innerExtras.push('Filter: ' + exprToSQL(rel.filter));
          }
          const innerNode: PlanNode = {
            label: 'Parallel Seq Scan on ' + rel.table,
            estStartup: 0,
            estTotal: (rel.totalCost - parallelSetupCost) * rel.parallelWorkers,
            estRows: Math.max(1, Math.floor(rel.estRows)),
            width: rel.width,
            extras: innerExtras,
            children: [],
          };
          return {
            label: 'Gather',
            estStartup: parallelSetupCost,
            estTotal: rel.totalCost,
            estRows: Math.max(1, Math.floor(rel.estRows)),
            width: rel.width,
            extras: [`Workers Planned: ${rel.parallelWorkers}`],
            children: [innerNode],
          };
        }
        extras.push(`Heap Pages: ${pc}`);
        if (rel.filter !== null) {
          extras.push('Filter: ' + exprToSQL(rel.filter));
        }
        break;
      }
    }

    return {
      label,
      estStartup: 0,
      estTotal: rel.totalCost,
      estRows: Math.max(1, Math.floor(rel.estRows)),
      width: rel.width,
      extras,
      children: [],
    };
  }

  // Join node
  const leftNode = physRelToPlanNode(rel.left!, db, ctes);

  if (rel.joinAlg === PhysJoinAlg.physIndexNestedLoop) {
    const depth = db.getIndexDepth(rel.right!.table, rel.innerIndexName);
    const innerNode: PlanNode = {
      label: `Index Scan using ${rel.innerIndexName} on ${rel.right!.table}`,
      estStartup: 0,
      estTotal: depth * seqPageCost * 0.1,
      estRows: 1,
      width: planWidth,
      extras: [
        `Index Cond: (${rel.innerIndexCol} = ${rel.outerJoinKey})`,
        '(executed per outer row)',
      ],
      children: [],
    };
    return {
      label: 'Nested Loop (Index)',
      estStartup: rel.startupCost,
      estTotal: rel.totalCost,
      estRows: Math.max(1, Math.floor(rel.estRows)),
      width: rel.width,
      extras: [],
      children: [leftNode, innerNode],
    };
  }

  const rightNode = physRelToPlanNode(rel.right!, db, ctes);

  let algLabel = 'Nested Loop';
  if (rel.joinAlg === PhysJoinAlg.physHashJoin) algLabel = 'Hash Join';
  if (rel.joinType === 'LEFT') algLabel += ' Left Join';

  const condKey = rel.joinAlg === PhysJoinAlg.physHashJoin ? 'Hash Cond' : 'Join Filter';
  const extras: string[] = [];
  if (rel.joinCond !== null) {
    extras.push(condKey + ': ' + exprToSQL(rel.joinCond));
  }

  return {
    label: algLabel,
    estStartup: rel.startupCost,
    estTotal: rel.totalCost,
    estRows: Math.max(1, Math.floor(rel.estRows)),
    width: rel.width,
    extras,
    children: [leftNode, rightNode],
  };
}
