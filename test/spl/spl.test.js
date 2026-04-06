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

import { translateSplToNrql } from '../../src/translate.js';
import { parseSplTime } from '../../src/input/spl/splTime.js';
import { messages } from '../../src/messages.js';

// AI-DEV: To add test cases, append to the `cases` array.
// Use `warningFunc`/`unsupportedFunc` (array of message keys from messages.js) for message assertions.
// The test runner verifies exhaustively: every listed function must be called, and no unlisted function may be called.
const cases = [
  //
  // ── Empty / invalid input ───────────────────────────────────────
  //
  //
  //
  {
    spl: '',
    nrql: 'FROM Log SELECT *',
    doc: 'empty-invalid',
    verified: 'human',
  },
  {
    spl: null,
    nrql: 'FROM Log SELECT *',
    doc: 'empty-invalid',
    verified: 'human',
  },
  {
    spl: '|||',
    nrql: 'FROM Log SELECT *',
    doc: 'empty-invalid',
    verified: 'human',
  },
  {
    spl: 'back`tick=value',
    errorIncludes: 'Failed to parse SPL',
    doc: 'empty-invalid',
    verified: 'human',
  },
  {
    spl: '   ',
    nrql: 'FROM Log SELECT *',
    doc: 'empty-invalid',
    verified: 'human',
  },
  //
  //
  ...[
    'message=',
    'message=fn(x)',
    'status IN ()',
    'https://example.com/path?q=1',
    '`mymacro`status=200',
  ].map((spl) => ({
    spl,
    errorIncludes: 'Failed to parse SPL',
    doc: 'empty-invalid',
    verified: 'human',
  })),
  // double pipe collapsed to single pipe
  {
    spl: '* || stats count',
    nrql: 'FROM Log SELECT count(*)',
    doc: 'edge-cases',
    verified: 'human',
  },
  // trailing pipe ignored
  {
    spl: '* | stats count |',
    nrql: 'FROM Log SELECT count(*)',
    doc: 'edge-cases',
    verified: 'human',
  },
  // top-level subsearch unwrapped to WHERE clause
  {
    spl: '[search index=web | fields host]',
    nrql: "FROM Log SELECT * WHERE index = 'web'",
    doc: 'edge-cases',
    verified: 'human',
  },
  //
  // ── Bare keywords (no field prefix) ─────────────────────────────
  //
  //
  //
  {
    spl: 'error',
    nrql: "FROM Log SELECT * WHERE message LIKE '%error%'",
    doc: 'bare-keywords',
    verified: 'human',
  },
  {
    spl: '"connection timeout"',
    nrql: "FROM Log SELECT * WHERE message LIKE '%connection timeout%'",
    doc: 'bare-keywords',
    verified: 'human',
  },
  {
    spl: 'error warning',
    nrql: "FROM Log SELECT * WHERE message LIKE '%error%' AND message LIKE '%warning%'",
    doc: 'bare-keywords',
    verified: 'human',
  },
  {
    spl: '*',
    nrql: 'FROM Log SELECT *',
    doc: 'bare-keywords',
    verified: 'human',
  },
  {
    spl: '100%cpu',
    nrql: "FROM Log SELECT * WHERE message LIKE '%100\\%cpu%'",
    doc: 'bare-keywords',
    verified: 'human',
    semantic_verification: 'mcp',
  },
  // Escaped quotes in bare search values
  {
    spl: '* Operation=\\"Add member\\"',
    nrql: "FROM Log SELECT * WHERE Operation = 'Add member'",
    doc: 'bare-keywords',
    verified: 'human',
  },
  // Template variables $var$ → {{var}}
  {
    spl: '* $global_time.earliest$ $global_time.latest$',
    nrql: 'FROM Log SELECT * SINCE {{global_time.earliest}} UNTIL {{global_time.latest}}',
    doc: 'bare-keywords',
    verified: 'human',
  },
  // TERM() search directive stripped
  {
    spl: 'TERM("control-connection-state-change") | stats count',
    nrql: "FROM Log SELECT count(*) WHERE message LIKE '%control-connection-state-change%'",
    doc: 'bare-keywords',
    verified: 'human',
    semantic_verification: 'mcp',
  },
  {
    spl: 'TERM("*peer-system-ip:*") | stats count',
    nrql: "FROM Log SELECT count(*) WHERE message LIKE '%%peer-system-ip:%%'",
    doc: 'bare-keywords',
    verified: 'human',
    semantic_verification: 'mcp',
  },
  //
  // ── Field comparisons ───────────────────────────────────────────
  //
  //
  //
  // Covers: string equality, numeric equality, !=, >=, implicit AND
  {
    spl: 'status>=400 status!=500 action=purchase',
    nrql: "FROM Log SELECT * WHERE numeric(status) >= 400 AND status != '500' AND numeric(status) != 500 AND action = 'purchase'",
    doc: 'field-comparisons',
    verified: 'human',
    semantic_verification: 'mcp',
  },
  // Numeric equality: integer, negative, decimal — all produce dual string/numeric
  {
    spl: 'status=200 offset=-10 score=3.14',
    nrql: "FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 AND `offset` = '-10' OR numeric(`offset`) = -10 AND score = '3.14' OR numeric(score) = 3.14",
    doc: 'field-comparisons',
    verified: 'human',
  },
  // Non-numeric values: alpha, hex-like, leading-zero — all string-only
  {
    spl: 'status=OK code=4xx zip=00123',
    nrql: "FROM Log SELECT * WHERE status = 'OK' AND code = '4xx' AND zip = '00123'",
    doc: 'field-comparisons',
    verified: 'human',
  },
  //
  //
  {
    spl: '_raw=*error*',
    nrql: "FROM Log SELECT * WHERE message LIKE '%error%'",
    warningFunc: ['raw_mapped_to_message'],
    doc: 'field-comparisons',
    verified: 'human',
  },
  //
  //
  // SPL/NRQL keywords as field values — all treated as string literals
  {
    spl: 'action=OR action=AND action=NOT action=by action=search action=stats group=by',
    nrql: "FROM Log SELECT * WHERE action = 'OR' AND action = 'AND' AND action = 'NOT' AND action = 'by' AND action = 'search' AND action = 'stats' AND group = 'by'",
    doc: 'field-comparisons',
    verified: 'human',
  },
  {
    spl: '"log.annotations.node"=NOSTORE',
    nrql: "FROM Log SELECT * WHERE `log.annotations.node` = 'NOSTORE'",
    doc: 'field-comparisons',
    verified: 'human',
  },
  {
    spl: '"details.error"="*"',
    nrql: "FROM Log SELECT * WHERE `details.error` LIKE '%'",
    doc: 'field-comparisons',
    verified: 'human',
  },
  {
    spl: 'status = 500',
    nrql: "FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500",
    doc: 'field-comparisons',
    verified: 'human',
  },
  {
    spl: 'level = "ERROR"',
    nrql: "FROM Log SELECT * WHERE level = 'ERROR'",
    doc: 'field-comparisons',
    verified: 'human',
  },
  // curly brace field names (JSON array access) → jparse + contains
  {
    spl: 'lineItemList{}.status=active',
    nrql: "FROM Log SELECT * WHERE contains(jparse(message, 'lineItemList[*].status'), 'active')",
    doc: 'json-array-access',
    verified: 'human',
  },
  // != on array field → NOT contains
  {
    spl: 'items{}.status != pending',
    nrql: "FROM Log SELECT * WHERE NOT contains(jparse(message, 'items[*].status'), 'pending')",
    doc: 'json-array-access',
    verified: 'human',
  },
  // Nested dot-path inside array
  {
    spl: 'orders{}.shipping.carrier=fedex',
    nrql: "FROM Log SELECT * WHERE contains(jparse(message, 'orders[*].shipping.carrier'), 'fedex')",
    doc: 'json-array-access',
    verified: 'human',
  },
  // Wildcard value on array field → LIKE on jparse result
  {
    spl: 'containers{}.image=nginx*',
    nrql: "FROM Log SELECT * WHERE jparse(message, 'containers[*].image') LIKE 'nginx%'",
    doc: 'json-array-access',
    verified: 'human',
  },
  // IN on array field → OR'd contains() calls
  {
    spl: 'items{}.category IN (electronics, clothing)',
    nrql: "FROM Log SELECT * WHERE contains(jparse(message, 'items[*].category'), 'electronics') OR contains(jparse(message, 'items[*].category'), 'clothing')",
    doc: 'json-array-access',
    verified: 'human',
  },
  // Indexed array access {0} → jparse with [0]
  {
    spl: 'sourceIPs{0}=10.0.0.1',
    nrql: "FROM Log SELECT * WHERE jparse(message, 'sourceIPs[0]') = '10.0.0.1'",
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
    nrql: "FROM Log SELECT * WHERE EventCode = '4720' OR numeric(EventCode) = 4720 OR EventCode = '4732' OR numeric(EventCode) = 4732",
    doc: 'boolean-operators',
    verified: 'human',
    semantic_verification: 'mcp',
  },
  {
    spl: 'NOT debug',
    nrql: "FROM Log SELECT * WHERE message NOT LIKE '%debug%'",
    doc: 'boolean-operators',
    verified: false,
  },
  {
    spl: '(error OR warning) NOT debug',
    nrql: "FROM Log SELECT * WHERE message LIKE '%error%' OR message LIKE '%warning%' AND message NOT LIKE '%debug%'",
    doc: 'boolean-operators',
    verified: false,
  },
  {
    spl: '`macro_a` AND `macro_b`',
    nrql: 'FROM Log SELECT * WHERE $macro_a AND $macro_b',
    warningFunc: ['macro_translated'],
    doc: 'boolean-operators',
    verified: 'human',
  },
  {
    spl: '`macro_a` AND status=200',
    nrql: "FROM Log SELECT * WHERE $macro_a AND status = '200' OR numeric(status) = 200",
    doc: 'boolean-operators',
    verified: 'human',
  },
  //
  //
  {
    spl: 'a=1 OR b=2 c=3',
    nrql: "FROM Log SELECT * WHERE a = '1' OR numeric(a) = 1 OR (b = '2' OR numeric(b) = 2 AND c = '3' OR numeric(c) = 3)",
    doc: 'boolean-operators',
    verified: 'human',
    semantic_verification: 'mcp',
  },
  {
    spl: '(a=1 OR b=2) AND c=3',
    nrql: "FROM Log SELECT * WHERE a = '1' OR numeric(a) = 1 OR b = '2' OR numeric(b) = 2 AND c = '3' OR numeric(c) = 3",
    doc: 'boolean-operators',
    verified: 'human',
    semantic_verification: 'mcp',
  },
  {
    spl: 'a=1 b=2 OR c=3 d=4',
    nrql: "FROM Log SELECT * WHERE (a = '1' OR numeric(a) = 1 AND b = '2' OR numeric(b) = 2) OR (c = '3' OR numeric(c) = 3 AND d = '4' OR numeric(d) = 4)",
    doc: 'boolean-operators',
    verified: 'human',
    semantic_verification: 'mcp',
  },
  {
    spl: 'NOT status=500 host=web',
    nrql: "FROM Log SELECT * WHERE NOT (status = '500' OR numeric(status) = 500) AND host = 'web'",
    doc: 'boolean-operators',
    verified: 'human',
  },
  {
    spl: 'NOT (status=500 host=web)',
    nrql: "FROM Log SELECT * WHERE NOT (status = '500' OR numeric(status) = 500 AND host = 'web')",
    doc: 'boolean-operators',
    verified: 'human',
    semantic_verification: 'mcp',
  },
  // NOT() without space + boolean group inside + combined with bare keyword
  {
    spl: 'error NOT(level=debug OR level=trace)',
    nrql: "FROM Log SELECT * WHERE message LIKE '%error%' AND NOT (level = 'debug' OR level = 'trace')",
    doc: 'boolean-operators',
    verified: 'human',
  },
  // NOT() empty parens — should be a no-op
  {
    spl: 'NOT() error',
    nrql: "FROM Log SELECT * WHERE message LIKE '%error%'",
    doc: 'boolean-operators',
    verified: 'human',
    semantic_verification: 'mcp',
  },
  //
  // ── IN operator ─────────────────────────────────────────────────
  //
  //
  //
  // Mixed types: numeric + string in one IN (covers pure-numeric and pure-string paths too)
  {
    spl: 'code IN (200, error, 404)',
    nrql: "FROM Log SELECT * WHERE code IN (200, 'error', 404)",
    doc: 'in-operator',
    verified: 'human',
  },
  // Wildcards inside IN — expands to LIKE clauses
  {
    spl: 'ScriptBlockText IN (*mimikatz*, *dumpcr*)',
    nrql: "FROM Log SELECT * WHERE ScriptBlockText LIKE '%mimikatz%' OR ScriptBlockText LIKE '%dumpcr%'",
    doc: 'in-operator',
    verified: 'human',
  },
  // NOT [inputlookup] → NOT IN lookup subquery
  {
    spl: '* NOT [|inputlookup exclude.csv] | stats count',
    nrql: 'FROM Log SELECT count(*) WHERE {{column}} NOT IN (FROM lookup(exclude) SELECT {{column}} LIMIT MAX)',
    warningFunc: ['not_inputlookup_translated'],
    doc: 'in-operator',
    verified: 'human',
  },
  // Quoted field name in IN()
  {
    spl: '"parameters.doc_title" IN ("*dhl*", "*invoice*")',
    nrql: "FROM Log SELECT * WHERE `parameters.doc_title` LIKE '%dhl%' OR `parameters.doc_title` LIKE '%invoice%'",
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
    nrql: "FROM Log SELECT * WHERE host LIKE '%server' AND host LIKE 'web%' AND message LIKE '%error%' AND path LIKE '/api/%/users'",
    doc: 'wildcards',
    verified: 'human',
    semantic_verification: 'mcp',
  },
  // Match-all wildcard
  {
    spl: 'host=*',
    nrql: "FROM Log SELECT * WHERE host LIKE '%'",
    doc: 'wildcards',
    verified: 'human',
  },
  // Negated wildcard
  {
    spl: 'host!=test*',
    nrql: "FROM Log SELECT * WHERE host NOT LIKE 'test%'",
    doc: 'wildcards',
    verified: false,
  },
  //
  // ── Quoted strings ──────────────────────────────────────────────
  //
  //
  //
  {
    spl: 'message="it\'s"',
    nrql: "FROM Log SELECT * WHERE message = 'it\\'s'",
    doc: 'quoted-strings',
    verified: 'human',
  },
  {
    spl: 'path="C:\\\\Windows\\\\System32"',
    nrql: "FROM Log SELECT * WHERE path = 'C:\\\\Windows\\\\System32'",
    doc: 'quoted-strings',
    verified: 'human',
  },
  {
    spl: 'msg="line1\\nline2"',
    nrql: "FROM Log SELECT * WHERE msg = 'line1\\nline2'",
    doc: 'quoted-strings',
    verified: 'human',
  },
  // Double-quoted with spaces, pipe, equals, comma, empty, unicode — all in one implicit-AND
  {
    spl: 'a="error in module" b="error | fatal" c="key=value" d="" e="日本語エラー" f="error, fatal"',
    nrql: "FROM Log SELECT * WHERE a = 'error in module' AND b = 'error | fatal' AND c = 'key=value' AND d = '' AND e = '日本語エラー' AND f = 'error, fatal'",
    doc: 'quoted-strings',
    verified: 'human',
  },
  // Double-quoted value with spaces
  {
    spl: 'message="error in module"',
    nrql: "FROM Log SELECT * WHERE message = 'error in module'",
    doc: 'quoted-strings',
    verified: 'human',
  },
  // Quoted value with parentheses in a real-world context
  {
    spl: 'index=web user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64)" | stats count by host',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' AND user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' FACET host",
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
    nrql: "FROM Log SELECT * WHERE `my-field` = 'value'",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: 'app:version=1.2.3',
    nrql: "FROM Log SELECT * WHERE `app:version` = '1.2.3'",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: 'kubernetes.labels.app:name=myapp',
    nrql: "FROM Log SELECT * WHERE `kubernetes.labels.app:name` = 'myapp'",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: '* | stats count by container-name',
    nrql: 'FROM Log SELECT count(*) FACET `container-name`',
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: '* | stats values(user.groups{}) as user_groups by host',
    nrql: "FROM Log SELECT uniques(jparse(message, 'user.groups[*]')) AS 'user_groups' FACET host",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: '* | table k8s:namespace, k8s:pod',
    nrql: 'FROM Log SELECT `k8s:namespace`, `k8s:pod`',
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: 'log-level IN (error, warn, info)',
    nrql: "FROM Log SELECT * WHERE `log-level` IN ('error', 'warn', 'info')",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: 'x-forwarded-for=10.0.0.1',
    nrql: "FROM Log SELECT * WHERE `x-forwarded-for` = '10.0.0.1'",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  {
    spl: 'SELECT=200',
    nrql: "FROM Log SELECT * WHERE `SELECT` = '200' OR numeric(`SELECT`) = 200",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  //
  //
  // Field names containing SPL keywords — not misparsed as commands
  {
    spl: 'search_term=hello NOT_FOUND=true top_secret=classified earliest_time=noon where=production table=users stats=enabled',
    nrql: "FROM Log SELECT * WHERE search_term = 'hello' AND NOT_FOUND = 'true' AND top_secret = 'classified' AND earliest_time = 'noon' AND `where` = 'production' AND table = 'users' AND stats = 'enabled'",
    doc: 'nrql-keywords',
    verified: 'human',
  },
  // Keyword-containing field with numeric value
  {
    spl: 'bytecount=1024',
    nrql: "FROM Log SELECT * WHERE bytecount = '1024' OR numeric(bytecount) = 1024",
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
    nrql: "FROM Log SELECT * WHERE index = 'web'",
    doc: 'metadata-fields',
    verified: 'human',
  },
  {
    spl: 'sourcetype=access_*',
    nrql: "FROM Log SELECT * WHERE sourcetype LIKE 'access_%'",
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
    nrql: "FROM Log SELECT * WHERE $sysmon AND EventCode = '10' OR numeric(EventCode) = 10",
    doc: 'macros',
    verified: 'human',
  },
  {
    spl: '`my_macro(arg1, arg2)` status=200',
    nrql: "FROM Log SELECT * WHERE $my_macro(arg1, arg2) AND status = '200' OR numeric(status) = 200",
    doc: 'macros',
    verified: 'human',
  },
  {
    spl: '* | `my_macro`',
    nrql: 'FROM Log SELECT * WHERE $my_macro',
    warningFunc: ['macro_translated'],
    doc: 'macros',
    verified: 'human',
  },
  {
    spl: '* | `my_macro(field1, field2)`',
    nrql: 'FROM Log SELECT * WHERE $my_macro(field1, field2)',
    warningFunc: ['macro_translated'],
    doc: 'macros',
    verified: 'human',
  },
  {
    spl: '`my_base_macro` | stats count',
    nrql: 'FROM Log SELECT count(*) WHERE $my_base_macro',
    warningFunc: ['macro_translated'],
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
    nrql: 'FROM Log SELECT * SINCE 24 hours ago',
    doc: 'time-constraints',
    verified: 'human',
  },
  {
    spl: 'latest=-1h',
    nrql: 'FROM Log SELECT * SINCE 24 hours ago UNTIL 1 hour ago',
    warningFunc: ['latest_without_earliest'],
    doc: 'time-constraints',
    verified: 'human',
  },
  {
    spl: 'latest=now',
    nrql: 'FROM Log SELECT *',
    doc: 'time-constraints',
    verified: 'human',
  },
  {
    spl: 'earliest=@d',
    nrql: 'FROM Log SELECT * SINCE today',
    doc: 'time-constraints',
    verified: 'human',
  },
  {
    spl: 'error earliest=-24h latest=now',
    nrql: "FROM Log SELECT * WHERE message LIKE '%error%' SINCE 24 hours ago",
    doc: 'time-constraints',
    verified: 'human',
  },
  {
    spl: 'earliest=-2h latest=-1h status=200',
    nrql: "FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 SINCE 2 hours ago UNTIL 1 hour ago",
    doc: 'time-constraints',
    verified: 'human',
  },
  {
    spl: 'earliest=-24h@h latest=now',
    nrql: 'FROM Log SELECT * SINCE 24 hours ago',
    doc: 'time-constraints',
    verified: 'human',
  },
  // Time constraint mid-expression — earliest/latest mixed with field comparisons
  {
    spl: 'status=500 earliest=-24h host=web',
    nrql: "FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND host = 'web' SINCE 24 hours ago",
    doc: 'time-constraints',
    verified: 'human',
  },
  // Multiple earliest — last one wins
  {
    spl: 'earliest=-24h earliest=-1h',
    nrql: 'FROM Log SELECT * SINCE 1 hour ago',
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
    nrql: 'FROM Log WITH numeric(bytes) / 1024 AS d, numeric(price) * numeric(quantity) AS m, numeric(sent) + numeric(received) AS a, numeric(end_time) - numeric(start_time) AS s, mod(numeric(x), 10) AS r SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // Precedence: * before +, / before +, parentheses override
  {
    spl: '* | eval p1 = a * b + c, p2 = a + b / c, p3 = (a + b) / c, p4 = (a + b) * (c - d)',
    nrql: 'FROM Log WITH numeric(a) * numeric(b) + numeric(c) AS p1, numeric(a) + numeric(b) / numeric(c) AS p2, (numeric(a) + numeric(b)) / numeric(c) AS p3, (numeric(a) + numeric(b)) * (numeric(c) - numeric(d)) AS p4 SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // Decimals, chaining (a+b+c+d), multi-multiply (a*b*c), multiple assignments
  {
    spl: '* | eval pct = count / 100.0, chain = a + b + c + d, mul = a * b * c, kb = bytes / 1024, mb = bytes / 1048576, gb = bytes / 1073741824',
    nrql: 'FROM Log WITH numeric(count) / 100 AS pct, numeric(a) + numeric(b) + numeric(c) + numeric(d) AS chain, numeric(a) * numeric(b) * numeric(c) AS mul, numeric(bytes) / 1024 AS kb, numeric(bytes) / 1048576 AS mb, numeric(bytes) / 1073741824 AS gb SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // eval if() function call
  {
    spl: '* | eval x = if(status=200, "ok", "err")',
    nrql: "FROM Log WITH if(status = '200' OR numeric(status) = 200, 'ok', 'err') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // Eval piped to stats + eval chained (two eval commands)
  {
    spl: '* | eval size_mb = bytes / 1048576 | eval size_gb = size_mb / 1024 | stats avg(size_mb) by host',
    nrql: 'FROM Log WITH numeric(bytes) / 1048576 AS size_mb, numeric(size_mb) / 1024 AS size_gb SELECT average(size_mb) FACET host',
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // Search clause + eval + table
  {
    spl: 'status=200 | eval duration_sec = duration / 1000 | table host, duration_sec',
    nrql: "FROM Log WITH numeric(duration) / 1000 AS duration_sec SELECT host, duration_sec WHERE status = '200' OR numeric(status) = 200",
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // Edge cases: no-spaces, rename, literal, double parens, hyphenated/colon/dotted fields
  {
    spl: '* | eval x=a+b, alias = original, lit = 42, parens = ((a + b)), hyph = http-status / 100, col = aws:region, dot = http.status / 100',
    nrql: 'FROM Log WITH numeric(a) + numeric(b) AS x, original AS alias, 42 AS lit, numeric(a) + numeric(b) AS parens, numeric(`http-status`) / 100 AS hyph, `aws:region` AS col, numeric(`http.status`) / 100 AS dot SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // Eval + spath
  {
    spl: '* | spath input=payload path=user.id output=uid | eval uid_num = uid / 1',
    nrql: "FROM Log WITH jparse(payload, 'user.id') AS uid, numeric(uid) / 1 AS uid_num SELECT *",
    warningFunc: ['spath_json_only'],
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // Eval + fillnull
  {
    spl: '* | fillnull value=0 bytes | eval kb = bytes / 1024',
    nrql: 'FROM Log WITH numeric(bytes OR 0) / 1024 AS kb SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  // eval coalesce() → nested if(IS NOT NULL) (NRQL has no coalesce())
  {
    spl: '* | eval val = coalesce(field1, field2, "default")',
    nrql: "FROM Log WITH (field1 OR field2 OR 'default') AS val SELECT *",
    doc: 'eval-type',
    verified: 'human',
  },
  // eval lower() → lower() (1:1 mapping)
  {
    spl: '* | eval name = lower(username)',
    nrql: 'FROM Log WITH lower(username) AS name SELECT *',
    doc: 'eval-string',
    verified: 'human',
  },
  // eval dot-concat → concat()
  {
    spl: '* | eval full = first . " " . last',
    nrql: "FROM Log WITH concat(first, ' ', last) AS full SELECT *",
    doc: 'eval-string',
    verified: 'human',
  },
  // eval mvindex() → getField()
  {
    spl: '* | eval first = mvindex(values, 0)',
    nrql: 'FROM Log WITH getField(values, 0) AS first SELECT *',
    doc: 'eval-multivalue',
    verified: 'human',
  },
  // eval mvjoin() → unsupported (NRQL can't join array elements)
  {
    spl: '* | eval joined = mvjoin(tags, ", ")',
    unsupportedFunc: ['eval_mvjoin_unsupported'],
    doc: 'eval-multivalue',
    verified: 'human',
  },
  // eval if() with comparison
  {
    spl: '* | eval x = if(a>1, "y", "n")',
    nrql: "FROM Log WITH if(numeric(a) > 1, 'y', 'n') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval mvcount() → length()
  {
    spl: '* | eval x = mvcount(lines)',
    nrql: 'FROM Log WITH length(lines) AS x SELECT *',
    doc: 'eval-multivalue',
    verified: 'human',
  },
  // eval if() with string equality (customer pattern)
  {
    spl: '* | eval FLSQuantity=if(channelName=="FLS", availableQuantityInChannel, 0)',
    nrql: "FROM Log WITH if(channelName = 'FLS', availableQuantityInChannel, 0) AS FLSQuantity SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval if() with compound condition (AND)
  {
    spl: '* | eval x=if(a > 0 and b > 0, "both", "nope")',
    nrql: "FROM Log WITH if(numeric(a) > 0 AND numeric(b) > 0, 'both', 'nope') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // where isint()
  {
    spl: '* | where isint(orderId)',
    nrql: 'FROM Log SELECT * WHERE numeric(orderId) IS NOT NULL',
    doc: 'results-where',
    verified: 'human',
  },
  //
  // ── case() tests ──────────────────────────────────────────────
  //
  // case() with numeric comparisons and 1=1 default
  {
    spl: '* | eval level = case(status<300, "ok", status<500, "warn", 1=1, "err")',
    nrql: "FROM Log WITH if(numeric(status) < 300, 'ok', if(numeric(status) < 500, 'warn', 'err')) AS level SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // case() with multiple conditions and 1=1 default (equality comparisons)
  {
    spl: '* | eval x=case(a=1, "one", b=2, "two", 1=1, "other")',
    nrql: "FROM Log WITH if(a = '1' OR numeric(a) = 1, 'one', if(b = '2' OR numeric(b) = 2, 'two', 'other')) AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // case() with even args and no default → NULL fallback
  {
    spl: '* | eval x=case(a=1, "one", b=2, "two")',
    nrql: "FROM Log WITH if(a = '1' OR numeric(a) = 1, 'one', if(b = '2' OR numeric(b) = 2, 'two', NULL)) AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval if() with OR condition
  {
    spl: '* | eval x=if(a > 0 or b > 0, "yes", "no")',
    nrql: "FROM Log WITH if(numeric(a) > 0 OR numeric(b) > 0, 'yes', 'no') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval if() with parenthesized compound condition
  {
    spl: '* | eval x=if((a > 0) or (b > 0), "yes", "no")',
    nrql: "FROM Log WITH if(numeric(a) > 0 OR numeric(b) > 0, 'yes', 'no') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval if() with arithmetic inside parenthesized condition args
  {
    spl: '* | eval x=if(count > (a + b), "over", "under")',
    nrql: "FROM Log WITH if(numeric(count) > numeric(a) + numeric(b), 'over', 'under') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval if() with field-to-field ordering comparison
  {
    spl: '* | eval x=if(skuCount > FCQuantity, "yes", "no")',
    nrql: "FROM Log WITH if(numeric(skuCount) > numeric(FCQuantity), 'yes', 'no') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval upper() → upper()
  {
    spl: '* | eval x=upper(name)',
    nrql: 'FROM Log WITH upper(name) AS x SELECT *',
    doc: 'eval-string',
    verified: 'human',
  },
  // eval substr() → substring() with 1-based to 0-based index adjustment
  {
    spl: '* | eval x=substr(name, 1, 3)',
    nrql: 'FROM Log WITH substring(name, 0, 3) AS x SELECT *',
    doc: 'eval-string',
    verified: 'human',
  },
  // eval substr() negative offset — last 3 chars (no index adjustment for negatives)
  {
    spl: '* | eval x=substr(name, -3)',
    nrql: 'FROM Log WITH substring(name, -3) AS x SELECT *',
    doc: 'eval-string',
    verified: 'human',
  },
  // eval trim() → capture with regex (alias name used as group name to avoid collision)
  {
    spl: '* | eval x=trim(name)',
    nrql: "FROM Log WITH capture(name, r'^\\s*(?P<x>.*\\S)\\s*$') AS x SELECT *",
    doc: 'eval-string',
    verified: 'human',
  },
  // eval ltrim() → capture with leading whitespace strip
  {
    spl: '* | eval x=ltrim(name)',
    nrql: "FROM Log WITH capture(name, r'^\\s*(?P<x>.*)$') AS x SELECT *",
    doc: 'eval-string',
    verified: 'human',
  },
  // eval replace() with simple literal → NRQL replace()
  {
    spl: '* | eval x=replace(name, "a", "b")',
    nrql: "FROM Log WITH replace(name, 'a', 'b') AS x SELECT *",
    doc: 'eval-string',
    verified: 'human',
  },
  // eval replace() with regex pattern → unsupported (NRQL replace is literal-only)
  {
    spl: '* | eval x=replace(name, "\\\\d+", "")',
    unsupportedFunc: ['eval_replace_regex'],
    doc: 'eval-string',
    verified: 'human',
  },
  // eval replace() simple deletion
  {
    spl: '* | eval x=replace(name, "SKU:", "")',
    nrql: "FROM Log WITH replace(name, 'SKU:', '') AS x SELECT *",
    doc: 'eval-string',
    verified: 'human',
  },
  // eval abs(), ceil(), floor(), round(), sqrt(), pow()
  ...['abs', 'ceil', 'floor', 'sqrt'].map((fn) => ({
    spl: `* | eval x=${fn}(val)`,
    nrql: `FROM Log WITH ${fn}(val) AS x SELECT *`,
    doc: 'eval-math',
    verified: 'human',
  })),
  {
    // SPL round(val, 2) = 2 decimal places → NRQL round(val, 0.01)
    spl: '* | eval x=round(val, 2)',
    nrql: 'FROM Log WITH round(val, 0.01) AS x SELECT *',
    doc: 'eval-math',
    verified: 'human',
  },
  {
    spl: '* | eval x=pow(base, exp)',
    nrql: 'FROM Log WITH pow(base, exp) AS x SELECT *',
    doc: 'eval-math',
    verified: 'human',
  },
  // eval ceiling() → ceil()
  {
    spl: '* | eval x=ceiling(val)',
    nrql: 'FROM Log WITH ceiling(val) AS x SELECT *',
    doc: 'eval-math',
    verified: 'human',
  },
  // eval log() single arg → log10() (SPL log() is base 10)
  {
    spl: '* | eval x=log(val)',
    nrql: 'FROM Log WITH log10(val) AS x SELECT *',
    doc: 'eval-math',
    verified: 'human',
  },
  // eval isnull() / isnotnull() — used inside conditionals
  {
    spl: '* | eval x=if(isnull(field), "missing", field)',
    nrql: "FROM Log WITH if(field IS NULL, 'missing', field) AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  {
    spl: '* | eval x=if(isnotnull(field), field, "default")',
    nrql: "FROM Log WITH if(field IS NOT NULL, field, 'default') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval like() → LIKE operator (used inside conditional)
  {
    spl: '* | eval x=if(like(name, "test%"), "match", "no")',
    nrql: "FROM Log WITH if(name LIKE 'test%', 'match', 'no') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval tonumber() → numeric()
  {
    spl: '* | eval x=tonumber(val)',
    nrql: 'FROM Log WITH numeric(val) AS x SELECT *',
    doc: 'eval-type',
    verified: 'human',
  },
  // tostring(val) → string(val); SPL format args (hex, commas) not supported
  {
    spl: '* | eval x=tostring(val)',
    nrql: 'FROM Log WITH string(val) AS x SELECT *',
    doc: 'eval-type',
    verified: 'human',
  },
  {
    spl: '* | eval x=typeof(val)',
    unsupportedFunc: ['eval_func_unsupported'],
    doc: 'eval-type',
    verified: 'human',
  },
  {
    spl: '* | eval x=isbool(val)',
    unsupportedFunc: ['eval_func_unsupported'],
    doc: 'eval-type',
    verified: 'human',
  },
  {
    spl: '* | eval x=isstr(val)',
    unsupportedFunc: ['eval_func_unsupported'],
    doc: 'eval-type',
    verified: 'human',
  },
  // eval if() with == on field-to-field comparison
  {
    spl: '* | eval match=if(a==b, "same", "diff")',
    nrql: "FROM Log WITH if(a = b, 'same', 'diff') AS match SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // eval if() with wrong arg count (2 args)
  {
    spl: '* | eval x=if(a > 0, "yes")',
    nrql: "FROM Log WITH if(numeric(a) > 0, 'yes') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  // case() with single arg — edge case, SPL returns the value as default
  {
    spl: '* | eval x=case("only")',
    nrql: "FROM Log WITH 'only' AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'human',
  },
  {
    spl: '* | eval x=mvindex(values)',
    nrql: 'FROM Log WITH values AS x SELECT *',
    warningFunc: ['eval_mvindex_args'],
    doc: 'eval-multivalue',
    verified: 'human',
  },
  // mvindex(split(...), 0) → getField(split(...), 0)
  {
    spl: '* | eval x=mvindex(split(data, ","), 0)',
    nrql: "FROM Log WITH getField(split(data, ','), 0) AS x SELECT *",
    doc: 'eval-multivalue',
    verified: 'human',
  },
  // replace() with bracket chars that are NOT regex — ] alone is a literal
  {
    spl: '* | eval x=replace(name, "]", "")',
    nrql: "FROM Log WITH replace(name, ']', '') AS x SELECT *",
    doc: 'eval-string',
    verified: 'human',
  },
  {
    spl: '* | eval x=replace(name, "[abc]", "")',
    unsupportedFunc: ['eval_replace_regex'],
    doc: 'eval-string',
    verified: 'human',
  },
  {
    spl: '* | eval x=replace(name, "test.*end", "")',
    unsupportedFunc: ['eval_replace_regex'],
    doc: 'eval-string',
    verified: 'human',
  },
  // replace() regex detection — quantifiers after word chars
  {
    spl: '* | eval x=replace(name, "\\d+", "")',
    unsupportedFunc: ['eval_replace_regex'],
    doc: 'eval-string',
    verified: 'human',
  },
  {
    spl: '* | eval x=replace(name, "foo+", "")',
    unsupportedFunc: ['eval_replace_regex'],
    doc: 'eval-string',
    verified: 'human',
  },
  {
    spl: '* | eval x=replace(name, "x?y", "")',
    unsupportedFunc: ['eval_replace_regex'],
    doc: 'eval-string',
    verified: 'human',
  },
  // replace() regex detection — alternation
  {
    spl: '* | eval x=replace(name, "foo|bar", "")',
    unsupportedFunc: ['eval_replace_regex'],
    doc: 'eval-string',
    verified: 'human',
  },
  // replace() regex detection — \s+ parsed as s+ (parser strips backslash)
  {
    spl: '* | eval x=replace(name, "\\s+", " ")',
    unsupportedFunc: ['eval_replace_regex'],
    doc: 'eval-string',
    verified: 'human',
  },
  // replace() with literal dot in hostname — should NOT flag as regex
  {
    spl: '* | eval x=replace(name, "old.host.com", "new.host.com")',
    nrql: "FROM Log WITH replace(name, 'old.host.com', 'new.host.com') AS x SELECT *",
    doc: 'eval-string',
    verified: 'human',
  },
  // replace() with literal hyphen — should NOT flag as regex
  {
    spl: '* | eval x=replace(name, "foo-bar", "baz")',
    nrql: "FROM Log WITH replace(name, 'foo-bar', 'baz') AS x SELECT *",
    doc: 'eval-string',
    verified: 'human',
  },
  // replace() with URL containing ? and + — should NOT flag as regex
  {
    spl: '* | eval x=replace(uri, "https://old.com/api?key=val", "https://new.com/api")',
    nrql: "FROM Log WITH replace(uri, 'https://old.com/api?key=val', 'https://new.com/api') AS x SELECT *",
    doc: 'eval-string',
    verified: 'human',
  },
  {
    spl: '* | eval x=replace(uri, "/path/to+file", "/path/to_file")',
    nrql: "FROM Log WITH replace(uri, '/path/to+file', '/path/to_file') AS x SELECT *",
    doc: 'eval-string',
    verified: 'human',
  },
  // replace() with URL that also has real regex — should still flag
  {
    spl: '* | eval x=replace(uri, "https://example.com/.*", "")',
    unsupportedFunc: ['eval_replace_regex'],
    doc: 'eval-string',
    verified: 'human',
  },
  // where with infix like operator — exact output
  {
    spl: '* | where name like "test%"',
    nrql: "FROM Log SELECT * WHERE name LIKE 'test%'",
    doc: 'results-where',
    verified: 'human',
  },
  // Eval with other pipe commands
  {
    spl: '* | eval rate = count / duration | sort -rate | head 10',
    nrql: 'FROM Log WITH numeric(count) / numeric(duration) AS rate SELECT * ORDER BY rate DESC LIMIT 10',
    doc: 'fields-eval-arithmetic',
    verified: 'human',
  },
  {
    spl: '* | eval kb = bytes / 1024 | rename kb as kilobytes',
    nrql: "FROM Log WITH numeric(bytes) / 1024 AS kb SELECT kb AS 'kilobytes', *",
    warningFunc: ['rename_keeps_original'],
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
    nrql: 'FROM Log JOIN (FROM lookup(geo_table) SELECT * FACET src_ip LIMIT MAX) ON src_ip = src_ip SELECT *',
    warningFunc: ['lookup_upload_reminder'],
    doc: 'correlation-lookup',
    verified: 'human',
  },
  {
    spl: '* | lookup ip_to_country src_ip OUTPUT country',
    nrql: 'FROM Log JOIN (FROM lookup(ip_to_country) SELECT country FACET src_ip LIMIT MAX) ON src_ip = src_ip SELECT *',
    warningFunc: ['lookup_upload_reminder'],
    doc: 'correlation-lookup',
    verified: 'human',
  },
  {
    spl: '* | lookup users_lookup username AS user OUTPUT department',
    nrql: 'FROM Log JOIN (FROM lookup(users_lookup) SELECT department FACET username LIMIT MAX) ON user = username SELECT *',
    warningFunc: ['lookup_upload_reminder'],
    doc: 'correlation-lookup',
    verified: 'human',
  },
  //
  // ── inputlookup command ─────────────────────────────────────────
  //
  {
    spl: '* | inputlookup geo_ips',
    nrql: 'FROM lookup(geo_ips) SELECT *',
    warningFunc: ['lookup_upload_reminder'],
    doc: 'results-inputlookup',
    verified: 'human',
  },
  {
    spl: '* | inputlookup append=true geo_ips',
    nrql: 'FROM lookup(geo_ips) SELECT *',
    warningFunc: ['lookup_upload_reminder'],
    doc: 'results-inputlookup',
    verified: 'human',
  },
  {
    spl: '* | inputlookup my_table',
    nrql: 'FROM lookup(my_table) SELECT *',
    warningFunc: ['lookup_upload_reminder'],
    doc: 'results-inputlookup',
    verified: 'human',
  },
  // join with inputlookup subsearch (no leading pipe)
  {
    spl: '* | join host [inputlookup servers.csv]',
    warningFunc: ['join_subsearch_warning', 'lookup_upload_reminder'],
    unsupportedFunc: ['join_needs_fields'],
    doc: 'results-inputlookup',
    verified: 'human',
  },
  {
    spl: '| inputlookup users.csv where role="admin"',
    nrql: "FROM lookup(users.csv) SELECT * WHERE role = 'admin'",
    warningFunc: ['inputlookup_where_warning', 'lookup_upload_reminder'],
    doc: 'results-inputlookup',
    verified: 'human',
  },
  //
  // ── rex command ─────────────────────────────────────────────────
  //
  {
    spl: '* | rex field=message "(?<ip>\\d+\\.\\d+\\.\\d+\\.\\d+)"',
    nrql: "FROM Log WITH capture(message, r'.*(?P<ip>\\d+\\.\\d+\\.\\d+\\.\\d+).*') AS (ip) SELECT *",
    doc: 'fields-rex',
    verified: 'human',
  },
  {
    spl: '* | rex "user=(?<username>\\w+)"',
    nrql: "FROM Log WITH capture(message, r'.*user=(?P<username>\\w+).*') AS (username) SELECT *",
    doc: 'fields-rex',
    verified: 'human',
  },
  // multi-capture rex: single capture() with tuple destructuring
  {
    spl: '* | rex field=_raw "From: <(?<from>.*)> To: <(?<to>.*)>"',
    nrql: "FROM Log WITH capture(message, r'.*From: <(?P<from>.*)> To: <(?P<to>.*)>.*') AS (from, to) SELECT *",
    doc: 'fields-rex',
    verified: 'human',
  },
  {
    spl: '* | rex field=message "\\d+"',
    unsupportedFunc: ['rex_no_groups'],
    doc: 'fields-rex',
    verified: 'human',
  },
  // Python-style (?P<name>) named groups
  {
    spl: '* | rex field=_raw ".*dlq\\/(?P<dlq_key>\\d+),"',
    nrql: "FROM Log WITH capture(message, r'.*dlq\\/(?P<dlq_key>\\d+),.*') AS (dlq_key) SELECT *",
    doc: 'fields-rex',
    verified: 'human',
  },
  // max_match=0 parsed but unsupported — capture() returns first match only
  {
    spl: '* | rex field=message "(?<skus>\\d{6,})" max_match=0',
    unsupportedFunc: ['rex_max_match'],
    doc: 'fields-rex',
    verified: 'human',
  },
  // Default field (no field= → uses message) + piped to stats
  {
    spl: '* | rex "status=(?<code>\\d+)" | stats count by code',
    nrql: "FROM Log WITH capture(message, r'.*status=(?P<code>\\d+).*') AS (code) SELECT count(*) FACET code",
    doc: 'fields-rex',
    verified: 'human',
  },
  //
  // ── rex sed mode ────────────────────────────────────────────────
  //
  {
    spl: '* | rex mode=sed field=message "s/old/new/g"',
    unsupportedFunc: ['rex_sed_unsupported'],
    doc: 'fields-rex-sed',
    verified: 'human',
  },
  //
  // ── rex PCRE mode ───────────────────────────────────────────────
  //
  {
    spl: '* | rex field=message "(?<=prefix)(?<val>\\w+)"',
    unsupportedFunc: ['rex_lookaround'],
    doc: 'fields-rex-pcre',
    verified: 'human',
  },
  //
  // ── spath command ───────────────────────────────────────────────
  //
  //
  //
  // Full form: input + path + output
  {
    spl: '* | spath input=payload path=user.name output=username',
    nrql: "FROM Log WITH jparse(payload, 'user.name') AS username SELECT *",
    warningFunc: ['spath_json_only'],
    doc: 'fields-spath',
    verified: 'human',
  },
  // Path only (no input/output): defaults input=message, output=leaf
  {
    spl: '* | spath path=response.status',
    nrql: "FROM Log WITH jparse(message, 'response.status') AS status SELECT *",
    warningFunc: ['spath_json_only'],
    doc: 'fields-spath',
    verified: 'human',
  },
  // _raw input maps to message; quoted path; deep nesting
  {
    spl: '* | spath input=_raw path=data.id output=id',
    nrql: "FROM Log WITH jparse(message, 'data.id') AS id SELECT *",
    warningFunc: ['spath_json_only'],
    doc: 'fields-spath',
    verified: 'human',
  },
  // Auto-extraction (no path) — unsupported
  {
    spl: '* | spath',
    unsupportedFunc: ['spath_no_path'],
    doc: 'fields-spath',
    verified: 'human',
  },
  // Spath piped to stats
  {
    spl: '* | spath path=response.code output=code | stats count by code',
    nrql: "FROM Log WITH jparse(message, 'response.code') AS code SELECT count(*) FACET code",
    warningFunc: ['spath_json_only', 'facet_default_limit'],
    doc: 'fields-spath',
    verified: 'human',
  },
  // Auto-extraction with input — unsupported
  {
    spl: '* | spath input=payload',
    unsupportedFunc: ['spath_no_path'],
    doc: 'fields-spath',
    verified: 'human',
  },
  {
    spl: '* | spath path=user.name output=name | spath path=user.email output=email',
    nrql: "FROM Log WITH jparse(message, 'user.name') AS name, jparse(message, 'user.email') AS email SELECT *",
    warningFunc: ['spath_json_only'],
    doc: 'fields-spath',
    verified: 'human',
  },
  {
    spl: '* | spath path=request.url output=url | rex field=url "(?<domain>[^/]+)"',
    nrql: "FROM Log WITH jparse(message, 'request.url') AS url, capture(url, r'.*(?P<domain>[^/]+).*') AS (domain) SELECT *",
    warningFunc: ['spath_json_only'],
    doc: 'fields-spath',
    verified: 'human',
  },
  // Positional argument (quoted) — shorthand for path="AppID"
  {
    spl: '* | spath "AppID"',
    nrql: "FROM Log WITH jparse(message, 'AppID') AS AppID SELECT *",
    warningFunc: ['spath_json_only'],
    doc: 'fields-spath',
    verified: 'human',
  },
  // Positional argument (bare) — shorthand for path=source_name
  {
    spl: '* | spath source_name',
    nrql: "FROM Log WITH jparse(message, 'source_name') AS source_name SELECT *",
    warningFunc: ['spath_json_only'],
    doc: 'fields-spath',
    verified: 'human',
  },
  // spath with array path + downstream search
  {
    spl: '* | spath path=errors{}.code output=error_code | search error_code=404',
    nrql: "FROM Log WITH jparse(message, 'errors[*].code') AS error_code SELECT * WHERE error_code = '404' OR numeric(error_code) = 404",
    warningFunc: ['spath_json_only'],
    doc: 'fields-spath',
    verified: 'human',
  },
  // spath with array path, no output= — derives name from last path segment
  {
    spl: '* | spath path=items{}.status',
    nrql: "FROM Log WITH jparse(message, 'items[*].status') AS status SELECT *",
    warningFunc: ['spath_json_only'],
    doc: 'fields-spath',
    verified: 'human',
  },
  // spath with input= on a custom field + array path
  {
    spl: '* | spath input=request_body path=user.preferences{}.key output=pref_key',
    nrql: "FROM Log WITH jparse(request_body, 'user.preferences[*].key') AS pref_key SELECT *",
    warningFunc: ['spath_json_only'],
    doc: 'fields-spath',
    verified: 'human',
  },
  // rex extracting from embedded JSON string
  {
    spl: '* | rex field=message "\\"orderId\\":\\"(?<orderId>[A-Z0-9-]+)\\""',
    nrql: 'FROM Log WITH capture(message, r\'.*\\"orderId\\":\\"(?P<orderId>[A-Z0-9-]+)\\".*\') AS (orderId) SELECT *',
    doc: 'fields-rex',
    verified: 'human',
  },
  // eval json_extract → jparse (strips $. prefix)
  {
    spl: '* | eval user_id = json_extract(payload, "$.user.id")',
    nrql: "FROM Log WITH jparse(payload, 'user.id') AS user_id SELECT *",
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
    nrql: "FROM Log SELECT host OR 'N/A', status OR 'N/A', *",
    doc: 'fields-fillnull',
    verified: 'human',
  },
  {
    spl: '* | fillnull value=0 bytes duration',
    nrql: 'FROM Log SELECT bytes OR 0, duration OR 0, *',
    doc: 'fields-fillnull',
    verified: 'human',
  },
  {
    spl: '* | fillnull bytes',
    nrql: "FROM Log SELECT bytes OR '0', *",
    doc: 'fields-fillnull',
    verified: 'human',
  },
  {
    spl: '* | fillnull value=0',
    unsupportedFunc: ['fillnull_no_fields'],
    doc: 'fields-fillnull',
    verified: 'human',
  },
  {
    spl: '* | fillnull value="unknown" host',
    nrql: "FROM Log SELECT host OR 'unknown', *",
    doc: 'fields-fillnull',
    verified: 'human',
  },
  {
    spl: '* | fillnull value=0 bytes | stats sum(bytes) by host',
    nrql: 'FROM Log SELECT sum(bytes OR 0) FACET host',
    doc: 'fields-fillnull',
    verified: 'human',
  },
  {
    spl: '* | fillnull value=0 field1, field2, field3',
    nrql: 'FROM Log SELECT field1 OR 0, field2 OR 0, field3 OR 0, *',
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
    nrql: "FROM Log SELECT src_ip AS 'source_address', *",
    warningFunc: ['rename_keeps_original'],
    doc: 'fields-rename',
    verified: 'human',
  },
  {
    // rename-after-stats: fold rename into stats alias
    spl: '* | stats avg(bytes) as avg_bytes by host | rename avg_bytes AS average_bytes',
    nrql: "FROM Log SELECT average(bytes) AS 'average_bytes' FACET host",
    doc: 'fields-rename',
    verified: 'human',
  },
  {
    spl: '* | rename _time AS "Time"',
    nrql: "FROM Log SELECT timestamp AS 'Time', *",
    warningFunc: ['rename_keeps_original'],
    doc: 'fields-rename',
    verified: 'human',
  },
  {
    spl: '* | rename properties.* as *',
    unsupportedFunc: ['rename_wildcard'],
    doc: 'fields-rename',
    verified: 'human',
  },
  {
    spl: '* | rename src_ip as src user_name as user',
    nrql: "FROM Log SELECT src_ip AS 'src', user_name AS 'user', *",
    warningFunc: ['rename_keeps_original'],
    doc: 'fields-rename',
    verified: 'human',
  },
  {
    spl: '* | rename "IsOutlier(count)" as isOutlier',
    unsupportedFunc: ['rename_parens'],
    doc: 'fields-rename',
    verified: 'human',
  },
  //
  // ── strcat command ──────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | strcat host ":" port address',
    nrql: "FROM Log WITH concat(host, ':', port) AS address SELECT *",
    doc: 'fields-strcat',
    verified: 'human',
  },
  {
    spl: '* | strcat first_name last_name full_name',
    nrql: 'FROM Log WITH concat(first_name, last_name) AS full_name SELECT *',
    doc: 'fields-strcat',
    verified: 'human',
  },
  {
    spl: '* | strcat protocol "://" host ":" port url',
    nrql: "FROM Log WITH concat(protocol, '://', host, ':', port) AS url SELECT *",
    doc: 'fields-strcat',
    verified: 'human',
  },
  {
    spl: '* | strcat host ":" port address | stats count by address',
    nrql: "FROM Log WITH concat(host, ':', port) AS address SELECT count(*) FACET address",
    doc: 'fields-strcat',
    verified: 'human',
  },
  //
  // ── rare command ────────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | rare status',
    nrql: 'FROM Log SELECT count(*) FACET status ORDER BY count ASC LIMIT 10',
    doc: 'reports-rare',
    verified: 'human',
  },
  {
    spl: '* | rare 5 uri_path',
    nrql: 'FROM Log SELECT count(*) FACET uri_path ORDER BY count ASC LIMIT 5',
    doc: 'reports-rare',
    verified: 'human',
  },
  {
    spl: '* | rare status by host',
    nrql: 'FROM Log SELECT count(*) FACET status, host ORDER BY count ASC LIMIT 10',
    doc: 'reports-rare',
    verified: 'human',
  },
  {
    spl: 'status>=400 | rare 20 uri_path',
    nrql: 'FROM Log SELECT count(*) WHERE numeric(status) >= 400 FACET uri_path ORDER BY count ASC LIMIT 20',
    doc: 'reports-rare',
    verified: 'human',
  },
  {
    spl: '* | rare app limit=20',
    nrql: 'FROM Log SELECT count(*) FACET app ORDER BY count ASC LIMIT 20',
    doc: 'reports-rare',
    verified: 'human',
  },
  {
    spl: '* | rare limit=20 "details.error"',
    nrql: 'FROM Log SELECT count(*) FACET `details.error` ORDER BY count ASC LIMIT 20',
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
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' FACET status",
    doc: 'reports-stats',
    verified: 'human',
  },
  {
    spl: '* | stats avg(response_time) as avg_response_time by host',
    nrql: "FROM Log SELECT average(response_time) AS 'avg_response_time' FACET host",
    doc: 'reports-stats',
    verified: 'human',
  },
  {
    spl: 'index=web | stats count, dc(clientip) AS unique_clients BY status',
    nrql: "FROM Log SELECT count(*), uniqueCount(clientip) AS 'unique_clients' WHERE index = 'web' FACET status",
    doc: 'reports-stats',
    verified: 'human',
  },
  {
    spl: '* | stats count min(_time) as firstTime max(_time) as lastTime BY user dest',
    nrql: "FROM Log SELECT count(*), min(timestamp) AS 'firstTime', max(timestamp) AS 'lastTime' FACET user, dest",
    doc: 'reports-stats',
    verified: 'human',
  },
  {
    spl: '* | stats count(status) by host',
    nrql: 'FROM Log SELECT count(status) FACET host',
    doc: 'reports-stats',
    verified: 'human',
  },
  {
    spl: '* | stats count as "totalFailure"',
    nrql: "FROM Log SELECT count(*) AS 'totalFailure'",
    doc: 'reports-stats',
    verified: 'human',
  },
  {
    spl: "* | stats count as 'my count'",
    nrql: "FROM Log SELECT count(*) AS 'my count'",
    doc: 'reports-stats',
    verified: 'human',
  },
  {
    spl: '* | stats count(eval(status>=400)) as errors',
    nrql: "FROM Log SELECT filter(count(*), WHERE numeric(status) >= 400) AS 'errors'",
    doc: 'reports-stats',
    verified: 'human',
  },
  {
    spl: '* | stats count(eval(EventCode=4648)) as attempts, count(eval(EventCode=4624)) as successes',
    nrql: "FROM Log SELECT filter(count(*), WHERE EventCode = '4648' OR numeric(EventCode) = 4648) AS 'attempts', filter(count(*), WHERE EventCode = '4624' OR numeric(EventCode) = 4624) AS 'successes'",
    doc: 'reports-stats',
    verified: 'human',
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
    nrql: 'FROM Log SELECT uniqueCount(clientip), average(bytes), sum(bytes), median(latency), average(latency), uniqueCount(user), uniques(status), percentile(latency, 95), percentile(latency, 99), stddev(latency) FACET host',
    doc: 'stats-functions',
    verified: 'human',
  },
  // min+max (multi-return)
  {
    spl: '* | stats min(duration), max(duration) by host',
    nrql: 'FROM Log SELECT min(duration), max(duration) FACET host',
    doc: 'stats-functions',
    verified: 'human',
  },
  // stdevp — approximate mapping with warning
  {
    spl: '* | stats stdevp(latency) by host',
    nrql: 'FROM Log SELECT stddev(latency) FACET host',
    warningFunc: ['stdevp_precision', 'facet_default_limit'],
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats earliest(timestamp), latest(timestamp) by host',
    nrql: 'FROM Log SELECT earliest(timestamp), latest(timestamp) FACET host',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats first(status) by host',
    nrql: 'FROM Log SELECT latest(status) FACET host',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats last(status) by host',
    nrql: 'FROM Log SELECT earliest(status) FACET host',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats rate(bytes) by host',
    nrql: 'FROM Log SELECT rate(sum(bytes), 1 second) FACET host',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats list(user) by host',
    nrql: 'FROM Log SELECT uniques(user) FACET host',
    warningFunc: ['list_order_warning', 'facet_default_limit'],
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats xyzfunc(field) by host',
    warningFunc: ['unknown_stats_func', 'facet_default_limit'],
    nrql: 'FROM Log SELECT * FACET host',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats estdc(clientip) as approx_unique by host',
    nrql: "FROM Log SELECT uniqueCount(clientip) AS 'approx_unique' FACET host",
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats exactperc95(latency) as exact_p95 by service',
    nrql: "FROM Log SELECT percentile(latency, 95) AS 'exact_p95' FACET service",
    warningFunc: ['perc_precision', 'facet_default_limit'],
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats upperperc99(response_time) by endpoint',
    nrql: 'FROM Log SELECT percentile(response_time, 99) FACET endpoint',
    warningFunc: ['perc_precision', 'facet_default_limit'],
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats per_second(bytes) as bps by host',
    nrql: "FROM Log SELECT rate(sum(bytes), 1 second) AS 'bps' FACET host",
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats per_minute(requests) as rpm by service',
    nrql: "FROM Log SELECT rate(sum(requests), 1 minute) AS 'rpm' FACET service",
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats per_hour(errors) as errors_per_hour by host',
    nrql: "FROM Log SELECT rate(sum(errors), 1 hour) AS 'errors_per_hour' FACET host",
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats per_day(signups) as daily_signups',
    nrql: "FROM Log SELECT rate(sum(signups), 1 day) AS 'daily_signups'",
    doc: 'stats-functions',
    verified: 'human',
  },
  // Arithmetic in function arguments — all 5 operators, parens, dots, chaining
  {
    spl: '* | stats max(a / 1000) as div, min(b * 8) as mul, sum(c + d) as add, avg(e - f) as sub, count(g % 3) as mod, max((h + i) * j) as parens, avg(response.time / 1000) as dotfield, sum(a + b + c) as chained by host',
    nrql: "FROM Log SELECT max(numeric(a) / 1000) AS 'div', min(numeric(b) * 8) AS 'mul', sum(numeric(c) + numeric(d)) AS 'add', average(numeric(e) - numeric(f)) AS 'sub', count(mod(numeric(g), 3)) AS 'mod', max((numeric(h) + numeric(i)) * numeric(j)) AS 'parens', average(numeric(`response.time`) / 1000) AS 'dotfield', sum(numeric(a) + numeric(b) + numeric(c)) AS 'chained' FACET host",
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | timechart span=1h avg(bytes * 8 / 1024)',
    nrql: 'FROM Log SELECT average(numeric(bytes) * 8 / 1024) TIMESERIES 1 hour',
    doc: 'stats-functions',
    verified: 'human',
  },
  {
    spl: '* | stats perc95(duration / 1000) as p95_sec',
    nrql: "FROM Log SELECT percentile(numeric(duration) / 1000, 95) AS 'p95_sec'",
    doc: 'stats-functions',
    verified: 'human',
  },
  //
  // ── stats functions (no equiv) ──────────────────────────────────
  //
  // Stats no-equiv — representative cases: statistical, time-based, and rate
  {
    spl: '* | stats mode(status) by host',
    warningFunc: ['no_equiv_func', 'facet_default_limit'],
    nrql: 'FROM Log SELECT * FACET host',
    doc: 'stats-no-equiv',
    verified: 'human',
  },
  {
    spl: '* | stats earliest_time(message) as first_seen by host',
    warningFunc: ['no_equiv_func', 'facet_default_limit'],
    nrql: 'FROM Log SELECT * FACET host',
    doc: 'stats-no-equiv',
    verified: 'human',
  },
  {
    spl: '* | stats rate_avg(cpu) by host',
    warningFunc: ['no_equiv_func', 'facet_default_limit'],
    nrql: 'FROM Log SELECT * FACET host',
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
    nrql: 'FROM Log SELECT count(*) TIMESERIES AUTO',
    doc: 'reports-timechart',
    verified: 'human',
  },
  {
    spl: 'sourcetype=access_* | timechart span=1h count by status',
    nrql: "FROM Log SELECT count(*) WHERE sourcetype LIKE 'access_%' FACET status TIMESERIES 1 hour",
    doc: 'reports-timechart',
    verified: 'human',
  },
  {
    spl: '* | timechart span=5m count BY host',
    nrql: 'FROM Log SELECT count(*) FACET host TIMESERIES 5 minutes',
    doc: 'reports-timechart',
    verified: 'human',
  },
  {
    spl: '* | timechart span=1d sum(price) by productName',
    nrql: 'FROM Log SELECT sum(price) FACET productName TIMESERIES 1 day',
    doc: 'reports-timechart',
    verified: 'human',
  },
  {
    spl: '* | timechart count span=5m',
    nrql: 'FROM Log SELECT count(*) TIMESERIES 5 minutes',
    doc: 'reports-timechart',
    verified: 'human',
  },
  {
    spl: '* | timechart count(POS) span=5m as "TPOS"',
    nrql: "FROM Log SELECT count(POS) AS 'TPOS' TIMESERIES 5 minutes",
    doc: 'reports-timechart',
    verified: 'human',
  },
  {
    spl: '* | timechart c span=1m',
    nrql: 'FROM Log SELECT count(*) TIMESERIES 1 minute',
    doc: 'reports-timechart',
    verified: 'human',
  },
  //
  // ── predict command ─────────────────────────────────────────────
  //
  {
    spl: '* | timechart span=30m count | predict count as predict_count',
    nrql: 'FROM Log SELECT count(*) TIMESERIES 30 minutes PREDICT',
    doc: 'reports-timechart',
    verified: 'human',
  },
  {
    spl: '* | stats count | predict count',
    nrql: 'FROM Log SELECT count(*) TIMESERIES AUTO PREDICT',
    warningFunc: ['predict_needs_timeseries'],
    doc: 'reports-timechart',
    verified: 'human',
  },
  // timechart then stats — _time FACET absorbed by TIMESERIES (found by model-based fuzz)
  // FIXME: inner subquery needs LIMIT MAX; outer count(*) is trivially 1 per bucket
  //   because timechart produces one row per time bucket. Semantics are wrong.
  {
    spl: '* | timechart span=1m count | stats count by _time',
    nrql: 'FROM (FROM Log SELECT count(*)) SELECT count(*) TIMESERIES 1 minute',
    doc: 'reports-timechart',
    verified: false,
  },
  // timechart then stats with non-_time aggregation
  // FIXME: same issue — inner subquery needs LIMIT MAX; chained stats-over-timechart
  //   semantics need rethinking
  {
    spl: '* | timechart span=5m count | stats sum(count)',
    nrql: 'FROM (FROM Log SELECT count(*)) SELECT sum(count) TIMESERIES 5 minutes',
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
    nrql: 'FROM Log SELECT count(*) FACET status',
    doc: 'reports-chart',
    verified: 'human',
  },
  //
  // ── top command ─────────────────────────────────────────────────
  //
  //
  {
    spl: '* | top categoryId',
    nrql: "FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET categoryId ORDER BY count DESC LIMIT 10",
    doc: 'reports-top',
    verified: 'human',
  },
  {
    spl: '* | top 20 host',
    nrql: "FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET host ORDER BY count DESC LIMIT 20",
    doc: 'reports-top',
    verified: 'human',
  },
  // limit=N keyword form
  {
    spl: '* | top limit=20 host',
    nrql: "FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET host ORDER BY count DESC LIMIT 20",
    doc: 'reports-top',
    verified: 'human',
  },
  // limit=0 means unlimited → LIMIT MAX
  {
    spl: '* | top limit=0 status',
    nrql: "FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET status ORDER BY count DESC LIMIT MAX",
    doc: 'reports-top',
    verified: 'human',
  },
  // countfield option renames the count column
  {
    spl: '* | top limit=5 countfield=total host',
    nrql: "FROM Log SELECT count(*) AS 'total', count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET host ORDER BY count DESC LIMIT 5",
    doc: 'reports-top',
    verified: 'human',
  },
  // showperc=false suppresses percent select
  {
    spl: '* | top 10 showperc=false host',
    nrql: 'FROM Log SELECT count(*) FACET host ORDER BY count DESC LIMIT 10',
    doc: 'reports-top',
    verified: 'human',
  },
  // useother=true warns about no NRQL equivalent
  {
    spl: '* | top 5 useother=true status',
    nrql: "FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET status ORDER BY count DESC LIMIT 5",
    warningFunc: ['top_useother'],
    doc: 'reports-top',
    verified: 'human',
  },
  // percentfield option renames the percent column
  {
    spl: '* | top 5 percentfield=pct host',
    nrql: "FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'pct' FACET host ORDER BY count DESC LIMIT 5",
    doc: 'reports-top',
    verified: 'human',
  },
  // limit=N after field name
  {
    spl: '* | top delay limit=10',
    nrql: "FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET delay ORDER BY count DESC LIMIT 10",
    doc: 'reports-top',
    verified: 'human',
  },
  // percent subquery includes WHERE from search
  {
    spl: 'error | top 5 status',
    nrql: "FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*) WHERE message LIKE '%error%') AS 'percent' WHERE message LIKE '%error%' FACET status ORDER BY count DESC LIMIT 5",
    doc: 'reports-top',
    verified: 'human',
  },
  //
  // ── top with groupby ────────────────────────────────────────────
  //
  {
    spl: '* | top 5 status by host',
    nrql: "FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*)) AS 'percent' FACET status, host ORDER BY count DESC LIMIT 5",
    warningFunc: ['top_groupby_warning'],
    doc: 'reports-top-groupby',
    verified: 'human',
  },
  //
  // ── Multiple aggregation ────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | stats count by host | stats avg(count)',
    nrql: 'FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT average(count)',
    doc: 'reports-chained-agg-no-outer-facet',
    verified: 'human',
  },
  {
    spl: 'index=web | stats count as cnt by host | stats max(cnt)',
    nrql: "FROM (FROM Log SELECT count(*) AS 'cnt' WHERE index = 'web' FACET host LIMIT MAX) SELECT max(cnt)",
    doc: 'reports-chained-agg-aliased',
    verified: 'human',
  },
  //
  // ── bin / bucket command ────────────────────────────────────────
  //
  {
    spl: '* | bin _time span=5m',
    nrql: 'FROM Log SELECT count(*) TIMESERIES 5 minutes',
    doc: 'reports-bin',
    verified: 'human',
  },
  {
    spl: '* | bucket _time span=5m',
    nrql: 'FROM Log SELECT count(*) TIMESERIES 5 minutes',
    doc: 'reports-bin',
    verified: 'human',
  },
  {
    spl: '* | bucket span=5m _time | stats count by _time',
    nrql: 'FROM Log SELECT count(*) TIMESERIES 5 minutes',
    doc: 'reports-bin',
    verified: 'human',
  },
  {
    spl: '* | bin size span=10',
    nrql: 'FROM Log SELECT histogram(size, 10)',
    doc: 'reports-bin',
    verified: 'human',
  },
  //
  // ── where (pipe) ────────────────────────────────────────────────
  //
  //
  //
  {
    spl: 'index=web | stats count BY status | where count > 100',
    nrql: "FROM (FROM Log SELECT count(*) WHERE index = 'web' FACET status LIMIT MAX) SELECT * WHERE numeric(count) > 100",
    doc: 'results-where',
    verified: 'human',
  },
  {
    spl: 'status=500 | where bytes > 1024',
    nrql: "FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND numeric(bytes) > 1024",
    doc: 'results-where',
    verified: 'human',
  },
  //
  //
  {
    spl: '* | where isnull(status)',
    nrql: 'FROM Log SELECT * WHERE status IS NULL',
    doc: 'results-where',
    verified: 'human',
  },
  {
    spl: '* | where isnotnull(status)',
    nrql: 'FROM Log SELECT * WHERE status IS NOT NULL',
    doc: 'results-where',
    verified: 'human',
  },
  {
    spl: '* | where host = "web01"',
    nrql: "FROM Log SELECT * WHERE host = 'web01'",
    doc: 'results-where',
    verified: 'human',
  },
  {
    spl: '* | where count > 100',
    nrql: 'FROM Log SELECT * WHERE numeric(count) > 100',
    doc: 'results-where',
    verified: 'human',
  },
  {
    spl: '* | where like(host, "web*")',
    nrql: "FROM Log SELECT * WHERE host LIKE 'web%'",
    doc: 'results-where',
    verified: 'human',
  },
  // where with infix like operator
  {
    spl: '* | where name like "%test%"',
    nrql: "FROM Log SELECT * WHERE name LIKE '%test%'",
    doc: 'results-where',
    verified: 'human',
  },
  // where like() as function call — migration guide pattern
  {
    spl: '* | where like(message, "%error%")',
    nrql: "FROM Log SELECT * WHERE message LIKE '%error%'",
    doc: 'results-where',
    verified: false,
  },
  // where NOT like() — NOT wrapping of function-call form
  {
    spl: '* | where NOT like(message, "%debug%")',
    nrql: "FROM Log SELECT * WHERE message NOT LIKE '%debug%'",
    doc: 'results-where',
    verified: false,
  },
  // where like(...) AND field=value — both conditions must appear in WHERE
  {
    spl: '* | where like(message, "%timeout%") AND status=500',
    nrql: "FROM Log SELECT * WHERE message LIKE '%timeout%' AND status = '500' OR numeric(status) = 500",
    doc: 'results-where',
    verified: false,
  },
  // where NOT like() with compound — NOT wrapping + AND
  {
    spl: '* | where NOT like(message, "%debug%") AND status=200',
    nrql: "FROM Log SELECT * WHERE message NOT LIKE '%debug%' AND status = '200' OR numeric(status) = 200",
    doc: 'results-where',
    verified: false,
  },
  {
    spl: '* | where match(host, "^web[0-9]+$")',
    nrql: "FROM Log SELECT * WHERE host RLIKE r'^web[0-9]+$'",
    doc: 'results-where',
    verified: 'human',
  },
  {
    spl: '* | where cidrmatch("10.0.0.0/8", src_ip)',
    nrql: "FROM Log SELECT * WHERE cidrAddress(src_ip, 8) = '10.0.0.0/8'",
    doc: 'results-where',
    verified: 'human',
  },
  {
    spl: '* | where status >= 400 AND status < 500',
    nrql: 'FROM Log SELECT * WHERE numeric(status) >= 400 AND numeric(status) < 500',
    doc: 'results-where',
    verified: 'human',
  },
  {
    spl: '* | where NOT status = 200',
    nrql: "FROM Log SELECT * WHERE NOT (status = '200' OR numeric(status) = 200)",
    doc: 'results-where',
    verified: 'human',
  },
  //
  // ── where on aggregation ────────────────────────────────────────
  //
  {
    spl: '* | stats count by host | where NOT count = 0',
    nrql: "FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT * WHERE NOT (count = '0' OR numeric(count) = 0)",
    doc: 'results-where-on-agg',
    verified: 'human',
  },
  {
    spl: '* | stats count by host | where count > 100 AND count < 1000',
    nrql: 'FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT * WHERE numeric(count) > 100 AND numeric(count) < 1000',
    doc: 'results-where-on-agg',
    verified: 'human',
  },
  // where-after-stats with no FACET (no LIMIT MAX in inner query)
  {
    spl: '* | stats count | where count > 0',
    nrql: 'FROM (FROM Log SELECT count(*)) SELECT * WHERE numeric(count) > 0',
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
    nrql: "FROM Log JOIN (FROM Log SELECT count(*) WHERE index = 'other' FACET host LIMIT MAX) ON host = host SELECT *",
    warningFunc: [
      'join_subsearch_warning',
      'join_cardinality_limit',
      'facet_default_limit',
    ],
    doc: 'correlation-join',
    verified: 'human',
  },
  {
    spl: '* | join type=left src_ip [search index=geo | table src_ip, country]',
    nrql: "FROM Log LEFT JOIN (FROM Log SELECT src_ip, country WHERE index = 'geo' LIMIT MAX) ON src_ip = src_ip SELECT *",
    doc: 'correlation-join',
    verified: 'human',
  },
  {
    spl: '* | join type=outer host [search * | stats count by host]',
    unsupportedFunc: ['join_outer_unsupported'],
    doc: 'correlation-join',
    verified: 'human',
  },
  {
    spl: '* | join host [search status=500 | table host, message]',
    nrql: "FROM Log JOIN (FROM Log SELECT host, message WHERE status = '500' OR numeric(status) = 500 LIMIT MAX) ON host = host SELECT *",
    warningFunc: ['join_cardinality_limit'],
    doc: 'correlation-join',
    verified: 'human',
  },
  {
    spl: '* | join src_ip [search * | stats count, avg(bytes) by src_ip]',
    nrql: 'FROM Log JOIN (FROM Log SELECT count(*), average(bytes) FACET src_ip LIMIT MAX) ON src_ip = src_ip SELECT *',
    warningFunc: [
      'join_subsearch_warning',
      'join_cardinality_limit',
      'facet_default_limit',
    ],
    doc: 'correlation-join',
    verified: 'human',
  },
  {
    spl: '* | join host [search * | stats count by host | head 100]',
    nrql: 'FROM Log JOIN (FROM Log SELECT count(*) FACET host LIMIT 100) ON host = host SELECT *',
    warningFunc: ['join_cardinality_limit'],
    doc: 'correlation-join',
    verified: 'human',
  },
  {
    spl: '* | join host [search status=200 host=web*]',
    unsupportedFunc: ['join_needs_fields'],
    doc: 'correlation-join',
    verified: 'human',
  },
  {
    spl: 'status=500 | join host [search * | stats count by host]',
    nrql: "FROM Log JOIN (FROM Log SELECT count(*) FACET host LIMIT MAX) ON host = host SELECT * WHERE status = '500' OR numeric(status) = 500",
    warningFunc: [
      'join_subsearch_warning',
      'join_cardinality_limit',
      'facet_default_limit',
    ],
    doc: 'correlation-join',
    verified: 'human',
  },
  {
    spl: '* | stats count by host | join host [search * | stats avg(cpu) by host]',
    nrql: 'FROM Log JOIN (FROM Log SELECT average(cpu) FACET host LIMIT MAX) ON host = host SELECT count(*) FACET host',
    warningFunc: [
      'join_subsearch_warning',
      'join_cardinality_limit',
      'facet_default_limit',
    ],
    doc: 'correlation-join',
    verified: 'human',
  },
  {
    spl: '* | join user [search * | table user, role]',
    nrql: 'FROM Log JOIN (FROM Log SELECT user, role LIMIT MAX) ON user = user SELECT *',
    warningFunc: ['join_cardinality_limit'],
    doc: 'correlation-join',
    verified: 'human',
  },
  //
  // ── dedup command ───────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | dedup host',
    nrql: 'FROM Log SELECT latest(timestamp) FACET host LIMIT MAX',
    warningFunc: ['dedup_facet_warning'],
    doc: 'results-dedup',
    verified: 'human',
  },
  {
    spl: '* | dedup host, status',
    nrql: 'FROM Log SELECT latest(timestamp) FACET host, status LIMIT MAX',
    warningFunc: ['dedup_facet_warning'],
    doc: 'results-dedup',
    verified: 'human',
  },
  {
    spl: '* | stats count by host | dedup host',
    nrql: 'FROM Log SELECT count(*) FACET host LIMIT MAX',
    warningFunc: ['dedup_facet_warning'],
    doc: 'results-dedup',
    verified: 'human',
  },
  //
  // ── regex command ───────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | regex message="error\\\\d+"',
    nrql: "FROM Log SELECT * WHERE message RLIKE r'error\\\\d+'",
    doc: 'results-regex',
    verified: 'human',
  },
  {
    spl: '* | regex status!="^2\\\\d{2}$"',
    nrql: "FROM Log SELECT * WHERE status NOT RLIKE r'^2\\\\d{2}$'",
    doc: 'results-regex',
    verified: 'human',
  },
  {
    spl: '* | regex "fatal|critical"',
    nrql: "FROM Log SELECT * WHERE message RLIKE r'fatal|critical'",
    doc: 'results-regex',
    verified: 'human',
  },
  {
    spl: 'status=500 | regex message="timeout"',
    nrql: "FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND message RLIKE r'timeout'",
    doc: 'results-regex',
    verified: 'human',
  },
  {
    spl: '* | regex uri_path="^/api/v[0-9]+"',
    nrql: "FROM Log SELECT * WHERE uri_path RLIKE r'^/api/v[0-9]+'",
    doc: 'results-regex',
    verified: 'human',
  },
  //
  // ── table / fields ──────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | table _time, host, status, bytes, url',
    nrql: 'FROM Log SELECT timestamp, host, status, bytes, url',
    doc: 'results-table',
    verified: 'human',
  },
  {
    spl: '* | table *',
    nrql: 'FROM Log SELECT *',
    doc: 'results-table',
    verified: 'human',
  },
  //
  //
  {
    spl: '* | fields host, status',
    nrql: 'FROM Log SELECT host, status',
    doc: 'results-table',
    verified: 'human',
  },
  {
    spl: '* | fields _time, host, status',
    nrql: 'FROM Log SELECT timestamp, host, status',
    doc: 'results-table',
    verified: 'human',
  },
  // fields + prefix (explicit include)
  {
    spl: '* | fields + host, status',
    nrql: 'FROM Log SELECT host, status',
    doc: 'results-table',
    verified: 'human',
  },
  //
  // ── fields - exclude ────────────────────────────────────────────
  //
  {
    spl: '* | fields - _raw, _time',
    nrql: 'FROM Log SELECT *',
    warningFunc: ['fields_exclude_limited'],
    doc: 'results-table',
    verified: 'human',
  },
  //
  // ── search (pipe) ───────────────────────────────────────────────
  //
  //
  //
  {
    spl: 'index=web | stats count by status | search status=200',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' AND status = '200' OR numeric(status) = 200 FACET status",
    doc: 'results-search',
    verified: 'human',
  },
  {
    spl: 'status=500 | search error',
    nrql: "FROM Log SELECT * WHERE status = '500' OR numeric(status) = 500 AND message LIKE '%error%'",
    doc: 'results-search',
    verified: 'human',
  },
  {
    spl: '* | search status=200 OR status=301',
    nrql: "FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 OR status = '301' OR numeric(status) = 301",
    doc: 'results-search',
    verified: 'human',
  },
  {
    spl: '| search host=web01',
    nrql: "FROM Log SELECT * WHERE host = 'web01'",
    doc: 'results-search',
    verified: 'human',
  },
  //
  // ── sort command ────────────────────────────────────────────────
  //
  //
  //
  {
    spl: '* | sort - count',
    nrql: 'FROM Log SELECT * ORDER BY count DESC',
    doc: 'results-sort',
    verified: 'human',
  },
  {
    spl: '* | sort + name',
    nrql: 'FROM Log SELECT * ORDER BY name ASC',
    doc: 'results-sort',
    verified: 'human',
  },
  {
    spl: '* | sort name',
    nrql: 'FROM Log SELECT * ORDER BY name ASC',
    doc: 'results-sort',
    verified: 'human',
  },
  {
    spl: '* | sort 0 host',
    nrql: 'FROM Log SELECT * ORDER BY host ASC',
    doc: 'results-sort',
    verified: 'human',
  },
  {
    spl: '* | sort count desc',
    nrql: 'FROM Log SELECT * ORDER BY count DESC',
    doc: 'results-sort',
    verified: 'human',
  },
  {
    spl: '* | sort 0 - firstTime',
    nrql: 'FROM Log SELECT * ORDER BY firstTime DESC',
    doc: 'results-sort',
    verified: 'human',
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
    spl: '* | reverse',
    nrql: 'FROM Log SELECT * ORDER BY timestamp ASC',
    doc: 'results-reverse',
    verified: 'human',
  },
  {
    spl: 'error | table message | reverse',
    nrql: "FROM Log SELECT message WHERE message LIKE '%error%' ORDER BY timestamp ASC",
    doc: 'results-reverse',
    verified: 'human',
  },
  // reverse after aggregation — ORDER BY timestamp ASC is wrong here;
  // reverse should flip the current row order, not sort by time.
  // FIXME: handler should detect post-aggregation context and warn or use FACET order.
  {
    spl: '* | stats count by host | reverse',
    nrql: 'FROM Log SELECT count(*) FACET host ORDER BY timestamp ASC',
    warningFunc: ['reverse_after_agg', 'facet_default_limit'],
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
    unsupportedFunc: ['unsupported_command'],
    doc: 'correlation-transaction',
    verified: 'human',
  },
  // eventstats with BY → subquery JOIN
  {
    spl: '* | eventstats count by host',
    nrql: "FROM Log JOIN (FROM Log SELECT count(*) AS 'count' FACET host LIMIT MAX) ON host = host SELECT *",
    warningFunc: ['join_cardinality_limit'],
    doc: 'reports-eventstats',
    verified: 'human',
  },
  // eventstats with alias and BY
  {
    spl: '* | eventstats avg(duration) AS avg_dur BY host',
    nrql: "FROM Log JOIN (FROM Log SELECT average(duration) AS 'avg_dur' FACET host LIMIT MAX) ON host = host SELECT *",
    warningFunc: ['join_cardinality_limit'],
    doc: 'reports-eventstats',
    verified: 'human',
  },
  // eventstats with multiple BY fields — unsupported (NRQL JOIN only supports single ON key)
  {
    spl: '* | eventstats sum(bytes) AS total BY host, status',
    unsupportedFunc: ['eventstats_multi_by'],
    doc: 'reports-eventstats',
    verified: 'human',
  },
  // eventstats without BY → scalar subquery in SELECT
  {
    spl: '* | eventstats count AS total',
    nrql: "FROM Log SELECT *, (FROM Log SELECT count(*)) AS 'total'",
    doc: 'reports-eventstats',
    verified: 'human',
  },
  // real-world pattern: stats then eventstats (chained aggregation, no BY)
  // FIXME: doubly-nested subquery needs validation — verify the inner/middle/outer nesting is correct
  // NOTE: this is the #1 eventstats pattern (~47% of real usage) per the
  //   splunk-to-nr migration guide (docs/references/splunk-to-nr-migration-guide.md)
  {
    spl: '* | stats count as appCount by app | eventstats sum(appCount) as namespaceCount',
    nrql: "FROM Log SELECT count(*) AS 'appCount', (FROM (FROM Log SELECT count(*) AS 'appCount' FACET app LIMIT MAX) SELECT sum(appCount)) AS 'namespaceCount' FACET app",
    doc: 'reports-eventstats',
    verified: false,
  },
  // real-world pattern: max(_time) for latest record
  {
    spl: '* | eventstats max(timestamp) as lastImport BY source',
    nrql: "FROM Log JOIN (FROM Log SELECT max(timestamp) AS 'lastImport' FACET source LIMIT MAX) ON source = source SELECT *",
    warningFunc: ['join_cardinality_limit'],
    doc: 'reports-eventstats',
    verified: 'human',
  },
  // multiple aggregations in one eventstats call
  {
    spl: '* | eventstats avg(duration) AS avg_dur, max(duration) AS max_dur BY host',
    nrql: "FROM Log JOIN (FROM Log SELECT average(duration) AS 'avg_dur', max(duration) AS 'max_dur' FACET host LIMIT MAX) ON host = host SELECT *",
    warningFunc: ['join_cardinality_limit'],
    doc: 'reports-eventstats',
    verified: 'human',
  },
  {
    spl: '* | streamstats count by host',
    unsupportedFunc: ['streamstats_unsupported'],
    doc: 'reports-streamstats',
    verified: 'human',
  },
  //
  // ── mvexpand patterns ─────────────────────────────────────────
  //
  // Pattern 1: expand-then-filter (most common ~40%)
  {
    spl: '* | spath path=cloudformation{}.stack_prefix output=stack_prefix | mvexpand stack_prefix | search stack_prefix="fff000-gitlabrole"',
    warningFunc: ['spath_json_only'],
    unsupportedFunc: ['mvexpand_unsupported'],
    doc: 'unsupported-mvexpand',
    verified: false,
  },
  // mvexpand with function-call field name (stats list() creates literal field name)
  {
    spl: '* | mvexpand list(orderNumber)',
    unsupportedFunc: ['mvexpand_unsupported'],
    doc: 'unsupported-mvexpand',
    verified: false,
  },
  // Pattern 2: dedup round-trip (~30%)
  {
    spl: '* | stats values(title) as title | mvexpand title',
    unsupportedFunc: ['mvexpand_unsupported'],
    doc: 'unsupported-mvexpand',
    verified: false,
  },
  // Pattern 3: expand + aggregate by expanded field
  {
    spl: '* | eval perms=split(permissions, ",") | mvexpand perms | stats count by perms',
    warningFunc: ['facet_default_limit'],
    unsupportedFunc: ['mvexpand_unsupported'],
    doc: 'unsupported-mvexpand',
    verified: false,
  },
  // Pattern 4: symmetric counting
  {
    spl: '* | eval notable_asset=mvappend(notable_src, notable_dest) | mvexpand notable_asset | stats count by notable_asset',
    warningFunc: ['facet_default_limit'],
    unsupportedFunc: ['mvexpand_unsupported'],
    doc: 'unsupported-mvexpand',
    verified: false,
  },
  // Pattern 5: expand + sort only (no aggregation by field)
  {
    spl: 'index=k8s_main bopus orderType=BOPUS storeNumber=* orderNumber=* | stats list(orderNumber) AS orderNumber BY orderStatus storeNumber | mvexpand orderNumber | sort -orderNumber',
    warningFunc: ['list_order_warning', 'facet_default_limit'],
    unsupportedFunc: ['mvexpand_unsupported'],
    doc: 'unsupported-mvexpand',
    verified: false,
  },
  {
    spl: '* | mvcombine delim="," values',
    unsupportedFunc: ['unsupported_command'],
    doc: 'fields-mvcombine',
    verified: 'human',
  },
  {
    spl: 'index=main | stats count as total_requests | appendcols [search index=main level=error | stats count as errors]',
    nrql: "FROM Log SELECT filter(count(*), WHERE index = 'main') AS 'total_requests', filter(count(*), WHERE index = 'main' AND level = 'error') AS 'errors'",
    warningFunc: ['append_filter_warning'],
    doc: 'correlation-appendcols',
    verified: 'human',
  },
  {
    // appendcols with different FACET on subsearch — can't merge
    spl: '* | stats count as total | appendcols [search * | stats count by host]',
    warningFunc: ['append_subsearch_warning', 'facet_default_limit'],
    unsupportedFunc: ['append_facet_mismatch'],
    doc: 'correlation-appendcols',
    verified: 'human',
  },
  {
    spl: '* | stats count as search_count | appendpipe [stats count | where count=0]',
    nrql: "FROM Log SELECT count(*) AS 'search_count'",
    warningFunc: ['appendpipe_row_append'],
    doc: 'correlation-appendpipe',
    verified: 'human',
  },
  {
    spl: '* | foreach count_* [eval total=total+<<FIELD>>]',
    unsupportedFunc: ['unsupported_command'],
    doc: 'fields-foreach',
    verified: 'human',
  },
  {
    spl: '* | predict count',
    nrql: 'FROM Log SELECT count(*) TIMESERIES AUTO PREDICT',
    warningFunc: ['predict_needs_timeseries'],
    doc: 'prediction-predict',
    verified: 'human',
  },
  {
    spl: '* | extract pairdelim=","',
    unsupportedFunc: ['kvparse_unsupported'],
    doc: 'fields-extract',
    verified: 'human',
  },
  {
    spl: '* | xmlkv',
    unsupportedFunc: ['unsupported_command'],
    doc: 'fields-xmlkv',
    verified: 'human',
  },
  {
    spl: '* | timechart count | timewrap 1d',
    unsupportedFunc: ['unsupported_command'],
    doc: 'reports-timewrap',
    verified: 'human',
  },
  {
    // '1234567' → 1234567
    spl: '* | convert num(bytes)',
    nrql: 'FROM Log WITH numeric(bytes) AS bytes_converted SELECT *',
    warningFunc: ['convert_alias_warning'],
    doc: 'fields-convert',
    verified: 'human',
  },
  {
    // '1,234,567' → 1234567
    spl: '* | convert rmcomma(total)',
    nrql: "FROM Log WITH numeric(replace(total, ',', '')) AS total_converted SELECT *",
    warningFunc: ['convert_alias_warning'],
    doc: 'fields-convert',
    verified: 'human',
  },
  {
    // 1741916927007 → '2026-03-13T23:48:47.007Z'
    spl: '* | convert ctime(timestamp) AS readable',
    nrql: 'FROM Log WITH toDatetime(timestamp) AS readable SELECT *',
    doc: 'fields-convert',
    verified: 'human',
  },
  {
    // '2026-03-13T23:48:47.007Z' → 1741916927007
    spl: '* | convert mktime(timestr)',
    nrql: 'FROM Log WITH toTimestamp(timestr) AS timestr_converted SELECT *',
    warningFunc: ['convert_alias_warning'],
    doc: 'fields-convert',
    verified: 'human',
  },
  {
    spl: '* | convert dur2sec(duration)',
    unsupportedFunc: ['convert_dur2sec_unsupported'],
    doc: 'fields-convert',
    verified: false,
  },
  {
    spl: '* | convert mstime(elapsed)',
    unsupportedFunc: ['convert_mstime_unsupported'],
    doc: 'fields-convert',
    verified: false,
  },
  {
    // num: '200' → 200, rmcomma: '1,000' → 1000
    // FIXME: should have 'cannot overwrite a field in-place' warning
    spl: '* | convert num(status), rmcomma(total)',
    nrql: "FROM Log WITH numeric(status) AS status_converted, numeric(replace(total, ',', '')) AS total_converted SELECT *",
    doc: 'fields-convert',
    verified: false,
  },
  {
    spl: '* | convert auto(field)',
    unsupportedFunc: ['convert_auto_unsupported'],
    doc: 'fields-convert',
    verified: false,
  },
  {
    // '512MB' — can't strip arbitrary units in NRQL
    spl: '* | convert rmunit(field)',
    unsupportedFunc: ['convert_func_unsupported'],
    doc: 'fields-convert',
    verified: 'human',
  },
  {
    // '512m' — memory normalization; NR data is already numeric bytes
    spl: '* | convert memk(field)',
    unsupportedFunc: ['convert_func_unsupported'],
    doc: 'fields-convert',
    verified: 'human',
  },
  // no downstream aggregation → replace inlined into SELECT

  {
    spl: '* | replace "error" WITH "warning" IN message',
    nrql: "FROM Log SELECT replace(message, 'error', 'warning'), *",
    doc: 'fields-replace',
    verified: 'human',
  },
  // downstream aggregation → replace applied in FACET
  {
    spl: '* | replace "kube:container:" WITH "" IN sourcetype | stats count by sourcetype',
    nrql: "FROM Log SELECT count(*) FACET replace(sourcetype, 'kube:container:', '')",
    doc: 'fields-replace',
    verified: 'human',
  },
  // multi-pair replace
  {
    spl: '* | replace "%%14674" WITH "Value Added", "%%14675" WITH "Value Deleted" IN OperationType',
    nrql: "FROM Log SELECT replace(replace(OperationType, '%%14674', 'Value Added'), '%%14675', 'Value Deleted'), *",
    doc: 'fields-replace',
    verified: 'human',
  },
  // replace eval: fix JSON quoting — self-referencing eval inlined into SELECT to avoid circular dependency
  {
    spl: '* | eval json_content=replace(json_content, "\'", "\\"") | spath input=json_content',
    unsupportedFunc: ['spath_no_path'],
    doc: 'eval-string',
    verified: 'human',
  },
  //
  // ── Edge cases ──────────────────────────────────────────────────
  //
  //
  //
  {
    spl: 'search error',
    nrql: "FROM Log SELECT * WHERE message LIKE '%error%'",
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: '| stats count',
    nrql: 'FROM Log SELECT count(*)',
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: '* | stats count by host | sort - count | head 5',
    nrql: 'FROM Log SELECT count(*) FACET host ORDER BY count DESC LIMIT 5',
    doc: 'edge-cases',
    verified: 'human',
  },
  //
  //
  {
    spl: 'OR status=200',
    nrql: "FROM Log SELECT * WHERE message LIKE '%OR%' AND status = '200' OR numeric(status) = 200",
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: 'NOT NOT error',
    nrql: "FROM Log SELECT * WHERE message LIKE '%error%'",
    doc: 'edge-cases',
    verified: false,
  },
  {
    spl: '-500',
    nrql: "FROM Log SELECT * WHERE message LIKE '%-500%'",
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: 'cpu_usage=95%',
    nrql: "FROM Log SELECT * WHERE cpu_usage = '95%'",
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: 'host=web,01',
    nrql: "FROM Log SELECT * WHERE host = 'web,01'",
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: 'path=C:\\',
    nrql: "FROM Log SELECT * WHERE path = 'C:\\\\'",
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: 'field=***',
    nrql: "FROM Log SELECT * WHERE field LIKE '%%%'",
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: 'host=*web*server*prod*',
    nrql: "FROM Log SELECT * WHERE host LIKE '%web%server%prod%'",
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: 'error|stats count',
    nrql: "FROM Log SELECT count(*) WHERE message LIKE '%error%'",
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: 'status=200\tstatus=300',
    nrql: "FROM Log SELECT * WHERE status = '200' OR numeric(status) = 200 AND status = '300' OR numeric(status) = 300",
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: 'index=web\n| stats count by host',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' FACET host",
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    // Grouping preserved via NRQL OR-tighter precedence — no explicit inner parens needed
    spl: '(a=1 OR (b=2 AND (c=3 OR d=4)))',
    nrql: "FROM Log SELECT * WHERE a = '1' OR numeric(a) = 1 OR (b = '2' OR numeric(b) = 2 AND c = '3' OR numeric(c) = 3 OR d = '4' OR numeric(d) = 4)",
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: 'status IN (200)',
    nrql: 'FROM Log SELECT * WHERE status IN (200)',
    doc: 'edge-cases',
    verified: 'human',
  },
  // FIXME: limit: 0 isn't a v2 assertion field — this test asserts nothing.
  // head 0 should either produce an error or LIMIT 0 / empty result.
  { spl: '* | head 0', limit: 0, doc: 'edge-cases', verified: false },
  {
    spl: '* error',
    nrql: "FROM Log SELECT * WHERE message LIKE '%error%'",
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: '* | where a>1 | where b<2',
    nrql: 'FROM Log SELECT * WHERE numeric(a) > 1 AND numeric(b) < 2',
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: '* | where (status >= 400 AND status < 500)',
    nrql: 'FROM Log SELECT * WHERE numeric(status) >= 400 AND numeric(status) < 500',
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: '* | sort -count, +name, host',
    nrql: 'FROM Log SELECT * ORDER BY count DESC',
    warningFunc: ['sort_single_field'],
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: '* | STATS COUNT BY host',
    nrql: 'FROM Log SELECT count(*) FACET host',
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: '* | Stats Count By Host',
    nrql: 'FROM Log SELECT count(*) FACET Host',
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: '* | stats count() by host',
    nrql: 'FROM Log SELECT count(*) FACET host',
    doc: 'edge-cases',
    verified: 'human',
  },
  {
    spl: '* | stats avg(response.time) by host',
    nrql: 'FROM Log SELECT average(`response.time`) FACET host',
    doc: 'edge-cases',
    verified: 'human',
  },
  // Real-world queries moved to spl-real-world.json
  //
  // ── Append command ────────────────────────────────────────────────
  //
  {
    spl: 'index=main "Cache hit" | stats count as Hits | append [search index=main "Cache miss" | stats count as Misses]',
    nrql: "FROM Log SELECT filter(count(*), WHERE index = 'main' AND message LIKE '%Cache hit%') AS 'Hits', filter(count(*), WHERE index = 'main' AND message LIKE '%Cache miss%') AS 'Misses'",
    warningFunc: ['append_filter_warning'],
    doc: 'correlation-append',
    verified: 'human',
  },
  // Same WHERE, different aggregations → merge SELECTs directly
  {
    spl: '* | stats avg(duration) | append [search * | stats max(duration)]',
    nrql: 'FROM Log SELECT average(duration), max(duration)',
    warningFunc: ['append_merged'],
    doc: 'correlation-append',
    verified: 'human',
  },
  // append with no aggregations on either side — raw event append = UNION, not supported
  {
    spl: 'index=web | append [search index=api]',
    unsupportedFunc: ['append_no_agg'],
    doc: 'correlation-append',
    verified: 'human',
  },
  // append with different FACET — can't merge because groupings differ
  {
    spl: '* | stats count as total | append [search * | stats avg(duration) by host]',
    warningFunc: ['append_subsearch_warning', 'facet_default_limit'],
    unsupportedFunc: ['append_facet_mismatch'],
    doc: 'correlation-append',
    verified: 'human',
  },
  // append with matching FACET — merge into filter() with shared FACET
  {
    spl: 'error | stats count by host | append [search success | stats count by host]',
    nrql: "FROM Log SELECT filter(count(*), WHERE message LIKE '%error%'), filter(count(*), WHERE message LIKE '%success%') FACET host",
    warningFunc: [
      'append_subsearch_warning',
      'append_filter_warning',
      'facet_default_limit',
    ],
    doc: 'correlation-append',
    verified: 'human',
  },
  // append with matching FACET and same WHERE — merge SELECT lists
  {
    spl: '* | stats count by host | append [search * | stats avg(duration) by host]',
    nrql: 'FROM Log SELECT count(*), average(duration) FACET host',
    warningFunc: [
      'append_subsearch_warning',
      'append_merged',
      'facet_default_limit',
    ],
    doc: 'correlation-append',
    verified: 'human',
  },
  // append with different WHERE and non-count aggregations — filter() wraps any aggregation
  {
    spl: 'error | stats avg(duration) as err_dur | append [search success | stats avg(duration) as ok_dur]',
    nrql: "FROM Log SELECT filter(average(duration), WHERE message LIKE '%error%') AS 'err_dur', filter(average(duration), WHERE message LIKE '%success%') AS 'ok_dur'",
    warningFunc: ['append_filter_warning'],
    doc: 'correlation-append',
    verified: 'human',
  },
  // append without aliases — filter() works without aliases too
  {
    spl: 'error | stats avg(duration) | append [search success | stats max(duration)]',
    nrql: "FROM Log SELECT filter(average(duration), WHERE message LIKE '%error%'), filter(max(duration), WHERE message LIKE '%success%')",
    warningFunc: ['append_filter_warning'],
    doc: 'correlation-append',
    verified: 'human',
  },
  //
  // ── Append edge cases (TODO: verify these produce correct results) ──
  //
  // Different indexes on each side — filter() WHERE clauses must reflect different sources
  {
    skip: true,
    spl: 'index=web | stats count as web_count | append [search index=api | stats count as api_count]',
    nrql: "FROM Log SELECT filter(count(*), WHERE index = 'web') AS 'web_count', filter(count(*), WHERE index = 'api') AS 'api_count'",
    warningFunc: ['append_filter_warning'],
    doc: 'correlation-append',
    verified: false,
  },
  // Pre-stats WHERE filtering — outer has where before stats, subsearch doesn't
  {
    skip: true,
    spl: '* | where status=500 | stats avg(duration) as err_dur | append [search * | stats avg(duration) as all_dur]',
    nrql: "FROM Log SELECT filter(average(duration), WHERE numeric(status) = 500) AS 'err_dur', filter(average(duration), WHERE 1=1) AS 'all_dur'",
    warningFunc: ['append_filter_warning'],
    doc: 'correlation-append',
    verified: false,
  },

  //
  // ── NRQL Feature Gaps (customer migration feedback) ───────────────
  //

  // Gap #2 — dedup + stats: warn about 5K LIMIT MAX sampling
  {
    spl: '* | dedup userId | stats count by routeName',
    nrql: 'FROM (FROM Log SELECT latest(timestamp) FACET userId LIMIT MAX) SELECT count(*) FACET routeName LIMIT MAX',
    warningFunc: ['dedup_facet_warning', 'dedup_limit_max_cap'],
    doc: 'dedup',
    verified: 'llm',
  },
  // Gap #9 — dedup + timechart: warn about TIMESERIES null buckets
  {
    spl: '* | dedup userId | timechart count span=1m',
    nrql: 'FROM (FROM Log SELECT latest(timestamp) FACET userId LIMIT MAX) SELECT count(*) LIMIT MAX TIMESERIES 1 minute',
    warningFunc: [
      'dedup_facet_warning',
      'dedup_limit_max_cap',
      'dedup_timeseries_warning',
    ],
    doc: 'timechart',
    verified: 'llm',
  },
  // Gap #7 — >5 rex commands: warn about capture() limit
  {
    spl: '* | rex field=f1 "(?<a>\\w+)" | rex field=f2 "(?<b>\\w+)" | rex field=f3 "(?<c>\\w+)" | rex field=f4 "(?<d>\\w+)" | rex field=f5 "(?<e>\\w+)" | rex field=f6 "(?<f>\\w+)"',
    nrql: "FROM Log WITH capture(f1, r'.*(?P<a>\\w+).*') AS (a), capture(f2, r'.*(?P<b>\\w+).*') AS (b), capture(f3, r'.*(?P<c>\\w+).*') AS (c), capture(f4, r'.*(?P<d>\\w+).*') AS (d), capture(f5, r'.*(?P<e>\\w+).*') AS (e), capture(f6, r'.*(?P<f>\\w+).*') AS (f) SELECT *",
    warningFunc: ['rex_capture_limit'],
    doc: 'rex',
    verified: 'llm',
  },
  // Gap #13 — split() multi-char delimiter
  {
    spl: '* | eval parts = split(field, "},{")',
    nrql: "FROM Log WITH split(field, '},{') AS parts SELECT *",
    warningFunc: ['split_multi_char_delimiter'],
    doc: 'eval',
    verified: 'llm',
  },
  // Gap #3 — cascading mvexpand
  {
    spl: '* | spath input=body path=Items{} output=items | mvexpand items | spath input=items path=Channels{} output=channels | mvexpand channels',
    warningFunc: ['spath_json_only'],
    unsupportedFunc: ['mvexpand_unsupported', 'mvexpand_cascading'],
    doc: 'mvexpand',
    verified: 'llm',
  },
  // Gap #5 — mvzip unsupported
  {
    spl: '* | eval paired = mvzip(nodes, skus)',
    unsupportedFunc: ['mvzip_unsupported'],
    doc: 'eval',
    verified: 'llm',
  },
  // Gap #22 — streamstats
  {
    spl: '* | streamstats count as row_num',
    unsupportedFunc: ['streamstats_unsupported'],
    doc: 'streamstats',
    verified: 'llm',
  },
  // Gap #10 — kvparse / extract
  {
    spl: '* | extract',
    unsupportedFunc: ['kvparse_unsupported'],
    doc: 'extract',
    verified: 'llm',
  },
  // Gap #15 — list() order not preserved
  {
    spl: '* | stats list(eventType) by orderId',
    nrql: 'FROM Log SELECT uniques(eventType) FACET orderId',
    warningFunc: ['list_order_warning', 'facet_default_limit'],
    doc: 'stats',
    verified: 'llm',
  },
  // Gap #4 — cross-expand field matching (two mvexpands on different fields)
  {
    spl: '* | spath input=_raw output=validation path=validations{} | mvexpand validation | spath input=_raw output=sku_data path=items{} | mvexpand sku_data',
    warningFunc: ['spath_json_only'],
    unsupportedFunc: ['mvexpand_unsupported', 'mvexpand_cascading'],
    doc: 'mvexpand',
    verified: 'llm',
  },
  // Gap #12 — FACET default 10 warning
  {
    spl: '* | stats count by host',
    nrql: 'FROM Log SELECT count(*) FACET host',
    warningFunc: ['facet_default_limit'],
    doc: 'stats',
    verified: 'llm',
  },
  // Gap #16 — append workaround hint
  {
    spl: '* | append [search * | table host]',
    unsupportedFunc: ['append_no_agg'],
    doc: 'correlation-append',
    verified: 'llm',
  },
  // Gap #17 — coalesce translates to OR chain (already implemented)
  {
    spl: '* | eval combined = coalesce(msg, message)',
    nrql: 'FROM Log WITH (msg OR message) AS combined SELECT *',
    doc: 'eval',
    verified: 'llm',
  },
  // Gap #18 — multi-column ORDER BY (already covered by sort_single_field)
  {
    spl: '* | sort host, -duration',
    nrql: 'FROM Log SELECT * ORDER BY host ASC',
    warningFunc: ['sort_single_field'],
    doc: 'sort',
    verified: 'llm',
  },

  //
  // ── NRQL Feature Gaps — B-tier FIXME tests (skip: true) ──────────
  //

  // Gap #3 — FIXME: cascading mvexpand workaround generation
  // When implemented, the translator should emit a nested-FROM pattern:
  //   FROM (FROM Log EXPAND jparse(Items) AS item SELECT item[Sku], item[Channels]
  //     FACET ... LIMIT MAX)
  //   EXPAND jparse(Channels) AS channel SELECT channel[Name]
  // See customer positive feedback: "Triple-nested FROM with double EXPAND"
  {
    skip: true,
    spl: '* | spath input=body path=Items{} output=items | mvexpand items | spath input=items path=Channels{} output=channels | mvexpand channels | spath input=channels path=Name output=channelName',
    nrql: 'FIXME: should emit nested FROM with EXPAND at each level',
    doc: 'mvexpand',
    verified: false,
  },
  // Gap #2 — FIXME: dedup + timechart should emit nested subquery approach
  // SPL dedup keeps first event per userId (most recent in historical search).
  // The eval before dedup tags Submit as orders=1; after dedup, only shoppers
  // whose last action was Submit retain orders=1. Then eval addtobags tags the rest.
  // Formula: (shoppers whose last action = Submit) / (last action = AddBag) × 100
  //
  // Best-effort NRQL: nested latest(routeName) FACET userId, then filter/count.
  // Limitations: LIMIT MAX caps at 5K (customer has <N> users/hr),
  // TIMESERIES on outer query produces nulls after first bucket.
  //
  // BLOCKER: `timechart eval(...)` doesn't parse — the grammar only recognizes
  // `name(eval(...))` (e.g., count(eval(if(...)))) but not bare `eval(expr)` as a
  // top-level stats_function. The customer's `timechart eval((sum(x)*100)/sum(y))`
  // uses eval as the top-level expression wrapping arithmetic over aggregation fns.
  //
  // FIX: Add an alternative to `stats_function` in spl.grammar that accepts
  // `eval(expr) as alias` as a top-level entry. The eval parser (eval_inner_expr)
  // already exists and handles nested parens — just needs to be reused:
  //   stats_function = ... / _* 'eval'i '(' _* expr:eval_inner_expr _* ')' alias:as_clause?
  //     { return { name: 'eval', args: [], alias: alias, evalFilter: expr }; }
  // The handler (aggregationHandlers.js handleTimechart) would then need to
  // recognize evalFilter on a bare eval entry and translate the arithmetic.
  {
    skip: true,
    spl: '(routeName="AddItem" OR routeName="Submit") msg="Processed Server Request.  Status: 200" | eval orders=if(routeName=="Submit",1,0) | dedup userId | eval addtobags=if(routeName=="AddItem",1,0) | timechart eval((sum(orders)*100)/sum(addtobags)) as orderCompletionRate span=1m',
    nrql: 'FIXME: needs grammar change for timechart eval(), then nested FROM (SELECT latest(routeName) AS lastRoute FACET userId LIMIT MAX) with filter/count formula + warnings',
    doc: 'dedup',
    verified: false,
  },

  // Gap #1 — FIXME: {} multivalue field syntax should use jparse + EXPAND
  // SPL `stats count by validations{}.code` auto-expands the array and groups by each
  // element's .code subfield. No explicit mvexpand needed in SPL.
  // Translator currently backtick-escapes the field name literally, producing wrong NRQL.
  // MCP-validated: val[code] works in SELECT but fails in FACET ("unexpected '['").
  // Workaround: getField(val, 'code') works in both SELECT and FACET.
  {
    skip: true,
    spl: '* | stats count by validations{}.code',
    nrql: "FROM Log SELECT count(val) EXPAND jparse(validations) AS val FACET getField(val, 'code') LIMIT MAX",
    doc: 'stats',
    verified: false,
  },

  // Gap #14 — FIXME: mvindex last-element workaround
  // SPL mvindex(result, -1) natively supports negative indexes.
  // NRQL workaround: nested if() with length check for each possible array size.
  // See customer doc for 14-level nested if() example.
  {
    skip: true,
    spl: '* | eval last = mvindex(result, -1)',
    unsupportedFunc: ['mvindex_last_element'],
    doc: 'eval',
    verified: false,
  },
];

describe('translateSplToNrql', () => {
  const spies = {};

  beforeEach(() => {
    for (const key of Object.keys(messages)) {
      spies[key] = vi.spyOn(messages, key);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  cases.forEach((c, i) => {
    const label = c.spl === null ? 'null' : c.spl || '(empty)';
    const testFn = c.skip ? it.skip : it;
    testFn(`[${i}] ${label.slice(0, 80)}`, () => {
      const r = translateSplToNrql(c.spl);

      if ('nrql' in c) expect(r.nrql).toBe(c.nrql);
      if ('errorIncludes' in c) {
        const joined = r.errors.join(' ');
        expect(joined).toContain(c.errorIncludes);
      }
      if ('warningFunc' in c || 'unsupportedFunc' in c) {
        const expectedWarnings = new Set(c.warningFunc || []);
        const expectedUnsupported = new Set(c.unsupportedFunc || []);
        const allExpected = new Set([
          ...expectedWarnings,
          ...expectedUnsupported,
        ]);
        // Every expected function must have been called
        for (const fn of allExpected) {
          expect(spies[fn]).toHaveBeenCalled();
        }
        // No unexpected functions should have been called
        for (const [key, spy] of Object.entries(spies)) {
          if (!allExpected.has(key) && spy.mock.calls.length > 0) {
            expect.fail(
              `unexpected message function '${key}' was called but not listed in warningFunc/unsupportedFunc`,
            );
          }
        }
      }
    });
  });
});

// ── Doc generation (afterAll) ────────────────────────────────────

const DOC_PATH = path.resolve(import.meta.dirname, '../../docs/SPL_TO_NRQL.md');
const SENTINEL_RE =
  /<!-- spl-cases: ([\w-]+) -->\n[\s\S]*?\n<!-- \/spl-cases -->/g;
const TABLE_SENTINEL_RE =
  /<!-- spl-table: ([\w-]+) -->\n[\s\S]*?\n<!-- \/spl-table -->/g;

afterAll(() => {
  // Group cases by doc tag
  const groups = {};
  for (const c of cases) {
    if (!c.doc) continue;
    if (!groups[c.doc]) groups[c.doc] = [];
    const r = translateSplToNrql(c.spl);
    const nrql = r.nrql || null;
    const warnings = r.warnings.length > 0 ? r.warnings : null;
    const unsupported = r.unsupported.length > 0 ? r.unsupported : null;
    groups[c.doc].push({
      spl: c.spl,
      nrql,
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

  const VERIFIED_BADGES = {
    human: '✅ Confirmed by human',
    llm: '🤖 Confirmed by LLM',
    mcp: '🔍 Confirmed by MCP',
  };

  // Backtick the leading command/function if it starts lowercase, otherwise capitalize
  function formatMessage(msg) {
    if (/^[A-Z]/.test(msg)) return msg;
    // Match leading command token: word(…) or word with possible dots/parens
    const m = msg.match(/^([a-zA-Z_][\w.]*(?:\([^)]*\))?)[:\s]/);
    if (m) {
      return `\`${m[1]}\`` + msg.slice(m[1].length);
    }
    // Fallback: capitalize first letter
    return msg.charAt(0).toUpperCase() + msg.slice(1);
  }

  function renderEntry(e) {
    const badge = VERIFIED_BADGES[e.verified] || '❓ Not confirmed';
    const codeLines = [badge, `SPL:  ${e.spl || '(empty)'}`];
    if (e.nrql) codeLines.push(`NRQL: ${e.nrql}`);
    if (e.warnings) {
      for (const w of e.warnings) codeLines.push(`🟡 ${formatMessage(w)}`);
    }
    if (e.unsupported) {
      for (const u of e.unsupported) codeLines.push(`🔴 ${formatMessage(u)}`);
    }
    return '```\n' + codeLines.join('\n') + '\n```';
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
        // Extract NRQL function from the translated output
        const nrqlRaw = e.nrql || '—';
        const selectMatch = nrqlRaw.match(
          /SELECT (.+?)(?:\s+(?:FACET|WHERE|$))/,
        );
        const nrqlExpr = selectMatch
          ? selectMatch[1].replace(/ AS '.*'$/, '')
          : '—';
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

  // Warn (don't error) about tags with no sentinel — these are in table sections
  const orphanedTags = [];
  const docTags = new Set(Object.keys(groups));
  for (const tag of docTags) {
    if (!foundTags.has(tag)) orphanedTags.push(tag);
  }
  if (orphanedTags.length > 0) {
    console.warn(
      `Doc tags with no sentinel in SPL_TO_NRQL.md (in tables): ${orphanedTags.join(', ')}`,
    );
  }

  // Generate table of contents from headings
  const TOC_RE = /<!-- toc -->\n[\s\S]*?\n<!-- \/toc -->/;
  const SKIP_TOC = new Set([
    'SPL-to-NRQL Translation Reference',
    'CLI tool',
    'Quick start',
    'Install globally (optional)',
    'Output formats',
    'Interactive REPL',
    'Options reference',
    'Usage telemetry (optional)',
    'Rebuilding the bundle',
  ]);
  // ToC shows only # level headers
  doc = doc.replace(TOC_RE, () => {
    const headings = [];
    for (const line of doc.split('\n')) {
      const m = line.match(/^# (.+)/);
      if (!m) continue;
      const text = m[1];
      if (SKIP_TOC.has(text)) continue;
      const slug = text
        .toLowerCase()
        .replace(/[`()]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      headings.push(`- [${text}](#${slug})`);
    }
    return `<!-- toc -->\n${headings.join('\n')}\n<!-- /toc -->`;
  });

  fs.writeFileSync(DOC_PATH, doc);
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
    now: { nrql: null, warning: null },
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
// spl-real-world.json is an array of { spl }.
// Each query is run through the translator to verify it doesn't crash.

const realWorldEntries = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dirname, 'spl-real-world.json'),
    'utf8',
  ),
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

      if (r.errors.length > 0) realWorldStats.parseErrors++;
      else if (r.unsupported.length > 0) realWorldStats.unsupported++;
      else if (r.warnings.length > 0) realWorldStats.warnings++;
      else realWorldStats.clean++;
    });
  });
});

afterAll(() => {
  const total = realWorldEntries.length;
  console.log(
    `\n  Real-world: ${total} queries — ${realWorldStats.parseErrors} parse errors, ` +
      `${realWorldStats.unsupported} unsupported, ${realWorldStats.warnings} warnings only, ` +
      `${realWorldStats.clean} clean\n`,
  );
});
