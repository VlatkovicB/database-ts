// =============================================================================
// Executor — port of internal/executor/executor.go
// Main entry point for SQL statement execution.
// =============================================================================

import { Statement } from '../parser/ast';
import { Database, Row, Snapshot } from '../storage/storage';
import { Transaction } from '../storage/mvcc';
import { execInsert, execUpdate, execDelete } from './dml';
import { execCreate, execDrop, execCreateIndex, execDropIndex, execAnalyze } from './ddl';
import { execBegin, execCommit, execRollback, execVacuum } from './transaction';
import { execSelect, planSelect, planSelectWithCTEs, ExecPlan } from './select';
import { execExplainPlan, execExplainAnalyze } from './explain';
import { materializeSubquery } from './subquery';
import { CteEntry, EvalCtx } from './expr';
import {
  newFilterNode,
  newLateralJoin,
  newHashAggregate,
  newSortNode,
  newLimitNode,
  newSeqScan,
} from './volcano';
import {
  Qplanner,
  buildTableRefs,
  physRelToVolcano,
  physRelToPlanNode,
} from './planner';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface Result {
  columns: string[];
  rows: unknown[][];
  message: string;
  trace: string[];
  indexSuggestions?: IndexSuggestion[];
}

export interface IndexSuggestion {
  reason: string;
  sql: string;
}

// ---------------------------------------------------------------------------
// Executor class
// ---------------------------------------------------------------------------

export class Executor {
  db: Database;
  currentTx: Transaction | null = null;

  constructor(db: Database) {
    this.db = db;
  }

  // currentXID returns the active transaction ID, or 0n for auto-commit mode.
  currentXID(): bigint {
    return this.currentTx?.id ?? 0n;
  }

  // currentSnapshot returns the active transaction's snapshot, or null for auto-commit.
  currentSnapshot(): Snapshot | null {
    return this.currentTx ? this.currentTx.snapshot : null;
  }

  // execute is the main entry point.
  execute(stmt: Statement): Result {
    try {
      return this.executeInner(stmt);
    } catch (err: any) {
      // Re-throw all errors (deadlock handling would go here if LockManager is ported)
      throw err;
    }
  }

  private executeInner(stmt: Statement): Result {
    switch (stmt.kind) {
      case 'select':
        return execSelect(this, stmt);
      case 'insert':
        return execInsert(this, stmt);
      case 'update':
        return execUpdate(this, stmt);
      case 'delete':
        return execDelete(this, stmt);
      case 'createTable':
        return execCreate(this, stmt);
      case 'dropTable':
        return execDrop(this, stmt);
      case 'explain':
        return this.execExplain(stmt);
      case 'createIndex':
        return execCreateIndex(this, stmt);
      case 'dropIndex':
        return execDropIndex(this, stmt);
      case 'analyze':
        return execAnalyze(this, stmt);
      case 'begin':
        return execBegin(this);
      case 'commit':
        return execCommit(this);
      case 'rollback':
        return execRollback(this);
      case 'vacuum':
        return execVacuum(this, stmt);
      default:
        throw new Error(`unknown statement type: ${(stmt as any).kind}`);
    }
  }

  private execExplain(stmt: import('../parser/ast').ExplainStatement): Result {
    if (stmt.analyze) {
      return execExplainAnalyze(this, stmt.stmt);
    }
    return execExplainPlan(this, stmt.stmt);
  }

  // ---------------------------------------------------------------------------
  // Subquery materialization — delegates to subquery.ts
  // ---------------------------------------------------------------------------

  materializeSubquery(q: import('../parser/ast').SelectStatement, ctx: EvalCtx | null): Row[] {
    return materializeSubquery(this, q, ctx);
  }

  // ---------------------------------------------------------------------------
  // Plan building — called by select.ts and explain.ts
  // These methods bridge to the volcano layer (volcano.ts) which is not ported here.
  // The volcano layer is expected to inject these implementations at runtime.
  // ---------------------------------------------------------------------------

  planSelect(sel: import('../parser/ast').SelectStatement): ExecPlan {
    return planSelect(this, sel);
  }

  planSelectWithCTEs(
    sel: import('../parser/ast').SelectStatement,
    ctes: Map<string, CteEntry> | null
  ): ExecPlan {
    return planSelectWithCTEs(this, sel, ctes);
  }

  // ---------------------------------------------------------------------------
  // Volcano node factory methods — implemented directly using planner.ts / volcano.ts
  // ---------------------------------------------------------------------------

  buildVolcanoRoot(
    sel: import('../parser/ast').SelectStatement,
    ctes: Map<string, CteEntry> | null,
    singleWhere: import('../parser/ast').Expression | null,
    snap: Snapshot | null,
    xid: bigint,
  ): any {
    const p = new Qplanner(this, ctes);
    const refs = buildTableRefs(sel);
    const physRel = p.planRelations(refs, singleWhere);
    return physRelToVolcano(physRel, this.db, snap, xid, ctes);
  }

  newFilterNode(root: any, where: import('../parser/ast').Expression, ctx: EvalCtx): any {
    return newFilterNode(root, where, ctx);
  }

  newLateralJoinNode(
    root: any,
    j: import('../parser/ast').JoinClause,
    ctes: Map<string, CteEntry> | null,
  ): any {
    return newLateralJoin(root, j.joinSubquery!, j.alias, j.type, j.condition, this, ctes);
  }

  newHashAggregateNode(
    root: any,
    groupBy: string[],
    exprs: import('../parser/ast').SelectExpr[] | null,
    having: import('../parser/ast').Expression | null,
  ): any {
    return newHashAggregate(root, groupBy, exprs ?? [], having);
  }

  newSortNode(root: any, orderBy: import('../parser/ast').OrderByExpr[]): any {
    return newSortNode(root, orderBy);
  }

  newLimitNode(root: any, limit: bigint | null, offset: bigint | null): any {
    return newLimitNode(root, limit, offset);
  }

  newSeqScan(db: Database, table: string, alias: string, snap: Snapshot | null, xid: bigint): any {
    return newSeqScan(db, table, alias, snap, xid);
  }

  buildPhysRelPlanNode(sel: import('../parser/ast').SelectStatement): any {
    const p = new Qplanner(this, null);
    const refs = buildTableRefs(sel);
    const physRel = p.planRelations(refs, sel.where);
    return physRelToPlanNode(physRel, this.db, null);
  }

  rowCount(tableName: string): number {
    const [n] = this.db.rowCount(tableName);
    return n;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function newExecutor(db: Database): Executor {
  return new Executor(db);
}
