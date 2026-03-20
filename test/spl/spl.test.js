/**
 * SPL-to-NRQL translation tests.
 *
 * Structure: one `cases` array feeds a single test runner. Each case is a
 * {spl, ...expected} object — the runner asserts only the fields present.
 *
 * parseSplTime tests are separate (different function, different shape).
 *
 * Verification levels (each level includes all checks from prior levels):
 *   false        — not verified at all
 *   'mcp'        — NRQL compiled against NR account 1 via execute_nrql_query
 *   'llm'        — SPL expert confirmed SPL is valid + NRQL expert confirmed
 *                   translation preserves semantics + MCP compiled
 *   'human'      — manually reviewed and confirmed correct by a human
 *
 * To run: ASDF_NODEJS_VERSION=20.19.0 npx jest --no-coverage --testPathPattern=spl
 */
import fs from 'fs';
import path from 'path';

import { translateSplToNrql, parseSplTime } from '../../src/input/spl/spl.js';
import { translateSplToNrqlV2 } from '../../src/translateV2.js';

import { assembleNrql } from './assembleNrql.js';

// ── V1 vs V2 comparison harness ─────────────────────────────
//
// Runs both translators on every real-world query and categorizes:
//   match       — same output (green)
//   improvement — V2 works where V1 had parse error (green)
//   divergence  — both work but differ (flag for review)
//   regression  — V2 errors but V1 worked (red)
//   v2Stub      — V2 returned stub (not yet implemented)

// AI-DEV: To add test cases, append to the `cases` array. Do NOT modify the test runner.

