# MiniDB (TypeScript)

A PostgreSQL-subset database engine built in TypeScript for learning how query execution works — port of the [Go version](../database).

## Features

- Full SQL pipeline: Lexer → Parser → Cost-based Planner → Volcano executor
- Joins: INNER, LEFT, subquery joins, LATERAL joins, Index Nested Loop
- Subqueries: derived tables, scalar subqueries, IN, EXISTS
- CTEs (`WITH` clause)
- Aggregates: COUNT, SUM, AVG, MIN, MAX with GROUP BY / HAVING
- Indexes: B+ tree, Index Scan, Bitmap Scan, Seq Scan
- Parallel SeqScan (auto-selected for large tables)
- MVCC snapshot isolation — multi-statement transactions (BEGIN / COMMIT / ROLLBACK)
- Row-level locking (FOR UPDATE / FOR SHARE) with deadlock detection
- Write-Ahead Log with checkpoint + crash recovery
- Buffer pool (LRU eviction)
- Column statistics (ANALYZE) — n_distinct, histograms, MCV
- EXPLAIN and EXPLAIN ANALYZE
- Heap page layout mirroring PostgreSQL's physical format
- PRIMARY KEY and FOREIGN KEY constraint enforcement
- VACUUM (dead tuple reclamation)
- Embedded web frontend with pipeline visualization

## Run

```bash
npm run dev     # ts-node-dev watch — http://localhost:3000
npm run build   # compile to dist/
npm start       # run compiled build
npm test        # jest test suite
```

## Example Queries

```sql
-- Basic SELECT
SELECT username, level FROM players WHERE level > 40 ORDER BY level DESC LIMIT 10;

-- Aggregates
SELECT class, COUNT(*), AVG(level) FROM players GROUP BY class HAVING COUNT(*) > 2;

-- Joins
SELECT p.username, g.name FROM players p JOIN guilds g ON p.guild_id = g.id;

-- Subquery
SELECT name FROM users WHERE id IN (SELECT user_id FROM orders);

-- Lateral join
SELECT p.username, sub.level
FROM players p
JOIN LATERAL (SELECT level FROM players i WHERE i.class = p.class) AS sub ON sub.level > p.level
LIMIT 5;

-- CTE
WITH top_players AS (SELECT * FROM players WHERE level > 45)
SELECT class, COUNT(*) FROM top_players GROUP BY class;

-- Transactions
BEGIN;
INSERT INTO players (id, username, level, xp, class) VALUES (99, 'Neo', 50, 5000, 'Mage');
COMMIT;

-- Indexes
CREATE INDEX idx_level ON players(level);
EXPLAIN ANALYZE SELECT * FROM players WHERE level > 40;

-- Statistics
ANALYZE players;

-- Maintenance
VACUUM players;
```

## API

| Method | Path | Description |
|---|---|---|
| POST | `/query` | Execute SQL — body: `{"sql": "...", "session_id": "optional"}` |
| GET | `/tables` | All tables with schema + row counts |
| POST | `/seed` | Reset to 11-table game DB (~277 rows) |
| POST | `/vacuum` | Reclaim dead tuples — body: `{"table": "players"}` |
| GET | `/wal` | WAL records + checkpoint LSN |
| POST | `/wal/checkpoint` | Take a checkpoint |
| POST | `/wal/crash` | Simulate crash (revert to last checkpoint) |
| POST | `/wal/recover` | Replay WAL since checkpoint |
| GET | `/history` | Query history |

## Architecture

```
src/
  lexer/          — SQL tokenizer
  parser/         — Recursive descent parser → AST
  executor/
    executor.ts   — Statement dispatcher
    planner.ts    — Cost-based query planner (PG-style)
    volcano.ts    — Iterator nodes (SeqScan, HashJoin, Sort, ...)
    select.ts     — SELECT execution
    dml.ts        — INSERT / UPDATE / DELETE
    ddl.ts        — CREATE / DROP TABLE / INDEX
    expr.ts       — WHERE / HAVING expression evaluator
    subquery.ts   — Subquery materialization
    explain.ts    — EXPLAIN output
    selectivity.ts— Cardinality estimation
  storage/
    storage.ts    — In-memory tables + DML
    btree.ts      — B+ tree indexes
    mvcc.ts       — Snapshot isolation (xmin/xmax per tuple)
    wal.ts        — Write-Ahead Log
    bufmgr.ts     — Buffer pool (LRU)
    lock.ts       — Row-level lock manager
    page.ts       — Heap page layout
    stats.ts      — Column statistics
  api/            — Express handlers, seed data, AST trace
  cmd/            — Server entry point + embedded frontend
```

## Go version

The original Go implementation lives at [`../database`](../database) and is kept in sync with this TypeScript port.
