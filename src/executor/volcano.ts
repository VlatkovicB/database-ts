// Volcano iterator model — mirrors internal/executor/volcano.go
//
// Each node implements the VolcanoNode interface: open() prepares state,
// next() emits one Row (null = EOF), close() releases resources.
// This mirrors PostgreSQL's executor node model.

import {
  Expression,
  SelectExpr,
  AggSelectExpr,
  ColSelectExpr,
  ExprSelectExpr,
  SelectStatement,
  OrderByExpr,
  JoinType,
  IdentExpr,
} from '../parser/ast';

import {
  Row,
  Tuple,
  Snapshot,
  Database,
  Table,
  compareVals,
} from '../storage/storage';

import {
  EvalCtx,
  CteEntry,
  AggSpec,
  SubqueryExecutor,
  evalExpr,
  boolVal,
  toFloat,
  exprString,
  collectAggFuncs,
  collectAggFuncsFromSelectExprs,
  resolveCol,
} from './expr';

// =============================================================================
// VolcanoNode interface
// =============================================================================

export interface VolcanoNode {
  open(): void;
  next(): Row | null;
  close(): void;
  nodeName(): string;
  nodeChildren(): VolcanoNode[];
  nodeId(): number;
}

// =============================================================================
// BufferReporter — implemented by scan nodes that track pages read
// =============================================================================

export interface BufferReporter {
  buffersRead(): number;
  bufferHits(): number;
  bufferMisses(): number;
  scanTable(): string;
}

// =============================================================================
// Step event logging (mirrors ExecLogger)
// =============================================================================

const MAX_STEP_EVENTS = 500;

export interface StepEvent {
  nodeId: number;
  nodeType: string;
  action: string;
  row?: Record<string, unknown>;
}

export class ExecLogger {
  events: StepEvent[] = [];
  truncated = false;
  private _nextId = 0;

  nextId(): number {
    return this._nextId++;
  }

  log(nodeId: number, nodeType: string, action: string, row: Row | null): void {
    if (this.events.length >= MAX_STEP_EVENTS) {
      this.truncated = true;
      return;
    }
    let r: Record<string, unknown> | undefined;
    if (row !== null && row !== undefined) {
      r = {};
      for (const [k, v] of row) {
        // Strip alias prefix for display
        const dotIdx = k.indexOf('.');
        const displayKey = dotIdx >= 0 ? k.slice(dotIdx + 1) : k;
        if (displayKey === 'ctid') continue;
        r[displayKey] = v;
      }
    }
    this.events.push({ nodeId, nodeType, action, row: r });
  }
}

// =============================================================================
// nodeBase — shared id + logger
// =============================================================================

class NodeBase {
  protected _id: number = 0;
  protected _log: ExecLogger | null = null;

  nodeId(): number { return this._id; }

  setLog(log: ExecLogger, id: number): void {
    this._log = log;
    this._id = id;
  }
}

// =============================================================================
// seqScan — reads all rows from one table, emits alias-prefixed rows
// =============================================================================

export class SeqScan extends NodeBase implements VolcanoNode, BufferReporter {
  private tuples: Tuple[] = [];
  private pos = 0;
  private _bufHits = 0;
  private _bufMisses = 0;

  constructor(
    private db: Database,
    private table: string,
    private alias: string,
    private snap: Snapshot | null,
    private xid: bigint,
  ) { super(); }

  nodeName(): string { return 'Seq Scan on ' + this.table; }
  nodeChildren(): VolcanoNode[] { return []; }
  buffersRead(): number { return this._bufHits + this._bufMisses; }
  bufferHits(): number { return this._bufHits; }
  bufferMisses(): number { return this._bufMisses; }
  scanTable(): string { return this.table; }

  open(): void {
    const [rawTuples, , , bpStats] = this.db.scanPages(this.table, this.snap, this.xid);
    const pfx = this.alias + '.';
    this.tuples = rawTuples.map((t: Tuple) => {
      const row: Row = new Map();
      for (const [k, v] of t.data) {
        row.set(pfx + k, v);
      }
      row.set(pfx + 'ctid', `(${t.pageNum},${t.slotNum})`);
      return { pageNum: t.pageNum, slotNum: t.slotNum, data: row, xmin: t.xmin, xmax: t.xmax };
    });
    this._bufHits = Number(bpStats.hits);
    this._bufMisses = Number(bpStats.misses);
    this.pos = 0;
  }

  next(): Row | null {
    if (this.pos >= this.tuples.length) return null;
    const row = this.tuples[this.pos++].data;
    this._log?.log(this._id, 'Seq Scan', 'scan', row);
    return row;
  }

  close(): void { this.tuples = []; }
}

export function newSeqScan(
  db: Database, table: string, alias: string,
  snap: Snapshot | null, xid: bigint,
): SeqScan {
  return new SeqScan(db, table, alias, snap, xid);
}

// =============================================================================
// parallelSeqScan (Gather node) — synchronous chunked scan that produces the
// same results as the Go goroutine version.
// Go uses goroutines + channels; here we process chunks sequentially and
// collect all results in order, matching the Go algorithm page-for-page.
// =============================================================================

export class ParallelSeqScan extends NodeBase implements VolcanoNode, BufferReporter {
  private tuples: Tuple[] = [];
  private pos = 0;
  private _bufHits = 0;
  private _bufMisses = 0;

  constructor(
    private db: Database,
    private table: string,
    private alias: string,
    private snap: Snapshot | null,
    private xid: bigint,
    private numWorkers: number,
  ) { super(); }

