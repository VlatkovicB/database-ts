# MiniDB (TypeScript)

PostgreSQL-subset database engine built in TypeScript — port of the Go MiniDB engine.

> **Keep in sync:** When SQL features, API endpoints, or architecture changes, update both this file (`CLAUDE.md`) and `README.md`.

## Run

```bash
npm run dev       # ts-node-dev watch (port 3000)
npm run build     # tsc compile → dist/
npm start         # run compiled dist/cmd/server.js
npm test          # jest
```

## Architecture

Query pipeline: SQL string → Lexer → Parser → Planner → Volcano nodes → Result

```
src/
  lexer/          # Tokenizes SQL string into typed tokens (token.ts, lexer.ts)
  parser/         # Recursive descent parser → AST (parser.ts, ast.ts)
  executor/
    executor.ts   # Dispatcher — routes statements to DML/DDL/txn handlers
    select.ts     # execSelect() + planSelect() — SELECT execution + index planner
    dml.ts        # execInsert(), execUpdate(), execDelete()
    ddl.ts        # execCreate(), execDrop(), execCreateIndex(), execDropIndex()
    transaction.ts# execBegin(), execCommit(), execRollback(), execVacuum()
    expr.ts       # evalExpr() — WHERE/HAVING expression evaluator
    subquery.ts   # Derived tables, scalar subqueries, IN/EXISTS materialization
    explain.ts    # EXPLAIN PLAN and EXPLAIN ANALYZE output
    volcano.ts    # Volcano iterator nodes (SeqScan, Filter, HashJoin, Sort, etc.)
    planner.ts    # Cost-based planner: Qplanner → PhysRelation tree → volcano nodes
    selectivity.ts# Cardinality estimation from column stats
  storage/
    storage.ts    # Database + Table classes, DML, constraint enforcement
    page.ts       # Heap page layout (pd_lower/pd_upper/LSN) mirroring PG
    btree.ts      # B+ tree: Insert, Search, RangeScan, leaf linking
    mvcc.ts       # TxManager, Transaction, Snapshot, Visible()
    wal.ts        # WALManager: TakeCheckpoint, RestoreCheckpoint, Replay
    bufmgr.ts     # BufferPool: LRU eviction, page cache
    lock.ts       # LockManager: row-level READ/WRITE locks, deadlock detection
    constraints.ts# PRIMARY KEY + FOREIGN KEY enforcement
    stats.ts      # ColumnStats (n_distinct, null_frac, histogram, MCV), computeStats()
  api/
    handler.ts    # Express routes
    seed.ts       # POST /seed — 11 game tables, ~277 rows
    trace.ts      # AST-to-JSON serialization for frontend
    history.ts    # Query history store
  cmd/
    server.ts     # Express bootstrap, port 3000
    web/
      index.html  # Embedded SPA frontend
```

## Supported SQL

```sql
-- DDL
CREATE TABLE users (id INT PRIMARY KEY, name TEXT, age INT, active BOOLEAN);
DROP TABLE [IF EXISTS] users;
CREATE INDEX idx_name ON users(name);
DROP INDEX [IF EXISTS] idx_name;

-- Constraints
-- PRIMARY KEY enforced on INSERT: duplicate or NULL rejected
-- FOREIGN KEY enforced on INSERT (child must match parent) and DELETE (parent rejected if referenced)
CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- DML
INSERT INTO users (id, name, age) VALUES (1, 'Alice', 30);
INSERT INTO users VALUES (2, 'Bob', 24);
UPDATE users SET age = 31 WHERE id = 1;
DELETE FROM users WHERE age < 25;

-- SELECT
SELECT * FROM users WHERE age > 25 AND name != 'Eve';
SELECT DISTINCT class FROM players ORDER BY class;
SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id;
SELECT u.name, o.total FROM users u LEFT JOIN orders o ON u.id = o.user_id;

-- Aggregates + GROUP BY
SELECT class, COUNT(*), AVG(level) FROM players GROUP BY class;
SELECT class, COUNT(*) FROM players GROUP BY class HAVING COUNT(*) > 2;

-- ORDER BY / LIMIT / OFFSET
SELECT username, level FROM players ORDER BY level DESC LIMIT 10 OFFSET 5;

-- Subquery in FROM (derived tables)
SELECT t.username FROM (SELECT username, level FROM players WHERE level > 40) t;

-- Scalar subqueries + IN / EXISTS
SELECT name, (SELECT COUNT(*) FROM orders WHERE orders.user_id = u.id) FROM users u;
SELECT * FROM users WHERE id IN (SELECT user_id FROM orders);
SELECT * FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id);

-- LATERAL joins
SELECT p.username, sub.level
FROM players p
JOIN LATERAL (SELECT level FROM players i WHERE i.class = p.class) AS sub ON sub.level > p.level
LIMIT 5;

-- CTEs (WITH)
WITH active_players AS (SELECT * FROM players WHERE level > 10)
SELECT class, COUNT(*) FROM active_players GROUP BY class;

-- Row locking
SELECT * FROM players WHERE id = 1 FOR UPDATE;
SELECT * FROM players WHERE id = 1 FOR SHARE;

-- Statistics
ANALYZE players;   -- computes n_distinct, null_frac, histograms, MCV per column

-- Transactions
BEGIN;
INSERT INTO players (id, username, level, xp, class) VALUES (99, 'Neo', 50, 5000, 'Mage');
COMMIT;
-- or: ROLLBACK;

VACUUM players;    -- reclaim dead tuples from committed DELETEs/UPDATEs

-- EXPLAIN
EXPLAIN SELECT * FROM players WHERE level > 10;
EXPLAIN ANALYZE SELECT * FROM players WHERE level > 10;
```

