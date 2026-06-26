'use strict';

// ============================================================================
// sql-sentinel-pro.js — Dialect-specific + advanced rules (Pro tier).
//
// These rules extend the OSS ruleset (sql-sentinel.js) with:
//   - BigQuery-specific slot/billing patterns
//   - Snowflake micro-partition / clustering patterns
//   - Redshift distribution-key / sort-key patterns
//   - Postgres bloat / index patterns
//   - Unused-column detection (cross-reference select list vs table metadata)
//
// Usage:
//   const { auditSql } = require('./sql-sentinel');
//   const { auditPro } = require('./sql-sentinel-pro');
//   const report = auditPro(sqlString, { dialect: 'bigquery', tableColumns: {users:['id','name']} });
//
// Pro is invoked ONLY when a valid license is present (see LICENSE note at bottom).
// ============================================================================

const { auditSql, RULES: OSS_RULES, splitStatements, stripCommentsAndStrings, whereClause, hasWord } = require('./sql-sentinel');

const PRO_RULES = [];
function prule(id, title, severity, run) { PRO_RULES.push({ id, title, severity, run }); }

// --- BigQuery (BQ) ---

// BQ001 — SELECT * with STRUCT/REPEATED columns (massive byte amplification)
prule('BQ001', 'BigQuery: SELECT * on table with ARRAY/STRUCT columns (byte amplification)', 'high', (stmt, ctx) => {
  const s = stmt.clean;
  if (!/\bSELECT\s+\*\s/i.test(s + ' ')) return null;
  // Heuristic: table name hints at nested schema
  const tables = (s.match(/FROM\s+([A-Za-z_][\w.]*)/gi) || []).join(' ');
  if (/event|raw|nested|json|payload|ga4|firebase/i.test(tables)) {
    return {
      id: 'BQ001', title: 'BigQuery: SELECT * on likely-nested table (ARRAY/STRUCT)',
      severity: 'high', line: stmt.startLine,
      why: 'Tables with REPEATED (ARRAY) or RECORD (STRUCT) columns store nested data that explodes when SELECT * flattens it. A GA4 events table can be 50-100x larger when SELECT *ed versus selecting scalar fields. This is the #1 BigQuery cost overrun pattern.',
      fix: 'Select only the top-level scalar fields you need. Use UNNEST() explicitly on the specific ARRAY column, never SELECT * on a nested table.',
      estSavings: '50-100x bytes on nested tables',
    };
  }
  return null;
});