  nodeName(): string { return 'Parallel Seq Scan on ' + this.table; }
  nodeChildren(): VolcanoNode[] { return []; }
  buffersRead(): number { return this._bufHits + this._bufMisses; }
  bufferHits(): number { return this._bufHits; }
  bufferMisses(): number { return this._bufMisses; }
  scanTable(): string { return this.table; }

  open(): void {
    const [pageCount] = this.db.pageCount(this.table);
    if (pageCount === 0) {
      this.pos = 0;
      return;
    }

    let workers = this.numWorkers;
    if (workers > pageCount) workers = pageCount;
    const chunkSize = Math.ceil(pageCount / workers);

    const pfx = this.alias + '.';

    // Process chunks synchronously (mirrors Go goroutine results collected via channel)
    for (let i = 0; i < workers; i++) {
      const start = i * chunkSize;
      const end = start + chunkSize;
      if (start >= pageCount) break;

      const [tuples, bpStats] = this.db.scanPagesRange(this.table, start, end, this.snap, this.xid);
      this._bufHits += Number(bpStats.hits);
      this._bufMisses += Number(bpStats.misses);
      for (const t of tuples) {
        const row: Row = new Map();
        for (const [k, v] of t.data) {
          row.set(pfx + k, v);
        }
        row.set(pfx + 'ctid', `(${t.pageNum},${t.slotNum})`);
        this.tuples.push({ pageNum: t.pageNum, slotNum: t.slotNum, data: row, xmin: t.xmin, xmax: t.xmax });
      }
    }
    this.pos = 0;
  }

  next(): Row | null {
    if (this.pos >= this.tuples.length) return null;
    const row = this.tuples[this.pos++].data;
    this._log?.log(this._id, 'Parallel Seq Scan', 'scan', row);
    return row;
  }

  close(): void { this.tuples = []; }
}

export function newParallelSeqScan(
  db: Database, table: string, alias: string,
  snap: Snapshot | null, xid: bigint, numWorkers: number,
): ParallelSeqScan {
  return new ParallelSeqScan(db, table, alias, snap, xid, numWorkers);
}

// =============================================================================
// indexScan — reads rows from a B+ tree index, emits alias-prefixed rows
// =============================================================================

export class IndexScan extends NodeBase implements VolcanoNode, BufferReporter {
  private tuples: Tuple[] = [];
  private pos = 0;
  private _buffersRead = 0;

  constructor(
    private db: Database,
    private table: string,
    private alias: string,
    private indexName: string,
    private column: string,
    private lo: unknown,
    private loOp: string,
    private hi: unknown,
    private hiOp: string,
    private snap: Snapshot | null,
    private xid: bigint,
  ) { super(); }

  nodeName(): string { return 'Index Scan using ' + this.indexName + ' on ' + this.table; }
  nodeChildren(): VolcanoNode[] { return []; }
  buffersRead(): number { return this._buffersRead; }
  bufferHits(): number { return 0; }   // index pages not tracked via BPM
  bufferMisses(): number { return this._buffersRead; }
  scanTable(): string { return this.table; }

  open(): void {
    const [rawTuples, depth] = this.db.indexRangeScan(
      this.table, this.indexName, this.lo, this.loOp, this.hi, this.hiOp,
    );
    const pfx = this.alias + '.';
    const pagesHit = new Set<number>();
    this.tuples = [];
    for (const t of rawTuples) {
      if (!this.db.tupleVisible(t, this.snap, this.xid)) continue;
      const row: Row = new Map();
      for (const [k, v] of t.data) {
        row.set(pfx + k, v);
      }
      row.set(pfx + 'ctid', `(${t.pageNum},${t.slotNum})`);
      this.tuples.push({ pageNum: t.pageNum, slotNum: t.slotNum, data: row, xmin: t.xmin, xmax: t.xmax });
      pagesHit.add(t.pageNum);
    }
    this._buffersRead = depth + pagesHit.size;
    this.pos = 0;
  }

  next(): Row | null {
    if (this.pos >= this.tuples.length) return null;
    const row = this.tuples[this.pos++].data;
    this._log?.log(this._id, 'Index Scan', 'scan', row);
    return row;
  }

  close(): void { this.tuples = []; }
}

export function newIndexScan(
  db: Database, table: string, alias: string, indexName: string, column: string,
  lo: unknown, loOp: string, hi: unknown, hiOp: string,
  snap: Snapshot | null, xid: bigint,
): IndexScan {
  return new IndexScan(db, table, alias, indexName, column, lo, loOp, hi, hiOp, snap, xid);
}

// =============================================================================
// bitmapIndexScan — Bitmap Index Scan + Bitmap Heap Scan
//
// PostgreSQL Bitmap Index Scan workflow:
//  1. Scan the B+ tree and collect all matching TIDs (page, slot) into a bitmap.
//  2. Sort TIDs by page number so the heap is read in sequential order.
//  3. Fetch tuples from the heap in that sorted order (Bitmap Heap Scan).
//
// Benefit over plain Index Scan: when many tuples match (selectivity > ~10%),
// random I/O per tuple costs more than sorted sequential access.
// =============================================================================

export class BitmapIndexScan extends NodeBase implements VolcanoNode, BufferReporter {
  private tuples: Tuple[] = [];
  private pos = 0;
  private _pagesHit = 0;

  constructor(
    private db: Database,
    private table: string,
    private alias: string,
    private indexName: string,
    private column: string,
    private lo: unknown,
    private loOp: string,
    private hi: unknown,
    private hiOp: string,
    private snap: Snapshot | null,
    private xid: bigint,
  ) { super(); }

  nodeName(): string { return 'Bitmap Heap Scan on ' + this.table; }
  nodeChildren(): VolcanoNode[] { return []; }
  buffersRead(): number { return this._pagesHit; }
  bufferHits(): number { return 0; }
  bufferMisses(): number { return this._pagesHit; }
  scanTable(): string { return this.table; }

