import {
  Row,
  Column,
  Page,
  Tuple,
  newPage,
  estimateTupleSize,
  tuplesPerPage as calcTuplesPerPage,
} from "./page";
import { BTree } from "./btree";
import { TableStats, computeStats } from "./stats";
import { TxManager, Snapshot, Visible } from "./mvcc";
import { WALManager, WALDatabase, WALTableLike } from "./wal";
import { BufferPool, BPStats, PageID, DefaultBufPoolSize } from "./bufmgr";
import { LockManager, LockMode, RowLockID } from "./lock";
import { checkPrimaryKey, checkForeignKeys, checkFKRestrict } from "./constraints";

export type { Row, Column, Page, Tuple } from "./page";
export type { Snapshot } from "./mvcc";
export type { BPStats } from "./bufmgr";

export interface FKConstraint {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface Index {
  name: string;
  column: string;
  tree: BTree;
}

export interface IndexInfo {
  name: string;
  column: string;
  size: number;
}

export interface TableInfo {
  name: string;
  columns: Column[];
  rowCount: number;
}

/** Table represents an in-memory heap table with pages, indexes, and statistics. */
export class Table implements WALTableLike {
  name: string;
  columns: Column[];
  foreignKeys: FKConstraint[] = [];
  pages: Page[] = [];
  tuplesPerPageCount: number;
  indexes: Map<string, Index> = new Map();
  stats: TableStats | null = null;

  constructor(name: string, columns: Column[]) {
    this.name = name;
    this.columns = columns;
    this.tuplesPerPageCount = calcTuplesPerPage(columns);
  }

  /** scanTuples calls fn for every tuple in the table, stopping early if fn returns false. */
  scanTuples(fn: (tpl: Tuple) => boolean): void {
    for (const pg of this.pages) {
      for (const tpl of pg.tuples) {
        if (!fn(tpl)) return;
      }
    }
  }

  updateIndexes(tuple: Tuple): void {
    if (tuple.xmax !== 0n) return; // don't index dead tuples
    for (const idx of this.indexes.values()) {
      const val = tuple.data.get(idx.column);
      if (val !== undefined) {
        idx.tree.insert(val, tuple);
      }
    }
  }

  rebuildIndexes(): void {
    for (const idx of this.indexes.values()) {
      idx.tree = new BTree();
      for (let pageNum = 0; pageNum < this.pages.length; pageNum++) {
        const pg = this.pages[pageNum];
        for (let slotNum = 0; slotNum < pg.tuples.length; slotNum++) {
          const tpl = pg.tuples[slotNum];
          if (tpl.xmax !== 0n) continue; // don't index dead tuples
          const val = tpl.data.get(idx.column);
          if (val !== undefined) {
            idx.tree.insert(val, {
              pageNum,
              slotNum,
              data: tpl.data,
              xmin: tpl.xmin,
              xmax: tpl.xmax,
            });
          }
        }
      }
    }
  }
}

/** Database is the main in-memory database, holding all tables and subsystems. */
export class Database implements WALDatabase {
  tables: Map<string, Table> = new Map();
  txManager: TxManager;
  wal: WALManager;
  lockMgr: LockManager;
  bpm: BufferPool;

  constructor() {
    this.txManager = new TxManager();
    this.wal = new WALManager();
    this.lockMgr = new LockManager();
    this.bpm = new BufferPool(DefaultBufPoolSize);
  }

  createTable(name: string, cols: Column[]): Error | null {
    if (this.tables.has(name)) {
      return new Error(`table "${name}" already exists`);
    }
    this.tables.set(name, new Table(name, cols));
    return null;
  }

  dropTable(name: string): Error | null {
    if (!this.tables.has(name)) {
      return new Error(`table "${name}" does not exist`);
    }
    this.tables.delete(name);
    return null;
  }

  getTable(name: string): [Table, null] | [null, Error] {
    const t = this.tables.get(name);
    if (!t) return [null, new Error(`table "${name}" does not exist`)];
    return [t, null];
  }