// BQ002 — Repeated UNNEST in a way that multiplies rows
prule('BQ002', 'BigQuery: multiple UNNEST without JOIN structure (row multiplication)', 'medium', (stmt, ctx) => {
  const s = stmt.clean;
  const unnestCount = (s.match(/\bUNNEST\s*\(/gi) || []).length;
  if (unnestCount < 2) return null;
  if (!/JOIN/i.test(s.replace(/UNNEST/g, ''))) {
    return {
      id: 'BQ002', title: `BigQuery: ${unnestCount} UNNESTs without JOIN (row multiplication)`,
      severity: 'medium', line: stmt.startLine,
      why: 'Multiple comma-separated UNNEST calls (without a JOIN) produce the Cartesian product of the arrays — if a row has 3-element and 5-element arrays, you get 15 rows from one. This silently inflates result sets and costs.',
      fix: 'Use UNNEST(...) WITH OFFSET joined on matching offsets, or UNNEST each array in a separate correlated subquery.',
      estSavings: 'N×M rows → N rows',
    };
  }
  return null;
});

// BQ003 — JavaScript UDF (slots, slow)
prule('BQ003', 'BigQuery: persistent JavaScript UDF (slow, slot-heavy)', 'medium', (stmt, ctx) => {
  const s = stmt.sql;
  if (/CREATE\s+(OR\s+REPLACE\s+)?(TEMPORARY\s+|TEMP\s+)?FUNCTION.*LANGUAGE\s+js/is.test(s)) {
    return {
      id: 'BQ003', title: 'BigQuery: JavaScript UDF definition',
      severity: 'medium', line: stmt.startLine,
      why: 'JS UDFs run in a separate V8 sandbox per row and cannot be vectorized. On large scans they are 10-100x slower than native SQL or SQL UDFs and dominate slot usage.',
      fix: 'Rewrite the logic as a SQL UDF (CREATE FUNCTION ... AS (sql_expr)) where possible. Reserve JS UDFs for genuinely irreducible string/regex work, and pre-filter rows before calling them.',
      estSavings: '10-100x slot time',
    };
  }
  return null;
});

// --- Snowflake (SF) ---

// SF001 — SELECT * defeats micro-partition pruning
prule('SF001', 'Snowflake: SELECT * defeats micro-partition column pruning', 'medium', (stmt, ctx) => {
  const s = stmt.clean;
  if (!/\bSELECT\s+\*\s/i.test(s + ' ')) return null;
  return {
    id: 'SF001', title: 'Snowflake: SELECT * (micro-partition pruning defeated)',
    severity: 'medium', line: stmt.startLine,
    why: 'Snowflake stores data in columnar micro-partitions and bills by bytes scanned. SELECT * forces it to read every column in every pruned micro-partition. Selecting only needed columns cuts credits proportionally.',
    fix: 'Name the columns. Snowflake shows "Bytes scanned" per query in the history — compare before/after.',
    estSavings: 'proportional to column selectivity',
  };
});

// SF002 — Query on a table without a clustering key (full scan risk)
prule('SF002', 'Snowflake: large table likely missing a clustering key', 'low', (stmt, ctx) => {
  const s = stmt.clean;
  if (!hasWord(s, 'WHERE')) return null;
  // Advisory — we cannot see actual metadata, so flag only very large-looking fact tables
  const tables = (s.match(/FROM\s+([A-Za-z_][\w.]*)/gi) || []);
  return null; // requires metadata to be meaningful; placeholder for tableColumns integration
});

// --- Redshift (RS) ---

// RS001 — JOIN on non-distribution key (broadcast/redistribute)
prule('RS001', 'Redshift: JOIN likely on non-DISTKEY (data redistribution)', 'medium', (stmt, ctx) => {
  const s = stmt.clean;
  // We cannot see actual dist keys, but flag joins where the ON columns differ in a way
  // that suggests a redistribution. Advisory only.
  return null; // requires metadata; advanced Pro feature
});

// --- Postgres (PG) ---

// PG001 — ILIKE (case-insensitive LIKE) is never indexable
prule('PG001', 'Postgres: ILIKE is never indexable (full scan)', 'high', (stmt, ctx) => {
  const s = stmt.sql;
  if (/\bILIKE\b/i.test(s)) {
    return {
      id: 'PG001', title: 'Postgres: ILIKE forces a sequential scan',
      severity: 'high', line: stmt.startLine,
      why: 'ILIKE (case-insensitive LIKE) cannot use a standard B-tree index — it always seq-scans. Even a trigram (pg_trgm) index is needed for it to be indexable.',
      fix: 'Add a pg_trgm GIN index and run SET enable_seqscan=off to verify it is used. Or store a LOWER(column) expression column with a B-tree index and query that.',
      estSavings: 'index seek vs full scan',
    };
  }
  return null;
});

// --- Unused-column detection (Pro) ---

/**
 * Cross-reference the SELECT list against provided table column metadata.
 * tableColumns: { 'schema.table': ['col1','col2',...] }
 * Flags columns READ in the query that are NOT returned — wasted reads.
 */
function findUnusedColumnReads(sqlScript, tableColumns) {
  if (!tableColumns) return [];
  const stmts = splitStatements(String(sqlScript));
  const findings = [];
  for (const stmt of stmts) {
    const clean = stripCommentsAndStrings(stmt.sql);
    if (!/^\s*SELECT/i.test(clean)) continue;
    // crude table resolution — match FROM table refs against tableColumns keys
    const fromRe = /FROM\s+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)/gi;
    let m;
    while ((m = fromRe.exec(clean)) !== null) {
      const tname = m[1].toLowerCase();
      // find a matching metadata key (case-insensitive, suffix match)
      const key = Object.keys(tableColumns).find(k => k.toLowerCase().endsWith(tname) || tname.endsWith(k.toLowerCase()));
      if (!key) continue;
      const allCols = tableColumns[key];
      // which columns appear anywhere in the query text?
      const referenced = allCols.filter(c => new RegExp(`\\b${c}\\b`, 'i').test(clean));
      const unused = allCols.filter(c => !referenced.includes(c));
      // If SELECT * AND there are many unused columns → strong signal
      if (/\bSELECT\s+\*\s/i.test(clean + ' ') && unused.length > allCols.length / 2) {
        findings.push({
          id: 'UC001', title: `Unused-column read: SELECT * on ${key} reads ${unused.length}/${allCols.length} unused columns`,
          severity: 'high', line: stmt.startLine,
          why: `Table ${key} has ${allCols.length} columns but only ${referenced.length} appear to be used. SELECT * reads all ${allCols.length}, billing/scanning ${Math.round(100*unused.length/allCols.length)}% wasted bytes.`,
          fix: `Replace SELECT * with: ${referenced.join(', ') || '(name the columns you use)'}`,
          estSavings: `${Math.round(100*unused.length/allCols.length)}% fewer bytes`,
        });
      }
    }
  }
  return findings;
}