  open(): void {
    const [rawTuples, depth] = this.db.indexRangeScan(
      this.table, this.indexName, this.lo, this.loOp, this.hi, this.hiOp,
    );
    const pfx = this.alias + '.';
    const pages = new Set<number>();
    const visible: Tuple[] = [];

    for (const t of rawTuples) {
      if (!this.db.tupleVisible(t, this.snap, this.xid)) continue;
      const row: Row = new Map();
      for (const [k, v] of t.data) {
        row.set(pfx + k, v);
      }
      row.set(pfx + 'ctid', `(${t.pageNum},${t.slotNum})`);
      visible.push({ pageNum: t.pageNum, slotNum: t.slotNum, data: row, xmin: t.xmin, xmax: t.xmax });
      pages.add(t.pageNum);
    }

    // Sort by (pageNum, slotNum) — heap pages visited in sequential order
    visible.sort((a, b) => {
      if (a.pageNum !== b.pageNum) return a.pageNum - b.pageNum;
      return a.slotNum - b.slotNum;
    });

    this.tuples = visible;
    this._pagesHit = depth + pages.size;
    this.pos = 0;
  }

  next(): Row | null {
    if (this.pos >= this.tuples.length) return null;
    const row = this.tuples[this.pos++].data;
    this._log?.log(this._id, 'Bitmap Heap Scan', 'scan', row);
    return row;
  }

  close(): void { this.tuples = []; }
}

export function newBitmapIndexScan(
  db: Database, table: string, alias: string, indexName: string, column: string,
  lo: unknown, loOp: string, hi: unknown, hiOp: string,
  snap: Snapshot | null, xid: bigint,
): BitmapIndexScan {
  return new BitmapIndexScan(db, table, alias, indexName, column, lo, loOp, hi, hiOp, snap, xid);
}

// =============================================================================
// indexNestedLoopJoin — Index Nested Loop Join
//
// For each outer row, probes the inner table via a B+ tree index lookup on the
// join key — no full inner materialization. PG calls this a "parameterized
// inner path": the inner side is re-executed with parameters from the outer row.
//
// Cost advantage: O(outer * logN) vs O(outer * inner) for regular NL join.
// =============================================================================

export class IndexNestedLoopJoin extends NodeBase implements VolcanoNode {
  private outerRow: Row | null = null;
  private innerTuples: Tuple[] = [];
  private innerPos = 0;
  private innerColKeys: Set<string> = new Set();
  private emittedMatch = false;

  constructor(
    private db: Database,
    private outer: VolcanoNode,
    private innerTable: string,
    private innerAlias: string,
    private indexName: string,
    private innerCol: string,
    private outerKey: string,   // map key into outer row, e.g. "p.id"
    private fullCond: Expression | null,
    private joinType: JoinType,
    private snap: Snapshot | null,
    private xid: bigint,
  ) { super(); }

  nodeName(): string {
    return this.joinType === 'LEFT'
      ? 'Nested Loop Left Join (Index)'
      : 'Nested Loop (Index)';
  }
  nodeChildren(): VolcanoNode[] { return [this.outer]; }

  open(): void {
    const [t] = this.db.getTable(this.innerTable);
    const pfx = this.innerAlias + '.';
    this.innerColKeys = new Set();
    for (const col of (t?.columns ?? [])) {
      this.innerColKeys.add(pfx + col.name);
    }
    this.innerColKeys.add(pfx + 'ctid');

    this.outer.open();
    this.outerRow = null;
    this.innerPos = 1; // force outer advance on first next()
  }

  close(): void {
    this.outer.close();
    this.innerTuples = [];
  }

  next(): Row | null {
    const pfx = this.innerAlias + '.';
    while (true) {
      if (this.innerPos >= this.innerTuples.length) {
        // LEFT JOIN: emit null-padded row for unmatched outer
        if (this.outerRow !== null && !this.emittedMatch && this.joinType === 'LEFT') {
          const nr: Row = new Map(this.outerRow);
          for (const k of this.innerColKeys) nr.set(k, null);
          this.outerRow = null;
          return nr;
        }
        const or = this.outer.next();
        if (or === null) return null;
        this.outerRow = or;

        const outerVal = or.get(this.outerKey);
        if (outerVal === null || outerVal === undefined) {
          this.innerTuples = [];
          this.innerPos = 0;
          this.emittedMatch = false;
          continue;
        }

        const [rawTuples] = this.db.indexRangeScan(
          this.innerTable, this.indexName, outerVal, '=', null, '',
        );
        const inner: Tuple[] = [];
        for (const t of rawTuples) {
          if (!this.db.tupleVisible(t, this.snap, this.xid)) continue;
          const row: Row = new Map();
          for (const [k, v] of t.data) {
            row.set(pfx + k, v);
          }
          row.set(pfx + 'ctid', `(${t.pageNum},${t.slotNum})`);
          inner.push({ pageNum: t.pageNum, slotNum: t.slotNum, data: row, xmin: t.xmin, xmax: t.xmax });
        }
        this.innerTuples = inner;
        this.innerPos = 0;
        this.emittedMatch = false;
      }

      if (this.innerPos >= this.innerTuples.length) {
        this.outerRow = null;
        continue;
      }

      const innerRow = this.innerTuples[this.innerPos++].data;
      const combined: Row = new Map([...this.outerRow!, ...innerRow]);

      if (this.fullCond !== null) {
        if (!boolVal(evalExpr(this.fullCond, combined, null))) continue;
      }
      this.emittedMatch = true;
      this._log?.log(this._id, 'Nested Loop (Index)', 'match', combined);
      return combined;
    }
  }
}

