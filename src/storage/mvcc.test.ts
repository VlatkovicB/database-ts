// mvcc.test.ts — port of internal/storage/mvcc_test.go

import { TxManager, Snapshot, Visible, Transaction } from './mvcc';
import { Database, Row, Column } from './storage';

// ---------------------------------------------------------------------------
// TxManager
// ---------------------------------------------------------------------------

test('TestBeginAssignsSequentialXIDs', () => {
  const m = new TxManager();
  const tx1 = m.begin();
  const tx2 = m.begin();
  expect(tx2.id).toBe(tx1.id + 1n);
});

test('TestCommit', () => {
  const m = new TxManager();
  const tx = m.begin();
  const err = m.commit(tx.id);
  expect(err).toBeNull();
  expect(m.isCommitted(tx.id)).toBe(true);
});

test('TestAbort', () => {
  const m = new TxManager();
  const tx = m.begin();
  const err = m.abort(tx.id);
  expect(err).toBeNull();
  expect(m.isCommitted(tx.id)).toBe(false);
});

test('TestCommitNonExistent', () => {
  const m = new TxManager();
  const err = m.commit(9999n);
  expect(err).not.toBeNull();
});

test('TestAbortNonExistent', () => {
  const m = new TxManager();
  const err = m.abort(9999n);
  expect(err).not.toBeNull();
});

test('TestCommitAlreadyCommitted', () => {
  const m = new TxManager();
  const tx = m.begin();
  m.commit(tx.id);
  const err = m.commit(tx.id);
  expect(err).not.toBeNull();
});

test('TestIsCommittedXIDZero', () => {
  const m = new TxManager();
  // xid=0n is auto-committed, always committed
  expect(m.isCommitted(0n)).toBe(true);
});

test('TestGetTx', () => {
  const m = new TxManager();
  const tx = m.begin();
  const got = m.getTx(tx.id);
  expect(got).not.toBeUndefined();
  expect(got!.id).toBe(tx.id);

  const missing = m.getTx(9999n);
  expect(missing).toBeUndefined();
});

test('TestSnapshotCapturesActiveXIDs', () => {
  const m = new TxManager();
  const tx1 = m.begin(); // xid=1, active
  const tx2 = m.begin(); // xid=2, snapshot should list tx1 as active

  // tx2's snapshot should include tx1 in active
  const found = tx2.snapshot.active.includes(tx1.id);
  expect(found).toBe(true);
});

// ---------------------------------------------------------------------------
// Visible
// ---------------------------------------------------------------------------

test('TestVisibleLegacyTuple', () => {
  const m = new TxManager();
  const snap: Snapshot = { xmin: 1n, xmax: 1n, active: [] };
  // xmin=0n xmax=0n: legacy live tuple — always visible
  expect(Visible(0n, 0n, snap, 1n, m)).toBe(true);
});

test('TestVisibleLegacyDeletedByUs', () => {
  const m = new TxManager();
  const snap: Snapshot = { xmin: 1n, xmax: 1n, active: [] };
  // xmin=0n xmax=currentXID: we deleted it — invisible
  expect(Visible(0n, 1n, snap, 1n, m)).toBe(false);
});

test('TestVisibleInsertedByUs', () => {
  const m = new TxManager();
  const snap: Snapshot = { xmin: 1n, xmax: 1n, active: [] };
  // xmin=currentXID xmax=0n: we inserted it, still live
  expect(Visible(1n, 0n, snap, 1n, m)).toBe(true);
});

test('TestVisibleInsertedAndDeletedByUs', () => {
  const m = new TxManager();
  const snap: Snapshot = { xmin: 1n, xmax: 1n, active: [] };
  // xmin=currentXID xmax=currentXID: we inserted and deleted it
  expect(Visible(1n, 1n, snap, 1n, m)).toBe(false);
});

test('TestVisibleCommittedBeforeSnapshot', () => {
  const m = new TxManager();
  const tx1 = m.begin();
  m.commit(tx1.id);

  const tx2 = m.begin(); // snapshot sees tx1 as committed, xmax > tx1.id
  expect(Visible(tx1.id, 0n, tx2.snapshot, tx2.id, m)).toBe(true);
});