  setForeignKeys(tableName: string, fks: FKConstraint[]): Error | null {
    const t = this.tables.get(tableName);
    if (!t) return new Error(`table "${tableName}" does not exist`);
    t.foreignKeys = fks;
    return null;
  }

  /**
   * insert appends a new tuple to the table.
   * xid is the inserting transaction ID (0n means auto-committed / pre-MVCC — always visible).
   */
  insert(tableName: string, row: Row, xid: bigint): Error | null {
    const t = this.tables.get(tableName);
    if (!t) return new Error(`table "${tableName}" does not exist`);

    const pkErr = checkPrimaryKey(t, row);
    if (pkErr) return pkErr;

    const fkErr = checkForeignKeys(t, row, (name) => this.tables.get(name));
    if (fkErr) return fkErr;

    const tupleSize = estimateTupleSize(t.columns);
    let inserted: Tuple;

    if (t.pages.length > 0) {
      const last = t.pages[t.pages.length - 1];
      if (last.header.hasRoom(tupleSize)) {
        const slotNum = last.tuples.length;
        const pageNum = t.pages.length - 1;
        inserted = { pageNum, slotNum, data: row, xmin: xid, xmax: 0n };
        last.tuples.push(inserted);
        last.header.addTuple(tupleSize);
        t.updateIndexes(inserted);
        this.bpm.invalidatePage({ table: tableName, pageNum: inserted.pageNum });
        return null;
      }
    }

    const pageNum = t.pages.length;
    inserted = { pageNum, slotNum: 0, data: row, xmin: xid, xmax: 0n };
    const pg = newPage();
    pg.tuples.push(inserted);
    pg.header.addTuple(tupleSize);
    t.pages.push(pg);
    t.updateIndexes(inserted);
    this.bpm.invalidatePage({ table: tableName, pageNum: inserted.pageNum });
    return null;
  }

  /**
   * scan returns visible rows and the column schema.
   * snap==null means auto-commit mode: shows tuples where xmin==0n or committed AND xmax==0n.
   */
  scan(tableName: string, snap: Snapshot | null, xid: bigint): [Row[], Column[], Error | null] {
    const t = this.tables.get(tableName);
    if (!t) return [[], [], new Error(`table "${tableName}" does not exist`)];
    const rows: Row[] = [];
    t.scanTuples((tuple) => {
      if (this.tupleVisible(tuple, snap, xid)) rows.push(tuple.data);
      return true;
    });
    return [rows, t.columns, null];
  }

  /** tupleVisible applies MVCC visibility rules to a single tuple. */
  tupleVisible(tuple: Tuple, snap: Snapshot | null, xid: bigint): boolean {
    if (snap === null) {
      // Auto-commit mode
      const xminOK = tuple.xmin === 0n || this.txManager.isCommitted(tuple.xmin);
      if (!xminOK) return false;
      const xmaxDead = tuple.xmax !== 0n && this.txManager.isCommitted(tuple.xmax);
      return !xmaxDead;
    }
    return Visible(tuple.xmin, tuple.xmax, snap, xid, this.txManager);
  }

  /**
   * scanPages returns visible tuples with physical locations, plus total page count and buffer stats.
   * snap==null means auto-commit mode.
   */
  scanPages(
    tableName: string,
    snap: Snapshot | null,
    xid: bigint
  ): [Tuple[], Column[], number, BPStats, Error | null] {
    const t = this.tables.get(tableName);
    if (!t) return [[], [], 0, new BPStats(), new Error(`table "${tableName}" does not exist`)];
    const tuples: Tuple[] = [];
    const stats = new BPStats();
    for (let i = 0; i < t.pages.length; i++) {
      const id: PageID = { table: tableName, pageNum: i };
      const [slot, hit] = this.bpm.fetchPage(id);
      if (hit) stats.hits++;
      else stats.misses++;
      for (const tpl of t.pages[i].tuples) {
        if (this.tupleVisible(tpl, snap, xid)) tuples.push(tpl);
      }
      this.bpm.unpin(slot, false);
    }
    return [tuples, t.columns, t.pages.length, stats, null];
  }