export function newIndexNestedLoopJoin(
  db: Database, outer: VolcanoNode,
  innerTable: string, innerAlias: string, indexName: string,
  innerCol: string, outerKey: string, fullCond: Expression | null,
  joinType: JoinType, snap: Snapshot | null, xid: bigint,
): IndexNestedLoopJoin {
  return new IndexNestedLoopJoin(
    db, outer, innerTable, innerAlias, indexName,
    innerCol, outerKey, fullCond, joinType, snap, xid,
  );
}

// =============================================================================
// filterNode — passes rows where predicate evaluates to true
// =============================================================================

export class FilterNode extends NodeBase implements VolcanoNode {
  constructor(
    private child: VolcanoNode,
    private pred: Expression,
    private ctx: EvalCtx | null = null,
  ) { super(); }

  nodeName(): string { return 'Filter'; }
  nodeChildren(): VolcanoNode[] { return [this.child]; }
  open(): void { this.child.open(); }
  close(): void { this.child.close(); }

  next(): Row | null {
    while (true) {
      const row = this.child.next();
      if (row === null) return null;
      const pass = boolVal(evalExpr(this.pred, row, this.ctx));
      if (pass) {
        this._log?.log(this._id, 'Filter', 'pass', row);
        return row;
      }
      this._log?.log(this._id, 'Filter', 'reject', row);
    }
  }
}

export function newFilterNode(child: VolcanoNode, pred: Expression, ctx?: EvalCtx | null): FilterNode {
  return new FilterNode(child, pred, ctx ?? null);
}

// =============================================================================
// nestedLoopJoin — materialises the inner side, probes once per outer row
// =============================================================================

export class NestedLoopJoin extends NodeBase implements VolcanoNode {
  private innerRows: Row[] = [];
  private innerKeys: Set<string> = new Set();
  private outerRow: Row | null = null;
  private innerPos = 0;
  private emittedMatch = false;

  constructor(
    private outer: VolcanoNode,
    private inner: VolcanoNode,
    private cond: Expression | null,
    private joinType: JoinType,
  ) { super(); }

  nodeName(): string {
    return this.joinType === 'LEFT' ? 'Nested Loop Left Join' : 'Nested Loop';
  }
  nodeChildren(): VolcanoNode[] { return [this.outer, this.inner]; }

  open(): void {
    // Materialise inner side (build phase)
    this.inner.open();
    this.innerKeys = new Set();
    this.innerRows = [];
    while (true) {
      const row = this.inner.next();
      if (row === null) break;
      for (const k of row.keys()) this.innerKeys.add(k);
      this.innerRows.push(row);
    }
    this.inner.close();

    this.outer.open();
    this.outerRow = null;
    this.innerPos = this.innerRows.length; // trigger outer advance on first next()
  }

  close(): void {
    this.outer.close();
    this.innerRows = [];
    this.innerKeys = new Set();
  }

  next(): Row | null {
    while (true) {
      if (this.innerPos >= this.innerRows.length) {
        // LEFT JOIN: emit null-padded row for previous unmatched outer row
        if (this.outerRow !== null && !this.emittedMatch && this.joinType === 'LEFT') {
          const nr: Row = new Map(this.outerRow);
          for (const k of this.innerKeys) nr.set(k, null);
          this.outerRow = null;
          return nr;
        }
        const or = this.outer.next();
        if (or === null) return null; // outer EOF
        this.outerRow = or;
        this.innerPos = 0;
        this.emittedMatch = false;
      }

      if (this.innerPos >= this.innerRows.length) {
        this.outerRow = null;
        continue;
      }

      const innerRow = this.innerRows[this.innerPos++];
      const combined: Row = new Map([...this.outerRow!, ...innerRow]);

      if (this.cond !== null) {
        if (!boolVal(evalExpr(this.cond, combined, null))) continue;
      }
      this.emittedMatch = true;
      this._log?.log(this._id, 'Nested Loop', 'match', combined);
      return combined;
    }
  }
}

export function newNestedLoopJoin(
  outer: VolcanoNode, inner: VolcanoNode,
  cond: Expression | null, joinType: JoinType,
): NestedLoopJoin {
  return new NestedLoopJoin(outer, inner, cond, joinType);
}

// =============================================================================
// hashAggregate — groups rows and computes aggregate functions
// =============================================================================

interface AggGroup {
  keyVals: Map<string, unknown>;
  rows: Row[];
}

export class HashAggregate extends NodeBase implements VolcanoNode {
  private output: Row[] = [];
  private pos = 0;
  private built = false;

  constructor(
    private child: VolcanoNode,
    private groupBy: string[],
    private selectExprs: SelectExpr[],
    private having: Expression | null,
  ) { super(); }

  nodeName(): string { return 'HashAggregate'; }
  nodeChildren(): VolcanoNode[] { return [this.child]; }
  open(): void { this.child.open(); }
  close(): void {
    this.child.close();
    this.output = [];
  }

