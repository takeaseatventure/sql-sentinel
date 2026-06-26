'use strict';

// ============================================================================
// sql-sentinel engine tests — zero-dep, runs with `node test.js`.
// Each test feeds real SQL and asserts the engine flags the expected rule.
// ============================================================================

const { auditSql, splitStatements, scoreHealth } = require('./sql-sentinel');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL: ' + msg); }
}
function ruleIds(report) { return new Set(report.findings.map(f => f.rule)); }

// --- 1. splitStatements: multiple statements, comments, strings ---
(function () {
  const sql = `-- comment
SELECT 1; /* block */ SELECT 'a;b' AS x; SELECT 2;`;
  const s = splitStatements(sql);
  assert(s.length === 3, 'splitStatements returns 3 statements (got ' + s.length + ')');
  assert(s[1].sql.includes("'a;b'"), 'semicolon inside string is NOT a terminator');
})();

// --- 2. SELECT * flagged ---
(function () {
  const r = auditSql('SELECT * FROM users WHERE id = 1');
  assert(ruleIds(r).has('SQL001'), 'SELECT * flagged SQL001');
})();

// --- 3. No WHERE on a big-table SELECT flagged ---
(function () {
  const r = auditSql('SELECT id FROM users');
  assert(ruleIds(r).has('SQL002'), 'SELECT with no WHERE flagged SQL002');
})();

// --- 4. Leading wildcard LIKE flagged ---
(function () {
  const r = auditSql("SELECT id FROM users WHERE name LIKE '%smith'");
  assert(ruleIds(r).has('SQL003'), "LIKE '%x' flagged SQL003");
})();

// --- 5. Function on column flagged ---
(function () {
  const r = auditSql("SELECT id FROM users WHERE LOWER(name) = 'bob'");
  assert(ruleIds(r).has('SQL004'), 'LOWER(col) flagged SQL004');
})();

// --- 6. CROSS JOIN flagged ---
(function () {
  const r = auditSql('SELECT a.id FROM a CROSS JOIN b');
  assert(ruleIds(r).has('SQL005'), 'CROSS JOIN flagged SQL005');
})();

// --- 7. Comma join flagged ---
(function () {
  const r = auditSql('SELECT a.id FROM a, b WHERE a.id = b.id');
  assert(ruleIds(r).has('SQL005'), 'comma join flagged SQL005');
})();

// --- 8. SELECT DISTINCT flagged ---
(function () {
  const r = auditSql('SELECT DISTINCT a, b FROM t WHERE a > 0');
  assert(ruleIds(r).has('SQL006'), 'SELECT DISTINCT flagged SQL006');
})();

// --- 9. ORDER BY without LIMIT flagged ---
(function () {
  const r = auditSql('SELECT id FROM t WHERE x=1 ORDER BY id');
  assert(ruleIds(r).has('SQL007'), 'ORDER BY no LIMIT flagged SQL007');
})();

// --- 10. NOT IN (subquery) flagged ---
(function () {
  const r = auditSql('SELECT id FROM t WHERE id NOT IN (SELECT id FROM u)');
  assert(ruleIds(r).has('SQL008'), 'NOT IN subquery flagged SQL008');
})();

// --- 11. COUNT(DISTINCT) flagged ---
(function () {
  const r = auditSql('SELECT COUNT(DISTINCT user_id) FROM events WHERE d=1');
  assert(ruleIds(r).has('SQL011'), 'COUNT(DISTINCT) flagged SQL011');
})();

// --- 12. LIMIT without ORDER BY flagged ---
(function () {
  const r = auditSql('SELECT id FROM t WHERE x=1 LIMIT 10');
  assert(ruleIds(r).has('SQL012'), 'LIMIT no ORDER BY flagged SQL012');
})();

// --- 13. UNION (not UNION ALL) flagged ---
(function () {
  const r = auditSql('SELECT id FROM a UNION SELECT id FROM b');
  assert(ruleIds(r).has('SQL022'), 'UNION (not ALL) flagged SQL022');
})();

// --- 14. UNION ALL NOT flagged ---
(function () {
  const r = auditSql('SELECT id FROM a UNION ALL SELECT id FROM b');
  assert(!ruleIds(r).has('SQL022'), 'UNION ALL not flagged SQL022');
})();

// --- 15. Fact-table-no-filter heuristic ---
(function () {
  const r = auditSql('SELECT id FROM user_events');
  assert(ruleIds(r).has('SQL015'), 'fact table no date filter flagged SQL015');
})();

// --- 16. DELETE without WHERE flagged ---
(function () {
  const r = auditSql('DELETE FROM users');
  assert(ruleIds(r).has('SQL020'), 'DELETE no WHERE flagged SQL020');
})();

// --- 17. Window OVER () flagged ---
(function () {
  const r = auditSql('SELECT id, SUM(x) OVER () FROM t WHERE d=1');
  assert(ruleIds(r).has('SQL018'), 'OVER () no partition flagged SQL018');
})();

// --- 18. 5+ JOINs flagged ---
(function () {
  const r = auditSql('SELECT a.id FROM a JOIN b ON a.id=b.id JOIN c ON b.id=c.id JOIN d ON c.id=d.id JOIN e ON d.id=e.id JOIN f ON e.id=f.id WHERE a.x=1');
  assert(ruleIds(r).has('SQL014'), '5+ joins flagged SQL014');
})();

// --- 19. Clean query gets a high score and no findings ---
(function () {
  const r = auditSql('SELECT id, email FROM users WHERE created_at >= TIMESTAMP \'2026-01-01\' AND created_at < TIMESTAMP \'2026-02-01\' ORDER BY id LIMIT 100');
  assert(r.healthScore >= 80, 'clean sargable query scores >= 80 (got ' + r.healthScore + ')');
})();

// --- 20. Catastrophic query gets a low score ---
(function () {
  const r = auditSql('SELECT * FROM events'); // SELECT * + no WHERE + fact table
  assert(r.healthScore < 70, 'catastrophic query scores < 70 (got ' + r.healthScore + ')');
  assert(r.grade !== 'A' && r.grade !== 'B', 'catastrophic query is not A/B');
})();

// --- 21. prioritizedPlan sorted by severity ---
(function () {
  const r = auditSql('SELECT * FROM a CROSS JOIN b');
  const sev = r.prioritizedPlan.map(p => p.priority);
  assert(sev[0] === 'critical', 'prioritized plan leads with critical');
})();

// --- 22. INSERT/DDL statements skipped, not audited as queries ---
(function () {
  const r = auditSql('INSERT INTO t (a) VALUES (1); SELECT * FROM t;');
  assert(r.statementsAudited === 1, 'only the SELECT audited, INSERT skipped (got ' + r.statementsAudited + ')');
})();

// --- 23. Multiple findings aggregate, score drops with each ---
(function () {
  const r = auditSql("SELECT DISTINCT * FROM events, logs WHERE LOWER(name) LIKE '%x%' ORDER BY id");
  assert(r.findings.length >= 3, 'multi-problem query yields 3+ findings (got ' + r.findings.length + ')');
})();

// --- 24. Hash comment (BigQuery/Redshift) handled ---
(function () {
  const r = auditSql('# bigquery comment\nSELECT * FROM t');
  assert(ruleIds(r).has('SQL001'), 'hash-comment SQL still parsed and flagged');
})();

console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total.`);
process.exit(fail ? 1 : 0);
