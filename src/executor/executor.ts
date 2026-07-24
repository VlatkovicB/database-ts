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

  // buildVolcanoRoot, newFilterNode, newLateralJoinNode, newHashAggregateNode,
  // newSortNode, newLimitNode, newSeqScan, buildPhysRelPlanNode:
  // These are injected by volcano.ts at startup. They are declared here so TypeScript
  // knows about them — concrete implementations are set on the prototype or instance
  // by the volcano layer.
  buildVolcanoRoot!: (
    sel: import('../parser/ast').SelectStatement,
    ctes: Map<string, CteEntry> | null,
    singleWhere: import('../parser/ast').Expression | null,
    snap: Snapshot | null,
    xid: bigint
  ) => any;

  newFilterNode!: (root: any, where: import('../parser/ast').Expression, ctx: EvalCtx) => any;

  newLateralJoinNode!: (
    root: any,
    j: import('../parser/ast').JoinClause,
    ctes: Map<string, CteEntry> | null
  ) => any;

  newHashAggregateNode!: (
    root: any,
    groupBy: string[],
    exprs: import('../parser/ast').SelectExpr[] | null,
    having: import('../parser/ast').Expression | null
  ) => any;

  newSortNode!: (root: any, orderBy: import('../parser/ast').OrderByExpr[]) => any;

  newLimitNode!: (root: any, limit: bigint | null, offset: bigint | null) => any;

  newSeqScan!: (db: Database, table: string, alias: string, snap: Snapshot | null, xid: bigint) => any;

  buildPhysRelPlanNode!: (sel: import('../parser/ast').SelectStatement) => any;

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