  private build(): void {
    const groups: AggGroup[] = [];
    const groupIdx = new Map<string, number>();

    while (true) {
      const row = this.child.next();
      if (row === null) break;

      const keyParts: string[] = [];
      for (const col of this.groupBy) {
        const val = evalExpr({ kind: 'ident', table: '', name: col } as IdentExpr, row, null);
        keyParts.push(String(val));
      }
      const groupKey = this.groupBy.length === 0 ? '__all__' : keyParts.join('\x00');

      const existing = groupIdx.get(groupKey);
      if (existing !== undefined) {
        groups[existing].rows.push(row);
      } else {
        const kv = new Map<string, unknown>();
        for (const col of this.groupBy) {
          const val = evalExpr({ kind: 'ident', table: '', name: col } as IdentExpr, row, null);
          kv.set(col, val);
        }
        groupIdx.set(groupKey, groups.length);
        groups.push({ keyVals: kv, rows: [row] });
      }
    }

    // No GROUP BY with zero input still emits one row (e.g. COUNT(*) = 0)
    if (this.groupBy.length === 0 && groups.length === 0) {
      groups.push({ keyVals: new Map(), rows: [] });
    }

    // Collect aggregate specs from SELECT list and HAVING
    const needed = new Map<string, AggSpec>();
    collectAggFuncsFromSelectExprs(this.selectExprs, needed);
    if (this.having !== null) collectAggFuncs(this.having, needed);

    // Build synthetic row per group, apply HAVING
    for (const g of groups) {
      const sr: Row = new Map();
      for (const [k, v] of g.keyVals) sr.set(k, v);
      for (const [key, spec] of needed) {
        sr.set(key, computeAggFromRows(spec.fn, spec.arg, g.rows));
      }
      if (this.having !== null) {
        if (!boolVal(evalExpr(this.having, sr, null))) continue;
      }
      this.output.push(sr);
    }
    this.built = true;
  }

  next(): Row | null {
    if (!this.built) this.build();
    if (this.pos >= this.output.length) return null;
    const row = this.output[this.pos++];
    this._log?.log(this._id, 'HashAggregate', 'emit', row);
    return row;
  }
}

export function newHashAggregate(
  child: VolcanoNode, groupBy: string[],
  exprs: SelectExpr[], having: Expression | null,
): HashAggregate {
  return new HashAggregate(child, groupBy, exprs, having);
}

// computeAggFromRows resolves column values via evalExpr (handles alias.col keys)
export function computeAggFromRows(fn: string, arg: string, rows: Row[]): unknown {
  switch (fn) {
    case 'COUNT': {
      if (arg === '*') return BigInt(rows.length);
      let count = 0n;
      for (const row of rows) {
        const val = evalExpr({ kind: 'ident', table: '', name: arg } as IdentExpr, row, null);
        if (val !== null && val !== undefined) count++;
      }
      return count;
    }
    case 'SUM': {
      let sum = 0;
      for (const row of rows) {
        const val = evalExpr({ kind: 'ident', table: '', name: arg } as IdentExpr, row, null);
        const [f, ok] = toFloat(val);
        if (!ok) throw new Error(`SUM: column "${arg}" is not numeric`);
        sum += f;
      }
      return sum;
    }
    case 'AVG': {
      if (rows.length === 0) return null;
      let sum = 0;
      for (const row of rows) {
        const val = evalExpr({ kind: 'ident', table: '', name: arg } as IdentExpr, row, null);
        const [f, ok] = toFloat(val);
        if (!ok) throw new Error(`AVG: column "${arg}" is not numeric`);
        sum += f;
      }
      return sum / rows.length;
    }
    case 'MIN': {
      if (rows.length === 0) return null;
      let minVal: unknown = undefined;
      for (const row of rows) {
        const val = evalExpr({ kind: 'ident', table: '', name: arg } as IdentExpr, row, null);
        if (minVal === undefined) { minVal = val; continue; }
        const [lf, lok] = toFloat(minVal);
        const [rf, rok] = toFloat(val);
        if (lok && rok) {
          if (rf < lf) minVal = val;
        } else if (String(val) < String(minVal)) {
          minVal = val;
        }
      }
      return minVal ?? null;
    }
    case 'MAX': {
      if (rows.length === 0) return null;
      let maxVal: unknown = undefined;
      for (const row of rows) {
        const val = evalExpr({ kind: 'ident', table: '', name: arg } as IdentExpr, row, null);
        if (maxVal === undefined) { maxVal = val; continue; }
        const [lf, lok] = toFloat(maxVal);
        const [rf, rok] = toFloat(val);
        if (lok && rok) {
          if (rf > lf) maxVal = val;
        } else if (String(val) > String(maxVal)) {
          maxVal = val;
        }
      }
      return maxVal ?? null;
    }
    default:
      throw new Error(`unknown aggregate function "${fn}"`);
  }
}

// =============================================================================
// sortNode — materialises child output, then emits sorted rows
// =============================================================================

export class SortNode extends NodeBase implements VolcanoNode {
  private rows: Row[] = [];
  private pos = 0;
  private built = false;

  constructor(
    private child: VolcanoNode,
    private orderBy: OrderByExpr[],
  ) { super(); }

  nodeName(): string { return 'Sort'; }
  nodeChildren(): VolcanoNode[] { return [this.child]; }
  open(): void { this.child.open(); }
  close(): void {
    this.child.close();
    this.rows = [];
  }

  next(): Row | null {
    if (!this.built) {
      while (true) {
        const row = this.child.next();
        if (row === null) break;
        this.rows.push(row);
      }
      // Stable sort by ORDER BY expressions
      this.rows.sort((a, b) => {
        for (const ob of this.orderBy) {
          const va = resolveCol(a, ob.col);
          const vb = resolveCol(b, ob.col);
          const cmp = compareVals(va, vb);
          if (cmp === 0) continue;
          return ob.desc ? -cmp : cmp;
        }
        return 0;
      });
      this.built = true;
    }
    if (this.pos >= this.rows.length) return null;
    const row = this.rows[this.pos++];
    this._log?.log(this._id, 'Sort', 'emit', row);
    return row;
  }
}

export function newSortNode(child: VolcanoNode, orderBy: OrderByExpr[]): SortNode {
  return new SortNode(child, orderBy);
}

// =============================================================================
// limitNode — emits at most N rows after skipping offset rows
// =============================================================================