  /**
   * scanPagesRange returns visible tuples from pages[startPage:endPage].
   * Used by parallel workers — each worker scans a disjoint page range.
   * Node.js is single-threaded so this runs synchronously (same chunked-scan semantics).
   */
  scanPagesRange(
    tableName: string,
    startPage: number,
    endPage: number,
    snap: Snapshot | null,
    xid: bigint
  ): [Tuple[], BPStats, Error | null] {
    const t = this.tables.get(tableName);
    if (!t) return [[], new BPStats(), new Error(`table "${tableName}" does not exist`)];
    if (startPage < 0) startPage = 0;
    if (endPage > t.pages.length) endPage = t.pages.length;
    const tuples: Tuple[] = [];
    const stats = new BPStats();
    for (let i = startPage; i < endPage; i++) {
      const id: PageID = { table: tableName, pageNum: i };
      const [slot, hit] = this.bpm.fetchPage(id);
      if (hit) stats.hits++;
      else stats.misses++;
      for (const tpl of t.pages[i].tuples) {
        if (this.tupleVisible(tpl, snap, xid)) tuples.push(tpl);
      }
      this.bpm.unpin(slot, false);
    }
    return [tuples, stats, null];
  }

  rowCount(tableName: string): [number, Error | null] {
    const t = this.tables.get(tableName);
    if (!t) return [0, new Error(`table "${tableName}" does not exist`)];
    let count = 0;
    for (const pg of t.pages) count += pg.tuples.length;
    return [count, null];
  }

  pageCount(tableName: string): [number, Error | null] {
    const t = this.tables.get(tableName);
    if (!t) return [0, new Error(`table "${tableName}" does not exist`)];
    return [t.pages.length, null];
  }

  /**
   * updateRows implements MVCC-style update: marks matching tuples dead (xmax=xid)
   * and inserts new tuple versions with xmin=xid.
   * xid==0n falls back to in-place mutation for auto-commit mode.
   * Returns [count, oldRows, newRows, error] for WAL logging by the caller.
   */
  updateRows(
    tableName: string,
    predicate: (row: Row) => boolean,
    update: (row: Row) => Row,
    xid: bigint
  ): [number, Row[], Row[], Error | null] {
    const t = this.tables.get(tableName);
    if (!t) return [0, [], [], new Error(`table "${tableName}" does not exist`)];

    // Auto-commit path: no row-level locking needed
    if (xid === 0n) {
      let count = 0;
      const oldRows: Row[] = [];
      for (const pg of t.pages) {
        for (const tpl of pg.tuples) {
          if (tpl.xmax !== 0n) continue;
          if (!predicate(tpl.data)) continue;
          const oldCopy: Row = new Map(tpl.data);
          tpl.data = update(tpl.data);
          oldRows.push(oldCopy);
          count++;
        }
      }
      t.rebuildIndexes();
      // For auto-commit, return same rows (in-place update; newRows == oldRows)
      return [count, oldRows, oldRows, null];
    }

    // MVCC path: scan → acquire row locks → write
    // Step 1: scan to find candidate tuples
    interface Candidate {
      pageNum: number;
      slotNum: number;
      data: Row;
    }
    const candidates: Candidate[] = [];
    for (let i = 0; i < t.pages.length; i++) {
      for (let j = 0; j < t.pages[i].tuples.length; j++) {
        const tpl = t.pages[i].tuples[j];
        if (tpl.xmax !== 0n) continue;
        if (predicate(tpl.data)) candidates.push({ pageNum: i, slotNum: j, data: tpl.data });
      }
    }

    // Step 2: acquire ExclusiveLock on each candidate row
    const locked: RowLockID[] = [];
    for (const c of candidates) {
      const rowID: RowLockID = { table: tableName, pageNum: c.pageNum, slotNum: c.slotNum };
      const err = this.lockMgr.acquire(xid, rowID, LockMode.ExclusiveLock);
      if (err) {
        for (const r of locked) this.lockMgr.release(xid, r);
        return [0, [], [], err];
      }
      locked.push(rowID);
    }

    // Step 3: write under full control
    const tbl = this.tables.get(tableName)!;
    let count = 0;
    const oldRows: Row[] = [];
    const newRows: Row[] = [];
    for (const c of candidates) {
      const tpl = tbl.pages[c.pageNum].tuples[c.slotNum];
      if (tpl.xmax !== 0n) continue; // first-updater-wins: another tx beat us
      const oldCopy: Row = new Map(tpl.data);
      const newRow = update(tpl.data);
      tpl.xmax = xid;
      newRows.push(newRow);
      oldRows.push(oldCopy);
      count++;
      this.bpm.invalidatePage({ table: tableName, pageNum: c.pageNum });
    }

    // Append new tuple versions
    const tupleSize = estimateTupleSize(tbl.columns);
    for (const row of newRows) {
      if (tbl.pages.length > 0) {
        const last = tbl.pages[tbl.pages.length - 1];
        if (last.header.hasRoom(tupleSize)) {
          const slotNum = last.tuples.length;
          const pageNum = tbl.pages.length - 1;
          last.tuples.push({ pageNum, slotNum, data: row, xmin: xid, xmax: 0n });
          last.header.addTuple(tupleSize);
          this.bpm.invalidatePage({ table: tableName, pageNum });
          continue;
        }
      }
      const pageNum = tbl.pages.length;
      const pg = newPage();
      pg.tuples.push({ pageNum, slotNum: 0, data: row, xmin: xid, xmax: 0n });
      pg.header.addTuple(tupleSize);
      tbl.pages.push(pg);
      this.bpm.invalidatePage({ table: tableName, pageNum });
    }
    tbl.rebuildIndexes();
    return [count, oldRows, newRows, null];
  }

