// storage.test.ts — port of internal/storage/storage_test.go

import { Database, Row, Column } from './storage';

function newDB(): Database {
  return new Database();
}

function createUsersTable(db: Database): void {
  const err = db.createTable('users', [
    { name: 'id', type: 'INT', primary: true },
    { name: 'name', type: 'TEXT', primary: false },
    { name: 'age', type: 'INT', primary: false },
  ]);
  if (err) throw err;
}

// ---------------------------------------------------------------------------
// CreateTable / DropTable
// ---------------------------------------------------------------------------

test('TestCreateTable', () => {
  const db = newDB();
  const err = db.createTable('t', [{ name: 'id', type: 'INT', primary: false }]);
  expect(err).toBeNull();
  const [tbl, getErr] = db.getTable('t');
  expect(getErr).toBeNull();
  expect(tbl).not.toBeNull();
});

test('TestCreateTableDuplicate', () => {
  const db = newDB();
  db.createTable('t', []);
  const err = db.createTable('t', []);
  expect(err).not.toBeNull();
});

test('TestDropTable', () => {
  const db = newDB();
  db.createTable('t', []);
  const err = db.dropTable('t');
  expect(err).toBeNull();
  const [, getErr] = db.getTable('t');
  expect(getErr).not.toBeNull();
});

test('TestDropNonExistentTable', () => {
  const db = newDB();
  const err = db.dropTable('nonexistent');
  expect(err).not.toBeNull();
});