test('TestVisibleActiveAtSnapshot', () => {
  const m = new TxManager();
  const tx1 = m.begin(); // starts active
  const tx2 = m.begin(); // takes snapshot: tx1 is active

  // tx1 inserts a tuple. tx2 should NOT see it (tx1 in tx2.snapshot.active)
  m.commit(tx1.id); // commit AFTER tx2 took its snapshot

  expect(Visible(tx1.id, 0n, tx2.snapshot, tx2.id, m)).toBe(false);
});

test('TestVisibleDeletedByCommittedTx', () => {
  const m = new TxManager();
  const tx1 = m.begin();
  m.commit(tx1.id);

  const tx2 = m.begin();
  m.commit(tx2.id);

  const tx3 = m.begin(); // takes snapshot after both tx1, tx2 committed

  // tx2 deleted the tuple inserted by tx1; tx3 should not see it
  expect(Visible(tx1.id, tx2.id, tx3.snapshot, tx3.id, m)).toBe(false);
});

test('TestVisibleDeletedByUncommittedTx', () => {
  const m = new TxManager();
  const tx1 = m.begin();
  m.commit(tx1.id);

  const tx2 = m.begin(); // active deleter

  const tx3 = m.begin(); // tx2 is active at snapshot time → deletion not visible

  // tx3 should still see the tuple (deletion by tx2 not committed yet)
  expect(Visible(tx1.id, tx2.id, tx3.snapshot, tx3.id, m)).toBe(true);
});

// ---------------------------------------------------------------------------
// MVCC isolation via Database
// ---------------------------------------------------------------------------

test('TestMVCCInsertVisibility', () => {
  const db = new Database();
  db.createTable('t', [{ name: 'id', type: 'INT', primary: false }]);

  // tx1: insert, not yet committed
  const tx1 = db.txManager.begin();
  db.insert('t', new Map([['id', 1n]]), tx1.id);

  // tx2: takes snapshot before tx1 commits
  const tx2 = db.txManager.begin();
  const snap2 = tx2.snapshot;

  // tx2 should NOT see tx1's insert
  let [rows] = db.scan('t', snap2, tx2.id);
  expect(rows.length).toBe(0);

  // commit tx1
  db.txManager.commit(tx1.id);

  // tx2 still cannot see it (snapshot taken before commit)
  [rows] = db.scan('t', snap2, tx2.id);
  expect(rows.length).toBe(0);

  // new tx3 (after tx1 committed) CAN see it
  const tx3 = db.txManager.begin();
  const snap3 = tx3.snapshot;
  [rows] = db.scan('t', snap3, tx3.id);
  expect(rows.length).toBe(1);
});

test('TestMVCCRollback', () => {
  const db = new Database();
  db.createTable('t', [{ name: 'id', type: 'INT', primary: false }]);

  const tx1 = db.txManager.begin();
  db.insert('t', new Map([['id', 42n]]), tx1.id);
  db.txManager.abort(tx1.id); // rollback

  // no other tx should see the aborted insert
  const tx2 = db.txManager.begin();
  const snap2 = tx2.snapshot;
  const [rows] = db.scan('t', snap2, tx2.id);
  expect(rows.length).toBe(0);
});

test('TestMVCCUpdateCreatesNewVersion', () => {
  const db = new Database();
  db.createTable('t', [
    { name: 'id', type: 'INT', primary: false },
    { name: 'v', type: 'INT', primary: false },
  ]);

  // auto-commit insert
  db.insert('t', new Map([['id', 1n], ['v', 10n]]), 0n);

  // tx1: update v = 20
  const tx1 = db.txManager.begin();
  db.updateRows(
    't',
    (r: Row) => r.get('id') === 1n,
    (r: Row) => new Map([['id', r.get('id')], ['v', 20n]]),
    tx1.id
  );

  // Before commit: tx1 sees new version (xmin=tx1.id, inserted by us)
  const snap1 = tx1.snapshot;
  let [rows] = db.scan('t', snap1, tx1.id);
  // tx1 should see v=20 (its own write)
  const found20 = rows.some((r) => r.get('v') === 20n);
  expect(found20).toBe(true);

  db.txManager.commit(tx1.id);

  // tx2 after commit sees v=20
  const tx2 = db.txManager.begin();
  const snap2 = tx2.snapshot;
  [rows] = db.scan('t', snap2, tx2.id);
  expect(rows.length).toBe(1);
  expect(rows[0].get('v')).toBe(20n);
});