  listTables(): TableInfo[] {
    const tables: TableInfo[] = [];
    for (const t of this.tables.values()) {
      let rowCount = 0;
      for (const pg of t.pages) rowCount += pg.tuples.length;
      tables.push({ name: t.name, columns: t.columns, rowCount });
    }
    tables.sort((a, b) => a.name.localeCompare(b.name));
    return tables;
  }

  createIndex(indexName: string, tableName: string, column: string): Error | null {
    const t = this.tables.get(tableName);
    if (!t) return new Error(`table "${tableName}" does not exist`);
    const colExists = t.columns.some((c) => c.name === column);
    if (!colExists) return new Error(`column "${column}" does not exist in table "${tableName}"`);
    if (t.indexes.has(indexName)) return new Error(`index "${indexName}" already exists`);

    const tree = new BTree();
    for (let pageNum = 0; pageNum < t.pages.length; pageNum++) {
      const pg = t.pages[pageNum];
      for (let slotNum = 0; slotNum < pg.tuples.length; slotNum++) {
        const tpl = pg.tuples[slotNum];
        const val = tpl.data.get(column);
        if (val !== undefined) {
          tree.insert(val, { pageNum, slotNum, data: tpl.data, xmin: tpl.xmin, xmax: tpl.xmax });
        }
      }
    }
    t.indexes.set(indexName, { name: indexName, column, tree });
    return null;
  }

  dropIndex(indexName: string, tableName: string): Error | null {
    const t = this.tables.get(tableName);
    if (!t) return new Error(`table "${tableName}" does not exist`);
    if (!t.indexes.has(indexName)) {
      return new Error(`index "${indexName}" does not exist on table "${tableName}"`);
    }
    t.indexes.delete(indexName);
    return null;
  }

  dropIndexByName(indexName: string, ifExists: boolean): Error | null {
    for (const t of this.tables.values()) {
      if (t.indexes.has(indexName)) {
        t.indexes.delete(indexName);
        return null;
      }
    }
    if (ifExists) return null;
    return new Error(`index "${indexName}" does not exist`);
  }

  findIndexForColumn(tableName: string, column: string): [string, boolean] {
    const t = this.tables.get(tableName);
    if (!t) return ["", false];
    for (const [name, idx] of t.indexes) {
      if (idx.column === column) return [name, true];
    }
    return ["", false];
  }