export class LimitNode extends NodeBase implements VolcanoNode {
  private seen = 0n;
  private emitted = 0n;
  private limit: bigint;
  private offset: bigint;

  constructor(
    private child: VolcanoNode,
    limitVal: bigint | null,
    offsetVal: bigint | null,
  ) {
    super();
    this.limit = limitVal ?? -1n;
    this.offset = offsetVal ?? 0n;
  }

  nodeName(): string { return 'Limit'; }
  nodeChildren(): VolcanoNode[] { return [this.child]; }
  open(): void { this.child.open(); }
  close(): void { this.child.close(); }

  next(): Row | null {
    while (true) {
      if (this.limit >= 0n && this.emitted >= this.limit) return null;
      const row = this.child.next();
      if (row === null) return null;
      this.seen++;
      if (this.seen <= this.offset) {
        this._log?.log(this._id, 'Limit', 'skip', row);
        continue;
      }
      this.emitted++;
      this._log?.log(this._id, 'Limit', 'pass', row);
      return row;
    }
  }
}

export function newLimitNode(child: VolcanoNode, limit: bigint | null, offset: bigint | null): LimitNode {
  return new LimitNode(child, limit, offset);
}

// =============================================================================
// distinctNode — deduplicates rows by value fingerprint
// =============================================================================

export class DistinctNode extends NodeBase implements VolcanoNode {
  private seen: Set<string> = new Set();

  constructor(private child: VolcanoNode) { super(); }

  nodeName(): string { return 'Unique'; }
  nodeChildren(): VolcanoNode[] { return [this.child]; }

  open(): void {
    this.seen = new Set();
    this.child.open();
  }
  close(): void { this.child.close(); }