// --- Main Pro audit: OSS + dialect + unused-column ---

function auditPro(sqlScript, opts) {
  opts = opts || {};
  // 1. Run the OSS audit
  const base = auditSql(sqlScript, opts);
  // 2. Run dialect-specific rules
  const stmts = splitStatements(String(sqlScript));
  const dialectFindings = [];
  const relevantRules = PRO_RULES.filter(r => {
    if (!opts.dialect) return true;
    if (opts.dialect === 'bigquery' && r.id.startsWith('BQ')) return true;
    if (opts.dialect === 'snowflake' && r.id.startsWith('SF')) return true;
    if (opts.dialect === 'redshift' && r.id.startsWith('RS')) return true;
    if (opts.dialect === 'postgres' && r.id.startsWith('PG')) return true;
    return false;
  });
  for (const stmt of stmts) {
    const clean = stripCommentsAndStrings(stmt.sql);
    for (const rule of relevantRules) {
      try {
        const f = rule.run({ sql: stmt.sql, clean, startLine: stmt.startLine }, opts);
        if (f) { f.rule = rule.id; dialectFindings.push(f); }
      } catch (e) {}
    }
  }
  // 3. Unused-column detection
  const unusedFindings = findUnusedColumnReads(sqlScript, opts.tableColumns);
  // 4. Merge + re-score
  const all = base.findings.concat(dialectFindings, unusedFindings);
  const { scoreHealth } = require('./sql-sentinel');
  const { score, grade } = scoreHealth(all);

  // Re-sort the prioritized plan
  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const prioritizedPlan = all.slice().sort((a, b) => (sevOrder[a.severity] - sevOrder[b.severity]) || (b.line - a.line));

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of all) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;

  return {
    ...base,
    tier: 'pro',
    healthScore: score,
    grade,
    findings: all,
    bySeverity,
    dialectFindingsCount: dialectFindings.length,
    unusedColumnFindingsCount: unusedFindings.length,
    prioritizedPlan: prioritizedPlan.map(f => ({
      priority: f.severity, rule: f.rule, title: f.title, line: f.line,
      why: f.why, fix: f.fix, estSavings: f.estSavings,
    })),
    rulesetVersion: '1.0.0-pro',
  };
}

module.exports = { auditPro, PRO_RULES, findUnusedColumnReads };

// LICENSE NOTE: This file is part of sql-sentinel Pro and requires a valid license key.
// The OSS engine (sql-sentinel.js) is MIT and unrestricted. Pro features activate
// after a license key is validated against POST https://takeaseatventure.com/v1/validate.