  indexRangeScan(
    tableName: string,
    indexName: string,
    lo: unknown,
    loOp: string,
    hi: unknown,
    hiOp: string
  ): [Tuple[], number, Error | null] {
    const t = this.tables.get(tableName);
    if (!t) return [[], 0, new Error(`table "${tableName}" does not exist`)];
    const idx = t.indexes.get(indexName);
    if (!idx) return [[], 0, new Error(`index "${indexName}" does not exist on table "${tableName}"`)];
    const depth = idx.tree.depth();
    let tuples: Tuple[];
    if (lo === null && hi === null) {
      tuples = idx.tree.all();
    } else {
      tuples = idx.tree.rangeScan(lo, loOp, hi, hiOp);
    }
    return [tuples, depth, null];
  }

  getIndexDepth(tableName: string, indexName: string): number {
    const t = this.tables.get(tableName);
    if (!t) return 1;
    const idx = t.indexes.get(indexName);
    if (!idx) return 1;
    return idx.tree.depth();
  }

  listIndexesForTable(tableName: string): IndexInfo[] {
    const t = this.tables.get(tableName);
    if (!t) return [];
    const infos: IndexInfo[] = [];
    for (const [name, idx] of t.indexes) {
      infos.push({ name, column: idx.column, size: idx.tree.size });
    }
    return infos;
  }

  /** analyzeTable computes statistics for all columns (like PostgreSQL ANALYZE). */
  analyzeTable(name: string): [string[], Error | null] {
    const t = this.tables.get(name);
    if (!t) return [[], new Error(`table "${name}" does not exist`)];
    t.stats = computeStats(t);
    return [t.stats.formatAnalyzeOutput(name, t.columns), null];
  }

  /** getTableStats returns the most recent ANALYZE results, or null if never analyzed. */
  getTableStats(name: string): TableStats | null {
    return this.tables.get(name)?.stats ?? null;
  }

  /**
   * deleteRows implements MVCC-style delete: stamps matching live tuples with xmax=xid.
   * When xid==0n (auto-commit), physically removes rows (legacy behaviour).
   * Returns [count, deletedRows, error] for WAL logging by the caller.
   */
  deleteRows(
    tableName: string,
    predicate: (row: Row) => boolean,
    xid: bigint
  ): [number, Row[], Error | null] {
    const t = this.tables.get(tableName);
    if (!t) return [0, [], new Error(`table "${tableName}" does not exist`)];

    // Auto-commit path
    if (xid === 0n) {
      const fkErr = checkFKRestrict(t, predicate, this.tables);
      if (fkErr) return [0, [], fkErr];

      let deleted = 0;
      const deletedRows: Row[] = [];
      const kept: Row[] = [];

      for (const pg of t.pages) {
        for (const tuple of pg.tuples) {
          if (tuple.xmax !== 0n) continue;
          if (predicate(tuple.data)) {
            deletedRows.push(new Map(tuple.data));
            deleted++;
          } else {
            kept.push(tuple.data);
          }
        }
      }

      const tupleSize = estimateTupleSize(t.columns);
      t.pages = [];
      let remaining = kept;
      for (let pageNum = 0; remaining.length > 0; pageNum++) {
        const end = Math.min(t.tuplesPerPageCount, remaining.length);
        const pg = newPage();
        for (let i = 0; i < end; i++) {
          pg.tuples.push({ pageNum, slotNum: i, data: remaining[i], xmin: 0n, xmax: 0n });
          pg.header.addTuple(tupleSize);
        }
        t.pages.push(pg);
        remaining = remaining.slice(end);
      }
      t.rebuildIndexes();
      return [deleted, deletedRows, null];
    }

    // MVCC path: scan → lock → mark dead
    const fkErr = checkFKRestrict(t, predicate, this.tables);
    if (fkErr) return [0, [], fkErr];

    interface Candidate {
      pageNum: number;
      slotNum: number;
      data: Row;
    }
    const candidates: Candidate[] = [];
    for (let i = 0; i < t.pages.length; i++) {
      for (let j = 0; j < t.pages[i].tuples.length; j++) {
        const tpl = t.pages[i].tuples[j];
        if (tpl.xmax !== 0n) continue;
        if (predicate(tpl.data)) candidates.push({ pageNum: i, slotNum: j, data: tpl.data });
      }
    }

    // Step 2: acquire ExclusiveLocks
    const locked: RowLockID[] = [];
    for (const c of candidates) {
      const rowID: RowLockID = { table: tableName, pageNum: c.pageNum, slotNum: c.slotNum };
      const err = this.lockMgr.acquire(xid, rowID, LockMode.ExclusiveLock);
      if (err) {
        for (const r of locked) this.lockMgr.release(xid, r);
        return [0, [], err];
      }
      locked.push(rowID);
    }

    // Step 3: mark dead
    const tbl = this.tables.get(tableName)!;
    let deleted = 0;
    const deletedRows: Row[] = [];
    for (const c of candidates) {
      const tpl = tbl.pages[c.pageNum].tuples[c.slotNum];
      if (tpl.xmax !== 0n) continue;
      deletedRows.push(new Map(tpl.data));
      tpl.xmax = xid;
      deleted++;
      this.bpm.invalidatePage({ table: tableName, pageNum: c.pageNum });
    }
    tbl.rebuildIndexes();
    return [deleted, deletedRows, null];
  }