Column types: `INT`, `TEXT`, `BOOLEAN`, `FLOAT`.

Parallel SeqScan auto-selected when estimated rows > 1000. EXPLAIN shows `Gather (Workers Planned: N) -> Parallel Seq Scan on t`.

## API

- `POST /query` — `{"sql": "...", "session_id": "tx-1"}` → `{columns, rows, message, tokens, ast, execTrace, session_id}`
- `GET /tables` — all tables with column schema + row counts
- `POST /seed` — drop + recreate all 11 game tables
- `POST /vacuum` — `{"table": "players"}` → `{"reclaimed": N}`
- `GET /wal` — all WAL records + checkpointLSN
- `POST /wal/checkpoint` — snapshot current DB state
- `POST /wal/crash` — revert DB to last checkpoint
- `POST /wal/recover` — replay WAL since checkpoint
- `GET /history` — query history

`session_id` optional. `BEGIN` creates a session and returns its ID. Pass in subsequent queries for multi-statement transactions.

## Key source locations

| What | File |
|---|---|
| Token types | `src/lexer/token.ts` |
| Lexer | `src/lexer/lexer.ts` |
| AST nodes | `src/parser/ast.ts` |
| Parser | `src/parser/parser.ts` |
| Executor dispatch | `src/executor/executor.ts` |
| SELECT + planner | `src/executor/select.ts` |
| Volcano nodes | `src/executor/volcano.ts` |
| Cost-based planner | `src/executor/planner.ts` |
| Expression eval | `src/executor/expr.ts` |
| Subquery materialization | `src/executor/subquery.ts` |
| EXPLAIN | `src/executor/explain.ts` |
| Selectivity estimation | `src/executor/selectivity.ts` |
| Storage + constraints | `src/storage/storage.ts` |
| Heap pages | `src/storage/page.ts` |
| B+ tree | `src/storage/btree.ts` |
| MVCC | `src/storage/mvcc.ts` |
| WAL | `src/storage/wal.ts` |
| Buffer pool | `src/storage/bufmgr.ts` |
| Lock manager | `src/storage/lock.ts` |
| Column statistics | `src/storage/stats.ts` |
| HTTP handlers | `src/api/handler.ts` |
| Seed data | `src/api/seed.ts` |
| AST trace serializer | `src/api/trace.ts` |
| Entry point | `src/cmd/server.ts` |
| Frontend | `src/cmd/web/index.html` |

## AST shape

`SelectStatement` fields: `distinct bool`, `exprs SelectExpr[]` (`ColSelectExpr` | `AggSelectExpr`), `table`, `alias`, `fromSubquery` (non-nil for `FROM (SELECT ...) AS alias`), `joins JoinClause[]`, `where Expression`, `groupBy string[]`, `having Expression`, `orderBy OrderByExpr[]`, `limit number | null`, `offset number | null`, `ctes CTEDefinition[]`, `forUpdate bool`, `forShare bool`.

`JoinClause` fields: `type`, `table`, `alias`, `condition`, `joinSubquery` (non-nil for `JOIN (SELECT ...) AS alias ON ...`), `lateral bool`.

Expression nodes: `BinaryExpr`, `IdentExpr`, `LiteralExpr`, `AggFuncExpr`, `SubqueryExpr`, `InExpr`, `ExistsExpr`.

## Executor dispatch

- No aggregates + no GROUP BY → single-row-at-a-time via volcano pipeline
- Has aggregates OR GROUP BY → `HashAggregate` volcano node
- LATERAL joins → `LateralJoin` node (re-evaluated per outer row, not pre-materialized)
- CTEs → materialized once into `CteSeqScan` nodes
- All paths feed through planner → `PhysRelation` tree → volcano nodes → `postProcess()` (DISTINCT → ORDER BY → LIMIT/OFFSET)

## Storage

In-memory tables — lost on restart. Rows are `Record<string, unknown>`. MVCC tuples carry `xmin` / `xmax`. Heap pages model PostgreSQL's 8KB page layout (`pd_lower`, `pd_upper`, line pointer array).

## Scan types

| Scan | When | PG concept |
|---|---|---|
| **Index Scan** | Equality predicate on indexed col | Point lookup |
| **Bitmap Scan** | Range predicate on indexed col | Collect TIDs → sort by page → heap read |
| **Seq Scan** | No usable index, or index cost > seq cost | Full table scan |

EXPLAIN shows "Index Scan using … on …" or "Bitmap Heap Scan on … → Bitmap Index Scan on …".

**Index Nested Loop Join**: inner table has index on join column → one index probe per outer row. EXPLAIN shows "Nested Loop (Index)".

## Tests

```bash
npm test                         # all tests
npx jest executor                # executor tests only
npx jest storage                 # storage tests only
npx jest mvcc                    # MVCC tests only
```

Test files: `src/executor/executor.test.ts`, `src/storage/storage.test.ts`, `src/storage/mvcc.test.ts`.