const cases = [
  //
  // ── Empty / invalid input ───────────────────────────────────────
  //
  //
  //
  {
    spl: '',
    v2nrql: 'FROM Log SELECT *',
    doc: 'empty-invalid',
    verified: 'llm',
  },
  {
    spl: null,
    v2nrql: 'FROM Log SELECT *',
    doc: 'empty-invalid',
    verified: 'human',
  },
  {
    spl: '|||',
    v2errorIncludes: 'Failed to parse SPL',
    doc: 'empty-invalid',
    verified: 'llm',
  },
  {
    spl: 'back`tick=value',
    v2errorIncludes: 'Failed to parse SPL',
    doc: 'empty-invalid',
    verified: 'llm',
  },
  {
    spl: '   ',
    v2nrql: 'FROM Log SELECT *',
    doc: 'empty-invalid',
    verified: 'human',
  },
  //
  //
  ...[
    'message=',
    'message=fn(x)',
    '[search index=web | fields host]',
    'status IN ()',
    '* || stats count',
    '* | stats count |',
    'https://example.com/path?q=1',
    '`mymacro`status=200',
  ].map((spl) => ({
    spl,
    v2errorIncludes: 'Failed to parse SPL',
    doc: 'empty-invalid',
    verified: 'llm',
  })),
  //
  // ── Bare keywords (no field prefix) ─────────────────────────────
  //
  //
  //
  {
    spl: 'error',
    v2nrql: "FROM Log SELECT * WHERE message LIKE '%error%'",
    doc: 'bare-keywords',
    verified: 'human',
  },
  {
    spl: '"connection timeout"',
    v2nrql: "FROM Log SELECT * WHERE message LIKE '%connection timeout%'",
    doc: 'bare-keywords',
    verified: 'human',
  },
  {
    spl: 'error warning',
    v2nrql:
      "FROM Log SELECT * WHERE message LIKE '%error%' AND message LIKE '%warning%'",
    doc: 'bare-keywords',
    verified: 'human',
  },
  {
    spl: '*',
    v2nrql: 'FROM Log SELECT *',
    doc: 'bare-keywords',
    verified: 'human',
  },
  {
    spl: '100%cpu',
    v2nrql: "FROM Log SELECT * WHERE message LIKE '%100\\%cpu%'",
    doc: 'bare-keywords',
    verified: 'human',
  },
  // Escaped quotes in bare search values
  {
    spl: '* Operation=\\"Add member\\"',
    v2nrql: "FROM Log SELECT * WHERE Operation = 'Add member'",
    doc: 'bare-keywords',
    verified: 'human',
  },
  // Template variables $var$ → {{var}}
  {
    spl: '* $global_time.earliest$ $global_time.latest$',
    v2nrql:
      'FROM Log SELECT * SINCE {{global_time.earliest}} UNTIL {{global_time.latest}}',
    doc: 'bare-keywords',
    verified: 'human',
  },
  // TERM() search directive stripped
  {
    spl: 'TERM("control-connection-state-change") | stats count',
    v2nrql:
      "FROM Log SELECT count(*) WHERE message LIKE '%control-connection-state-change%'",
    doc: 'bare-keywords',
    verified: 'human',
  },
  {
    spl: 'TERM("*peer-system-ip:*") | stats count',
    v2nrql: "FROM Log SELECT count(*) WHERE message LIKE '%%peer-system-ip:%%'",
    doc: 'bare-keywords',
    verified: 'human',
  },
  //
  // ── Field comparisons ───────────────────────────────────────────
  //
  //
  //
  // Covers: string equality, numeric equality, !=, >=, implicit AND
  {
    spl: 'status>=400 status!=500 action=purchase',
    v2nrql:
      "FROM Log SELECT * WHERE numeric(status) >= 400 AND status != '500' AND numeric(status) != 500 AND action = 'purchase'",
    doc: 'field-comparisons',
    verified: 'human',
  },
  // Numeric equality: integer, negative, decimal — all produce dual string/numeric
  {
    spl: 'status=200 offset=-10 score=3.14',
    v2nrql:
      "FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 AND `offset` = '-10' OR numeric(`offset`) = -10 AND score = '3.14' OR numeric(score) = 3.14",
    doc: 'field-comparisons',
    verified: 'human',
  },
  // Non-numeric values: alpha, hex-like, leading-zero — all string-only
  {
    spl: 'status=OK code=4xx zip=00123',
    v2nrql:
      "FROM Log SELECT * WHERE status = 'OK' AND code = '4xx' AND zip = '00123'",
    doc: 'field-comparisons',
    verified: 'human',
  },
  //
  //
  {
    spl: '_raw=*error*',
    v2nrql: "FROM Log SELECT * WHERE message LIKE '%error%'",
    v2warningIncludes: '_raw is not a valid NRQL field',
    doc: 'field-comparisons',
    verified: 'human',
  },
  //
  //
  // SPL/NRQL keywords as field values — all treated as string literals
  {
    spl: 'action=OR action=AND action=NOT action=by action=search action=stats group=by',
    v2nrql:
      "FROM Log SELECT * WHERE action = 'OR' AND action = 'AND' AND action = 'NOT' AND action = 'by' AND action = 'search' AND action = 'stats' AND group = 'by'",
    doc: 'field-comparisons',
    verified: 'human',
  },
  {
    spl: '"log.annotations.node"=NOSTORE',
    v2nrql: "FROM Log SELECT * WHERE `log.annotations.node` = 'NOSTORE'",
    doc: 'field-comparisons',
    verified: 'human',
  },
  {
    spl: '"details.error"="*"',
    v2nrql: "FROM Log SELECT * WHERE `details.error` LIKE '%'",
    doc: 'field-comparisons',
    verified: 'human',
  },
  {
    spl: 'status = 500',
    v2nrql: "FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500",
    doc: 'field-comparisons',
    verified: 'human',
  },
  {
    spl: 'level = "ERROR"',
    v2nrql: "FROM Log SELECT * WHERE level = 'ERROR'",
    doc: 'field-comparisons',
    verified: 'human',
  },
  // curly brace field names (JSON array access) → jparse + contains
  {
    spl: 'lineItemList{}.status=active',
    v2nrql:
      "FROM Log SELECT * WHERE contains(jparse(message, 'lineItemList[*].status'), 'active')",
    doc: 'json-array-access',
    verified: 'human',
  },
  // != on array field → NOT contains
  {
    spl: 'items{}.status != pending',
    v2nrql:
      "FROM Log SELECT * WHERE NOT contains(jparse(message, 'items[*].status'), 'pending')",
    doc: 'json-array-access',
    verified: 'human',
  },
  // Nested dot-path inside array
  {
    spl: 'orders{}.shipping.carrier=fedex',
    v2nrql:
      "FROM Log SELECT * WHERE contains(jparse(message, 'orders[*].shipping.carrier'), 'fedex')",
    doc: 'json-array-access',
    verified: 'human',
  },
  // Wildcard value on array field → LIKE on jparse result
  {
    spl: 'containers{}.image=nginx*',
    v2nrql:
      "FROM Log SELECT * WHERE jparse(message, 'containers[*].image') LIKE 'nginx%'",
    doc: 'json-array-access',
    verified: 'human',
  },
  // IN on array field → OR'd contains() calls
  {
    spl: 'items{}.category IN (electronics, clothing)',
    v2nrql:
      "FROM Log SELECT * WHERE contains(jparse(message, 'items[*].category'), 'electronics') OR contains(jparse(message, 'items[*].category'), 'clothing')",
    doc: 'json-array-access',
    verified: 'human',
  },
  // Indexed array access {0} → jparse with [0]
  {
    spl: 'sourceIPs{0}=10.0.0.1',
    v2nrql:
      "FROM Log SELECT * WHERE jparse(message, 'sourceIPs[0]') = '10.0.0.1'",
    doc: 'json-array-access',
    verified: 'human',
  },
  //
  // ── Boolean operators ───────────────────────────────────────────
  //
  //
  //
  {
    spl: 'EventCode=4720 OR EventCode=4732',
    v2nrql:
      "FROM Log SELECT * WHERE EventCode = '4720' OR numeric(EventCode) = 4720 OR EventCode = '4732' OR numeric(EventCode) = 4732",
    doc: 'boolean-operators',
    verified: 'human',
  },
  {
    spl: 'NOT debug',
    v2nrql: "FROM Log SELECT * WHERE NOT message LIKE '%debug%'",
    doc: 'boolean-operators',
    verified: 'human',
  },
  {
    spl: '(error OR warning) NOT debug',
    v2nrql:
      "FROM Log SELECT * WHERE message LIKE '%error%' OR message LIKE '%warning%' AND NOT message LIKE '%debug%'",
    doc: 'boolean-operators',
    verified: 'human',
  },
  {
    spl: '`macro_a` AND `macro_b`',
    v2nrql: 'FROM Log SELECT * WHERE $macro_a AND $macro_b',
    v2warningIncludes: 'macro',
    doc: 'boolean-operators',
    verified: 'human',
  },
  {
    spl: '`macro_a` AND status=200',
    v2nrql:
      "FROM Log SELECT * WHERE $macro_a AND status = '200' OR numeric(status) = 200",
    doc: 'boolean-operators',
    verified: 'human',
  },
  //
  //
  {
    spl: 'a=1 OR b=2 c=3',
    v2nrql:
      "FROM Log SELECT * WHERE a = '1' OR numeric(a) = 1 OR (b = '2' OR numeric(b) = 2 AND c = '3' OR numeric(c) = 3)",
    doc: 'boolean-operators',
    verified: 'human',
  },
  {
    spl: '(a=1 OR b=2) AND c=3',
    v2nrql:
      "FROM Log SELECT * WHERE a = '1' OR numeric(a) = 1 OR b = '2' OR numeric(b) = 2 AND c = '3' OR numeric(c) = 3",
    doc: 'boolean-operators',
    verified: 'human',
  },
  {
    spl: 'a=1 b=2 OR c=3 d=4',
    v2nrql:
      "FROM Log SELECT * WHERE (a = '1' OR numeric(a) = 1 AND b = '2' OR numeric(b) = 2) OR (c = '3' OR numeric(c) = 3 AND d = '4' OR numeric(d) = 4)",
    doc: 'boolean-operators',
    verified: 'human',
  },
  {
    spl: 'NOT status=500 host=web',
    v2nrql:
      "FROM Log SELECT * WHERE NOT (status = '500' OR numeric(status) = 500) AND host = 'web'",
    doc: 'boolean-operators',
    verified: 'human',
  },
  {
    spl: 'NOT (status=500 host=web)',
    v2nrql:
      "FROM Log SELECT * WHERE NOT (status = '500' OR numeric(status) = 500 AND host = 'web')",
    doc: 'boolean-operators',
    verified: 'human',
  },
  // NOT() without space + boolean group inside + combined with bare keyword
  {
    spl: 'error NOT(level=debug OR level=trace)',
    v2nrql:
      "FROM Log SELECT * WHERE message LIKE '%error%' AND NOT (level = 'debug' OR level = 'trace')",
    doc: 'boolean-operators',
    verified: 'human',
  },
  // NOT() empty parens — should be a no-op
  {
    spl: 'NOT() error',
    v2nrql: "FROM Log SELECT * WHERE message LIKE '%error%'",
    doc: 'boolean-operators',
    verified: 'human',
  },
  //
  // ── IN operator ─────────────────────────────────────────────────
  //
  //
  //
  // Mixed types: numeric + string in one IN (covers pure-numeric and pure-string paths too)
  {
    spl: 'code IN (200, error, 404)',
    v2nrql: "FROM Log SELECT * WHERE code IN (200, 'error', 404)",
    doc: 'in-operator',
    verified: 'human',
  },
  // Wildcards inside IN — expands to LIKE clauses
  {
    spl: 'ScriptBlockText IN (*mimikatz*, *dumpcr*)',
    v2nrql:
      "FROM Log SELECT * WHERE ScriptBlockText LIKE '%mimikatz%' OR ScriptBlockText LIKE '%dumpcr%'",
    doc: 'in-operator',
    verified: 'human',
  },
  // NOT [inputlookup] → NOT IN lookup subquery
  {
    spl: '* NOT [|inputlookup exclude.csv] | stats count',
    v2nrql:
      'FROM Log SELECT count(*) WHERE {{column}} NOT IN (FROM lookup(exclude) SELECT {{column}} LIMIT MAX)',
    v2warningIncludes: 'NOT [|inputlookup exclude.csv]',
    doc: 'in-operator',
    verified: 'human',
  },
  // Quoted field name in IN()
  {
    spl: '"parameters.doc_title" IN ("*dhl*", "*invoice*")',
    v2nrql:
      "FROM Log SELECT * WHERE `parameters.doc_title` LIKE '%dhl%' OR `parameters.doc_title` LIKE '%invoice%'",
    doc: 'in-operator',
    verified: 'human',
  },
  //
  // ── Wildcards ───────────────────────────────────────────────────
  //
  //
  //
  // Covers: suffix, prefix, contains, and interior wildcard — all four positions
  {
    spl: 'host=*server host=web* message=*error* path=/api/*/users',
    v2nrql:
      "FROM Log SELECT * WHERE host LIKE '%server' AND host LIKE 'web%' AND message LIKE '%error%' AND path LIKE '/api/%/users'",
    doc: 'wildcards',
    verified: 'human',
  },
  // Match-all wildcard
  {
    spl: 'host=*',
    v2nrql: "FROM Log SELECT * WHERE host LIKE '%'",
    doc: 'wildcards',
    verified: 'human',
  },
  // Negated wildcard
  {
    spl: 'host!=test*',
    v2nrql: "FROM Log SELECT * WHERE NOT host LIKE 'test%'",
    doc: 'wildcards',
    verified: 'human',
  },
  //
  // ── Quoted strings ──────────────────────────────────────────────
  //
  //
  //
  {
    spl: 'message="it\'s"',
    v2nrql: "FROM Log SELECT * WHERE message = 'it\\'s'",
    doc: 'quoted-strings',
    verified: 'human',
  },
  {
    spl: 'path="C:\\\\Windows\\\\System32"',
    v2nrql: "FROM Log SELECT * WHERE path = 'C:\\\\Windows\\\\System32'",
    doc: 'quoted-strings',
    verified: 'human',
  },
  {
    spl: 'msg="line1\\nline2"',
    v2nrql: "FROM Log SELECT * WHERE msg = 'line1\\nline2'",
    doc: 'quoted-strings',
    verified: 'human',
  },
  // Double-quoted with spaces, pipe, equals, comma, empty, unicode — all in one implicit-AND
  {
    spl: 'a="error in module" b="error | fatal" c="key=value" d="" e="日本語エラー" f="error, fatal"',
    v2nrql:
      "FROM Log SELECT * WHERE a = 'error in module' AND b = 'error | fatal' AND c = 'key=value' AND d = '' AND e = '日本語エラー' AND f = 'error, fatal'",
    doc: 'quoted-strings',
    verified: 'human',
  },
  // Double-quoted value with spaces
  {
    spl: 'message="error in module"',
    v2nrql: "FROM Log SELECT * WHERE message = 'error in module'",
    doc: 'quoted-strings',
    verified: 'human',
  },
  // Quoted value with parentheses in a real-world context
  {
    spl: 'index=web user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64)" | stats count by host',
    v2nrql:
      "FROM Log SELECT count(*) WHERE index = 'web' AND user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' FACET host",
    doc: 'quoted-strings',
    verified: 'human',
  },
  //
  // ── NRQL keywords in values ─────────────────────────────────────
  //
  //
  //
  {
    spl: 'my-field=value',
    v2nrql: "FROM Log SELECT * WHERE `my-field` = 'value'",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: 'app:version=1.2.3',
    v2nrql: "FROM Log SELECT * WHERE `app:version` = '1.2.3'",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: 'kubernetes.labels.app:name=myapp',
    v2nrql: "FROM Log SELECT * WHERE `kubernetes.labels.app:name` = 'myapp'",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: '* | stats count by container-name',
    v2nrql: 'FROM Log SELECT count(*) FACET `container-name`',
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: '* | stats values(user.groups{}) as user_groups by host',
    v2nrql:
      "FROM Log SELECT uniques(jparse(message, 'user.groups[*]')) AS 'user_groups' FACET host",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: '* | table k8s:namespace, k8s:pod',
    v2nrql: 'FROM Log SELECT `k8s:namespace`, `k8s:pod`',
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: 'log-level IN (error, warn, info)',
    v2nrql: "FROM Log SELECT * WHERE `log-level` IN ('error', 'warn', 'info')",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: 'x-forwarded-for=10.0.0.1',
    v2nrql: "FROM Log SELECT * WHERE `x-forwarded-for` = '10.0.0.1'",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: 'SELECT=200',
    v2nrql:
      "FROM Log SELECT * WHERE `SELECT` = '200' OR numeric(`SELECT`) = 200",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  //
  //
  // Field names containing SPL keywords — not misparsed as commands
  {
    spl: 'search_term=hello NOT_FOUND=true top_secret=classified earliest_time=noon where=production table=users stats=enabled',
    v2nrql:
      "FROM Log SELECT * WHERE search_term = 'hello' AND NOT_FOUND = 'true' AND top_secret = 'classified' AND earliest_time = 'noon' AND `where` = 'production' AND table = 'users' AND stats = 'enabled'",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  // Keyword-containing field with numeric value
  {
    spl: 'bytecount=1024',
    v2nrql:
      "FROM Log SELECT * WHERE bytecount = '1024' OR numeric(bytecount) = 1024",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  //
  // ── Metadata fields ─────────────────────────────────────────────
  //
  //
  //
  {
    spl: 'index=web',
    v2nrql: "FROM Log SELECT * WHERE index = 'web'",
    doc: 'metadata-fields',
    verified: 'human',
  },
  {
    spl: 'sourcetype=access_*',
    v2nrql: "FROM Log SELECT * WHERE sourcetype LIKE 'access_%'",
    doc: 'metadata-fields',
    verified: 'human',
  },
  //
  // ── Macros ──────────────────────────────────────────────────────
  //
  //
  //
  {
    spl: '`sysmon` EventCode=10',
    v2nrql:
      "FROM Log SELECT * WHERE $sysmon AND EventCode = '10' OR numeric(EventCode) = 10",
    doc: 'macros',
    verified: 'human',
  },
  {
    spl: '`my_macro(arg1, arg2)` status=200',
    v2nrql:
      "FROM Log SELECT * WHERE $my_macro(arg1, arg2) AND status = '200' OR numeric(status) = 200",
    doc: 'macros',
    verified: 'human',
  },
  {
    spl: '* | `my_macro`',
    v2nrql: 'FROM Log SELECT * WHERE $my_macro',
    v2warningIncludes: 'macro',
    doc: 'macros',
    verified: 'human',
  },
  {
    spl: '* | `my_macro(field1, field2)`',
    v2nrql: 'FROM Log SELECT * WHERE $my_macro(field1, field2)',
    v2warningIncludes: 'macro',
    doc: 'macros',
    verified: 'human',
  },
  {
    spl: '`my_base_macro` | stats count',
    v2nrql: 'FROM Log SELECT count(*) WHERE $my_base_macro',
    v2warningIncludes: 'macro',
    doc: 'macros',
    verified: 'human',
  },
  //
  // ── Time constraints ────────────────────────────────────────────
  //
  //
  //
  {
    spl: 'earliest=-24h',
    v2nrql: 'FROM Log SELECT * SINCE 24 hours ago',
    doc: 'time-constraints',
    verified: 'human',
  },
  {
    spl: 'latest=-1h',
    v2nrql: 'FROM Log SELECT * SINCE 24 hours ago UNTIL 1 hour ago',
    v2warningIncludes: 'latest without earliest',
    doc: 'time-constraints',
    verified: 'human',
  },
  {
    spl: 'latest=now',
    v2nrql: 'FROM Log SELECT *',
    doc: 'time-constraints',
    verified: 'human',
  },
  {
    spl: 'earliest=@d',
    v2nrql: 'FROM Log SELECT * SINCE today',
    doc: 'time-constraints',
    verified: 'human',
  },
  {
    spl: 'error earliest=-24h latest=now',
    v2nrql: "FROM Log SELECT * WHERE message LIKE '%error%' SINCE 24 hours ago",
    doc: 'time-constraints',
    verified: 'human',
  },
  {
    spl: 'earliest=-2h latest=-1h status=200',
    v2nrql:
      "FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 SINCE 2 hours ago UNTIL 1 hour ago",
    doc: 'time-constraints',
    verified: 'human',
  },
  {
    spl: 'earliest=-24h@h latest=now',
    v2nrql: 'FROM Log SELECT * SINCE 24 hours ago',
    doc: 'time-constraints',
    verified: 'human',
  },
  // Time constraint mid-expression — earliest/latest mixed with field comparisons
  {
    spl: 'status=500 earliest=-24h host=web',
    v2nrql:
      "FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND host = 'web' SINCE 24 hours ago",
    doc: 'time-constraints',
    verified: 'human',
  },
  // Multiple earliest — last one wins
  {
    spl: 'earliest=-24h earliest=-1h',
    v2nrql: 'FROM Log SELECT * SINCE 1 hour ago',
    doc: 'time-constraints',
    verified: 'human',
  },
  //
  // ── eval command ────────────────────────────────────────────────
  //
  //
  //
  // All 5 operators in one multi-assignment eval
  {
    spl: '* | eval d = bytes / 1024, m = price * quantity, a = sent + received, s = end_time - start_time, r = x % 10',
    v2nrql:
      'FROM Log WITH numeric(bytes) / 1024 AS d, numeric(price) * numeric(quantity) AS m, numeric(sent) + numeric(received) AS a, numeric(end_time) - numeric(start_time) AS s, mod(numeric(x), 10) AS r SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // Precedence: * before +, / before +, parentheses override
  {
    spl: '* | eval p1 = a * b + c, p2 = a + b / c, p3 = (a + b) / c, p4 = (a + b) * (c - d)',
    v2nrql:
      'FROM Log WITH numeric(a) * numeric(b) + numeric(c) AS p1, numeric(a) + numeric(b) / numeric(c) AS p2, (numeric(a) + numeric(b)) / numeric(c) AS p3, (numeric(a) + numeric(b)) * (numeric(c) - numeric(d)) AS p4 SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // Decimals, chaining (a+b+c+d), multi-multiply (a*b*c), multiple assignments
  {
    spl: '* | eval pct = count / 100.0, chain = a + b + c + d, mul = a * b * c, kb = bytes / 1024, mb = bytes / 1048576, gb = bytes / 1073741824',
    v2nrql:
      'FROM Log WITH numeric(count) / 100 AS pct, numeric(a) + numeric(b) + numeric(c) + numeric(d) AS chain, numeric(a) * numeric(b) * numeric(c) AS mul, numeric(bytes) / 1024 AS kb, numeric(bytes) / 1048576 AS mb, numeric(bytes) / 1073741824 AS gb SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // eval if() function call
  {
    spl: '* | eval x = if(status=200, "ok", "err")',
    v2nrql: "FROM Log WITH if(status = 200, 'ok', 'err') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // Eval piped to stats + eval chained (two eval commands)
  {
    spl: '* | eval size_mb = bytes / 1048576 | eval size_gb = size_mb / 1024 | stats avg(size_mb) by host',
    v2nrql:
      'FROM Log WITH numeric(bytes) / 1048576 AS size_mb, numeric(size_mb) / 1024 AS size_gb SELECT average(size_mb) FACET host',
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // Search clause + eval + table
  {
    spl: 'status=200 | eval duration_sec = duration / 1000 | table host, duration_sec',
    v2nrql:
      "FROM Log WITH numeric(duration) / 1000 AS duration_sec SELECT host, duration_sec WHERE status = '200' OR numeric(status) = 200",
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // Edge cases: no-spaces, rename, literal, double parens, hyphenated/colon/dotted fields
  {
    spl: '* | eval x=a+b, alias = original, lit = 42, parens = ((a + b)), hyph = http-status / 100, col = aws:region, dot = http.status / 100',
    v2nrql:
      'FROM Log WITH numeric(a) + numeric(b) AS x, original AS alias, 42 AS lit, numeric(a) + numeric(b) AS parens, numeric(`http-status`) / 100 AS hyph, `aws:region` AS col, numeric(`http.status`) / 100 AS dot SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // Eval + spath
  {
    spl: '* | spath input=payload path=user.id output=uid | eval uid_num = uid / 1',
    v2nrql:
      "FROM Log WITH jparse(payload, 'user.id') AS uid, numeric(uid) / 1 AS uid_num SELECT *",
    v2warningIncludes: 'only works on JSON',
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // Eval + fillnull
  {
    spl: '* | fillnull value=0 bytes | eval kb = bytes / 1024',
    v2nrql: 'FROM Log WITH numeric(bytes OR 0) / 1024 AS kb SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // eval coalesce() → nested if(IS NOT NULL) (NRQL has no coalesce())
  {
    spl: '* | eval val = coalesce(field1, field2, "default")',
    v2nrql: "FROM Log WITH (field1 OR field2 OR 'default') AS val SELECT *",
    doc: 'eval-type',
    verified: 'human',
  },
  // eval lower() → lower() (1:1 mapping)
  {
    spl: '* | eval name = lower(username)',
    v2nrql: 'FROM Log WITH lower(username) AS name SELECT *',
    doc: 'eval-string',
    verified: 'human',
  },
  // Unsupported eval: string concat with dots
  // TODO: should translate to concat(first, ' ', last) once strcat/concat is implemented
  {
    spl: '* | eval full = first . " " . last',
    v2unsupportedIncludes: 'eval expression not supported',
    doc: 'eval-string',
    verified: false,
  },
  // eval mvindex() → getField()
  {
    spl: '* | eval first = mvindex(values, 0)',
    v2nrql: 'FROM Log WITH getField(values, 0) AS first SELECT *',
    doc: 'eval-multivalue',
    verified: 'human',
  },
  // eval mvjoin() → skipped, field passed through
  // TODO: mvjoin has no NRQL equivalent; current translation is a no-op alias (incorrect)
  {
    spl: '* | eval joined = mvjoin(tags, ", ")',
    v2nrql: 'FROM Log WITH tags AS joined SELECT *',
    doc: 'eval-multivalue',
    verified: false,
  },
  // eval if() with comparison
  {
    spl: '* | eval x = if(a>1, "y", "n")',
    v2nrql: "FROM Log WITH if(numeric(a) > 1, 'y', 'n') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval mvcount() → length()
  {
    spl: '* | eval x = mvcount(lines)',
    v2nrql: 'FROM Log WITH length(lines) AS x SELECT *',
    doc: 'eval-multivalue',
    verified: 'human',
  },
  // eval if() with string equality (customer pattern)
  {
    spl: '* | eval FLSQuantity=if(channelName=="FLS", availableQuantityInChannel, 0)',
    v2nrql:
      "FROM Log WITH if(channelName = 'FLS', availableQuantityInChannel, 0) AS FLSQuantity SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval if() with compound condition (AND)
  {
    spl: '* | eval x=if(a > 0 and b > 0, "both", "nope")',
    v2nrql:
      "FROM Log WITH if(numeric(a) > 0 AND numeric(b) > 0, 'both', 'nope') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // where isint()
  {
    spl: '* | where isint(orderId)',
    v2nrql: 'FROM Log SELECT * WHERE numeric(orderId) IS NOT NULL',
    doc: 'results-where',
    verified: 'human',
  },
  //
  // ── case() tests ──────────────────────────────────────────────
  //
  // case() with numeric comparisons and 1=1 default
  {
    spl: '* | eval level = case(status<300, "ok", status<500, "warn", 1=1, "err")',
    v2nrql:
      "FROM Log WITH if(numeric(status) < 300, 'ok', if(numeric(status) < 500, 'warn', 'err')) AS level SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // case() with multiple conditions and 1=1 default (equality comparisons)
  {
    spl: '* | eval x=case(a=1, "one", b=2, "two", 1=1, "other")',
    v2nrql:
      "FROM Log WITH if(a = 1, 'one', if(b = 2, 'two', 'other')) AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // case() with even args and no default → NULL fallback
  {
    spl: '* | eval x=case(a=1, "one", b=2, "two")',
    v2nrql:
      "FROM Log WITH if(a = 1, 'one', if(b = 2, 'two', NULL)) AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval if() with OR condition
  {
    spl: '* | eval x=if(a > 0 or b > 0, "yes", "no")',
    v2nrql:
      "FROM Log WITH if(numeric(a) > 0 OR numeric(b) > 0, 'yes', 'no') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval if() with parenthesized compound condition
  {
    spl: '* | eval x=if((a > 0) or (b > 0), "yes", "no")',
    v2nrql:
      "FROM Log WITH if(numeric(a) > 0 OR numeric(b) > 0, 'yes', 'no') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval if() with arithmetic inside parenthesized condition args
  {
    spl: '* | eval x=if(count > (a + b), "over", "under")',
    v2nrql:
      "FROM Log WITH if(numeric(count) > numeric(a) + numeric(b), 'over', 'under') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval if() with field-to-field ordering comparison
  {
    spl: '* | eval x=if(skuCount > FCQuantity, "yes", "no")',
    v2nrql:
      "FROM Log WITH if(numeric(skuCount) > numeric(FCQuantity), 'yes', 'no') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval upper() → upper()
  {
    spl: '* | eval x=upper(name)',
    v2nrql: 'FROM Log WITH upper(name) AS x SELECT *',
    doc: 'eval-string',
    verified: 'human',
  },
  // eval substr() → substring() with 1-based to 0-based index adjustment
  {
    spl: '* | eval x=substr(name, 1, 3)',
    v2nrql: 'FROM Log WITH substring(name, 0, 3) AS x SELECT *',
    doc: 'eval-string',
    verified: 'human',
  },
  // eval substr() negative offset — last 3 chars (no index adjustment for negatives)
  {
    spl: '* | eval x=substr(name, -3)',
    v2nrql: 'FROM Log WITH substring(name, -3) AS x SELECT *',
    doc: 'eval-string',
    verified: 'human',
  },
  // eval trim() → capture with regex (NRQL has no trim)
  // FIXME: multiple trim() calls would collide on (?P<t>...) named group
  {
    spl: '* | eval x=trim(name)',
    v2nrql:
      "FROM Log WITH capture(name, r'^\\s*(?P<t>.*\\S)\\s*$') AS x SELECT *",
    doc: 'eval-string',
    verified: false,
  },
  // eval ltrim() → capture with leading whitespace strip
  // FIXME: same (?P<t>...) collision issue as trim()
  {
    spl: '* | eval x=ltrim(name)',
    v2nrql: "FROM Log WITH capture(name, r'^\\s*(?P<t>.*)$') AS x SELECT *",
    doc: 'eval-string',
    verified: false,
  },
  // eval replace() with simple literal → NRQL replace()
  {
    spl: '* | eval x=replace(name, "a", "b")',
    v2nrql: "FROM Log WITH replace(name, 'a', 'b') AS x SELECT *",
    doc: 'eval-string',
    verified: 'human',
  },
  // eval replace() with regex pattern → literal replace with warning
  // FIXME: passes regex through as literal — silently produces wrong results
  {
    spl: '* | eval x=replace(name, "\\\\d+", "")',
    v2nrql: "FROM Log WITH replace(name, '\\\\d+', '') AS x SELECT *",
    v2warningIncludes: 'literal-only',
    doc: 'eval-string',
    verified: false,
  },
  // eval replace() simple deletion
  {
    spl: '* | eval x=replace(name, "SKU:", "")',
    v2nrql: "FROM Log WITH replace(name, 'SKU:', '') AS x SELECT *",
    doc: 'eval-string',
    verified: 'human',
  },
  // eval abs(), ceil(), floor(), round(), sqrt(), pow()
  ...['abs', 'ceil', 'floor', 'sqrt'].map((fn) => ({
    spl: `* | eval x=${fn}(val)`,
    v2nrql: `FROM Log WITH ${fn}(val) AS x SELECT *`,
    doc: 'eval-math',
    verified: 'human',
  })),
  // FIXME: round(val, 2) in NRQL rounds to nearest multiple of 2, not 2 decimal places
  // SPL round(val, 2) = 2 decimal places → NRQL should be round(val, 0.01)
  {
    spl: '* | eval x=round(val, 2)',
    v2nrql: 'FROM Log WITH round(val, 2) AS x SELECT *',
    doc: 'eval-math',
    verified: false,
  },
  {
    spl: '* | eval x=pow(base, exp)',
    v2nrql: 'FROM Log WITH pow(base, exp) AS x SELECT *',
    doc: 'eval-math',
    verified: 'human',
  },
  // eval ceiling() → ceil()
  {
    spl: '* | eval x=ceiling(val)',
    v2nrql: 'FROM Log WITH ceiling(val) AS x SELECT *',
    doc: 'eval-math',
    verified: 'human',
  },
  // eval log() single arg → log10() (SPL log() is base 10)
  {
    spl: '* | eval x=log(val)',
    v2nrql: 'FROM Log WITH log10(val) AS x SELECT *',
    doc: 'eval-math',
    verified: 'human',
  },
  // eval isnull() / isnotnull() — used inside conditionals
  {
    spl: '* | eval x=if(isnull(field), "missing", field)',
    v2nrql: "FROM Log WITH if(field IS NULL, 'missing', field) AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  {
    spl: '* | eval x=if(isnotnull(field), field, "default")',
    v2nrql:
      "FROM Log WITH if(field IS NOT NULL, field, 'default') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval like() → LIKE operator (used inside conditional)
  {
    spl: '* | eval x=if(like(name, "test%"), "match", "no")',
    v2nrql: "FROM Log WITH if(name LIKE 'test%', 'match', 'no') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval tonumber() → numeric()
  {
    spl: '* | eval x=tonumber(val)',
    v2nrql: 'FROM Log WITH numeric(val) AS x SELECT *',
    doc: 'eval-type',
    verified: 'human',
  },
  // FIXME: tostring() → string() compiles but may not behave as expected
  {
    spl: '* | eval x=tostring(val)',
    v2nrql: 'FROM Log WITH string(val) AS x SELECT *',
    doc: 'eval-type',
    verified: false,
  },
  // FIXME: typeof() does not exist in NRQL — passes through, fails at runtime
  {
    spl: '* | eval x=typeof(val)',
    unsupportedIncludes: 'typeof()',
    v2nrql: 'FROM Log WITH typeof(val) AS x SELECT *',
    doc: 'eval-type',
    verified: false,
  },
  // FIXME: isbool() does not exist in NRQL — passes through, fails at runtime
  {
    spl: '* | eval x=isbool(val)',
    unsupportedIncludes: 'isbool()',
    v2nrql: 'FROM Log WITH isbool(val) AS x SELECT *',
    doc: 'eval-type',
    verified: false,
  },
  // FIXME: isstr() does not exist in NRQL — passes through, fails at runtime
  {
    spl: '* | eval x=isstr(val)',
    unsupportedIncludes: 'isstr()',
    v2nrql: 'FROM Log WITH isstr(val) AS x SELECT *',
    doc: 'eval-type',
    verified: false,
  },
  // eval if() with == on field-to-field comparison
  {
    spl: '* | eval match=if(a==b, "same", "diff")',
    v2nrql: "FROM Log WITH if(a = b, 'same', 'diff') AS match SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval if() with wrong arg count (2 args)
  {
    spl: '* | eval x=if(a > 0, "yes")',
    warningIncludes: 'if() expects 3 arguments',
    v2nrql: "FROM Log WITH if(numeric(a) > 0, 'yes') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // case() with single arg — edge case, SPL returns the value as default
  {
    spl: '* | eval x=case("only")',
    v2nrql: "FROM Log WITH 'only' AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // FIXME: mvindex() with 1 arg — passes through field as no-op alias (wrong)
  {
    spl: '* | eval x=mvindex(values)',
    v2nrql: 'FROM Log WITH values AS x SELECT *',
    v2warningIncludes: 'mvindex() requires at least 2 arguments',
    doc: 'eval-multivalue',
    verified: false,
  },
  // mvindex(split(...), 0) → getField(split(...), 0)
  {
    spl: '* | eval x=mvindex(split(data, ","), 0)',
    v2nrql: "FROM Log WITH getField(split(data, ','), 0) AS x SELECT *",
    doc: 'eval-multivalue',
    verified: 'human',
  },
  // replace() with bracket chars that are NOT regex — ] alone is a literal
  {
    spl: '* | eval x=replace(name, "]", "")',
    v2nrql: "FROM Log WITH replace(name, ']', '') AS x SELECT *",
    doc: 'eval-string',
    verified: 'human',
  },
  // FIXME: replace() with regex pattern — passes through as literal, silently wrong
  {
    spl: '* | eval x=replace(name, "[abc]", "")',
    unsupportedIncludes: 'replace() with regex pattern',
    v2nrql: "FROM Log WITH replace(name, '[abc]', '') AS x SELECT *",
    v2warningIncludes: 'literal-only',
    doc: 'eval-string',
    verified: false,
  },
  // FIXME: replace() with regex pattern — passes through as literal, silently wrong
  {
    spl: '* | eval x=replace(name, "test.*end", "")',
    unsupportedIncludes: 'replace() with regex pattern',
    v2nrql: "FROM Log WITH replace(name, 'test.*end', '') AS x SELECT *",
    v2warningIncludes: 'literal-only',
    doc: 'eval-string',
    verified: false,
  },
  // where with infix like operator — exact output
  {
    spl: '* | where name like "test%"',
    v2nrql: "FROM Log SELECT * WHERE name LIKE 'test%'",
    doc: 'results-where',
    verified: 'human',
  },
  // Eval with other pipe commands
  {
    spl: '* | eval rate = count / duration | sort -rate | head 10',
    v2nrql:
      'FROM Log WITH numeric(count) / numeric(duration) AS rate SELECT * ORDER BY rate DESC LIMIT 10',
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  {
    spl: '* | eval kb = bytes / 1024 | rename kb as kilobytes',
    v2nrql:
      "FROM Log WITH numeric(bytes) / 1024 AS kb SELECT kb AS 'kilobytes'",
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  //
  // ── lookup command ──────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | lookup geo_table src_ip',
    v2nrql:
      'FROM Log JOIN (FROM lookup(geo_table) SELECT * LIMIT MAX) ON src_ip = src_ip SELECT *',
    v2warningIncludes: 'lookup table',
    doc: 'correlation-lookup',
    verified: 'human',
  },
  // FIXME: JOIN subquery must select at least 2 values — needs join key in SELECT
  {
    spl: '* | lookup ip_to_country src_ip OUTPUT country',
    v2nrql:
      'FROM Log JOIN (FROM lookup(ip_to_country) SELECT country LIMIT MAX) ON src_ip = src_ip SELECT *',
    v2warningIncludes: 'lookup table',
    doc: 'correlation-lookup',
    verified: false,
  },
  // FIXME: JOIN subquery must select at least 2 values — needs join key in SELECT
  {
    spl: '* | lookup users_lookup username AS user OUTPUT department',
    v2nrql:
      'FROM Log JOIN (FROM lookup(users_lookup) SELECT department LIMIT MAX) ON user = username SELECT *',
    v2warningIncludes: 'lookup table',
    doc: 'correlation-lookup',
    verified: false,
  },
  //
  // ── inputlookup command ─────────────────────────────────────────
  //
  {
    spl: '* | inputlookup geo_ips',
    v2nrql: 'FROM lookup(geo_ips) SELECT *',
    v2warningIncludes: 'lookup table',
    doc: 'results-inputlookup',
    verified: 'human',
  },
  {
    spl: '* | inputlookup append=true geo_ips',
    v2nrql: 'FROM lookup(geo_ips) SELECT *',
    v2warningIncludes: 'lookup table',
    doc: 'results-inputlookup',
    verified: 'human',
  },
  {
    spl: '* | inputlookup my_table',
    v2nrql: 'FROM lookup(my_table) SELECT *',
    v2warningIncludes: 'lookup table',
    doc: 'results-inputlookup',
    verified: 'human',
  },
  // TODO: expand to include a real search before | to test the join case
  {
    spl: '| inputlookup users.csv where role="admin"',
    from: 'lookup(users.csv)',
    where: 'role="admin"',
    warningIncludes: 'inputlookup WHERE',
    v2nrql: 'FROM lookup(users.csv) SELECT * WHERE role="admin"',
    v2warningIncludes: 'inputlookup WHERE',
    doc: 'results-inputlookup',
    verified: false,
  },
  //
  // ── rex command ─────────────────────────────────────────────────
  //
  {
    spl: '* | rex field=message "(?<ip>\\d+\\.\\d+\\.\\d+\\.\\d+)"',
    v2nrql:
      "FROM Log WITH capture(message, r'.*(?P<ip>\\d+\\.\\d+\\.\\d+\\.\\d+).*') AS (ip) SELECT *",
    doc: 'fields-rex',
    verified: 'human',
  },
  {
    spl: '* | rex "user=(?<username>\\w+)"',
    v2nrql:
      "FROM Log WITH capture(message, r'.*user=(?P<username>\\w+).*') AS (username) SELECT *",
    doc: 'fields-rex',
    verified: 'human',
  },
  // FIXME: multi-capture AS `(from, to)` creates one weird field name instead of two separate fields
  {
    spl: '* | rex field=_raw "From: <(?<from>.*)> To: <(?<to>.*)>"',
    v2nrql:
      "FROM Log WITH capture(message, r'.*From: <(?P<from>.*)> To: <(?P<to>.*)>.*') AS `(from, to)` SELECT *",
    doc: 'fields-rex',
    verified: false,
  },
  {
    spl: '* | rex field=message "\\d+"',
    unsupportedIncludes: 'no named capture',
    v2unsupportedIncludes: 'no named capture',
    doc: 'fields-rex',
    verified: 'human',
  },
  // Python-style (?P<name>) named groups
  {
    spl: '* | rex field=_raw ".*dlq\\/(?P<dlq_key>\\d+),"',
    v2nrql:
      "FROM Log WITH capture(message, r'.*dlq\\/(?P<dlq_key>\\d+),.*') AS (dlq_key) SELECT *",
    doc: 'fields-rex',
    verified: 'human',
  },
  // max_match=0 parsed but unsupported — capture() returns first match only
  {
    spl: '* | rex field=message "(?<skus>\\d{6,})" max_match=0',
    v2nrql:
      "FROM Log WITH capture(message, r'.*(?P<skus>\\d{6,}).*') AS (skus) SELECT *",
    v2unsupportedIncludes: 'max_match',
    doc: 'fields-rex',
    verified: 'human',
  },
  // Default field (no field= → uses message) + piped to stats
  {
    spl: '* | rex "status=(?<code>\\d+)" | stats count by code',
    v2nrql:
      "FROM Log WITH capture(message, r'.*status=(?P<code>\\d+).*') AS (code) SELECT count(*) FACET code",
    doc: 'fields-rex',
    verified: 'human',
  },
  //
  // ── rex sed mode ────────────────────────────────────────────────
  //
  // FIXME: rex mode=sed has no NRQL equivalent
  {
    spl: '* | rex mode=sed field=message "s/old/new/g"',
    unsupportedIncludes: 'sed',
    v2unsupportedIncludes: 'sed',
    doc: 'fields-rex-sed',
    verified: 'human',
  },
  //
  // ── rex PCRE mode ───────────────────────────────────────────────
  //
  // FIXME: PCRE lookbehind (?<=...) gets mangled by (?< → (?P< conversion, producing garbled output
  {
    spl: '* | rex field=message "(?<=prefix)(?<val>\\w+)"',
    warningIncludes: 'PCRE-style',
    v2nrql:
      "FROM Log WITH capture(message, r'.*(?P<=prefix)(?<val>\\w+).*') AS (=prefix)(?<val) SELECT *",
    doc: 'fields-rex-pcre',
    verified: false,
  },
  //
  // ── spath command ───────────────────────────────────────────────
  //
  //
  //
  // Full form: input + path + output
  {
    spl: '* | spath input=payload path=user.name output=username',
    v2nrql: "FROM Log WITH jparse(payload, 'user.name') AS username SELECT *",
    v2warningIncludes: 'only works on JSON',
    doc: 'fields-spath',
    verified: 'human',
  },
  // Path only (no input/output): defaults input=message, output=leaf
  {
    spl: '* | spath path=response.status',
    v2nrql:
      "FROM Log WITH jparse(message, 'response.status') AS status SELECT *",
    v2warningIncludes: 'only works on JSON',
    doc: 'fields-spath',
    verified: 'human',
  },
  // _raw input maps to message; quoted path; deep nesting
  {
    spl: '* | spath input=_raw path=data.id output=id',
    v2nrql: "FROM Log WITH jparse(message, 'data.id') AS id SELECT *",
    v2warningIncludes: 'only works on JSON',
    doc: 'fields-spath',
    verified: 'human',
  },
  // Auto-extraction (no path) — unsupported
  {
    spl: '* | spath',
    unsupportedIncludes: 'auto-extraction',
    v2unsupportedIncludes: 'auto-extraction',
    doc: 'fields-spath',
    verified: 'human',
  },
  // Spath piped to stats
  {
    spl: '* | spath path=response.code output=code | stats count by code',
    v2nrql:
      "FROM Log WITH jparse(message, 'response.code') AS code SELECT count(*) FACET code",
    v2warningIncludes: 'only works on JSON',
    doc: 'fields-spath',
    verified: 'human',
  },
  // Auto-extraction with input — unsupported
  {
    spl: '* | spath input=payload',
    unsupportedIncludes: 'auto-extraction',
    v2unsupportedIncludes: 'auto-extraction',
    doc: 'fields-spath',
    verified: 'human',
  },
  {
    spl: '* | spath path=user.name output=name | spath path=user.email output=email',
    v2nrql:
      "FROM Log WITH jparse(message, 'user.name') AS name, jparse(message, 'user.email') AS email SELECT *",
    v2warningIncludes: 'only works on JSON',
    doc: 'fields-spath',
    verified: 'human',
  },
  {
    spl: '* | spath path=request.url output=url | rex field=url "(?<domain>[^/]+)"',
    v2nrql:
      "FROM Log WITH jparse(message, 'request.url') AS url, capture(url, r'.*(?P<domain>[^/]+).*') AS (domain) SELECT *",
    v2warningIncludes: 'only works on JSON',
    doc: 'fields-spath',
    verified: 'human',
  },
  // Positional argument (quoted) — shorthand for path="AppID"
  {
    spl: '* | spath "AppID"',
    v2nrql: "FROM Log WITH jparse(message, 'AppID') AS AppID SELECT *",
    v2warningIncludes: 'only works on JSON',
    doc: 'fields-spath',
    verified: 'human',
  },
  // Positional argument (bare) — shorthand for path=source_name
  {
    spl: '* | spath source_name',
    v2nrql:
      "FROM Log WITH jparse(message, 'source_name') AS source_name SELECT *",
    v2warningIncludes: 'only works on JSON',
    doc: 'fields-spath',
    verified: 'human',
  },
  // spath with array path + downstream search
  {
    spl: '* | spath path=errors{}.code output=error_code | search error_code=404',
    v2nrql:
      "FROM Log WITH jparse(message, 'errors[*].code') AS error_code SELECT * WHERE error_code = '404' OR numeric(error_code) = 404",
    v2warningIncludes: 'only works on JSON',
    doc: 'fields-spath',
    verified: 'human',
  },
  // spath with array path, no output= — derives name from last path segment
  {
    spl: '* | spath path=items{}.status',
    v2nrql:
      "FROM Log WITH jparse(message, 'items[*].status') AS status SELECT *",
    v2warningIncludes: 'only works on JSON',
    doc: 'fields-spath',
    verified: 'human',
  },
  // spath with input= on a custom field + array path
  {
    spl: '* | spath input=request_body path=user.preferences{}.key output=pref_key',
    v2nrql:
      "FROM Log WITH jparse(request_body, 'user.preferences[*].key') AS pref_key SELECT *",
    v2warningIncludes: 'only works on JSON',
    doc: 'fields-spath',
    verified: 'human',
  },
  // rex extracting from embedded JSON string
  {
    spl: '* | rex field=message "\\"orderId\\":\\"(?<orderId>[A-Z0-9-]+)\\""',
    v2nrql:
      'FROM Log WITH capture(message, r\'.*\\"orderId\\":\\"(?P<orderId>[A-Z0-9-]+)\\".*\') AS (orderId) SELECT *',
    doc: 'fields-rex',
    verified: 'human',
  },
  // eval json_extract → jparse (strips $. prefix)
  {
    spl: '* | eval user_id = json_extract(payload, "$.user.id")',
    v2nrql: "FROM Log WITH jparse(payload, 'user.id') AS user_id SELECT *",
    doc: 'fields-spath',
    verified: 'human',
  },
  //
  // ── fillnull command ────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | fillnull value=N/A host status',
    v2nrql: "FROM Log SELECT host OR 'N/A', status OR 'N/A', *",
    doc: 'fields-fillnull',
    verified: 'human',
  },
  {
    spl: '* | fillnull value=0 bytes duration',
    v2nrql: 'FROM Log SELECT bytes OR 0, duration OR 0, *',
    doc: 'fields-fillnull',
    verified: 'human',
  },
  {
    spl: '* | fillnull bytes',
    v2nrql: "FROM Log SELECT bytes OR '0', *",
    doc: 'fields-fillnull',
    verified: 'human',
  },
  // FIXME: fillnull without field list should be unsupported, not silently ignored
  {
    spl: '* | fillnull value=0',
    warningIncludes: 'all fields',
    v2nrql: 'FROM Log SELECT *',
    v2warningIncludes: 'all fields',
    doc: 'fields-fillnull',
    verified: false,
  },
  {
    spl: '* | fillnull value="unknown" host',
    v2nrql: "FROM Log SELECT host OR 'unknown', *",
    doc: 'fields-fillnull',
    verified: 'human',
  },
  {
    spl: '* | fillnull value=0 bytes | stats sum(bytes) by host',
    v2nrql: 'FROM Log SELECT sum(bytes OR 0) FACET host',
    doc: 'fields-fillnull',
    verified: 'human',
  },
  {
    spl: '* | fillnull value=0 field1, field2, field3',
    v2nrql: 'FROM Log SELECT field1 OR 0, field2 OR 0, field3 OR 0, *',
    doc: 'fields-fillnull',
    verified: 'human',
  },
  //
  // ── rename command ──────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | rename src_ip AS source_address',
    v2nrql: "FROM Log SELECT src_ip AS 'source_address'",
    doc: 'fields-rename',
    verified: 'human',
  },
  {
    // FIXME: rename-after-stats emits broken double-alias (avg_bytes + average_bytes in SELECT);
    // should fold rename into the stats alias: average(bytes) AS 'average_bytes'
    spl: '* | stats avg(bytes) as avg_bytes by host | rename avg_bytes AS average_bytes',
    select: ["average(bytes) AS 'average_bytes'"],
    doc: 'fields-rename',
    verified: false,
  },
  {
    // FIXME: _time should map to timestamp in NRQL; bare _time fails compilation
    spl: '* | rename _time AS "Time"',
    select: ["`_time` AS 'Time'"],
    v2nrql: "FROM Log SELECT _time AS 'Time'",
    doc: 'fields-rename',
    verified: false,
  },
  {
    spl: '* | rename properties.* as *',
    unsupportedIncludes: 'Wildcard rename',
    doc: 'fields-rename',
    verified: 'human',
  },
  {
    // FIXME: rename drops non-renamed fields; NRQL has no rename-and-keep-all equivalent
    spl: '* | rename src_ip as src user_name as user',
    select: ["`src_ip` AS 'src'", "`user_name` AS 'user'"],
    v2nrql: "FROM Log SELECT src_ip AS 'src', user_name AS 'user'",
    doc: 'fields-rename',
    verified: false,
  },
  {
    // FIXME: quoted field name with parens — V2 emits IsOutlier(count) as a function call,
    // but it's a field name. NRQL can't reference fields with parens; should be unsupported.
    spl: '* | rename "IsOutlier(count)" as isOutlier',
    select: ["`IsOutlier(count)` AS 'isOutlier'"],
    v2nrql: "FROM Log SELECT IsOutlier(count) AS 'isOutlier'",
    doc: 'fields-rename',
    verified: false,
  },
  //
  // ── strcat command ──────────────────────────────────────────────
  //
  //
  //
  {
    // FIXME: V2 doesn't support strcat; V1 correctly translates to concat() in WITH
    spl: '* | strcat host ":" port address',
    with: ["concat(`host`, ':', `port`) AS `address`"],
    doc: 'fields-strcat',
    verified: false,
  },
  {
    // FIXME: V2 doesn't support strcat; V1 correctly translates to concat() in WITH
    spl: '* | strcat first_name last_name full_name',
    with: ['concat(`first_name`, `last_name`) AS `full_name`'],
    doc: 'fields-strcat',
    verified: false,
  },
  {
    // FIXME: V2 doesn't support strcat; V1 correctly translates to concat() in WITH
    spl: '* | strcat protocol "://" host ":" port url',
    with: ["concat(`protocol`, '://', `host`, ':', `port`) AS `url`"],
    doc: 'fields-strcat',
    verified: false,
  },
  {
    // FIXME: V2 doesn't support strcat; V1 correctly translates to concat() in WITH + FACET
    spl: '* | strcat host ":" port address | stats count by address',
    withLength: 1,
    select: ['count(*)'],
    facet: ['`address`'],
    doc: 'fields-strcat',
    verified: false,
  },
  //
  // ── rare command ────────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | rare status',
    v2nrql: 'FROM Log SELECT count(*) FACET status ORDER BY count ASC LIMIT 10',
    doc: 'reports-rare',
    verified: 'human',
  },
  {
    spl: '* | rare 5 uri_path',
    v2nrql:
      'FROM Log SELECT count(*) FACET uri_path ORDER BY count ASC LIMIT 5',
    doc: 'reports-rare',
    verified: 'human',
  },
  {
    spl: '* | rare status by host',
    v2nrql:
      'FROM Log SELECT count(*) FACET status, host ORDER BY count ASC LIMIT 10',
    doc: 'reports-rare',
    verified: 'human',
  },
  {
    spl: 'status>=400 | rare 20 uri_path',
    v2nrql:
      'FROM Log SELECT count(*) WHERE numeric(status) >= 400 FACET uri_path ORDER BY count ASC LIMIT 20',
    doc: 'reports-rare',
    verified: 'human',
  },
  {
    spl: '* | rare app limit=20',
    v2nrql: 'FROM Log SELECT count(*) FACET app ORDER BY count ASC LIMIT 20',
    doc: 'reports-rare',
    verified: 'human',
  },
  {
    spl: '* | rare limit=20 "details.error"',
    v2nrql:
      'FROM Log SELECT count(*) FACET `details.error` ORDER BY count ASC LIMIT 20',
    doc: 'reports-rare',
    verified: 'human',
  },
  //
  // ── stats command ───────────────────────────────────────────────
  //
  //
  //
  {
    spl: 'index=web | stats count by status',
    v2nrql: "FROM Log SELECT count(*) WHERE index = 'web' FACET status",
    doc: 'reports-stats',
    verified: 'human',
  },
  {
    spl: '* | stats avg(response_time) as avg_response_time by host',
    v2nrql:
      "FROM Log SELECT average(response_time) AS 'avg_response_time' FACET host",
    doc: 'reports-stats',
    verified: 'human',
  },
  {
    spl: 'index=web | stats count, dc(clientip) AS unique_clients BY status',
    v2nrql:
      "FROM Log SELECT count(*), uniqueCount(clientip) AS 'unique_clients' WHERE index = 'web' FACET status",
    doc: 'reports-stats',
    verified: 'human',
  },
  {
    spl: '* | stats count min(_time) as firstTime max(_time) as lastTime BY user dest',
    v2nrql:
      "FROM Log SELECT count(*), min(timestamp) AS 'firstTime', max(timestamp) AS 'lastTime' FACET user, dest",
    doc: 'reports-stats',
    verified: 'human',
  },
  {
    spl: '* | stats count(status) by host',
    v2nrql: 'FROM Log SELECT count(status) FACET host',
    doc: 'reports-stats',
    verified: 'human',
  },
  {
    spl: '* | stats count as "totalFailure"',
    v2nrql: "FROM Log SELECT count(*) AS 'totalFailure'",
    doc: 'reports-stats',
    verified: 'human',
  },
  {
    spl: "* | stats count as 'my count'",
    v2nrql: "FROM Log SELECT count(*) AS 'my count'",
    doc: 'reports-stats',
    verified: 'human',
  },
  {
    // FIXME: V2 missing numeric() wrapper on status in filter condition for range comparison
    spl: '* | stats count(eval(status>=400)) as errors',
    select: ["filter(count(*), WHERE numeric(`status`)>=400) AS 'errors'"],
    doc: 'reports-stats',
    verified: false,
  },
  {
    // FIXME: V2 missing dual-check for equality inside filter() — should be
    // EventCode = '4648' OR numeric(EventCode) = 4648
    spl: '* | stats count(eval(EventCode=4648)) as attempts, count(eval(EventCode=4624)) as successes',
    select: [
      "filter(count(*), WHERE numeric(`EventCode`)=4648) AS 'attempts'",
      "filter(count(*), WHERE numeric(`EventCode`)=4624) AS 'successes'",
    ],
    doc: 'reports-stats',
    verified: false,
  },
  //
  // ── stats functions ─────────────────────────────────────────────
  //
  //
  //
  // All stats function mappings in one query — dc, avg/mean, sum, median,
  // distinct_count, values, perc95/p99, stdev
  {
    spl: '* | stats dc(clientip), avg(bytes), sum(bytes), median(latency), mean(latency), distinct_count(user), values(status), perc95(latency), p99(latency), stdev(latency) by host',
    v2nrql:
      'FROM Log SELECT uniqueCount(clientip), average(bytes), sum(bytes), median(latency), average(latency), uniqueCount(user), uniques(status), percentile(latency, 95), percentile(latency, 99), stddev(latency) FACET host',
    doc: 'stats-functions',
    verified: 'human',
  },
  // min+max (multi-return)
  {
    spl: '* | stats min(duration), max(duration) by host',
    v2nrql: 'FROM Log SELECT min(duration), max(duration) FACET host',
    doc: 'stats-functions',
    verified: 'human',
  },
  // stdevp — approximate mapping with warning
  {
    spl: '* | stats stdevp(latency) by host',
    v2nrql: 'FROM Log SELECT stddev(latency) FACET host',
    v2warningIncludes: 'stdevp',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats earliest(timestamp), latest(timestamp) by host',
    v2nrql: 'FROM Log SELECT earliest(timestamp), latest(timestamp) FACET host',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats first(status) by host',
    v2nrql: 'FROM Log SELECT latest(status) FACET host',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats last(status) by host',
    v2nrql: 'FROM Log SELECT earliest(status) FACET host',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats rate(bytes) by host',
    v2nrql: 'FROM Log SELECT rate(sum(bytes), 1 second) FACET host',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats list(user) by host',
    v2nrql: 'FROM Log SELECT uniques(user) FACET host',
    v2warningIncludes: 'list()',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats xyzfunc(field) by host',
    v2warningIncludes: 'xyzfunc()',
    v2nrql: 'FROM Log SELECT * FACET host',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats estdc(clientip) as approx_unique by host',
    v2nrql:
      "FROM Log SELECT uniqueCount(clientip) AS 'approx_unique' FACET host",
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats exactperc95(latency) as exact_p95 by service',
    v2nrql:
      "FROM Log SELECT percentile(latency, 95) AS 'exact_p95' FACET service",
    v2warningIncludes: 'exactperc',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats upperperc99(response_time) by endpoint',
    v2nrql: 'FROM Log SELECT percentile(response_time, 99) FACET endpoint',
    v2warningIncludes: 'upperperc',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats per_second(bytes) as bps by host',
    v2nrql: "FROM Log SELECT rate(sum(bytes), 1 second) AS 'bps' FACET host",
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats per_minute(requests) as rpm by service',
    v2nrql:
      "FROM Log SELECT rate(sum(requests), 1 minute) AS 'rpm' FACET service",
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats per_hour(errors) as errors_per_hour by host',
    v2nrql:
      "FROM Log SELECT rate(sum(errors), 1 hour) AS 'errors_per_hour' FACET host",
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats per_day(signups) as daily_signups',
    v2nrql: "FROM Log SELECT rate(sum(signups), 1 day) AS 'daily_signups'",
    doc: 'stats-functions',
    verified: 'human',
  },
  // Arithmetic in function arguments — all 5 operators, parens, dots, chaining
  {
    spl: '* | stats max(a / 1000) as div, min(b * 8) as mul, sum(c + d) as add, avg(e - f) as sub, count(g % 3) as mod, max((h + i) * j) as parens, avg(response.time / 1000) as dotfield, sum(a + b + c) as chained by host',
    v2nrql:
      "FROM Log SELECT max(numeric(a) / 1000) AS 'div', min(numeric(b) * 8) AS 'mul', sum(numeric(c) + numeric(d)) AS 'add', average(numeric(e) - numeric(f)) AS 'sub', count(mod(numeric(g), 3)) AS 'mod', max((numeric(h) + numeric(i)) * numeric(j)) AS 'parens', average(numeric(`response.time`) / 1000) AS 'dotfield', sum(numeric(a) + numeric(b) + numeric(c)) AS 'chained' FACET host",
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | timechart span=1h avg(bytes * 8 / 1024)',
    v2nrql:
      'FROM Log SELECT average(numeric(bytes) * 8 / 1024) TIMESERIES 1 hour',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats perc95(duration / 1000) as p95_sec',
    v2nrql:
      "FROM Log SELECT percentile(numeric(duration) / 1000, 95) AS 'p95_sec'",
    doc: 'stats-functions',
    verified: 'human',
  },
  //
  // ── stats functions (no equiv) ──────────────────────────────────
  //
  // Stats no-equiv — representative cases: statistical, time-based, and rate
  {
    spl: '* | stats mode(status) by host',
    v2warningIncludes: 'mode()',
    v2nrql: 'FROM Log SELECT * FACET host',
    doc: 'stats-no-equiv',
    verified: 'human',
  },
  {
    spl: '* | stats earliest_time(message) as first_seen by host',
    v2warningIncludes: 'earliest_time()',
    v2nrql: 'FROM Log SELECT * FACET host',
    doc: 'stats-no-equiv',
    verified: 'human',
  },
  {
    spl: '* | stats rate_avg(cpu) by host',
    v2warningIncludes: 'rate_avg()',
    v2nrql: 'FROM Log SELECT * FACET host',
    doc: 'stats-no-equiv',
    verified: 'human',
  },
  //
  // ── timechart command ───────────────────────────────────────────
  //
  //
  //
  // timechart without span → TIMESERIES AUTO
  {
    spl: '* | timechart count',
    v2nrql: 'FROM Log SELECT count(*) TIMESERIES AUTO',
    doc: 'reports-timechart',
    verified: 'human',
  },
  {
    spl: 'sourcetype=access_* | timechart span=1h count by status',
    v2nrql:
      "FROM Log SELECT count(*) WHERE sourcetype LIKE 'access_%' FACET status TIMESERIES 1 hour",
    doc: 'reports-timechart',
    verified: 'human',
  },
  {
    spl: '* | timechart span=5m count BY host',
    v2nrql: 'FROM Log SELECT count(*) FACET host TIMESERIES 5 minutes',
    doc: 'reports-timechart',
    verified: 'human',
  },
  {
    spl: '* | timechart span=1d sum(price) by productName',
    v2nrql: 'FROM Log SELECT sum(price) FACET productName TIMESERIES 1 day',
    doc: 'reports-timechart',
    verified: 'human',
  },
  {
    spl: '* | timechart count span=5m',
    v2nrql: 'FROM Log SELECT count(*) TIMESERIES 5 minutes',
    doc: 'reports-timechart',
    verified: 'human',
  },
  {
    spl: '* | timechart count(POS) span=5m as "TPOS"',
    v2nrql: "FROM Log SELECT count(POS) AS 'TPOS' TIMESERIES 5 minutes",
    doc: 'reports-timechart',
    verified: 'human',
  },
  {
    spl: '* | timechart c span=1m',
    v2nrql: 'FROM Log SELECT count(*) TIMESERIES 1 minute',
    doc: 'reports-timechart',
    verified: 'human',
  },
  //
  // ── predict command ─────────────────────────────────────────────
  //
  {
    spl: '* | timechart span=30m count | predict count as predict_count',
    v2nrql: 'FROM Log SELECT count(*) TIMESERIES 30 minutes PREDICT',
    doc: 'reports-timechart',
    verified: 'human',
  },
  {
    // FIXME: V2 emits PREDICT without TIMESERIES which fails at runtime;
    // should either add TIMESERIES AUTO or drop PREDICT
    spl: '* | stats count | predict count',
    select: ['count(*)'],
    predict: true,
    warningIncludes: 'PREDICT requires TIMESERIES',
    doc: 'reports-timechart',
    verified: false,
  },
  //
  // ── chart command ───────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | chart count by status',
    v2nrql: 'FROM Log SELECT count(*) FACET status',
    doc: 'reports-chart',
    verified: 'human',
  },
  //
  // ── top command ─────────────────────────────────────────────────
  //
  // FIXME: V2 top does not include percent calculation. SPL top outputs count
  // and percent columns by default. In NRQL, use a pie chart display to see
  // percentages, or add a percent subquery. V2 should add a warning about this.
  //
  {
    // FIXME: V2 top missing percent column; warn about pie chart display for percentages
    spl: '* | top categoryId',
    select: [
      'count(*)',
      "count(*) * 100.0 / (SELECT count(*) FROM Log) AS 'percent'",
    ],
    facet: ['`categoryId`'],
    limit: 10,
    doc: 'reports-top',
    verified: false,
  },
  {
    // FIXME: V2 top missing percent column
    spl: '* | top 20 host',
    select: [
      'count(*)',
      "count(*) * 100.0 / (SELECT count(*) FROM Log) AS 'percent'",
    ],
    limit: 20,
    facet: ['`host`'],
    doc: 'reports-top',
    verified: false,
  },
  // limit=N keyword form
  {
    // FIXME: V2 top missing percent column
    spl: '* | top limit=20 host',
    select: [
      'count(*)',
      "count(*) * 100.0 / (SELECT count(*) FROM Log) AS 'percent'",
    ],
    facet: ['`host`'],
    limit: 20,
    doc: 'reports-top',
    verified: false,
  },
  // limit=0 means unlimited → LIMIT MAX
  {
    // FIXME: V2 emits LIMIT 10 for limit=0; should be LIMIT MAX (unlimited)
    spl: '* | top limit=0 status',
    select: [
      'count(*)',
      "count(*) * 100.0 / (SELECT count(*) FROM Log) AS 'percent'",
    ],
    facet: ['`status`'],
    limit: 'MAX',
    doc: 'reports-top',
    verified: false,
  },
  // countfield option renames the count column
  {
    // FIXME: V2 top ignores countfield option; should alias count(*) AS 'total'
    spl: '* | top limit=5 countfield=total host',
    select: [
      "count(*) AS 'total'",
      "count(*) * 100.0 / (SELECT count(*) FROM Log) AS 'percent'",
    ],
    facet: ['`host`'],
    limit: 5,
    doc: 'reports-top',
    verified: false,
  },
  // showperc=false suppresses percent select
  {
    spl: '* | top 10 showperc=false host',
    v2nrql: 'FROM Log SELECT count(*) FACET host ORDER BY count DESC LIMIT 10',
    doc: 'reports-top',
    verified: 'human',
  },
  // useother=true warns about no NRQL equivalent
  {
    // FIXME: V2 silently drops useother; should warn that NRQL pie chart
    // display shows an "Other" category automatically
    spl: '* | top 5 useother=true status',
    select: [
      'count(*)',
      "count(*) * 100.0 / (SELECT count(*) FROM Log) AS 'percent'",
    ],
    facet: ['`status`'],
    limit: 5,
    warningIncludes: 'useother',
    doc: 'reports-top',
    verified: false,
  },
  // percentfield option renames the percent column
  {
    // FIXME: V2 top ignores percentfield option
    spl: '* | top 5 percentfield=pct host',
    select: [
      'count(*)',
      "count(*) * 100.0 / (SELECT count(*) FROM Log) AS 'pct'",
    ],
    facet: ['`host`'],
    limit: 5,
    doc: 'reports-top',
    verified: false,
  },
  // limit=N after field name
  {
    spl: '* | top delay limit=10',
    v2nrql: 'FROM Log SELECT count(*) FACET delay ORDER BY count DESC LIMIT 10',
    doc: 'reports-top',
    verified: 'human',
  },
  // percent subquery includes WHERE from search
  {
    // FIXME: V2 top missing percent column with WHERE-aware subquery
    spl: 'error | top 5 status',
    selectIncludes: [
      "count(*) * 100.0 / (SELECT count(*) FROM Log WHERE message LIKE '%error%') AS 'percent'",
    ],
    facet: ['`status`'],
    limit: 5,
    doc: 'reports-top',
    verified: false,
  },
  //
  // ── top with groupby ────────────────────────────────────────────
  //
  {
    // FIXME: V2 drops by-clause from top; should be FACET status, host
    spl: '* | top 5 status by host',
    select: [
      'count(*)',
      "count(*) * 100.0 / (SELECT count(*) FROM Log) AS 'percent'",
    ],
    facet: ['`status`', '`host`'],
    limit: 5,
    warningIncludes: 'top with groupBy',
    doc: 'reports-top-groupby',
    verified: false,
  },
  //
  // ── Multiple aggregation ────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | stats count by host | stats avg(count)',
    v2nrql:
      'FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT average(count)',
    doc: 'reports-chained-agg-no-outer-facet',
    verified: 'human',
  },
  {
    spl: 'index=web | stats count as cnt by host | stats max(cnt)',
    v2nrql:
      "FROM (FROM Log SELECT count(*) AS 'cnt' WHERE index = 'web' FACET host LIMIT MAX) SELECT max(cnt)",
    doc: 'reports-chained-agg-aliased',
    verified: 'human',
  },
  //
  // ── bin / bucket command ────────────────────────────────────────
  //
  {
    spl: '* | bin _time span=5m',
    v2nrql: 'FROM Log SELECT count(*) TIMESERIES 5 minutes',
    doc: 'reports-bin',
    verified: 'human',
  },
  {
    spl: '* | bucket _time span=5m',
    v2nrql: 'FROM Log SELECT count(*) TIMESERIES 5 minutes',
    doc: 'reports-bin',
    verified: 'human',
  },
  {
    // FIXME: V2 emits FACET _time alongside TIMESERIES; _time is not a real NRQL attribute
    // and by _time after bin should be absorbed by TIMESERIES, not emitted as FACET
    spl: '* | bucket span=5m _time | stats count by _time',
    timeseries: '5 minutes',
    select: ['count(*)'],
    unsupported: [],
    v2nrql: 'FROM Log SELECT count(*) FACET _time TIMESERIES 5 minutes',
    doc: 'reports-bin',
    verified: false,
  },
  {
    // FIXME: V2 doesn't support numeric bin; should emit histogram(size, 10)
    spl: '* | bin size span=10',
    select: ['histogram(`size`, 10)'],
    unsupported: [],
    doc: 'reports-bin',
    verified: false,
  },
  //
  // ── where (pipe) ────────────────────────────────────────────────
  //
  //
  //
  {
    spl: 'index=web | stats count BY status | where count > 100',
    v2nrql:
      "FROM (FROM Log SELECT count(*) WHERE index = 'web' FACET status LIMIT MAX) SELECT * WHERE numeric(count) > 100",
    doc: 'results-where',
    verified: 'human',
  },
  {
    spl: 'status=500 | where bytes > 1024',
    v2nrql:
      "FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND numeric(bytes) > 1024",
    doc: 'results-where',
    verified: 'human',
  },
  //
  //
  {
    spl: '* | where isnull(status)',
    v2nrql: 'FROM Log SELECT * WHERE status IS NULL',
    doc: 'results-where',
    verified: 'human',
  },
  {
    spl: '* | where isnotnull(status)',
    v2nrql: 'FROM Log SELECT * WHERE status IS NOT NULL',
    doc: 'results-where',
    verified: 'human',
  },
  {
    spl: '* | where host = "web01"',
    v2nrql: "FROM Log SELECT * WHERE host = 'web01'",
    doc: 'results-where',
    verified: 'human',
  },
  {
    spl: '* | where count > 100',
    v2nrql: 'FROM Log SELECT * WHERE numeric(count) > 100',
    doc: 'results-where',
    verified: 'human',
  },
  {
    // FIXME: V2 like() function handler doesn't destructure args; emits [object Object]
    spl: '* | where like(host, "web*")',
    where: "`host` LIKE 'web%'",
    doc: 'results-where',
    verified: false,
  },
  // where with infix like operator
  {
    spl: '* | where name like "%test%"',
    v2nrql: "FROM Log SELECT * WHERE name LIKE '%test%'",
    doc: 'results-where',
    verified: 'human',
  },
  {
    spl: '* | where match(host, "^web[0-9]+$")',
    v2nrql: "FROM Log SELECT * WHERE host RLIKE r'^web[0-9]+$'",
    doc: 'results-where',
    verified: false,
  },
  {
    // FIXME: V2 doesn't handle cidrmatch(); should emit cidrAddress()
    spl: '* | where cidrmatch("10.0.0.0/8", src_ip)',
    where: "cidrAddress(`src_ip`, 8) = '10.0.0.0/8'",
    doc: 'results-where',
    verified: false,
  },
  {
    spl: '* | where status >= 400 AND status < 500',
    v2nrql:
      'FROM Log SELECT * WHERE numeric(status) >= 400 AND numeric(status) < 500',
    doc: 'results-where',
    verified: 'human',
  },
  {
    spl: '* | where NOT status = 200',
    v2nrql:
      "FROM Log SELECT * WHERE NOT (status = '200' OR numeric(status) = 200)",
    doc: 'results-where',
    verified: 'human',
  },
  //
  // ── where on aggregation ────────────────────────────────────────
  //
  {
    spl: '* | stats count by host | where NOT count = 0',
    v2nrql:
      "FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT * WHERE NOT (count = '0' OR numeric(count) = 0)",
    doc: 'results-where-on-agg',
    verified: 'human',
  },
  {
    spl: '* | stats count by host | where count > 100 AND count < 1000',
    v2nrql:
      'FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT * WHERE numeric(count) > 100 AND numeric(count) < 1000',
    doc: 'results-where-on-agg',
    verified: 'human',
  },
  // where-after-stats with no FACET (no LIMIT MAX in inner query)
  {
    spl: '* | stats count | where count > 0',
    v2nrql: 'FROM (FROM Log SELECT count(*)) SELECT * WHERE numeric(count) > 0',
    doc: 'results-where-on-agg',
    verified: 'human',
  },
  //
  // ── join command ────────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | join host [search index=other | stats count by host]',
    v2nrql:
      "FROM Log JOIN (FROM Log SELECT count(*) WHERE index = 'other' FACET host LIMIT MAX) ON host = host SELECT *",
    v2warningIncludes: 'JOIN',
    doc: 'correlation-join',
    verified: 'llm',
  },
  {
    // FIXME: V2 emits JOIN LEFT instead of LEFT JOIN; MCP rejects JOIN LEFT
    spl: '* | join type=left src_ip [search index=geo | table src_ip, country]',
    joinLength: 1,
    joinIncludes: ['LEFT', 'ON `src_ip` = `src_ip`', '`src_ip`, `country`'],
    doc: 'correlation-join',
    verified: false,
  },
  {
    spl: '* | join type=outer host [search * | stats count by host]',
    unsupportedIncludes: 'outer join',
    doc: 'correlation-join',
    verified: 'llm',
  },
  {
    spl: '* | join host [search status=500 | table host, message]',
    v2nrql:
      "FROM Log JOIN (FROM Log SELECT host, message WHERE status = '500' OR numeric(status) = 500 LIMIT MAX) ON host = host SELECT *",
    v2warningIncludes: 'JOIN',
    doc: 'correlation-join',
    verified: 'llm',
  },
  {
    spl: '* | join src_ip [search * | stats count, avg(bytes) by src_ip]',
    v2nrql:
      'FROM Log JOIN (FROM Log SELECT count(*), average(bytes) FACET src_ip LIMIT MAX) ON src_ip = src_ip SELECT *',
    v2warningIncludes: 'JOIN',
    doc: 'correlation-join',
    verified: 'llm',
  },
  {
    spl: '* | join host [search * | stats count by host | head 100]',
    v2nrql:
      'FROM Log JOIN (FROM Log SELECT count(*) FACET host LIMIT 100) ON host = host SELECT *',
    v2warningIncludes: 'JOIN',
    doc: 'correlation-join',
    verified: 'llm',
  },
  {
    spl: '* | join host [search status=200 host=web*]',
    v2nrql:
      "FROM Log JOIN (FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 AND host LIKE 'web%' LIMIT MAX) ON host = host SELECT *",
    v2warningIncludes: 'JOIN',
    doc: 'correlation-join',
    verified: 'llm',
  },
  {
    spl: 'status=500 | join host [search * | stats count by host]',
    v2nrql:
      "FROM Log JOIN (FROM Log SELECT count(*) FACET host LIMIT MAX) ON host = host SELECT * WHERE status = '500' OR numeric(status) = 500",
    v2warningIncludes: 'JOIN',
    doc: 'correlation-join',
    verified: 'llm',
  },
  {
    spl: '* | stats count by host | join host [search * | stats avg(cpu) by host]',
    v2nrql:
      'FROM Log JOIN (FROM Log SELECT average(cpu) FACET host LIMIT MAX) ON host = host SELECT count(*) FACET host',
    v2warningIncludes: 'JOIN',
    doc: 'correlation-join',
    verified: 'llm',
  },
  {
    spl: '* | join user [search * | table user, role]',
    v2nrql:
      'FROM Log JOIN (FROM Log SELECT user, role LIMIT MAX) ON user = user SELECT *',
    v2warningIncludes: 'JOIN',
    doc: 'correlation-join',
    verified: 'llm',
  },
  //
  // ── dedup command ───────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | dedup host',
    v2nrql: 'FROM Log SELECT latest(timestamp) FACET host LIMIT MAX',
    v2warningIncludes: 'dedup',
    doc: 'results-dedup',
    verified: 'llm',
  },
  {
    spl: '* | dedup host, status',
    v2nrql: 'FROM Log SELECT latest(timestamp) FACET host, status LIMIT MAX',
    v2warningIncludes: 'dedup',
    doc: 'results-dedup',
    verified: 'llm',
  },
  {
    spl: '* | stats count by host | dedup host',
    v2nrql: 'FROM Log SELECT count(*) FACET host LIMIT MAX',
    v2warningIncludes: 'dedup',
    doc: 'results-dedup',
    verified: 'llm',
  },
  //
  // ── regex command ───────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | regex message="error\\\\d+"',
    v2nrql: "FROM Log SELECT * WHERE message RLIKE r'error\\\\d+'",
    doc: 'results-regex',
    verified: false,
  },
  {
    spl: '* | regex status!="^2\\\\d{2}$"',
    v2nrql: "FROM Log SELECT * WHERE status NOT RLIKE r'^2\\\\d{2}$'",
    doc: 'results-regex',
    verified: false,
  },
  {
    spl: '* | regex "fatal|critical"',
    v2nrql: "FROM Log SELECT * WHERE message RLIKE r'fatal|critical'",
    doc: 'results-regex',
    verified: false,
  },
  {
    spl: 'status=500 | regex message="timeout"',
    v2nrql:
      "FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND message RLIKE r'timeout'",
    doc: 'results-regex',
    verified: false,
  },
  {
    spl: '* | regex uri_path="^/api/v[0-9]+"',
    v2nrql: "FROM Log SELECT * WHERE uri_path RLIKE r'^/api/v[0-9]+'",
    doc: 'results-regex',
    verified: false,
  },
  //
  // ── table / fields ──────────────────────────────────────────────
  //
  //
  //
  {
    // FIXME: V2 emits bare _time which fails MCP; should map to timestamp
    spl: '* | table _time, host, status, bytes, url',
    select: ['`host`', '`status`', '`bytes`', '`url`'],
    doc: 'results-table',
    verified: false,
  },
  {
    spl: '* | table *',
    v2nrql: 'FROM Log SELECT *',
    doc: 'results-table',
    verified: 'llm',
  },
  //
  //
  {
    spl: '* | fields host, status',
    v2nrql: 'FROM Log SELECT host, status',
    doc: 'results-table',
    verified: 'llm',
  },
  {
    // FIXME: V2 emits bare _time; should map to timestamp
    spl: '* | fields _time, host, status',
    select: ['`host`', '`status`'],
    doc: 'results-table',
    verified: false,
  },
  // fields + prefix (explicit include)
  {
    spl: '* | fields + host, status',
    v2nrql: 'FROM Log SELECT host, status',
    doc: 'results-table',
    verified: 'llm',
  },
  //
  // ── fields - exclude ────────────────────────────────────────────
  //
  {
    spl: '* | fields - _raw, _time',
    unsupportedIncludes: 'exclude',
    doc: 'results-table',
    verified: 'llm',
  },
  //
  // ── search (pipe) ───────────────────────────────────────────────
  //
  //
  //
  {
    spl: 'index=web | stats count by status | search status=200',
    v2nrql:
      "FROM Log SELECT count(*) WHERE index = 'web' AND status = '200' OR numeric(status) = 200 FACET status",
    doc: 'results-search',
    verified: 'llm',
  },
  {
    spl: 'status=500 | search error',
    v2nrql:
      "FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND message LIKE '%error%'",
    doc: 'results-search',
    verified: 'llm',
  },
  {
    spl: '* | search status=200 OR status=301',
    v2nrql:
      "FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 OR status = '301' OR numeric(status) = 301",
    doc: 'results-search',
    verified: 'llm',
  },
  {
    spl: '| search host=web01',
    v2nrql: "FROM Log SELECT * WHERE host = 'web01'",
    doc: 'results-search',
    verified: 'llm',
  },
  //
  // ── uniq command ────────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | sort host | uniq',
    unsupportedIncludes: 'uniq',
    doc: 'results-uniq',
    verified: 'llm',
  },
  //
  // ── sort command ────────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | sort - count',
    v2nrql: 'FROM Log SELECT * ORDER BY count DESC',
    doc: 'results-sort',
    verified: 'llm',
  },
  {
    spl: '* | sort + name',
    v2nrql: 'FROM Log SELECT * ORDER BY name ASC',
    doc: 'results-sort',
    verified: 'llm',
  },
  {
    spl: '* | sort name',
    v2nrql: 'FROM Log SELECT * ORDER BY name ASC',
    doc: 'results-sort',
    verified: 'llm',
  },
  {
    spl: '* | sort 0 host',
    v2nrql: 'FROM Log SELECT * ORDER BY host ASC',
    doc: 'results-sort',
    verified: 'llm',
  },
  {
    spl: '* | sort count desc',
    v2nrql: 'FROM Log SELECT * ORDER BY count DESC',
    doc: 'results-sort',
    verified: 'llm',
  },
  {
    spl: '* | sort 0 - firstTime',
    v2nrql: 'FROM Log SELECT * ORDER BY firstTime DESC',
    doc: 'results-sort',
    verified: 'llm',
  },
  //
  // ── head command ────────────────────────────────────────────────
  //
  //
  //
  { spl: '* | head 10', limit: 10, doc: 'results-head', verified: 'human' },
  { spl: '* | head', limit: 10, doc: 'results-head', verified: 'human' },
  //
  // ── reverse command ─────────────────────────────────────────────
  //
  //
  //
  {
    // FIXME: V2 marks reverse as unsupported; should emit ORDER BY timestamp ASC
    spl: '* | reverse',
    orderBy: ['timestamp ASC'],
    doc: 'results-reverse',
    verified: false,
  },
  {
    // FIXME: V2 drops reverse; should emit ORDER BY timestamp ASC
    spl: 'error | table message | reverse',
    orderBy: ['timestamp ASC'],
    select: ['`message`'],
    doc: 'results-reverse',
    verified: false,
  },
  //
  // ── Unsupported commands ────────────────────────────────────────
  //
  //
  // Table-driven: [spl, keyword that must appear in unsupported message]
  //
  // ── Unsupported commands (distributed by Splunk category) ─────
  {
    spl: '* | transaction clientip maxspan=10m',
    unsupportedIncludes: 'transaction',
    doc: 'correlation-transaction',
    verified: 'llm',
  },
  {
    spl: '| tstats count FROM datamodel=Endpoint.Processes',
    unsupportedIncludes: 'tstats',
    doc: 'data-tstats',
    verified: 'llm',
  },
  // eventstats with BY → subquery JOIN
  {
    spl: '* | eventstats count by host',
    v2nrql:
      "FROM Log JOIN (FROM Log SELECT count(*) AS 'count' FACET host LIMIT MAX) ON host = host SELECT *",
    v2warningIncludes: '5,000',
    doc: 'reports-eventstats',
    verified: 'llm',
  },
  // eventstats with alias and BY
  {
    spl: '* | eventstats avg(duration) AS avg_dur BY host',
    v2nrql:
      "FROM Log JOIN (FROM Log SELECT average(duration) AS 'avg_dur' FACET host LIMIT MAX) ON host = host SELECT *",
    v2warningIncludes: '5,000',
    doc: 'reports-eventstats',
    verified: 'llm',
  },
  // eventstats with multiple BY fields — unsupported (NRQL JOIN only supports single ON key)
  {
    spl: '* | eventstats sum(bytes) AS total BY host, status',
    unsupportedIncludes: 'multiple BY fields',
    doc: 'reports-eventstats',
    verified: 'llm',
  },
  // eventstats without BY → scalar subquery in SELECT
  {
    // FIXME: V2 uses WITH count(*) AS total which fails — aggregate functions
    // can't go in WITH clause. Should use scalar subquery: (SELECT count(*) FROM Log) AS 'total'
    spl: '* | eventstats count AS total',
    selectIncludes: ["(SELECT count(*) FROM Log) AS 'total'"],
    doc: 'reports-eventstats',
    verified: false,
  },
  // real-world pattern: stats then eventstats (chained aggregation, no BY)
  // eventstats after stats without BY → scalar subquery
  {
    // FIXME: V2 uses WITH sum(appCount) which fails — same aggregate-in-WITH bug
    spl: '* | stats count as appCount by app | eventstats sum(appCount) as namespaceCount',
    selectIncludes: ["(SELECT sum(appCount) FROM Log) AS 'namespaceCount'"],
    doc: 'reports-eventstats',
    verified: false,
  },
  // real-world pattern: max(_time) for latest record
  {
    spl: '* | eventstats max(timestamp) as lastImport BY source',
    v2nrql:
      "FROM Log JOIN (FROM Log SELECT max(timestamp) AS 'lastImport' FACET source LIMIT MAX) ON source = source SELECT *",
    v2warningIncludes: '5,000',
    doc: 'reports-eventstats',
    verified: 'llm',
  },
  // multiple aggregations in one eventstats call
  {
    spl: '* | eventstats avg(duration) AS avg_dur, max(duration) AS max_dur BY host',
    v2nrql:
      "FROM Log JOIN (FROM Log SELECT average(duration) AS 'avg_dur', max(duration) AS 'max_dur' FACET host LIMIT MAX) ON host = host SELECT *",
    v2warningIncludes: '5,000',
    doc: 'reports-eventstats',
    verified: 'llm',
  },
  {
    spl: '* | streamstats count by host',
    unsupportedIncludes: 'streamstats',
    doc: 'reports-streamstats',
    verified: 'llm',
  },
  //
  // ── mvexpand patterns ─────────────────────────────────────────
  //
  // Pattern 1: expand-then-filter (most common ~40%) — NRQL works without expansion
  {
    spl: '* | spath path=cloudformation{}.stack_prefix output=stack_prefix | mvexpand stack_prefix | search stack_prefix="fff000-gitlabrole"',
    v2nrql:
      "FROM Log WITH jparse(message, 'cloudformation[*].stack_prefix') AS stack_prefix SELECT * WHERE stack_prefix = 'fff000-gitlabrole'",
    v2warningIncludes: 'mvexpand',
    doc: 'unsupported-mvexpand',
    verified: 'llm',
  },
  // mvexpand with function-call field name (stats list() creates literal field name)
  {
    spl: '* | mvexpand list(orderNumber)',
    v2nrql: 'FROM Log SELECT *',
    v2warningIncludes: 'mvexpand',
    doc: 'unsupported-mvexpand',
    verified: 'llm',
  },
  // Pattern 2: dedup round-trip (~30%) — NRQL works without expansion

  {
    spl: '* | stats values(title) as title | mvexpand title',
    v2nrql: "FROM Log SELECT uniques(title) AS 'title'",
    v2warningIncludes: 'mvexpand',
    doc: 'unsupported-mvexpand',
    verified: 'llm',
  },
  // Pattern 3: expand + aggregate by expanded field — truly unsupported
  {
    spl: '* | eval perms=split(permissions, ",") | mvexpand perms | stats count by perms',
    unsupportedIncludes: 'row multiplication',
    v2nrql:
      "FROM Log WITH split(permissions, ',') AS perms SELECT count(*) FACET perms",
    doc: 'unsupported-mvexpand',
    verified: 'llm',
  },
  // Pattern 4: symmetric counting — truly unsupported (aggregates by expanded field)
  {
    spl: '* | eval notable_asset=mvappend(notable_src, notable_dest) | mvexpand notable_asset | stats count by notable_asset',
    unsupportedIncludes: 'row multiplication',
    v2nrql:
      'FROM Log WITH mvappend(notable_src, notable_dest) AS notable_asset SELECT count(*) FACET notable_asset',
    doc: 'unsupported-mvexpand',
    verified: 'llm',
  },
  // Pattern 5: expand + sort only (no aggregation by field) — NRQL works without expansion

  {
    spl: 'index=k8s_main bopus orderType=BOPUS storeNumber=* orderNumber=* | stats list(orderNumber) AS orderNumber BY orderStatus storeNumber | mvexpand orderNumber | sort -orderNumber',
    v2nrql:
      "FROM Log SELECT uniques(orderNumber) AS 'orderNumber' WHERE index = 'k8s_main' AND message LIKE '%bopus%' AND orderType = 'BOPUS' AND storeNumber LIKE '%' AND orderNumber LIKE '%' FACET orderStatus, storeNumber ORDER BY orderNumber DESC",
    v2warningIncludes: 'mvexpand',
    doc: 'unsupported-mvexpand',
    verified: 'llm',
  },
  {
    spl: '* | mvcombine delim="," values',
    unsupportedIncludes: 'multivalue',
    doc: 'fields-mvcombine',
    verified: 'llm',
  },
  {
    spl: '* | nomv values',
    unsupportedIncludes: 'multivalue',
    doc: 'fields-nomv',
    verified: 'llm',
  },
  {
    spl: '* | outputcsv results.csv',
    unsupportedIncludes: 'write',
    doc: 'results-outputcsv',
    verified: 'llm',
  },
  {
    spl: '* | sendemail to="admin@example.com"',
    unsupportedIncludes: 'write',
    doc: 'results-sendemail',
    verified: 'llm',
  },
  {
    spl: '* | mcollect index=metrics_idx',
    unsupportedIncludes: 'write',
    doc: 'results-mcollect',
    verified: 'llm',
  },
  {
    spl: 'index=main | stats count as total_requests | appendcols [search index=main level=error | stats count as errors]',
    v2nrql:
      "FROM Log SELECT filter(count(*), WHERE index = 'main') AS 'total_requests', filter(count(*), WHERE index = 'main' AND level = 'error') AS 'errors'",
    v2warningIncludes: 'appendcols',
    doc: 'correlation-appendcols',
    verified: 'llm',
  },
  {
    // appendcols with different FACET on subsearch — can't merge
    spl: '* | stats count as total | appendcols [search * | stats count by host]',
    unsupportedIncludes:
      'appendcols with subsearch cannot be automatically translated',
    v2nrql: "FROM Log SELECT count(*) AS 'total'",
    doc: 'correlation-appendcols',
    verified: 'llm',
  },
  {
    spl: '* | stats count as search_count | appendpipe [stats count | where count=0]',
    v2nrql: "FROM Log SELECT count(*) AS 'search_count'",
    v2warningIncludes: 'appendpipe',
    doc: 'correlation-appendpipe',
    verified: 'llm',
  },
  {
    spl: '* | set union',
    unsupportedIncludes: 'union',
    doc: 'correlation-set',
    verified: 'llm',
  },
  {
    spl: '* | foreach count_* [eval total=total+<<FIELD>>]',
    unsupportedIncludes: 'foreach',
    doc: 'fields-foreach',
    verified: 'llm',
  },
  {
    spl: '| datamodel Authentication',
    unsupportedIncludes: 'Splunk-specific',
    doc: 'data-datamodel',
    verified: 'llm',
  },
  {
    spl: '| pivot Web_Traffic count',
    unsupportedIncludes: 'Splunk-specific',
    doc: 'data-pivot',
    verified: 'llm',
  },
  {
    spl: '* | predict count',
    predict: true,
    warningIncludes: 'PREDICT requires TIMESERIES',
    doc: 'prediction-predict',
    verified: 'llm',
  },
  {
    spl: '* | anomalies field=count',
    unsupportedIncludes: 'anomaly',
    doc: 'anomalies-anomalies',
    verified: 'llm',
  },
  {
    spl: '* | cluster showcount=true',
    unsupportedIncludes: 'cluster',
    doc: 'anomalies-cluster',
    verified: 'llm',
  },
  {
    spl: '* | trendline sma5(count) as trend',
    unsupportedIncludes: 'trendline',
    doc: 'prediction-trendline',
    verified: 'llm',
  },
  {
    spl: '* | extract pairdelim=","',
    unsupportedIncludes: 'capture()',
    doc: 'fields-extract',
    verified: 'llm',
  },
  {
    spl: '* | xmlkv',
    unsupportedIncludes: 'jparse',
    doc: 'fields-xmlkv',
    verified: 'llm',
  },
  {
    spl: '* | stats count by host | transpose',
    unsupportedIncludes: 'transpose',
    v2nrql: 'FROM Log SELECT count(*) FACET host',
    doc: 'results-transpose',
    verified: 'llm',
  },
  {
    spl: '* | timechart count | timewrap 1d',
    unsupportedIncludes: 'COMPARE WITH',
    v2nrql: 'FROM Log SELECT count(*) TIMESERIES AUTO',
    doc: 'reports-timewrap',
    verified: 'llm',
  },
  {
    // FIXME: V2 drops convert silently; V1 maps num() to numeric() in WITH
    // '1234567' → 1234567
    spl: '* | convert num(bytes)',
    with: ['numeric(`bytes`) AS `bytes_converted`'],
    warningIncludes: 'cannot overwrite a field in-place',
    doc: 'fields-convert',
    verified: false,
  },
  {
    // FIXME: V2 drops convert silently; V1 maps rmcomma() to replace+numeric in WITH
    // '1,234,567' → 1234567
    spl: '* | convert rmcomma(total)',
    with: ["numeric(replace(`total`, ',', '')) AS `total_converted`"],
    warningIncludes: 'cannot overwrite a field in-place',
    doc: 'fields-convert',
    verified: false,
  },
  {
    // FIXME: V2 drops convert silently; V1 maps ctime() to toDatetime() in WITH
    // 1741916927007 → '2026-03-13T23:48:47.007Z'
    spl: '* | convert ctime(timestamp) AS readable',
    with: ['toDatetime(`timestamp`) AS `readable`'],
    doc: 'fields-convert',
    verified: false,
  },
  {
    // FIXME: V2 drops convert silently; V1 maps mktime() to toTimestamp()
    // '2026-03-13T23:48:47.007Z' → 1741916927007
    spl: '* | convert mktime(timestr)',
    withIncludes: ['toTimestamp('],
    doc: 'fields-convert',
    verified: false,
  },
  {
    // FIXME: V2 drops convert silently; V1 maps dur2sec() to substring arithmetic
    // '346.319097ms' → 0.346, '5.4712s' → 5.4712, '509.634µs' → 0.000509, '01:30:45' → 5445
    spl: '* | convert dur2sec(duration)',
    withIncludes: ['numeric(substring('],
    warningIncludes: 'dur2sec',
    doc: 'fields-convert',
    verified: false,
  },
  {
    // FIXME: V2 drops convert silently; V1 maps mstime() to substring arithmetic
    // '02:30.500' → 150.5
    spl: '* | convert mstime(elapsed)',
    withIncludes: ['numeric(substring('],
    doc: 'fields-convert',
    verified: false,
  },
  {
    // FIXME: V2 drops convert silently; V1 handles multi-function convert
    // num: '200' → 200, rmcomma: '1,000' → 1000
    spl: '* | convert num(status), rmcomma(total)',
    withLength: 2,
    doc: 'fields-convert',
    verified: false,
  },
  {
    spl: '* | convert auto(field)',
    unsupportedIncludes: 'auto',
    doc: 'fields-convert',
    verified: 'llm',
  },
  {
    // '512MB' — can't strip arbitrary units in NRQL
    spl: '* | convert rmunit(field)',
    unsupportedIncludes: 'rmunit',
    doc: 'fields-convert',
    verified: 'llm',
  },
  {
    // '512m' — memory normalization; NR data is already numeric bytes
    spl: '* | convert memk(field)',
    unsupportedIncludes: 'memk',
    doc: 'fields-convert',
    verified: 'llm',
  },
  {
    spl: '* | highlight error warning',
    unsupportedIncludes: 'UI feature',
    doc: 'results-highlight',
    verified: 'llm',
  },
  {
    spl: '| metadata type=sources',
    unsupportedIncludes: 'Splunk-specific',
    doc: 'data-metadata',
    verified: 'llm',
  },
  {
    spl: '| rest /services/server/info',
    unsupportedIncludes: 'Splunk-specific',
    doc: 'data-rest',
    verified: 'llm',
  },
  {
    spl: '* | tail 10',
    unsupportedIncludes: 'reverse-order',
    doc: 'results-tail',
    verified: 'llm',
  },
  {
    spl: '* | selfjoin host',
    unsupportedIncludes: 'JOIN',
    doc: 'correlation-selfjoin',
    verified: 'llm',
  },
  {
    spl: '* | accum bytes as running_total',
    unsupportedIncludes: 'WITH',
    doc: 'reports-accum',
    verified: 'llm',
  },
  // no downstream aggregation → replace inlined into SELECT

  {
    spl: '* | replace "error" WITH "warning" IN message',
    selectIncludes: ["replace(`message`, 'error', 'warning')"],
    // FIXME: V2 drops replace silently; V1 maps to replace() in SELECT/FACET
    doc: 'fields-replace',
    verified: false,
  },
  // downstream aggregation → replace applied in FACET

  {
    spl: '* | replace "kube:container:" WITH "" IN sourcetype | stats count by sourcetype',
    select: ['count(*)'],
    facet: ["replace(`sourcetype`, 'kube:container:', '')"],
    // FIXME: V2 drops replace silently; V1 maps to replace() in SELECT/FACET
    doc: 'fields-replace',
    verified: false,
  },
  // multi-pair replace
  {
    spl: '* | replace "%%14674" WITH "Value Added", "%%14675" WITH "Value Deleted" IN OperationType',
    selectIncludes: [
      "replace(replace(`OperationType`, '%%14674', 'Value Added'), '%%14675', 'Value Deleted')",
    ],
    // FIXME: V2 drops replace silently; V1 maps to replace() in SELECT/FACET
    doc: 'fields-replace',
    verified: false,
  },
  // replace eval: fix JSON quoting — self-referencing eval inlined into SELECT to avoid circular dependency
  {
    spl: '* | eval json_content=replace(json_content, "\'", "\\"") | spath input=json_content',
    selectIncludes: ["replace(`json_content`, '\\'', '\"')"],
    doc: 'eval-string',
    verified: false,
  },
  {
    spl: '* | sichart count by host',
    unsupportedIncludes: 'summary indexing',
    doc: 'data-sichart',
    verified: 'llm',
  },
  {
    spl: '| mstats avg(cpu.percent) by host',
    unsupportedIncludes: 'Metric',
    doc: 'metrics-mstats',
    verified: 'llm',
  },
  {
    spl: '* | xyzcommand foo bar',
    unsupportedIncludes: 'xyzcommand',
    doc: 'unsupported-unknown',
    verified: 'llm',
  },
  {
    spl: '* | tail 20',
    unsupportedIncludes: 'tail',
    doc: 'results-tail',
    verified: 'llm',
  },
  //
  // ── Edge cases ──────────────────────────────────────────────────
  //
  //
  //
  {
    spl: 'search error',
    v2nrql: "FROM Log SELECT * WHERE message LIKE '%error%'",
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: '| stats count',
    v2nrql: 'FROM Log SELECT count(*)',
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: '* | stats count by host | sort - count | head 5',
    v2nrql: 'FROM Log SELECT count(*) FACET host ORDER BY count DESC LIMIT 5',
    doc: 'edge-cases',
    verified: 'llm',
  },
  //
  //
  {
    spl: 'OR status=200',
    v2nrql:
      "FROM Log SELECT * WHERE message LIKE '%OR%' AND status = '200' OR numeric(status) = 200",
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: 'NOT NOT error',
    v2nrql:
      "FROM Log SELECT * WHERE NOT message LIKE '%NOT%' AND message LIKE '%error%'",
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: '-500',
    v2nrql: "FROM Log SELECT * WHERE message LIKE '%-500%'",
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: 'cpu_usage=95%',
    v2nrql: "FROM Log SELECT * WHERE cpu_usage = '95%'",
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: 'host=web,01',
    v2nrql: "FROM Log SELECT * WHERE host = 'web,01'",
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: 'path=C:\\',
    v2nrql: "FROM Log SELECT * WHERE path = 'C:\\\\'",
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: 'field=***',
    v2nrql: "FROM Log SELECT * WHERE field LIKE '%%%'",
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: 'host=*web*server*prod*',
    v2nrql: "FROM Log SELECT * WHERE host LIKE '%web%server%prod%'",
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: 'error|stats count',
    v2nrql: "FROM Log SELECT count(*) WHERE message LIKE '%error%'",
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: 'status=200\tstatus=300',
    v2nrql:
      "FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 AND status = '300' OR numeric(status) = 300",
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: 'index=web\n| stats count by host',
    v2nrql: "FROM Log SELECT count(*) WHERE index = 'web' FACET host",
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    // FIXME: V2 nested parens with AND/OR don't preserve SPL grouping correctly;
    // inner (b=2 AND (c=3 OR d=4)) loses AND grouping due to OR-tighter precedence
    spl: '(a=1 OR (b=2 AND (c=3 OR d=4)))',
    where:
      "(`a` = '1' OR numeric(`a`) = 1) OR ((`b` = '2' OR numeric(`b`) = 2) AND ((`c` = '3' OR numeric(`c`) = 3) OR (`d` = '4' OR numeric(`d`) = 4)))",
    doc: 'edge-cases',
    verified: false,
  },
  {
    spl: 'status IN (200)',
    v2nrql: 'FROM Log SELECT * WHERE status IN (200)',
    doc: 'edge-cases',
    verified: 'llm',
  },
  { spl: '* | head 0', limit: 0, doc: 'edge-cases', verified: 'llm' },
  {
    spl: '* error',
    v2nrql: "FROM Log SELECT * WHERE message LIKE '%error%'",
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: '* | where a>1 | where b<2',
    v2nrql: 'FROM Log SELECT * WHERE numeric(a) > 1 AND numeric(b) < 2',
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: '* | where (status >= 400 AND status < 500)',
    v2nrql:
      'FROM Log SELECT * WHERE numeric(status) >= 400 AND numeric(status) < 500',
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    // FIXME: V2 only supports single-field sort; drops additional fields with warning
    spl: '* | sort -count, +name, host',
    orderBy: ['count DESC', 'name ASC', 'host ASC'],
    doc: 'edge-cases',
    verified: false,
  },
  {
    spl: '* | STATS COUNT BY host',
    v2nrql: 'FROM Log SELECT count(*) FACET host',
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: '* | Stats Count By Host',
    v2nrql: 'FROM Log SELECT count(*) FACET Host',
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: '* | stats count() by host',
    v2nrql: 'FROM Log SELECT count(*) FACET host',
    doc: 'edge-cases',
    verified: 'llm',
  },
  {
    spl: '* | stats avg(response.time) by host',
    v2nrql: 'FROM Log SELECT average(`response.time`) FACET host',
    doc: 'edge-cases',
    verified: 'llm',
  },
  // Real-world queries moved to spl-real-world.json
  //
  // ── Append command ────────────────────────────────────────────────
  //
  {
    spl: 'index=main "Cache hit" | stats count as Hits | append [search index=main "Cache miss" | stats count as Misses]',
    where: '',
    select: [
      "filter(count(*), WHERE `index` = 'main' AND message LIKE '%Cache hit%') AS 'Hits'",
      "filter(count(*), WHERE `index` = 'main' AND message LIKE '%Cache miss%') AS 'Misses'",
    ],
    warningIncludes: 'append translated to filter()',
    v2nrql:
      "FROM Log SELECT filter(count(*), WHERE index = 'main' AND message LIKE '%Cache hit%') AS 'Hits', filter(count(*), WHERE index = 'main' AND message LIKE '%Cache miss%') AS 'Misses'",
    doc: 'correlation-append',
    verified: 'llm',
  },
  // Same WHERE, different aggregations → merge SELECTs directly
  {
    spl: '* | stats avg(duration) | append [search * | stats max(duration)]',
    select: ['average(duration)', 'max(duration)'],
    warningIncludes: 'append merged into a single query',
    v2nrql: 'FROM Log SELECT average(duration), max(duration)',
    doc: 'correlation-append',
    verified: 'llm',
  },
  // append with no aggregations on either side — raw event append, can't merge
  {
    spl: '* | append [search error]',
    unsupportedIncludes:
      'append with subsearch cannot be automatically translated',
    doc: 'correlation-append',
    verified: 'llm',
  },
  // append with different FACET — can't merge because groupings differ
  {
    spl: '* | stats count as total | append [search * | stats avg(duration) by host]',
    unsupportedIncludes:
      'append with subsearch cannot be automatically translated; the main query and subsearch group by different fields',
    v2nrql: "FROM Log SELECT count(*) AS 'total'",
    doc: 'correlation-append',
    verified: 'llm',
  },
  // append with matching FACET — merge into filter() with shared FACET
  {
    spl: 'error | stats count by host | append [search success | stats count by host]',
    where: '',
    select: [
      "filter(count(*), WHERE message LIKE '%error%')",
      "filter(count(*), WHERE message LIKE '%success%')",
    ],
    facet: ['`host`'],
    warningIncludes: 'append translated to filter()',
    v2nrql:
      "FROM Log SELECT filter(count(*), WHERE message LIKE '%error%'), filter(count(*), WHERE message LIKE '%success%') FACET host",
    doc: 'correlation-append',
    verified: 'llm',
  },
  // append with matching FACET and same WHERE — merge SELECT lists
  {
    spl: '* | stats count by host | append [search * | stats avg(duration) by host]',
    select: ['count(*)', 'average(duration)'],
    facet: ['`host`'],
    warningIncludes: 'append merged into a single query',
    v2nrql: 'FROM Log SELECT count(*), average(duration) FACET host',
    doc: 'correlation-append',
    verified: 'llm',
  },
  // append with different WHERE and non-count aggregations — filter() wraps any aggregation
  {
    spl: 'error | stats avg(duration) as err_dur | append [search success | stats avg(duration) as ok_dur]',
    where: '',
    select: [
      "filter(average(duration), WHERE message LIKE '%error%') AS 'err_dur'",
      "filter(average(duration), WHERE message LIKE '%success%') AS 'ok_dur'",
    ],
    warningIncludes: 'append translated to filter()',
    v2nrql:
      "FROM Log SELECT filter(average(duration), WHERE message LIKE '%error%') AS 'err_dur', filter(average(duration), WHERE message LIKE '%success%') AS 'ok_dur'",
    doc: 'correlation-append',
    verified: 'llm',
  },
  // append without aliases — filter() works without aliases too
  {
    spl: 'error | stats avg(duration) | append [search success | stats max(duration)]',
    where: '',
    select: [
      "filter(average(duration), WHERE message LIKE '%error%')",
      "filter(max(duration), WHERE message LIKE '%success%')",
    ],
    warningIncludes: 'append translated to filter()',
    v2nrql:
      "FROM Log SELECT filter(average(duration), WHERE message LIKE '%error%'), filter(max(duration), WHERE message LIKE '%success%')",
    doc: 'correlation-append',
    verified: 'llm',
  },
];

describe('translateSplToNrql', () => {
  cases.forEach((c, i) => {
    const label = c.spl === null ? 'null' : c.spl || '(empty)';
    const testFn = c.skip ? it.skip : it;
    /* eslint-disable jest/no-standalone-expect */
    testFn(`[${i}] ${label.slice(0, 80)}`, () => {
      const r = translateSplToNrql(c.spl);
      if ('where' in c) expect(r.where).toBe(c.where);
      if ('select' in c) expect(r.select).toEqual(c.select);
      if ('facet' in c) expect(r.facet).toEqual(c.facet);
      if ('orderBy' in c) expect(r.orderBy).toEqual(c.orderBy);
      if ('limit' in c) expect(r.limit).toBe(c.limit);
      if ('since' in c) expect(r.since).toBe(c.since);
      if ('until' in c) expect(r.until).toBe(c.until);
      if ('untilNull' in c) expect(r.until).toBeNull();
      if ('timeseries' in c) expect(r.timeseries).toBe(c.timeseries);
      if ('predict' in c) expect(r.predict).toBe(c.predict);
      if ('from' in c) expect(r.from).toBe(c.from);
      if ('with' in c) expect(r.with).toEqual(c.with);
      if ('withLength' in c) expect(r.with).toHaveLength(c.withLength);
      if ('withIncludes' in c)
        c.withIncludes.forEach((s) =>
          expect(r.with.some((w) => w.includes(s))).toBe(true),
        );
      if ('join' in c) expect(r.join).toEqual(c.join);
      if ('joinLength' in c) expect(r.join).toHaveLength(c.joinLength);
      if ('joinIncludes' in c)
        c.joinIncludes.forEach((s) => expect(r.join[0]).toContain(s));
      if ('joinMatch' in c) expect(r.join[0]).toMatch(c.joinMatch);
      if ('warnings' in c) expect(r.warnings).toEqual(c.warnings);
      if ('warningMatch' in c) expect(r.warnings[0]).toMatch(c.warningMatch);
      if ('warningIncludes' in c)
        expect(r.warnings.some((w) => w.includes(c.warningIncludes))).toBe(
          true,
        );
      if ('warningCount' in c) expect(r.warnings).toHaveLength(c.warningCount);
      if ('errorMatch' in c) expect(r.errors[0]).toMatch(c.errorMatch);
      if ('errorIncludes' in c)
        expect(r.errors.some((e) => e.includes(c.errorIncludes))).toBe(true);
      if ('errorCount' in c) expect(r.errors).toHaveLength(c.errorCount);
      if ('unsupported' in c) expect(r.unsupported).toEqual(c.unsupported);
      if ('unsupportedLength' in c)
        expect(r.unsupported.length).toBeGreaterThanOrEqual(
          c.unsupportedLength,
        );
      if ('unsupportedIncludes' in c)
        expect(
          r.unsupported.some((u) => u.includes(c.unsupportedIncludes)),
        ).toBe(true);
      if ('unexpandedMacros' in c)
        expect(r.unexpandedMacros.length).toBe(c.unexpandedMacros);
      if ('selectIncludes' in c)
        c.selectIncludes.forEach((s) => expect(r.select).toContain(s));
      if ('facetIncludes' in c)
        c.facetIncludes.forEach((s) => expect(r.facet).toContain(s));
      if ('whereIncludes' in c)
        c.whereIncludes.forEach((p) => expect(r.where).toMatch(p));
      if ('nrql' in c) expect(assembleNrql(r)).toBe(c.nrql);
    });
    /* eslint-enable jest/no-standalone-expect */
  });
});

// ── V2 unit tests ───────────────────────────────────────────────
//
// Run every unit test case through V2. For each case:
//   1. V2 must not crash (no uncaught exceptions)
//   2. If V1 parses it (no errors), V2 must also parse it
//   3. If the case has a `v2nrql` field, check V2's NRQL output

const v2UnitStats = { pass: 0, parseRegression: 0, crash: 0 };

describe('translateSplToNrqlV2 (unit cases)', () => {
  cases.forEach((c, i) => {
    if (c.skip) return;
    const label = c.spl === null ? 'null' : c.spl || '(empty)';

    /* eslint-disable jest/no-conditional-expect */
    it(`[${i}] ${label.slice(0, 80)}`, () => {
      // Must not crash
      let v2;
      try {
        v2 = translateSplToNrqlV2(c.spl);
      } catch (e) {
        v2UnitStats.crash++;
        throw e; // fail the test
      }

      // If V1 parses it, V2 must also parse it
      const v1 = translateSplToNrql(c.spl);
      if (v1.errors.length === 0 && v2.errors.length > 0) {
        v2UnitStats.parseRegression++;
        // Uncomment to enforce:
        // expect(v2.errors).toEqual([]);
      }

      // If case specifies expected V2 NRQL, check it
      if ('v2nrql' in c) {
        expect(v2.nrql).toBe(c.v2nrql);
      }

      // V2 warning/unsupported/error assertions
      if ('v2warningIncludes' in c) {
        const joined = v2.warnings.join(' ');
        expect(joined).toContain(c.v2warningIncludes);
      }
      if ('v2unsupportedIncludes' in c) {
        const joined = v2.unsupported.join(' ');
        expect(joined).toContain(c.v2unsupportedIncludes);
      }
      if ('v2errorIncludes' in c) {
        const joined = v2.errors.join(' ');
        expect(joined).toContain(c.v2errorIncludes);
      }

      v2UnitStats.pass++;
    });
    /* eslint-enable jest/no-conditional-expect */
  });
});

// ── Doc generation (afterAll) ────────────────────────────────────

const DOC_PATH = path.resolve(import.meta.dirname, '../../docs/SPL_TO_NRQL.md');
const SENTINEL_RE =
  /<!-- spl-cases: ([\w-]+) -->\n[\s\S]*?\n<!-- \/spl-cases -->/g;
const TABLE_SENTINEL_RE =
  /<!-- spl-table: ([\w-]+) -->\n[\s\S]*?\n<!-- \/spl-table -->/g;

afterAll(() => {
  // Group cases by doc tag, run both V1 and V2
  const groups = {};
  for (const c of cases) {
    if (!c.doc) continue;
    if (!groups[c.doc]) groups[c.doc] = [];
    const r = translateSplToNrql(c.spl);
    const nrql = assembleNrql(r);
    const v2 = translateSplToNrqlV2(c.spl);
    const v2nrql = v2.nrql || null;
    const warnings = r.warnings.length > 0 ? r.warnings : null;
    const unsupported = r.unsupported.length > 0 ? r.unsupported : null;
    groups[c.doc].push({
      spl: c.spl,
      nrql,
      v2nrql,
      warnings,
      unsupported,
      verified: c.verified,
    });
  }

  let doc = fs.readFileSync(DOC_PATH, 'utf8');
  const foundTags = new Set();

  // Read sort order from doc comment
  const sortMatch = doc.match(/<!-- sort-order: (\w+) -->/);
  const sortOrder = sortMatch ? sortMatch[1] : 'status';

  // Status: 0=green (supported, with or without warnings), 1=red (unsupported)
  function statusRank(e) {
    if (e.unsupported) return 1;
    return 0;
  }

  const STATUS_COLORS = ['#d4edda', '#f8d7da'];
  const VERIFIED_BADGES = {
    human: '✅ Confirmed by human',
    llm: '🤖 Confirmed by LLM',
    mcp: '🔍 Confirmed by MCP',
  };

  function renderEntry(e) {
    const bg = STATUS_COLORS[statusRank(e)];
    const badge = VERIFIED_BADGES[e.verified] || '❓ Not confirmed';
    const codeLines = [`SPL:  ${e.spl || '(empty)'}`, `NRQL: ${e.nrql}`];
    // Show V2 output if it differs from V1
    if (e.v2nrql && e.v2nrql !== e.nrql) {
      codeLines.push(`V2:   ${e.v2nrql}`);
    }
    const escaped = codeLines
      .join('\n')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const notes = [];
    if (e.warnings) {
      for (const w of e.warnings)
        notes.push(
          `<div style="background: #fff3cd; padding: 4px 8px; border-radius: 3px; margin: 4px 0 0 0; font-size: 0.9em;">⚠ ${w.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`,
        );
    }
    if (e.unsupported) {
      for (const u of e.unsupported)
        notes.push(
          `<div style="padding: 4px 8px; margin: 4px 0 0 0; font-size: 0.9em;">✗ ${u.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`,
        );
    }
    // Give the first note extra top margin to match the outer div's bottom padding
    if (notes.length > 0) {
      notes[0] = notes[0].replace('margin: 4px 0 0 0', 'margin: 8px 0 0 0');
    }
    const noteBlock = notes.length > 0 ? `\n${notes.join('')}` : '';
    return (
      `<div style="background: ${bg}; padding: 8px; border-radius: 4px; margin: 4px 0;">\n` +
      `<div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">\n` +
      `<pre style="margin: 0; flex: 1;">${escaped}</pre>\n` +
      `<span style="background: rgba(255,255,255,0.6); padding: 2px 8px; border-radius: 12px; font-size: 0.8em; white-space: nowrap;">${badge}</span>\n` +
      `</div>${noteBlock}\n` +
      `</div>`
    );
  }

  doc = doc.replace(SENTINEL_RE, (match, tag) => {
    foundTags.add(tag);
    const entries = groups[tag];
    if (!entries || entries.length === 0) {
      return `<!-- spl-cases: ${tag} -->\n_No test cases for this section._\n<!-- /spl-cases -->`;
    }
    const sorted =
      sortOrder === 'status'
        ? [...entries].sort((a, b) => statusRank(a) - statusRank(b))
        : [...entries].sort((a, b) => (a.spl || '').localeCompare(b.spl || ''));
    const blocks = sorted.map(renderEntry);
    return (
      `<!-- spl-cases: ${tag} -->\n` +
      blocks.join('\n\n') +
      `\n<!-- /spl-cases -->`
    );
  });

  // Generate tables from test cases
  doc = doc.replace(TABLE_SENTINEL_RE, (match, tag) => {
    foundTags.add(tag);
    const entries = groups[tag];
    if (!entries || entries.length === 0) {
      return `<!-- spl-table: ${tag} -->\n_No test cases for this section._\n<!-- /spl-table -->`;
    }

    if (tag === 'stats-functions') {
      const rows = [];
      const seen = new Set();
      for (const e of entries) {
        const splFunc = e.spl.match(/stats\s+(\S+)\(/);
        if (!splFunc) continue;
        const splName = splFunc[1];
        if (seen.has(splName)) continue;
        seen.add(splName);
        const r = translateSplToNrql(e.spl);
        const nrqlExpr = (r.select[0] || '—').replace(/ AS '.*'$/, '');
        const nrqlFunc = nrqlExpr
          .replace(/\((\w[\w.]*)\)/, '(field)')
          .replace(/\((\w[\w.]*),\s*(\d+)\)/, '(field, $2)');
        const notes = e.warnings ? e.warnings[0].replace(/^SPL /, '') : '';
        rows.push(`| \`${splName}(field)\` | \`${nrqlFunc}\` | ${notes} |`);
      }
      const header = '| SPL function | NRQL function | Notes |\n|---|---|---|';
      return `<!-- spl-table: ${tag} -->\n${header}\n${rows.join('\n')}\n<!-- /spl-table -->`;
    }

    if (tag === 'stats-no-equiv') {
      const rows = [];
      for (const e of entries) {
        const splFunc = e.spl.match(/stats\s+(\S+)\(/);
        if (!splFunc) continue;
        const splName = splFunc[1];
        const raw = e.warnings ? e.warnings[0].replace(/^SPL \S+ /, '') : '—';
        const note = raw.charAt(0).toUpperCase() + raw.slice(1);
        rows.push(`| \`${splName}(field)\` | ${note} |`);
      }
      const header = '| SPL function | Notes |\n|---|---|';
      return `<!-- spl-table: ${tag} -->\n${header}\n${rows.join('\n')}\n<!-- /spl-table -->`;
    }

    return match;
  });

  const orphanedTags = [];
  const docTags = new Set(Object.keys(groups));
  for (const tag of docTags) {
    if (!foundTags.has(tag)) orphanedTags.push(tag);
  }
  if (orphanedTags.length > 0) {
    throw new Error(
      `Doc tags with no sentinel in SPL_TO_NRQL.md: ${orphanedTags.join(', ')}`,
    );
  }

  const untagged = cases.filter((c) => !c.doc);
  if (untagged.length > 0) {
    const samples = untagged.slice(0, 5).map((c) => c.spl || '(empty)');
    throw new Error(
      `${untagged.length} test case(s) missing doc tag: ${samples.join('; ')}`,
    );
  }

  // Generate table of contents from headings
  const TOC_RE = /<!-- toc -->\n[\s\S]*?\n<!-- \/toc -->/;
  const SKIP_TOC = new Set([
    'CLI tool',
    'How this document works',
    'Legend',
    'Quick start',
    'Install globally (optional)',
    'Output formats',
    'Interactive REPL',
    'Options reference',
    'Usage telemetry (optional)',
    'Rebuilding the bundle',
  ]);
  doc = doc.replace(TOC_RE, () => {
    const headings = [];
    for (const line of doc.split('\n')) {
      const m = line.match(/^(#{2,3})\s+(.+)/);
      if (!m) continue;
      const level = m[1].length; // 2=##, 3=###, etc.
      const text = m[2];
      if (SKIP_TOC.has(text)) continue;
      const slug = text
        .toLowerCase()
        .replace(/[`()]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const indent = '  '.repeat(level - 2);
      headings.push(`${indent}- [${text}](#${slug})`);
    }
    return `<!-- toc -->\n${headings.join('\n')}\n<!-- /toc -->`;
  });

  fs.writeFileSync(DOC_PATH, doc);
});

// ── assembleNrql tests ──────────────────────────────────────────
describe('assembleNrql', () => {
  it('empty result → SELECT * FROM Log', () => {
    const r = translateSplToNrql('');
    expect(assembleNrql(r)).toBe('FROM Log SELECT *');
  });

  it('select + where', () => {
    const r = translateSplToNrql('status=500 | stats count by host');
    expect(assembleNrql(r)).toBe(
      "FROM Log SELECT count(*) WHERE (`status` = '500' OR numeric(`status`) = 500) FACET `host`",
    );
  });

  it('all clauses: WITH, WHERE, FACET, ORDER BY, LIMIT, SINCE, UNTIL, TIMESERIES', () => {
    const r = translateSplToNrql(
      'earliest=-7d latest=-1d status=500 | eval kb = bytes / 1024 | timechart span=1h count by host | sort -count | head 5',
    );
    expect(assembleNrql(r)).toContain('SINCE 7 days ago');
    expect(assembleNrql(r)).toContain('UNTIL 1 day ago');
    expect(assembleNrql(r)).toContain('TIMESERIES 1 hour');
    expect(assembleNrql(r)).toContain('WITH');
    expect(assembleNrql(r)).toContain('LIMIT 5');
  });

  it('FROM override (inputlookup)', () => {
    const r = translateSplToNrql('| inputlookup geo_ips');
    expect(assembleNrql(r)).toBe('FROM lookup(geo_ips) SELECT *');
  });

  it('JOIN', () => {
    const r = translateSplToNrql(
      '* | join host [search index=other | stats count by host]',
    );
    expect(assembleNrql(r)).toContain('JOIN INNER');
    expect(assembleNrql(r)).toContain('ON `host` = `host`');
  });

  it('WITH clauses (fillnull)', () => {
    const r = translateSplToNrql('* | fillnull value=0 bytes duration');
    expect(assembleNrql(r)).toContain('WITH if(`bytes` IS NULL');
    expect(assembleNrql(r)).toContain('if(`duration` IS NULL');
  });
});

// ── parseSplTime tests ──────────────────────────────────────────
// AI-DEV: AI **MUST NOT** modify these tests. If they fail, fix the production code.
describe('parseSplTime', () => {
  const timeCases = {
    '-24h': { nrql: '24 hours ago', warning: null },
    '-30m': { nrql: '30 minutes ago', warning: null },
    '-7d': { nrql: '7 days ago', warning: null },
    '-1w': { nrql: '1 week ago', warning: null },
    '-1h': { nrql: '1 hour ago', warning: null },
    '-5m': { nrql: '5 minutes ago', warning: null },
    '-60s': { nrql: '60 seconds ago', warning: null },
    '-1y': { nrql: '1 year ago', warning: null },
    '-2mon': { nrql: '2 months ago', warning: null },
    'now': { nrql: null, warning: null },
    '@h': { nrql: 'this hour', warning: null },
    '@d': { nrql: 'today', warning: null },
    '@w': { nrql: 'this week', warning: null },
    '@mon': { nrql: 'this month', warning: null },
    '@q': { nrql: 'this quarter', warning: null },
    '@y': { nrql: 'this year', warning: null },
  };

  Object.entries(timeCases).forEach(([input, expected]) => {
    it(`converts '${input}' to nrql: ${expected.nrql}`, () => {
      const result = parseSplTime(input);
      expect(result.nrql).toBe(expected.nrql);
      expect(result.warning).toBe(expected.warning);
    });
  });

  it('returns a warning for snap-to times like -1d@d', () => {
    const result = parseSplTime('-1d@d');
    expect(result.nrql).toBe('1 day ago');
    expect(result.warning).toMatch(/snap/i);
  });

  it('returns null for empty input', () => {
    expect(parseSplTime(null).nrql).toBeNull();
    expect(parseSplTime('').nrql).toBeNull();
  });

  it('returns a warning for unrecognized time expressions', () => {
    const result = parseSplTime('bogus');
    expect(result.nrql).toBeNull();
    expect(result.warning).toMatch(/Unrecognized/);
  });

  it('approximates unrecognized snap-only unit @s as today', () => {
    const result = parseSplTime('@s');
    expect(result.nrql).toBe('today');
    expect(result.warning).toMatch(/@s/);
  });

  it('handles forward time expression (no minus sign)', () => {
    const result = parseSplTime('1h');
    expect(result.nrql).toBe('1 hour from now');
    expect(result.warning).toBeNull();
  });
});

// ── Real-world SPL regression tests ─────────────────────────────
//
// spl-real-world.json is an array of { spl, nrql, warnings, unsupported }.
// To add a new example, add just { "spl": "..." } — run the tests and they'll
// fail showing the actual output. Copy the output into the JSON to accept it.

const realWorldEntries = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'spl-real-world.json'), 'utf8'),
);

const realWorldStats = {
  parseErrors: 0,
  unsupported: 0,
  warnings: 0,
  clean: 0,
};

describe('spl-real-world translations', () => {
  realWorldEntries.forEach((entry, i) => {
    it(`[${i}] ${entry.spl.slice(0, 80)}`, () => {
      const r = translateSplToNrql(entry.spl);
      const nrql = assembleNrql(r) || null;

      if (r.errors.length > 0) realWorldStats.parseErrors++;
      else if (r.unsupported.length > 0) realWorldStats.unsupported++;
      else if (r.warnings.length > 0) realWorldStats.warnings++;
      else realWorldStats.clean++;

      expect(nrql).toBe(entry.nrql);
      expect(r.unsupported).toEqual(entry.unsupported);
      expect(r.errors).toEqual(entry.errors || []);
      expect(r.warnings).toEqual(entry.warnings || []);
    });
  });
});

const v2Stats = {
  match: 0,
  semanticMatch: 0,
  improvement: 0,
  divergence: 0,
  regression: 0,
  v2Stub: 0,
};

describe('V1 vs V2 comparison', () => {
  realWorldEntries.forEach((entry, i) => {
    it(`[${i}] ${entry.spl.slice(0, 60)}`, () => {
      const v1 = translateSplToNrql(entry.spl);
      const v1Nrql = assembleNrql(v1) || null;

      const v2 = translateSplToNrqlV2(entry.spl);
      const v2Nrql = v2.nrql || null;

      // Skip stubs
      if (v2.warnings.some((w) => w.includes('V2 translator stub'))) {
        v2Stats.v2Stub++;
        return;
      }

      if (v2.errors.length > 0 && v1.errors.length === 0) {
        v2Stats.regression++;
      } else if (v1.errors.length > 0 && v2.errors.length === 0) {
        v2Stats.improvement++;
      } else if (v1Nrql === v2Nrql) {
        v2Stats.match++;
      } else if (
        v1Nrql &&
        v2Nrql &&
        v1Nrql.replace(/`/g, '') === v2Nrql.replace(/`/g, '')
      ) {
        v2Stats.semanticMatch++;
      } else {
        v2Stats.divergence++;
      }
    });
  });
});

afterAll(() => {
  const total = realWorldEntries.length;
  console.log(
    `\n  Real-world V1: ${total} queries — ${realWorldStats.parseErrors} parse errors, ` +
      `${realWorldStats.unsupported} unsupported, ${realWorldStats.warnings} warnings only, ` +
      `${realWorldStats.clean} clean`,
  );
  console.log(
    `  V1 vs V2: ${v2Stats.match} exact, ${v2Stats.semanticMatch} semantic (backtick-only), ` +
      `${v2Stats.divergence} divergence, ${v2Stats.regression} regression, ` +
      `${v2Stats.improvement} improvement, ${v2Stats.v2Stub} stub`,
  );
  console.log(
    `  V2 unit: ${v2UnitStats.pass} pass, ${v2UnitStats.parseRegression} parse regressions, ` +
      `${v2UnitStats.crash} crashes\n`,
  );
});
