// Pro engine smoke test — runs dialect rules + unused-column detection on real SQL.
const { auditPro, findUnusedColumnReads } = require('./sql-sentinel-pro');

let pass = 0, fail = 0;
function assert(c, m) { if (c) pass++; else { fail++; console.error('  FAIL: ' + m); } }
function ids(r) { return new Set(r.findings.map(f => f.rule)); }

// 1. BigQuery SELECT * on nested-looking table
(function () {
  const r = auditPro('SELECT * FROM ga4_events LIMIT 10', { dialect: 'bigquery' });
  assert(ids(r).has('BQ001'), 'BQ001 fires for SELECT * on nested-looking table');
})();

// 2. BigQuery multiple UNNEST
(function () {
  const r = auditPro('SELECT id FROM t, UNNEST(a), UNNEST(b) WHERE id=1', { dialect: 'bigquery' });
  assert(ids(r).has('BQ002'), 'BQ002 fires for multiple UNNEST');
})();

// 3. Snowflake SELECT * dialect rule
(function () {
  const r = auditPro('SELECT * FROM sales WHERE region=\'US\'', { dialect: 'snowflake' });
  assert(ids(r).has('SF001'), 'SF001 fires for Snowflake SELECT *');
})();

// 4. Postgres ILIKE
(function () {
  const r = auditPro("SELECT id FROM users WHERE name ILIKE '%bob%'", { dialect: 'postgres' });
  assert(ids(r).has('PG001'), 'PG001 fires for ILIKE');
})();

// 5. Unused-column detection with metadata
(function () {
  const tableColumns = { 'public.users': ['id', 'name', 'email', 'password_hash', 'created_at', 'updated_at', 'deleted_at', 'metadata_json'] };
  const findings = findUnusedColumnReads('SELECT * FROM users', tableColumns);
  assert(findings.length > 0, 'unused-column detection fires for SELECT * with unused cols');
  assert(findings.some(f => f.id === 'UC001'), 'UC001 finding present');
  assert(findings[0].estSavings.includes('%'), 'estSavings includes a percentage');
})();

// 6. Pro audit merges OSS + dialect + unused and re-scores
(function () {
  const tableColumns = { 'public.users': ['id', 'name', 'email', 'password_hash', 'created_at', 'updated_at', 'deleted_at', 'metadata_json', 'prefs', 'avatar_url'] };
  const r = auditPro("SELECT * FROM users WHERE name ILIKE '%x%'", { dialect: 'postgres', tableColumns });
  assert(r.tier === 'pro', 'auditPro returns tier=pro');
  assert(r.findings.length >= 3, 'pro audit yields 3+ findings across rulesets');
  assert(r.healthScore < 80, 'messy pro query scores < 80');
})();

// 7. Pro does NOT break when no dialect/metadata provided
(function () {
  const r = auditPro('SELECT id FROM users WHERE created_at >= 1');
  assert(r.tier === 'pro', 'pro audit works without dialect/metadata');
})();

console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total.`);
process.exit(fail ? 1 : 0);