  /**
   * vacuum physically removes tuples that are dead (xmax != 0n) and whose deleting
   * transaction has committed. Returns the number of tuples reclaimed.
   */
  vacuum(tableName: string): [number, Error | null] {
    const t = this.tables.get(tableName);
    if (!t) return [0, new Error(`table "${tableName}" does not exist`)];

    const kept: Tuple[] = [];
    let reclaimed = 0;
    t.scanTuples((tuple) => {
      const dead = tuple.xmax !== 0n && this.txManager.isCommitted(tuple.xmax);
      if (dead) reclaimed++;
      else kept.push(tuple);
      return true;
    });

    const tupleSize = estimateTupleSize(t.columns);
    t.pages = [];
    let remaining = kept;
    for (let pageNum = 0; remaining.length > 0; pageNum++) {
      const end = Math.min(t.tuplesPerPageCount, remaining.length);
      const pg = newPage();
      for (let i = 0; i < end; i++) {
        const tpl = remaining[i];
        pg.tuples.push({ pageNum, slotNum: i, data: tpl.data, xmin: tpl.xmin, xmax: tpl.xmax });
        pg.header.addTuple(tupleSize);
      }
      t.pages.push(pg);
      remaining = remaining.slice(end);
    }
    t.rebuildIndexes();
    return [reclaimed, null];
  }

  // --- WALDatabase interface implementation ---

  /** restoreTable is used by WALManager.restoreCheckpoint to rebuild a table from snapshot. */
  restoreTable(name: string, columns: Column[], foreignKeys: FKConstraint[], pages: Page[]): void {
    const tbl = new Table(name, columns);
    tbl.foreignKeys = foreignKeys;
    tbl.pages = pages;
    tbl.rebuildIndexes();
    this.tables.set(name, tbl);
  }
}

/** newDatabase creates a fresh Database instance. */
export function newDatabase(): Database {
  return new Database();
}

/**
 * compareVals compares two values of any type and returns a number:
 *   < 0 if a < b, 0 if equal, > 0 if a > b.
 * Numeric types are compared as numbers; everything else is compared as strings.
 */
export function compareVals(a: unknown, b: unknown): number {
  if (a === null || a === undefined) {
    if (b === null || b === undefined) return 0;
    return -1;
  }
  if (b === null || b === undefined) return 1;

  const aNum = typeof a === 'number' || typeof a === 'bigint';
  const bNum = typeof b === 'number' || typeof b === 'bigint';
  if (aNum && bNum) {
    const an = Number(a);
    const bn = Number(b);
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}