test('TestGetTableNotFound', () => {
  const db = newDB();
  const [, err] = db.getTable('missing');
  expect(err).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Insert / Scan
// ---------------------------------------------------------------------------

test('TestInsertAndScan', () => {
  const db = newDB();
  createUsersTable(db);

  const row1: Row = new Map<string, unknown>([['id', 1n], ['name', 'Alice'], ['age', 30n]]);
  const row2: Row = new Map<string, unknown>([['id', 2n], ['name', 'Bob'], ['age', 25n]]);
  db.insert('users', row1, 0n);
  db.insert('users', row2, 0n);

  const [rows, cols, err] = db.scan('users', null, 0n);
  expect(err).toBeNull();
  expect(rows.length).toBe(2);
  expect(cols.length).toBe(3);
});

test('TestInsertNonExistentTable', () => {
  const db = newDB();
  const row: Row = new Map();
  const err = db.insert('nope', row, 0n);
  expect(err).not.toBeNull();
});

test('TestScanNonExistentTable', () => {
  const db = newDB();
  const [, , err] = db.scan('nope', null, 0n);
  expect(err).not.toBeNull();
});

// ---------------------------------------------------------------------------
// UpdateRows
// ---------------------------------------------------------------------------

test('TestUpdateRows', () => {
  const db = newDB();
  createUsersTable(db);
  db.insert('users', new Map<string, unknown>([['id', 1n], ['name', 'Alice'], ['age', 30n]]), 0n);
  db.insert('users', new Map<string, unknown>([['id', 2n], ['name', 'Bob'], ['age', 25n]]), 0n);

  const [count, , , err] = db.updateRows(
    'users',
    (r: Row) => r.get('name') === 'Alice',
    (r: Row) => new Map<string, unknown>([['id', r.get('id')], ['name', r.get('name')], ['age', 31n]]),
    0n
  );
  expect(err).toBeNull();
  expect(count).toBe(1);

  const [rows] = db.scan('users', null, 0n);
  for (const row of rows) {
    if (row.get('name') === 'Alice') {
      expect(row.get('age')).toBe(31n);
    }
  }
});

test('TestUpdateNoMatch', () => {
  const db = newDB();
  createUsersTable(db);
  db.insert('users', new Map<string, unknown>([['id', 1n], ['name', 'Alice'], ['age', 30n]]), 0n);

  const [count, , , err] = db.updateRows(
    'users',
    (r: Row) => r.get('name') === 'Nobody',
    (r: Row) => r,
    0n
  );
  expect(err).toBeNull();
  expect(count).toBe(0);
});

// ---------------------------------------------------------------------------
// DeleteRows
// ---------------------------------------------------------------------------

test('TestDeleteRows', () => {
  const db = newDB();
  createUsersTable(db);
  db.insert('users', new Map<string, unknown>([['id', 1n], ['name', 'Alice'], ['age', 30n]]), 0n);
  db.insert('users', new Map<string, unknown>([['id', 2n], ['name', 'Bob'], ['age', 20n]]), 0n);

  const [count, , err] = db.deleteRows(
    'users',
    (r: Row) => Number(r.get('age') as bigint) < 25,
    0n
  );
  expect(err).toBeNull();
  expect(count).toBe(1);

  const [rows] = db.scan('users', null, 0n);
  expect(rows.length).toBe(1);
  expect(rows[0].get('name')).toBe('Alice');
});

test('TestDeleteAllRows', () => {
  const db = newDB();
  createUsersTable(db);
  db.insert('users', new Map<string, unknown>([['id', 1n], ['name', 'Alice'], ['age', 30n]]), 0n);
  db.deleteRows('users', () => true, 0n);

  const [rows] = db.scan('users', null, 0n);
  expect(rows.length).toBe(0);
});

// ---------------------------------------------------------------------------
// RowCount / PageCount
// ---------------------------------------------------------------------------

test('TestRowCount', () => {
  const db = newDB();
  createUsersTable(db);
  db.insert('users', new Map<string, unknown>([['id', 1n], ['name', 'A'], ['age', 1n]]), 0n);
  db.insert('users', new Map<string, unknown>([['id', 2n], ['name', 'B'], ['age', 2n]]), 0n);

  const [n, err] = db.rowCount('users');
  expect(err).toBeNull();
  expect(n).toBe(2);
});

test('TestPageCount', () => {
  const db = newDB();
  createUsersTable(db);
  // insert enough rows to span multiple pages
  for (let i = 0n; i < 100n; i++) {
    db.insert('users', new Map<string, unknown>([['id', i], ['name', 'x'], ['age', i]]), 0n);
  }
  const [n, err] = db.pageCount('users');
  expect(err).toBeNull();
  expect(n).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

test('TestCreateAndDropIndex', () => {
  const db = newDB();
  createUsersTable(db);
  db.insert('users', new Map<string, unknown>([['id', 1n], ['name', 'Alice'], ['age', 30n]]), 0n);

  const createErr = db.createIndex('idx_age', 'users', 'age');
  expect(createErr).toBeNull();

  const idxes = db.listIndexesForTable('users');
  expect(idxes.length).toBe(1);
  expect(idxes[0].name).toBe('idx_age');

  const dropErr = db.dropIndex('idx_age', 'users');
  expect(dropErr).toBeNull();
  expect(db.listIndexesForTable('users').length).toBe(0);
});

test('TestCreateIndexDuplicate', () => {
  const db = newDB();
  createUsersTable(db);
  db.createIndex('idx', 'users', 'age');
  const err = db.createIndex('idx', 'users', 'age');
  expect(err).not.toBeNull();
});

test('TestCreateIndexBadColumn', () => {
  const db = newDB();
  createUsersTable(db);
  const err = db.createIndex('idx', 'users', 'nonexistent');
  expect(err).not.toBeNull();
});

test('TestIndexRangeScan', () => {
  const db = newDB();
  createUsersTable(db);
  for (let i = 1n; i <= 10n; i++) {
    db.insert('users', new Map<string, unknown>([['id', i], ['name', 'u'], ['age', i * 10n]]), 0n);
  }
  db.createIndex('idx_age', 'users', 'age');

  const [tuples, , err] = db.indexRangeScan('users', 'idx_age', 30n, '>=', 60n, '<=');
  expect(err).toBeNull();
  // ages: 30, 40, 50, 60 → 4 tuples
  expect(tuples.length).toBe(4);
});

test('TestFindIndexForColumn', () => {
  const db = newDB();
  createUsersTable(db);
  db.createIndex('idx_age', 'users', 'age');

  const [name, found] = db.findIndexForColumn('users', 'age');
  expect(found).toBe(true);
  expect(name).toBe('idx_age');

  const [, notFound] = db.findIndexForColumn('users', 'name');
  expect(notFound).toBe(false);
});

test('TestDropIndexByName', () => {
  const db = newDB();
  createUsersTable(db);
  db.createIndex('idx_age', 'users', 'age');
  const err = db.dropIndexByName('idx_age', false);
  expect(err).toBeNull();
});

test('TestDropIndexByNameIfExists', () => {
  const db = newDB();
  // ifExists=true: no error when missing
  const err1 = db.dropIndexByName('nonexistent', true);
  expect(err1).toBeNull();
  // ifExists=false: error when missing
  const err2 = db.dropIndexByName('nonexistent', false);
  expect(err2).not.toBeNull();
});

// ---------------------------------------------------------------------------
// ANALYZE / Stats
// ---------------------------------------------------------------------------

test('TestAnalyzeTable', () => {
  const db = newDB();
  createUsersTable(db);
  for (let i = 1n; i <= 20n; i++) {
    db.insert('users', new Map<string, unknown>([['id', i], ['name', 'u'], ['age', i]]), 0n);
  }

  const [lines, err] = db.analyzeTable('users');
  expect(err).toBeNull();
  expect(lines.length).toBeGreaterThan(0);

  const stats = db.getTableStats('users');
  expect(stats).not.toBeNull();
  expect(stats!.columns.get('age')).not.toBeUndefined();
});

test('TestGetTableStatsNoAnalyze', () => {
  const db = newDB();
  createUsersTable(db);
  const stats = db.getTableStats('users');
  expect(stats).toBeNull();
});

// ---------------------------------------------------------------------------
// ListTables
// ---------------------------------------------------------------------------

test('TestListTables', () => {
  const db = newDB();
  db.createTable('a', []);
  db.createTable('b', []);
  const tables = db.listTables();
  expect(tables.length).toBe(2);
  expect(tables[0].name).toBe('a');
  expect(tables[1].name).toBe('b');
});

// ---------------------------------------------------------------------------
// Vacuum
// ---------------------------------------------------------------------------

test('TestVacuum', () => {
  const db = newDB();
  createUsersTable(db);

  // Begin + insert + commit
  const tx = db.txManager.begin();
  db.insert('users', new Map<string, unknown>([['id', 1n], ['name', 'Alice'], ['age', 30n]]), tx.id);
  db.txManager.commit(tx.id);

  // Begin + delete + commit (MVCC soft-delete)
  const tx2 = db.txManager.begin();
  db.deleteRows('users', () => true, tx2.id);
  db.txManager.commit(tx2.id);

  const [reclaimed, err] = db.vacuum('users');
  expect(err).toBeNull();
  expect(reclaimed).toBe(1);
});

test('TestVacuumNoDeadTuples', () => {
  const db = newDB();
  createUsersTable(db);
  db.insert('users', new Map<string, unknown>([['id', 1n], ['name', 'Alice'], ['age', 30n]]), 0n);

  const [reclaimed, err] = db.vacuum('users');
  expect(err).toBeNull();
  expect(reclaimed).toBe(0);
});