  next(): Row | null {
    while (true) {
      const row = this.child.next();
      if (row === null) return null;
      // Build a stable fingerprint from all entries
      const key = JSON.stringify(Array.from(row.entries()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
      if (!this.seen.has(key)) {
        this.seen.add(key);
        this._log?.log(this._id, 'Unique', 'pass', row);
        return row;
      }
      this._log?.log(this._id, 'Unique', 'dedup', row);
    }
  }
}

export function newDistinctNode(child: VolcanoNode): DistinctNode {
  return new DistinctNode(child);
}

// =============================================================================
// projectNode — column projection (not in Go volcano.go but mentioned in spec)
// Projects rows to only the columns named in selectExprs.
// =============================================================================

export class ProjectNode extends NodeBase implements VolcanoNode {
  constructor(
    private child: VolcanoNode,
    private selectExprs: SelectExpr[],
    private ctx: EvalCtx | null = null,
  ) { super(); }

  nodeName(): string { return 'Project'; }
  nodeChildren(): VolcanoNode[] { return [this.child]; }
  open(): void { this.child.open(); }
  close(): void { this.child.close(); }

  next(): Row | null {
    const row = this.child.next();
    if (row === null) return null;

    if (!this.selectExprs || this.selectExprs.length === 0) return row;

    const out: Row = new Map();
    for (const expr of this.selectExprs) {
      if (expr.kind === 'col') {
        const col = (expr as ColSelectExpr).col;
        if (col.endsWith('.*')) {
          // Expand alias.* — include all keys with this prefix
          const pfx = col.slice(0, col.length - 1); // "alias."
          for (const [k, v] of row) {
            if (k.startsWith(pfx)) out.set(k, v);
          }
        } else {
          const val = resolveCol(row, col) ?? row.get(col);
          out.set(col, val ?? null);
        }
      } else if (expr.kind === 'agg') {
        const agg = expr as AggSelectExpr;
        const key = agg.func + '(' + agg.arg + ')';
        out.set(key, row.get(key) ?? null);
      } else if (expr.kind === 'expr') {
        const ex = expr as ExprSelectExpr;
        const val = evalExpr(ex.expr, row, this.ctx);
        out.set(ex.alias, val);
      }
    }
    return out;
  }
}

export function newProjectNode(child: VolcanoNode, exprs: SelectExpr[], ctx?: EvalCtx | null): ProjectNode {
  return new ProjectNode(child, exprs, ctx ?? null);
}

// =============================================================================
// hashJoin — builds a hash table on inner (right) side, probes per outer row
//
// Faster than Nested Loop when both sides are large and no index exists on
// the inner join key. Build cost: O(inner). Probe cost: O(outer).
// =============================================================================

function extractHashJoinKeys(cond: Expression | null, innerAlias: string): {
  outerExpr: Expression | null;
  innerExpr: Expression | null;
  canHash: boolean;
} {
  if (!innerAlias || !cond || cond.kind !== 'binary') {
    return { outerExpr: null, innerExpr: null, canHash: false };
  }
  const bin = cond as import('../parser/ast').BinaryExpr;
  if (bin.op !== '=') return { outerExpr: null, innerExpr: null, canHash: false };
  if (bin.left.kind !== 'ident' || bin.right.kind !== 'ident') {
    return { outerExpr: null, innerExpr: null, canHash: false };
  }
  const leftId = bin.left as IdentExpr;
  const rightId = bin.right as IdentExpr;
  if (leftId.table === innerAlias) {
    return { outerExpr: bin.right, innerExpr: bin.left, canHash: true };
  }
  if (rightId.table === innerAlias) {
    return { outerExpr: bin.left, innerExpr: bin.right, canHash: true };
  }
  return { outerExpr: null, innerExpr: null, canHash: false };
}

export class HashJoin extends NodeBase implements VolcanoNode {
  // build phase
  private hashTab = new Map<string, Row[]>();
  private fallback: Row[] = [];
  private innerKeys: Set<string> = new Set();
  private outerExpr: Expression | null = null;
  private innerExpr: Expression | null = null;
  private canHash = false;

  // probe state
  private outerRow: Row | null = null;
  private probeList: Row[] = [];
  private probePos = 0;
  private emittedMatch = false;

  constructor(
    private outer: VolcanoNode,
    private inner: VolcanoNode,
    private innerAlias: string,
    private cond: Expression | null,
    private joinType: JoinType,
  ) { super(); }

  nodeName(): string {
    return this.joinType === 'LEFT' ? 'Hash Join Left Join' : 'Hash Join';
  }
  nodeChildren(): VolcanoNode[] { return [this.outer, this.inner]; }

  open(): void {
    this.inner.open();

    const { outerExpr, innerExpr, canHash } = extractHashJoinKeys(this.cond, this.innerAlias);
    this.canHash = canHash;
    this.outerExpr = outerExpr;
    this.innerExpr = innerExpr;
    this.hashTab = new Map();
    this.innerKeys = new Set();

    // Build phase: scan inner once and hash on the join key
    while (true) {
      const row = this.inner.next();
      if (row === null) break;
      for (const k of row.keys()) this.innerKeys.add(k);
      if (this.canHash && this.innerExpr !== null) {
        try {
          const keyVal = evalExpr(this.innerExpr, row, null);
          if (keyVal !== null && keyVal !== undefined) {
            const key = String(keyVal);
            const bucket = this.hashTab.get(key) ?? [];
            bucket.push(row);
            this.hashTab.set(key, bucket);
            continue;
          }
        } catch { /* fall through to fallback */ }
      }
      this.fallback.push(row);
    }
    this.inner.close();

    this.outer.open();
    this.outerRow = null;
    this.probeList = [];
    this.probePos = 0;
  }

  close(): void {
    this.outer.close();
    this.hashTab = new Map();
    this.fallback = [];
    this.innerKeys = new Set();
  }

  next(): Row | null {
    while (true) {
      // Drain remaining probe matches from the current outer row
      while (this.probePos < this.probeList.length) {
        const innerRow = this.probeList[this.probePos++];
        const combined: Row = new Map([...this.outerRow!, ...innerRow]);

        if (this.cond !== null) {
          if (!boolVal(evalExpr(this.cond, combined, null))) continue;
        }
        this.emittedMatch = true;
        this._log?.log(this._id, 'Hash Join', 'match', combined);
        return combined;
      }

      // LEFT JOIN: emit a null-padded row for an unmatched outer row
      if (this.outerRow !== null && !this.emittedMatch && this.joinType === 'LEFT') {
        const nr: Row = new Map(this.outerRow);
        for (const k of this.innerKeys) nr.set(k, null);
        this.outerRow = null;
        return nr;
      }

      // Advance to next outer row
      const or = this.outer.next();
      if (or === null) return null;
      this.outerRow = or;
      this.emittedMatch = false;

      // Probe phase: look up hash table or fall back to linear scan
      if (this.canHash && this.outerExpr !== null) {
        try {
          const keyVal = evalExpr(this.outerExpr, or, null);
          if (keyVal !== null && keyVal !== undefined) {
            this.probeList = this.hashTab.get(String(keyVal)) ?? [];
            this.probePos = 0;
            continue;
          }
        } catch { /* fall through to fallback */ }
      }
      this.probeList = this.fallback;
      this.probePos = 0;
    }
  }
}

export function newHashJoin(
  outer: VolcanoNode, inner: VolcanoNode,
  innerAlias: string, cond: Expression | null, joinType: JoinType,
): HashJoin {
  return new HashJoin(outer, inner, innerAlias, cond, joinType);
}

// =============================================================================
// cteSeqScan — iterates over a pre-materialized CTE result set
// =============================================================================

export class CteSeqScan extends NodeBase implements VolcanoNode {
  private pos = 0;

  constructor(
    private rows: Row[],
    private alias: string,
  ) { super(); }

  open(): void { this.pos = 0; }
  close(): void { /* no-op */ }
  nodeName(): string { return 'CTE Scan'; }
  nodeChildren(): VolcanoNode[] { return []; }

  next(): Row | null {
    if (this.pos >= this.rows.length) return null;
    const src = this.rows[this.pos++];
    if (!this.alias) return src;

    // Re-prefix bare column names with the outer alias (e.g. "username" -> "t.username")
    const pfx = this.alias + '.';
    const out: Row = new Map();
    for (const [k, v] of src) {
      if (k.includes('.')) {
        out.set(k, v); // already prefixed
      } else {
        out.set(pfx + k, v);
      }
    }
    return out;
  }
}

export function newCteSeqScan(rows: Row[], alias: string): CteSeqScan {
  return new CteSeqScan(rows, alias);
}

// =============================================================================
// lateralJoin — re-evaluates a LATERAL subquery for each outer row
// =============================================================================

export class LateralJoin extends NodeBase implements VolcanoNode {
  private outerRow: Row | null = null;
  private innerRows: Row[] = [];
  private innerIdx = 0;
  private emittedMatch = false;
  private colsKnown = false;
  private innerCols: string[];

  constructor(
    private outer: VolcanoNode,
    private subq: SelectStatement,
    private alias: string,
    private joinType: JoinType,
    private onCond: Expression | null,
    private exec: SubqueryExecutor,
    private ctes: Map<string, CteEntry> | null,
  ) {
    super();
    this.innerCols = lateralColsFromAST(subq);
  }

  nodeName(): string {
    return this.joinType === 'LEFT'
      ? 'Nested Loop Left Join (LATERAL)'
      : 'Nested Loop (LATERAL)';
  }
  nodeChildren(): VolcanoNode[] { return [this.outer]; }
  open(): void { this.outer.open(); }
  close(): void { this.outer.close(); }

  next(): Row | null {
    while (true) {
      if (this.innerIdx >= this.innerRows.length) {
        // LEFT JOIN: emit null-padded outer for unmatched row
        if (this.outerRow !== null && !this.emittedMatch && this.joinType === 'LEFT') {
          const nr: Row = new Map(this.outerRow);
          for (const col of this.innerCols) {
            nr.set(this.alias + '.' + col, null);
          }
          this.outerRow = null;
          return nr;
        }
        // Advance outer
        const outerRow = this.outer.next();
        if (outerRow === null) return null;
        this.outerRow = outerRow;
        const ctx: EvalCtx = { exec: this.exec, outer: outerRow, ctes: this.ctes };
        this.innerRows = this.exec.materializeSubquery(this.subq, ctx);
        this.innerIdx = 0;
        this.emittedMatch = false;
      }

      if (this.innerIdx >= this.innerRows.length) continue;

      const innerRow = this.innerRows[this.innerIdx++];

      // Merge outer + re-keyed inner rows
      const merged: Row = new Map(this.outerRow!);
      if (!this.colsKnown) this.innerCols = [];
      for (const [k, v] of innerRow) {
        const dotIdx = k.lastIndexOf('.');
        const col = dotIdx >= 0 ? k.slice(dotIdx + 1) : k;
        merged.set(this.alias + '.' + col, v);
        if (!this.colsKnown) this.innerCols.push(col);
      }
      this.colsKnown = true;

      // Apply ON condition
      if (this.onCond !== null) {
        const ctx: EvalCtx = { exec: this.exec, outer: this.outerRow!, ctes: this.ctes };
        if (!boolVal(evalExpr(this.onCond, merged, ctx))) continue;
      }
      this.emittedMatch = true;
      return merged;
    }
  }
}

/** Derives projected column names from a subquery's SELECT list for LEFT LATERAL null-padding. */
function lateralColsFromAST(subq: SelectStatement | null): string[] {
  if (!subq || !subq.exprs) return [];
  const cols: string[] = [];
  for (const expr of subq.exprs) {
    if (expr.kind === 'col') {
      const col = (expr as ColSelectExpr).col;
      const dotIdx = col.lastIndexOf('.');
      cols.push(dotIdx >= 0 ? col.slice(dotIdx + 1) : col);
    } else if (expr.kind === 'agg') {
      const agg = expr as AggSelectExpr;
      cols.push(agg.func + '(' + agg.arg + ')');
    } else if (expr.kind === 'expr') {
      const ex = expr as ExprSelectExpr;
      if (ex.alias) cols.push(ex.alias);
    }
  }
  return cols;
}

export function newLateralJoin(
  outer: VolcanoNode, subq: SelectStatement, alias: string,
  joinType: JoinType, onCond: Expression | null,
  exec: SubqueryExecutor, ctes: Map<string, CteEntry> | null,
): LateralJoin {
  return new LateralJoin(outer, subq, alias, joinType, onCond, exec, ctes);
}

// =============================================================================
// subqueryScan — iterates over a derived table's materialized rows
// Same logic as CteSeqScan but shows "Subquery Scan" in EXPLAIN.
// =============================================================================

export class SubqueryScan extends NodeBase implements VolcanoNode {
  private pos = 0;

  constructor(
    private rows: Row[],
    private alias: string,
  ) { super(); }

  open(): void { this.pos = 0; }
  close(): void { /* no-op */ }
  nodeName(): string { return 'Subquery Scan on ' + this.alias; }
  nodeChildren(): VolcanoNode[] { return []; }

  next(): Row | null {
    if (this.pos >= this.rows.length) return null;
    const src = this.rows[this.pos++];
    const pfx = this.alias + '.';
    const out: Row = new Map();
    for (const [k, v] of src) {
      if (k.includes('.')) {
        out.set(k, v);
      } else {
        out.set(pfx + k, v);
      }
    }
    return out;
  }
}

export function newSubqueryScan(rows: Row[], alias: string): SubqueryScan {
  return new SubqueryScan(rows, alias);
}

// =============================================================================
// instrumentedNode — wraps any Node to collect per-node timing and row counts
// =============================================================================

export class InstrumentedNode implements VolcanoNode {
  private totalMs = 0;
  actualRows = 0;

  constructor(private child: VolcanoNode) {}

  nodeName(): string { return this.child.nodeName(); }
  nodeChildren(): VolcanoNode[] { return this.child.nodeChildren(); }
  nodeId(): number { return this.child.nodeId(); }

  open(): void {
    const t = performance.now();
    this.child.open();
    this.totalMs += performance.now() - t;
  }

  next(): Row | null {
    const t = performance.now();
    const row = this.child.next();
    this.totalMs += performance.now() - t;
    if (row !== null) this.actualRows++;
    return row;
  }

  close(): void {
    const t = performance.now();
    this.child.close();
    this.totalMs += performance.now() - t;
  }

  ms(): number { return this.totalMs; }
}

export function newInstrumentedNode(child: VolcanoNode): InstrumentedNode {
  return new InstrumentedNode(child);
}

// =============================================================================
// NodeTreeDesc — EXPLAIN tree representation
// =============================================================================

export interface NodeTreeDesc {
  id: number;
  nodeType: string;
  children?: NodeTreeDesc[];
}

export function buildNodeTree(node: VolcanoNode): NodeTreeDesc {
  const desc: NodeTreeDesc = { id: node.nodeId(), nodeType: node.nodeName() };
  const children = node.nodeChildren();
  if (children.length > 0) {
    desc.children = children.map(buildNodeTree);
  }
  return desc;
}
