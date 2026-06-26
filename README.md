# sql-sentinel

### The SQL cost & performance audit skill for Claude Code

A senior data engineer's warehouse query review takes an hour. **sql-sentinel runs the same review in milliseconds**, scores the query 0-100, and outputs a prioritized cost-reduction plan for **BigQuery, Snowflake, Redshift, and Postgres**. Built for **data teams, analytics engineers, and anyone who's opened a cloud bill and winced**. Local, deterministic, zero dependencies, MIT-licensed.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-26%20passing-brightgreen)](scripts/test.js)
[![Zero Deps](https://img.shields.io/badge/dependencies-0-blue)](scripts/sql-sentinel.js)
[![Ruleset](https://img.shields.io/badge/rules-22%20cost%2Fperf%20checks-orange)](#the-22-rules)

**Host support:**
![Claude Code](https://img.shields.io/badge/Claude%20Code-Verified-brightgreen) ![Cursor](https://img.shields.io/badge/Cursor-Verified-brightgreen) ![Codex CLI](https://img.shields.io/badge/Codex%20CLI-Verified-brightgreen) ![Gemini CLI](https://img.shields.io/badge/Gemini%20CLI-Verified-brightgreen)

> **Why this exists:** most warehouse cost overruns come from a handful of well-understood SQL anti-patterns — a `SELECT *` on a 200-column fact table, a missing partition filter, a cross join, a `LOWER(col)` that silently disables an index. These pass code review because they're *valid SQL*. sql-sentinel is a second pair of eyes that knows the 22 patterns that burn credits.

---

## Who this is for

- **Analytics engineers (dbt, Looker, Hex)**: audit every model before it hits production. Same time budget, 10x the coverage of a manual review.
- **Data platform teams running FinOps / "reduce cloud spend"**: point it at a folder of `.sql` and triage the most expensive patterns first, with estimated savings per finding.
- **Backend devs who occasionally write SQL**: catch the footgun (`DELETE` with no `WHERE`, the `NOT IN` NULL trap, the comma join) before it's an incident.
- **Anyone reviewing a pull request that touches SQL**: run it, paste the prioritized plan into the PR.

## Demo

Run it on a realistic messy dashboard query:

```sql
-- sample.sql
SELECT DISTINCT *
FROM user_events, raw_logs
WHERE LOWER(event_name) LIKE '%signup%'
  AND user_id NOT IN (SELECT id FROM deleted_users)
ORDER BY created_at;
```

```bash
$ node scripts/sql-sentinel.js sample.sql
```

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                     sql-sentinel audit report                   ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

  Health score : 17/100  (grade F)
  Statements   : 1 audited
  Findings     : 7 total — 1 critical, 4 high, 2 medium, 0 low

  ── Prioritized cost-reduction plan ──────────────────────────────

  [1] CRITICAL CROSS JOIN / comma-join produces a Cartesian product
       why  : A CROSS JOIN multiplies every row of one table by every row of the other.
              Two 1M-row tables → 1 trillion rows. This is the single fastest way to run
              up a 5-figure BigQuery bill on one query.
       fix  : Replace with an INNER/LEFT JOIN ON an explicit key.
       $    : est. savings — can turn a $0.02 query into a $200 query

  [2] HIGH     SELECT * forces full column scan
       why  : SELECT * reads every column. On a 200-column fact table this costs
              50-200x more than naming the 5 columns you need.
       fix  : List only the columns you use.
       $    : est. savings — 30-90% bytes scanned on wide tables

  [3] HIGH     Leading-wildcard LIKE ("%term") is non-sargable
  [4] HIGH     Function wrapping a column defeats indexes/zone maps
  [5] HIGH     NOT IN (SELECT ...) — NULL semantics hazard
  [6] MEDIUM   SELECT DISTINCT forces an expensive dedup
  [7] MEDIUM   ORDER BY without LIMIT sorts the full result set
  ...
```

A clean, sargable query scores an A:

```sql
-- this scores 90+/100 (grade A) — no findings
SELECT id, email, created_at
FROM users
WHERE created_at >= TIMESTAMP '2026-01-01'
  AND created_at <  TIMESTAMP '2026-02-01'
ORDER BY id
LIMIT 100;
```

## Install

sql-sentinel is a single file. Three ways to use it:

### 1. As a Claude Code skill (recommended)
Copy the `skills/sql-sentinel/` folder into `.claude/skills/` (or your agent's skills directory). Then just ask:

> "Audit this SQL for cost and performance issues: `SELECT * FROM events`"

Claude loads the skill, runs the engine, and explains each finding with its `why` and `fix`.

### 2. As a CLI
```bash
git clone https://github.com/takeaseatventure/sql-sentinel.git
cd sql-sentinel
node scripts/sql-sentinel.js path/to/query.sql          # pretty report
node scripts/sql-sentinel.js path/to/query.sql --json   # JSON for CI
cat query.sql | node scripts/sql-sentinel.js -          # stdin
```

### 3. Programmatic (Node)
```js
const { auditSql } = require('./sql-sentinel/scripts/sql-sentinel');
const report = auditSql(sqlString, { dialect: 'bigquery' });
// report.healthScore     -> 0-100
// report.grade           -> 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
// report.prioritizedPlan -> array of { priority, title, why, fix, estSavings }
```

No `npm install`. The engine is a single ~700-line file with zero runtime dependencies.

## The 22 rules

| Rule | Severity | Catches | Typical cost |
|---|---|---|---|
| **SQL001** | high | `SELECT *` (full column scan) | 30-90% bytes on wide tables |
| **SQL002** | critical | No `WHERE` (full table scan) | often 90%+ of bytes |
| **SQL003** | high | `LIKE '%term'` (non-sargable) | full scan vs index |
| **SQL004** | high | `LOWER(col)` / function on column | index unusable |
| **SQL005** | critical | `CROSS JOIN` / comma-join | **$0.02 → $200/query** |
| **SQL006** | medium | `SELECT DISTINCT` dedup cost | memory spill |
| **SQL007** | medium | `ORDER BY` w/o `LIMIT` | full sort |
| **SQL008** | high | `NOT IN (SELECT ...)` NULL trap | correctness bug + slow |
| **SQL009** | medium | Implicit type cast | index unusable |
| **SQL010** | low | Many `OR`s (use `IN`/`UNION`) | index merge blocked |
| **SQL011** | medium | `COUNT(DISTINCT ...)` at scale | use HLL |
| **SQL012** | low | `LIMIT` w/o `ORDER BY` | non-deterministic |
| **SQL013** | medium | Scalar subquery in `SELECT` | N executions |
| **SQL014** | medium | 5+ JOINs | broadcast/spill |
| **SQL015** | high | Fact table, no partition filter | full history scan |
| **SQL017** | low | String concat in `SELECT` | CPU + NULLs |
| **SQL018** | medium | `OVER ()` no `PARTITION` | global sort |
| **SQL020** | critical | `DELETE`/`UPDATE` w/o `WHERE` | data loss |
| **SQL021** | low | `SELECT *` in `EXISTS`/`IN` | planner noise |
| **SQL022** | medium | `UNION` vs `UNION ALL` | wasted dedup |

Full `why` + `fix` text for every rule is in the engine output and in [`scripts/sql-sentinel.js`](scripts/sql-sentinel.js).

## Run the tests

```bash
cd scripts && node test.js
# 26 passed, 0 failed, 26 total.
```

The test suite feeds real SQL to each rule and asserts the engine flags it — no mocked results.

## What it is NOT

- **It's a static analyzer**, not a query-plan reader. It finds anti-patterns in the *text* of your SQL. It can't see your actual row counts or billing. A flagged query on a 100-row table is cheap; the same query on a billion-row table is exactly what the rule exists to prevent.
- **It does not execute SQL.** Safe to run on any `.sql` file.
- **It's not magic.** It catches the well-understood patterns that dominate warehouse cost. For deep plan-level optimization you still need `EXPLAIN ANALYZE`.

## Pro tier

The open-source engine covers the 20 universal cost/perf rules. The **Pro tier** adds:

- **Dialect-specific rules**: BigQuery slot saturation patterns (`FLATTEN`, repeated `UNNEST`), Snowflake micro-partition pruning hints, Redshift distribution-key mismatches, Postgres bloat/index checks.
- **Unused-column detection**: cross-reference a query's selected columns against table metadata to flag columns read but never returned.
- **CI hook + SARIF output**: drop into GitHub Actions and surface findings as PR comments.
- **Priority email support** for your team's audit.

→ **[Get sql-sentinel Pro — $29 one-time](https://takeaseatventure.com/pro)**

## Contributing

Found a false positive or a missing rule? Open an issue with the SQL and the expected finding. PRs welcome — the rule format is intentionally simple:

```js
rule('SQL023', 'title', 'severity', (stmt, ctx) => {
  if (/* pattern matches */) return { id, title, severity, line, why, fix, estSavings };
  return null;
});
```

## License

MIT — see [LICENSE](LICENSE).
