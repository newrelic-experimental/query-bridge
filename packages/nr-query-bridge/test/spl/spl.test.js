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
  // Template variables $var.earliest$/$var.latest$ are time tokens: drop+warn
  // (old behavior emitted invalid NRQL `SINCE {{…}}` — fixed by Path 2 handler)
  {
    spl: '* $global_time.earliest$ $global_time.latest$',
    nrql: 'FROM Log SELECT *',
    warningFunc: ['time_token_bound_dropped', 'time_token_bound_dropped'],
    doc: 'bare-keywords',
    verified: 'llm',
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
    verified: 'llm',
  },
  {
    spl: '(error OR warning) NOT debug',
    nrql: "FROM Log SELECT * WHERE message LIKE '%error%' OR message LIKE '%warning%' AND message NOT LIKE '%debug%'",
    doc: 'boolean-operators',
    verified: 'llm',
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
    verified: 'llm',
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
  // SPL preserves \n as a literal backslash-n inside double-quoted strings
  // (Splunk's only real C-escape sequences are \\ and \"/\'). NRQL needs the
  // backslash escaped to \\ so the resulting LIKE/string literal carries
  // the same two chars (\, n), not a real newline.
  {
    spl: 'msg="line1\\nline2"',
    nrql: "FROM Log SELECT * WHERE msg = 'line1\\\\nline2'",
    doc: 'quoted-strings',
    verified: 'llm',
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
    // latest= with no earliest= is unsupported: there's no safe lower bound to
    // fabricate (any fixed default inverts the window when latest is older than
    // it, which NRQL rejects). Was previously a fabricated SINCE 24 hours ago —
    // corrected after live-NRQL confirmed the inversion failure. Re-verify+promote.
    spl: 'latest=-1h',
    nrql: '',
    unsupportedFunc: ['latest_without_earliest_unsupported'],
    doc: 'time-constraints',
    verified: 'llm',
  },
  // Regression: latest= older than the old 24h default used to emit invalid
  // inverted NRQL (SINCE 24 hours ago UNTIL 2 days ago). Now unsupported.
  {
    spl: 'latest=-2d',
    nrql: '',
    unsupportedFunc: ['latest_without_earliest_unsupported'],
    doc: 'time-constraints',
    verified: 'llm',
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
  // ── Dashboard time tokens: Path 1 (TimeConstraint earliest=/latest=) ──
  {
    spl: 'index=web earliest=$tok.earliest$ latest=$tok.latest$ | stats count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped', 'time_token_bound_dropped'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  {
    spl: 'index=web latest=$tok.latest$ | stats count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  {
    spl: 'index=web earliest=$myStart$ latest=$myEnd$ | stats count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped', 'time_token_bound_dropped'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  // The genuinely common dashboard form: a global time picker injects prefix-less
  // $earliest$/$latest$ as the earliest=/latest= RHS (a TimeConstraint → Path 1).
  {
    spl: 'index=web earliest=$earliest$ latest=$latest$ | stats count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped', 'time_token_bound_dropped'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  // ── Dashboard time tokens: Path 2 (standalone TemplateVariable) ──
  // FIXME(path-2-semantics): These three standalone-body token cases drop the
  // token AS A TIME BOUND, but that's semantically wrong. Two independent SPL
  // experts + three OSS SPL parsers (airbus ANTLR, kotlaluk Lark-from-btool-BNF,
  // salspaugh PLY) agree: a bare $x.earliest$ in the SEARCH BODY (not an
  // earliest=/latest= RHS) is an ordinary _raw term/value substitution — time
  // semantics come from POSITION, never the token name. The "correct" value-sub
  // output (WHERE ... AND {{tok.earliest}}) does NOT compile standalone (MCP:
  // "undefined template variable"), whereas the current drop output DOES compile.
  // This form is also ~nonexistent in the corpus (every real .earliest token is
  // an earliest= RHS = Path 1, which is correct). Left as-is and NOT promoted to
  // 'llm' pending the dashboard-importer work, which will give this real context.
  {
    spl: 'index=web $tok.earliest$ | stats count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  {
    spl: 'index=web $earliest$ | stats count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  {
    spl: 'index=web $latest$ | stats count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  // ── Dashboard time tokens: mixed literal + token → unsupported ──
  {
    spl: 'index=web earliest=-24h latest=$tok.latest$ | stats count',
    nrql: '',
    warningFunc: ['time_token_bound_dropped'],
    unsupportedFunc: ['mixed_token_literal_time_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  {
    spl: 'index=web earliest=$tok.earliest$ latest=-2h | stats count',
    nrql: '',
    warningFunc: ['time_token_bound_dropped'],
    unsupportedFunc: ['mixed_token_literal_time_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  // Cross-path mix: a Path-2 standalone token ($tok.latest$) alongside a Path-1
  // literal (earliest=-24h) must ALSO escalate — proves the TemplateVariable
  // branch sets the same sawTimeToken flag the escalation reads.
  {
    spl: 'index=web $tok.latest$ earliest=-24h | stats count',
    nrql: '',
    warningFunc: ['time_token_bound_dropped'],
    unsupportedFunc: ['mixed_token_literal_time_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  // Regression: literal-only window is untouched (no token, no escalation).
  {
    spl: 'index=web earliest=-24h latest=-1h | stats count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' SINCE 24 hours ago UNTIL 1 hour ago",
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  // A NON-time template variable in value position becomes an unquoted {{token}}
  // (a dashboard variable filled at render time), never a quoted literal.
  {
    spl: 'index=web status=$sev$ | stats count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' AND status = {{sev}}",
    doc: 'dashboard-time-tokens',
    verified: false,
  },
  // Boundary: name CONTAINS "earliest" but is neither `earliest` nor `.earliest`
  // suffix — must NOT be treated as a time token (it emits {{earliestSeen}} as a
  // value-position token, not dropped as a time bound).
  {
    spl: 'index=web earliestSeen=$earliestSeen$ | stats count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' AND earliestSeen = {{earliestSeen}}",
    doc: 'dashboard-time-tokens',
    verified: false,
  },
  // index= with a value-position token → {{token}}, unquoted.
  {
    spl: 'index=$idx$ | stats count',
    nrql: 'FROM Log SELECT count(*) WHERE index = {{idx}}',
    doc: 'dashboard-time-tokens',
    verified: false,
  },
  // Double-quoted standalone token → {{token}}, same as unquoted. Quoting is a
  // Splunk idiom for values that may contain spaces; a quoted literal '$env$'
  // would match nothing.
  {
    spl: 'index="$env$" | stats count',
    nrql: 'FROM Log SELECT count(*) WHERE index = {{env}}',
    doc: 'dashboard-time-tokens',
    verified: false,
  },
  // Wildcard-ONLY token (`*$tok$*`, `$tok$*`, `*$tok$`) → `field LIKE {{tok}}`. New Relic
  // substitutes the variable in value position, so the % wildcards must live in the
  // variable's VALUE; the warning says so. Verified accepted by dashboardCreate + NRQL
  // execution (staging acct 1, 2026-06-22). All three forms collapse to `LIKE {{tok}}`.
  {
    spl: 'index="*$env$*" | stats count',
    nrql: 'FROM Log SELECT count(*) WHERE index LIKE {{env}}',
    warningFunc: ['wildcard_token_like'],
    doc: 'dashboard-time-tokens',
    verified: false,
  },
  {
    spl: 'index="$env$*" | stats count',
    nrql: 'FROM Log SELECT count(*) WHERE index LIKE {{env}}',
    warningFunc: ['wildcard_token_like'],
    doc: 'dashboard-time-tokens',
    verified: false,
  },
  {
    spl: 'index="*$env$" | stats count',
    nrql: 'FROM Log SELECT count(*) WHERE index LIKE {{env}}',
    warningFunc: ['wildcard_token_like'],
    doc: 'dashboard-time-tokens',
    verified: false,
  },
  // Literal text affixed to a token (`*fps-$tok$*`, `$tok$-suffix`) → unsupported. New Relic
  // can't interpolate {{tok}} inside a string literal, and emitting the literal $tok$ would
  // silently never substitute — loud failure over silent-wrong. No nrql is pinned: the
  // condition is dropped and an unsupported message fires (the importer placeholders it).
  {
    spl: 'index="*fps-$env$*" | stats count',
    unsupportedFunc: ['affixed_token_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: false,
  },
  {
    spl: 'index="$env$-suffix" | stats count',
    unsupportedFunc: ['affixed_token_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: false,
  },
  // Boundary: standalone non-time $…$ search term falls through to identifier path,
  // NOT dropped, NOT span-unsupported (it's not in a span= position).
  {
    spl: 'index=web $timespan$ | stats count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' AND {{timespan}}",
    doc: 'dashboard-time-tokens',
    verified: 'llm',
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
  // ── EvalArith: arithmetic inside function args (Task 4) ──
  // This eval references `total`, which `stats count` never produces (not an
  // aggregate, not a facet key) — unresolvable post-aggregation. Loud unsupported
  // rather than NRQL where `total` silently resolves to null.
  {
    spl: '* | stats count | eval x = round(total/count, 2)',
    nrql: '',
    unsupportedFunc: ['compound_collapse_unsupported'],
    doc: 'eval-conditional',
    verified: false,
  },
  {
    spl: '* | stats count by host | eval pct = count * 100',
    nrql: "FROM Log SELECT count(*) * 100 AS 'pct' FACET host LIMIT MAX",
    warningFunc: ['eval_after_agg_drops_source'],
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  // eval ARITHMETIC over a median/percentile after stats folds FLAT into the stats
  // step: `median(latency) * 2` in a flat SELECT is valid NRQL (staging-verified, acct
  // 10671289). No subquery, no getField — the eval-projection folds, dropping the raw
  // aggregate alias (drops-source warning). Task 5 narrowed the nonscalar guard to LISTS,
  // re-opening this faithful flat fold for the keyed-object aggregates.
  {
    spl: '* | stats median(latency) as p50 by host | eval x = p50 * 2',
    nrql: "FROM Log SELECT median(latency) * 2 AS 'x' FACET host LIMIT MAX",
    warningFunc: ['eval_after_agg_drops_source'],
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  {
    spl: '* | stats median(duration) as med by service | eval x = med * 2',
    nrql: "FROM Log SELECT median(duration) * 2 AS 'x' FACET service LIMIT MAX",
    warningFunc: ['eval_after_agg_drops_source'],
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  {
    spl: '* | stats p95(duration) as p95 by service | eval x = p95 * 2',
    nrql: "FROM Log SELECT percentile(duration, 95) * 2 AS 'x' FACET service LIMIT MAX",
    warningFunc: ['eval_after_agg_drops_source'],
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  // median/percentile referenced across the SUBQUERY boundary (where / trailing-agg) is
  // a keyed object ({50: v} / {N: v}); a bare numeric()/aggregate over it resolves to
  // null (silent-wrong). Task 5 extracts the scalar with getField(col, '<N>'). For a
  // WHERE reference, bind once via `WITH getField(col,'N') AS <col>N` and reference the
  // bound name in SELECT + WHERE (staging-verified, acct 10671289). median → key '50'.
  {
    spl: '* | stats median(duration) as md by host | where md>10',
    nrql: "FROM (FROM Log SELECT median(duration) AS 'md' FACET host LIMIT MAX) WITH getField(md, '50') AS md50 SELECT md50 WHERE md50 > 10",
    doc: 'compound-eval-where',
    verified: false,
  },
  // Trailing re-aggregation over a median column: getField is inlined into the outer
  // aggregate's argument (used once, no WITH needed).
  {
    spl: '* | stats median(duration) as md by host | stats avg(md)',
    nrql: "FROM (FROM Log SELECT median(duration) AS 'md' FACET host LIMIT MAX) SELECT average(getField(md, '50'))",
    doc: 'compound-eval-stats',
    verified: false,
  },
  // percentile(x, N) → key String(N). p95 → '95'.
  {
    spl: '* | stats p95(duration) as p95 by host | where p95>10',
    nrql: "FROM (FROM Log SELECT percentile(duration, 95) AS 'p95' FACET host LIMIT MAX) WITH getField(p95, '95') AS p9595 SELECT p9595 WHERE p9595 > 10",
    doc: 'compound-eval-where',
    verified: false,
  },
  {
    spl: '* | stats p95(duration) as p95 by host | stats avg(p95)',
    nrql: "FROM (FROM Log SELECT percentile(duration, 95) AS 'p95' FACET host LIMIT MAX) SELECT average(getField(p95, '95'))",
    doc: 'compound-eval-stats',
    verified: false,
  },
  // Silent-wrong guard for the narrowing: an eval-PROJECTION over a median that does NOT
  // fold flat (concat is not a distributed/fold-safe function) would otherwise leave a
  // bare `concat(md, …)` referencing the keyed-object column across the boundary, which
  // resolves to null. The post-pass non-scalar guard catches it → loud unsupported. This
  // is the path the guard-narrowing re-opened; it must NOT emit silent-wrong NRQL.
  {
    spl: '* | stats median(duration) as md by host | eval x = md . "ms"',
    nrql: '',
    unsupportedFunc: ['eval_after_agg_nonscalar'],
    doc: 'compound-eval-where',
    verified: false,
  },
  // uniques/values (a LIST) has no scalar-extraction equivalent across the boundary, so
  // a where/trailing-agg reference STAYS loud unsupported (eval_after_agg_nonscalar). The
  // Task 5 narrowing keeps lists unsupported while opening keyed objects.
  {
    spl: '* | stats values(status) as s by host | where s>5',
    nrql: '',
    unsupportedFunc: ['eval_after_agg_nonscalar'],
    doc: 'compound-eval-where',
    verified: false,
  },
  {
    spl: '* | stats values(status) as s by host | stats avg(s)',
    nrql: '',
    unsupportedFunc: ['eval_after_agg_nonscalar'],
    doc: 'compound-eval-stats',
    verified: false,
  },
  // The getField extraction touches ONLY the keyed-object column; a scalar sibling
  // (avg → `a`) in the same WHERE keeps its ordinary numeric() coercion. Proves the
  // rewrite does not over-fire onto scalar references.
  {
    spl: '* | stats median(duration) as md, avg(duration) as a by host | where md>10 AND a>5',
    nrql: "FROM (FROM Log SELECT median(duration) AS 'md', average(duration) AS 'a' FACET host LIMIT MAX) WITH getField(md, '50') AS md50 SELECT md50 WHERE md50 > 10 AND numeric(a) > 5",
    doc: 'compound-eval-where',
    verified: false,
  },
  // Known limitation (loud, never silent-wrong): two stacked WHERE layers over a
  // median column do not merge once the inner layer is getField-rewritten (it becomes
  // a row-wise layer that can't re-nest), so the chain stays loud unsupported rather
  // than emitting a bare numeric(md) that would resolve to null. Single-WHERE median
  // (above) is the supported form.
  {
    spl: '* | stats median(duration) as md by host | where md>10 | where md<100',
    nrql: '',
    unsupportedFunc: ['compound_collapse_unsupported'],
    doc: 'compound-eval-where',
    verified: false,
  },
  // Silent-wrong guard — bound-name collision: the synthesized getField bound name
  // `md50` would collide with the REAL `md50` (avg) column and silently shadow it (the
  // user's md50 filter would read the median). The collision-free picker renames the
  // synthesized binding to `md50_2`; the user's own `md50` keeps its numeric() filter.
  {
    spl: '* | stats median(duration) as md, avg(duration) as md50 by host | where md>10 AND md50>5',
    nrql: "FROM (FROM Log SELECT median(duration) AS 'md', average(duration) AS 'md50' FACET host LIMIT MAX) WITH getField(md, '50') AS md50_2 SELECT md50_2 WHERE md50_2 > 10 AND numeric(md50) > 5",
    doc: 'compound-eval-where',
    verified: false,
  },
  // Silent-wrong guard — exposed-name collision on the extraction path: two inner
  // aggregates expose the same column `m`; NRQL keeps the FIRST (median, key 50) but our
  // map would key getField off the LAST (percentile 95) → wrong/missing key → null. No
  // faithful translation, so the trailing-agg path bails loud (collision guard).
  {
    spl: '* | stats p50(duration) as m, p95(duration) as m by host | stats avg(m)',
    nrql: '',
    unsupportedFunc: ['subquery_name_collision'],
    doc: 'compound-eval-stats',
    verified: false,
  },
  // Silent-wrong guard — ORDER BY over a keyed-object column: no extraction branch
  // rewrites orderBy, so a bare `ORDER BY md DESC` over a median ({50:v}) would sort on
  // the raw object (and SELECT * returns it). The post-pass guard walks orderBy → loud.
  {
    spl: '* | stats median(duration) as md by host | where host!="x" | sort -md',
    nrql: '',
    unsupportedFunc: ['eval_after_agg_nonscalar'],
    doc: 'compound-eval-where',
    verified: false,
  },
  // Silent-wrong guard — FACET over a keyed-object column: a trailing `by md` regroups on
  // a median keyed object; NRQL groups on bogus "0"/"1" buckets (staging-confirmed). The
  // facet key IS exposed (so the Task-4 regroup guard does not fire), but the post-pass
  // guard walks facet for non-scalar references → loud unsupported.
  {
    spl: '* | stats median(duration) as md by host | stats count by md',
    nrql: '',
    warningFunc: ['facet_default_limit'],
    unsupportedFunc: ['eval_after_agg_nonscalar'],
    doc: 'compound-eval-stats',
    verified: false,
  },
  // eval after stats where two inner aggregates resolve to the same exposed column
  // name (count(*) and `sum(...) as count`): NRQL would silently keep only one, so
  // a faithful translation is impossible → loud unsupported (collision guard).
  {
    spl: '* | stats count, sum(throughput) as count by host | eval x = count * 2',
    nrql: '',
    unsupportedFunc: ['subquery_name_collision'],
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  // concat fold-blocker fallback: a non-foldable eval (concat, canFoldEval false) over a
  // plain scalar aggregate does NOT fold flat — it stays as a row-wise SELECT layer over
  // the aggregating inner, i.e. a single legal subquery (count is now an exposed scalar
  // column, so concat references it fine; no non-scalar guard, no string() wrap — NRQL
  // concat auto-coerces numerics). The facet key host is re-projected.
  {
    spl: '* | stats count by host | eval label="n=".count',
    nrql: "FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT host, concat('n=', count) AS 'label'",
    doc: 'compound-eval-eval',
    verified: false,
  },
  // Facet-key fold-blocker: an eval that references a facet key (a `by` event field)
  // must NOT fold flat even when its functions are fold-safe — a flat aggregating SELECT
  // over an event field is invalid NRQL ("FACET cannot be used when selecting on event
  // fields"). The facet-key reference is a fold-BLOCKER exactly like concat; the layer
  // stays a row-wise SELECT over the aggregating inner (region is now an exposed column
  // the outer if() references fine). Re-projects the facet key region.
  {
    spl: '* | stats count by region | eval ru = if(region="us","domestic","intl")',
    nrql: "FROM (FROM Log SELECT count(*) FACET region LIMIT MAX) SELECT region, if(region = 'us', 'domestic', 'intl') AS 'ru'",
    doc: 'compound-eval-eval',
    verified: false,
  },
  // Facet-key fold-blocker — aggregate × facet-key arithmetic (`count * len(host)`). The
  // flat form `count(*) * length(host) FACET host` is rejected (aggregate × event field);
  // keep the subquery so count is an exposed scalar and host an exposed event column.
  // (`numeric(count)` because `*` is arithmetic; count is the exposed scalar column.)
  {
    spl: '* | stats count by host | eval scaled = count * len(host)',
    nrql: "FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT host, numeric(count) * length(host) AS 'scaled'",
    warningFunc: ['eval_length_warning'],
    doc: 'compound-eval-eval',
    verified: false,
  },
  // Facet-key fold-blocker — fold-safe fn (if) over a facet key only, no aggregate ref.
  // Still blocks the flat fold; the facet key host is re-projected and referenced by if().
  {
    spl: '* | stats count by host | eval x = if(host = "a", 1, 0)',
    nrql: "FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT host, if(host = 'a', 1, 0) AS 'x'",
    doc: 'compound-eval-eval',
    verified: false,
  },
  // Facet-key fold-blocker — bare facet-key projection (`eval x = host`). A flat
  // `SELECT host AS x FACET host` selects on an event field → invalid. Keep the subquery.
  {
    spl: '* | stats count by host | eval x = host',
    nrql: "FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT host, host AS 'x'",
    doc: 'compound-eval-eval',
    verified: false,
  },
  // Compound transform after an eval/where that itself followed an aggregation.
  // Task 2: eval-led post-aggregation chains no longer emit compound_rewrap_unsupported.
  // eval|eval folds flat and is ADDITIVE — both a and b survive (Splunk's eval keeps
  // prior columns); only the raw count aggregate is dropped (+ drops-source warning).
  {
    spl: '* | stats count by host | eval a=count/60 | eval b=a/60',
    nrql: "FROM Log SELECT count(*) / 60 AS 'a', count(*) / 60 / 60 AS 'b' FACET host LIMIT MAX",
    warningFunc: ['eval_after_agg_drops_source'],
    doc: 'compound-eval-eval',
    verified: false,
  },
  // eval|where: fold collapses the eval into the inner; outer SELECT is empty → SELECT *;
  // WHERE uses numeric() coercion because > is an ordering operator.
  {
    spl: '* | stats count by host | eval rpm=count/60 | where rpm>10',
    nrql: "FROM (FROM Log SELECT count(*) / 60 AS 'rpm' FACET host LIMIT MAX) SELECT * WHERE numeric(rpm) > 10",
    warningFunc: ['eval_after_agg_drops_source'],
    doc: 'compound-eval-where',
    verified: false,
  },
  // eval|stats: fold collapses the eval into the inner, outer re-aggregates.
  {
    spl: '* | stats count by host | eval rpm=count/60 | stats avg(rpm)',
    nrql: "FROM (FROM Log SELECT count(*) / 60 AS 'rpm' FACET host LIMIT MAX) SELECT average(rpm)",
    warningFunc: ['eval_after_agg_drops_source'],
    doc: 'compound-eval-stats',
    verified: false,
  },
  // fold pass: eval-projection folds into its aggregating subquery (Task 1)
  {
    spl: '* | stats count by host | eval rps = count/3600',
    nrql: "FROM Log SELECT count(*) / 3600 AS 'rps' FACET host LIMIT MAX",
    warningFunc: ['eval_after_agg_drops_source'],
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  // where|where: two stacked row-wise where layers over the aggregating stats inner
  // AND-fold into one legal single subquery (Task 3).
  {
    spl: '* | stats count by host | where count > 5 | where count < 100',
    nrql: 'FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT * WHERE numeric(count) > 5 AND numeric(count) < 100',
    doc: 'compound-where-where',
    verified: false,
  },
  // Guard: the AND-fold must NOT resurrect a dropped-aggregate reference. Here eval a
  // drops the raw `count`; the merged WHERE still references the dropped `count`, so
  // unexposedReference keeps it loud unsupported — never silently-wrong null NRQL.
  {
    spl: '* | stats count by host | eval a=count/60 | where a>5 | where count<100',
    nrql: '',
    warningFunc: ['eval_after_agg_drops_source'],
    unsupportedFunc: ['compound_collapse_unsupported'],
    doc: 'compound-where-where',
    verified: false,
  },
  // The AND-fold must base on the OUTER layer so a trailing sort's ORDER BY survives
  // the merge — folding onto the inner would silently drop it (silent-wrong).
  {
    spl: '* | stats count by host | where count > 5 | where count < 100 | sort count',
    nrql: 'FROM (FROM Log SELECT count(*) FACET host LIMIT MAX) SELECT * WHERE numeric(count) > 5 AND numeric(count) < 100 ORDER BY count ASC',
    doc: 'compound-where-where',
    verified: false,
  },
  // Silent-wrong guard: a post-aggregation step that references a raw aggregate an
  // earlier eval consumed (count is dropped when eval a folds) cannot resolve it —
  // loud unsupported, never null-valued NRQL. (Splunk keeps count, so it works there.)
  {
    spl: '* | stats count by host | eval a=count/60 | eval b=count/120',
    nrql: '',
    warningFunc: ['eval_after_agg_drops_source'],
    unsupportedFunc: ['compound_collapse_unsupported'],
    doc: 'compound-eval-eval',
    verified: false,
  },
  {
    spl: '* | stats count by host | eval a=count/60 | where count>5',
    nrql: '',
    warningFunc: ['eval_after_agg_drops_source'],
    unsupportedFunc: ['compound_collapse_unsupported'],
    doc: 'compound-eval-where',
    verified: false,
  },
  // The dropped-reference guard walks ALL expression node types (deny-by-default),
  // so a reference to the dropped aggregate routed through NOT / isnull (not just a
  // bare BinOp) is caught too — same loud unsupported, never silent-wrong.
  {
    spl: '* | stats count by host | eval a=count/60 | where NOT count>5',
    nrql: '',
    warningFunc: ['eval_after_agg_drops_source'],
    unsupportedFunc: ['compound_collapse_unsupported'],
    doc: 'compound-eval-where',
    verified: false,
  },
  {
    spl: '* | stats count by host | eval a=count/60 | where isnull(count)',
    nrql: '',
    warningFunc: ['eval_after_agg_drops_source'],
    unsupportedFunc: ['compound_collapse_unsupported'],
    doc: 'compound-eval-where',
    verified: false,
  },
  // Third surface of the dropped-reference class: a sort on the dropped aggregate
  // would silently mis-order (NRQL ignores the unresolved ORDER BY key) — loud instead.
  {
    spl: '* | stats count by host | eval a=count/60 | sort count',
    nrql: '',
    warningFunc: ['eval_after_agg_drops_source'],
    unsupportedFunc: ['compound_collapse_unsupported'],
    doc: 'compound-eval-where',
    verified: false,
  },
  // Task 4: trailing stats re-aggregation. Valid when the outer's FACET key is a
  // subset of the inner's exposed columns — `region` IS in the inner FACET host, region,
  // so the regroup resolves. Legal NRQL agg-over-agg subquery, NOT flagged.
  {
    spl: '* | stats count by host, region | stats sum(count) by region',
    nrql: 'FROM (FROM Log SELECT count(*) FACET host, region LIMIT MAX) SELECT sum(count) FACET region',
    warningFunc: ['facet_default_limit'],
    doc: 'compound-stats-stats',
    verified: false,
  },
  // Regroup guard: the outer FACET key `region` is NOT among the inner's exposed
  // columns (inner exposes count, host). NRQL would group on null → silently empty.
  // Loud unsupported over wrong.
  {
    spl: '* | stats count by host | stats sum(count) by region',
    nrql: '',
    warningFunc: ['facet_default_limit'],
    unsupportedFunc: ['compound_trailing_regroup_unsupported'],
    doc: 'compound-stats-stats',
    verified: false,
  },
  // Time-bucket regroup is exempt ONLY when the inner carries TIMESERIES (a timechart
  // re-supplies _time). A plain stats|stats by _time has no TIMESERIES, so _time is a
  // real unexposed regroup → loud unsupported, not silent group-on-null.
  {
    spl: '* | stats count by host | stats sum(count) by _time',
    nrql: '',
    warningFunc: ['facet_default_limit'],
    unsupportedFunc: ['compound_trailing_regroup_unsupported'],
    doc: 'compound-stats-stats',
    verified: false,
  },
  // Regroup guard, eval-led (Task 2 deferred this silent-wrong to Task 4). After eval
  // folds, the inner exposes `a` and facet `host`; the trailing `by region` regroups on
  // a column the inner never produced → loud unsupported. The eval-fold still drops the
  // raw `count`, so eval_after_agg_drops_source fires alongside the guard.
  {
    spl: '* | stats count by host | eval a=count/60 | stats sum(a) by region',
    nrql: '',
    warningFunc: ['facet_default_limit', 'eval_after_agg_drops_source'],
    unsupportedFunc: ['compound_trailing_regroup_unsupported'],
    doc: 'compound-eval-stats',
    verified: false,
  },
  // Same class: `by count` regroups on the raw aggregate the eval-fold dropped, so it is
  // not exposed by the inner either → loud unsupported, never group-on-null.
  {
    spl: '* | stats count by host | eval a=count/60 | stats sum(a) by count',
    nrql: '',
    warningFunc: ['facet_default_limit', 'eval_after_agg_drops_source'],
    unsupportedFunc: ['compound_trailing_regroup_unsupported'],
    doc: 'compound-eval-stats',
    verified: false,
  },
  // Nested regroup: a trailing `where` wraps the bad regroup ONE level down, so the
  // hazard sits on a nested aggregating layer, not the root. The guard pushes its
  // diagnosis onto the threaded ROOT unsupported array (the emitter reads only the root),
  // so it still surfaces as '' rather than silently-wrong 3-level nested NRQL.
  {
    spl: '* | stats count by host | stats sum(count) by region | where region="x"',
    nrql: '',
    unsupportedFunc: ['compound_trailing_regroup_unsupported'],
    doc: 'compound-stats-stats',
    verified: false,
  },
  // The same nested shape with a FAITHFUL inner regroup (`region` IS in the inner FACET
  // host, region) must stay valid — the guard must NOT over-fire on a nested layer whose
  // facet key the inner does expose.
  {
    spl: '* | stats count by host, region | stats sum(count) by region | where region="x"',
    nrql: "FROM (FROM (FROM Log SELECT count(*) FACET host, region LIMIT MAX) SELECT sum(count) FACET region LIMIT MAX) SELECT * WHERE region = 'x'",
    doc: 'compound-stats-stats',
    verified: false,
  },
  // ── Cleanroom regression gaps (Task 7b): confirmed-correct compound behaviors ──
  // where on a FACET KEY (not an aggregate) after stats: the filter targets `region`,
  // an exposed facet column, so it is a plain string equality with NO numeric() wrap —
  // distinct from the where-on-aggregate cases which coerce the count column.
  {
    spl: '* | stats count by host, region | where region = "us-east"',
    nrql: "FROM (FROM Log SELECT count(*) FACET host, region LIMIT MAX) SELECT * WHERE region = 'us-east'",
    doc: 'results-where-on-agg',
    verified: false,
  },
  // where comparing two aggregate result columns to each other (`c > hosts`): both
  // sides are exposed scalars, so ordering coercion wraps BOTH in numeric().
  {
    spl: '* | stats count as c, dc(host) as hosts by region | where c > hosts',
    nrql: "FROM (FROM Log SELECT count(*) AS 'c', uniqueCount(host) AS 'hosts' FACET region LIMIT MAX) SELECT * WHERE numeric(c) > numeric(hosts)",
    doc: 'results-where-on-agg',
    verified: false,
  },
  // eval if() over an aggregate folds FLAT into the stats step (no subquery); the raw
  // count column is not re-projected (drops-source warning).
  {
    spl: '* | stats count by host | eval band = if(count > 100, "hi", "lo")',
    nrql: "FROM Log SELECT if(count(*) > 100, 'hi', 'lo') AS 'band' FACET host LIMIT MAX",
    warningFunc: ['eval_after_agg_drops_source'],
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  // ratio of two distinct aggregates (`b / c`) folds flat: each alias resolves back to
  // its aggregate inside one SELECT; both raw columns dropped (drops-source warning).
  {
    spl: '* | stats sum(bytes) as b, count as c by host | eval avg_size = b / c',
    nrql: "FROM Log SELECT sum(bytes) / count(*) AS 'avg_size' FACET host LIMIT MAX",
    warningFunc: ['eval_after_agg_drops_source'],
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  // self-shadowing eval (`count = count + 1`): the RHS `count` resolves to the aggregate
  // (no infinite loop), folding flat to `count(*) + 1`; raw count dropped.
  {
    spl: '* | stats count by host | eval count = count + 1',
    nrql: "FROM Log SELECT count(*) + 1 AS 'count' FACET host LIMIT MAX",
    warningFunc: ['eval_after_agg_drops_source'],
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  // four-level compose: stats → eval-fold → where-filter → trailing re-aggregation. The
  // eval folds into the inner (rps), the trailing stats re-aggregates over the subquery,
  // and the where filters it. FACET-default-limit AND drops-source warnings both fire.
  {
    spl: '* | stats count by host, region | eval rps = count/60 | where rps > 1 | stats sum(rps) by region',
    nrql: "FROM (FROM Log SELECT count(*) / 60 AS 'rps' FACET host, region LIMIT MAX) SELECT sum(rps) WHERE numeric(rps) > 1 FACET region",
    warningFunc: ['facet_default_limit', 'eval_after_agg_drops_source'],
    doc: 'compound-eval-stats',
    verified: false,
  },
  // eval after a WHERE-subquery: the where already wrapped a row-wise outer over the
  // aggregating inner; a further eval would nest that row-wise layer as an illegal
  // non-aggregating inner → loud unsupported (defensible, never silent-wrong).
  {
    spl: '* | stats count by host | where count > 5 | eval label = if(count > 50, "high", "low")',
    nrql: '',
    unsupportedFunc: ['compound_collapse_unsupported'],
    doc: 'compound-eval-where',
    verified: false,
  },
  // timechart then eval folds flat; the TIMESERIES that timechart owned stays on the
  // (now eval-projected) aggregation. Raw count dropped (drops-source warning).
  {
    spl: '* | timechart count by host | eval rps = count/60',
    nrql: "FROM Log SELECT count(*) / 60 AS 'rps' FACET host LIMIT MAX TIMESERIES AUTO",
    warningFunc: ['eval_after_agg_drops_source'],
    doc: 'fields-eval-arithmetic',
    verified: false,
  },
  // timechart then where wraps a subquery; the TIMESERIES belongs to the inner
  // aggregation (timechart owned it), and the outer filters the count column.
  {
    spl: '* | timechart count by host | where count > 100',
    nrql: 'FROM (FROM Log SELECT count(*) FACET host LIMIT MAX TIMESERIES AUTO) SELECT * WHERE numeric(count) > 100',
    doc: 'results-where-on-agg',
    verified: false,
  },
  // dc() → uniqueCount is a SCALAR aggregate, so a where over its aliased column needs
  // only numeric() coercion — no getField extraction (contrast median/percentile, which
  // expose keyed objects across the subquery boundary and require getField).
  {
    spl: '* | stats dc(user) as users by host | where users > 100',
    nrql: "FROM (FROM Log SELECT uniqueCount(user) AS 'users' FACET host LIMIT MAX) SELECT * WHERE numeric(users) > 100",
    doc: 'results-where-on-agg',
    verified: false,
  },
  {
    spl: '* | eval x = if(a > b+1, "hi", "lo")',
    nrql: "FROM Log WITH if(numeric(a) > numeric(b) + 1, 'hi', 'lo') AS x SELECT *",
    doc: 'eval-conditional',
    verified: 'llm',
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
  // Regression: eval like() pattern with an apostrophe must escape it as \'
  // so it doesn't terminate the surrounding NRQL '...' string literal.
  {
    spl: '* | eval x=if(like(message, "%Can\'t cover%"), "y", "n")',
    nrql: "FROM Log WITH if(message LIKE '%Can\\'t cover%', 'y', 'n') AS x SELECT *",
    doc: 'eval-like-apostrophe-regression',
    verified: 'llm',
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
  {
    spl: '* | stats eval(upper(host)) as h',
    unsupportedFunc: ['stats_eval_unsupported'],
    doc: 'stats-eval-grammar',
    verified: false,
  },
  {
    // non-fold-safe function OVER an aggregate (distinct path from upper(host),
    // which has no aggregate at all) — both → unsupported.
    spl: '* | stats eval(mvjoin(values(x), ",")) as j',
    unsupportedFunc: ['stats_eval_unsupported'],
    doc: 'stats-eval-grammar',
    verified: false,
  },
  {
    spl: '* | eventstats eval(sum(bytes)) by host',
    unsupportedFunc: ['stats_eval_unsupported'],
    doc: 'stats-eval-grammar',
    verified: false,
  },
  {
    // Regression: count(eval(...)) is the DISTINCT fn(eval()) form and must not change.
    spl: '* | stats count(eval(status>=500)) as errors',
    nrql: "FROM Log SELECT filter(count(*), WHERE numeric(status) >= 500) AS 'errors'",
    warningFunc: [],
    unsupportedFunc: [],
    doc: 'stats-eval-grammar',
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
  // timechart then stats grouped by _time (found by model-based fuzz). Degenerate:
  // timechart produces one row per bucket, so `stats count by _time` is trivially
  // 1 per group. With TIMESERIES now correctly on the inner timechart, the `by
  // _time` lands as an outer FACET _time. FIXME: that `by _time` should fold back
  // into the inner TIMESERIES; semantics still wrong — kept verified:false.
  {
    spl: '* | timechart span=1m count | stats count by _time',
    nrql: 'FROM (FROM Log SELECT count(*) TIMESERIES 1 minute) SELECT count(*) FACET _time',
    warningFunc: ['facet_default_limit'],
    doc: 'reports-timechart',
    verified: false,
  },
  // timechart then stats with non-_time aggregation
  // FIXME: same issue — inner subquery needs LIMIT MAX; chained stats-over-timechart
  //   semantics need rethinking
  {
    spl: '* | timechart span=5m count | stats sum(count)',
    nrql: 'FROM (FROM Log SELECT count(*) TIMESERIES 5 minutes) SELECT sum(count)',
    doc: 'reports-timechart',
    verified: false,
  },
  // timechart then stats: TIMESERIES belongs on the INNER aggregation (the
  // timechart), not the outer. Verified on staging (acct 10671289) that nested
  // TIMESERIES populates all buckets.
  {
    spl: '* | timechart count by host | stats avg(count) as a',
    nrql: "FROM (FROM Log SELECT count(*) FACET host LIMIT MAX TIMESERIES AUTO) SELECT average(count) AS 'a'",
    doc: 'reports-timechart',
    verified: false,
  },
  // bin _time + stats by _time then a trailing stats: TIMESERIES already groups by
  // time, so the inner FACET _time is redundant. The outer post-loop dedup can't
  // reach the inner once wrapped, so wrapAsSubquery strips it from the inner facet.
  {
    spl: '* | bin _time span=1h | stats count by _time | stats avg(count)',
    nrql: 'FROM (FROM Log SELECT count(*) TIMESERIES 1 hour) SELECT average(count)',
    doc: 'reports-timechart',
    verified: false,
  },
  // ── Dashboard time tokens: Path 3 ($timespan$ in span=) ──
  {
    spl: 'index=web | timechart span=$timespan$ count',
    nrql: '',
    unsupportedFunc: ['span_token_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  {
    spl: 'index=web | bin _time span=$timespan$ | stats count',
    nrql: '',
    unsupportedFunc: ['span_token_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  // A span token on a NON-_time numeric bin must ALSO surface the specific
  // span_token_unsupported, not the generic bin-unsupported — for BOTH grammar
  // orders (span-first and field-first). The grammar preserves the SpanToken
  // object on span so handleBin's guard catches it regardless of field.
  {
    spl: 'index=web | bin span=$timespan$ bytes',
    nrql: '',
    unsupportedFunc: ['span_token_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  {
    spl: 'index=web | bin bytes span=$timespan$ as size',
    nrql: '',
    unsupportedFunc: ['span_token_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  // Token name with a HYPHEN — a real corpus token (`span=$time-span$`). Our
  // original [a-zA-Z0-9_.]+ charset rejected it (whole command read as generic
  // unsupported). Widened to include hyphen + colon, confirmed by 3 OSS SPL
  // parsers (see .claude/references/spl-reference.md → Cross-check Parsers).
  {
    spl: 'index=web | timechart span=$time-span$ count',
    nrql: '',
    unsupportedFunc: ['span_token_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  // Token name with a COLON — same charset widening.
  {
    spl: 'index=web | timechart span=$ns:span$ count',
    nrql: '',
    unsupportedFunc: ['span_token_unsupported'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  // Regression: literal numeric span unchanged.
  {
    spl: 'index=web | timechart span=5m count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' TIMESERIES 5 minutes",
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  // Regression: bare-word duration span unchanged.
  {
    spl: 'index=web | timechart span=hour count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' TIMESERIES 1 hour",
    doc: 'dashboard-time-tokens',
    verified: 'llm',
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
    verified: 'llm',
  },
  // where NOT like() — NOT wrapping of function-call form
  {
    spl: '* | where NOT like(message, "%debug%")',
    nrql: "FROM Log SELECT * WHERE message NOT LIKE '%debug%'",
    doc: 'results-where',
    verified: 'llm',
  },
  // where like(...) AND field=value — both conditions must appear in WHERE
  {
    spl: '* | where like(message, "%timeout%") AND status=500',
    nrql: "FROM Log SELECT * WHERE message LIKE '%timeout%' AND status = '500' OR numeric(status) = 500",
    doc: 'results-where',
    verified: 'llm',
  },
  // where NOT like() with compound — NOT wrapping + AND
  {
    spl: '* | where NOT like(message, "%debug%") AND status=200',
    nrql: "FROM Log SELECT * WHERE message NOT LIKE '%debug%' AND status = '200' OR numeric(status) = 200",
    doc: 'results-where',
    verified: 'llm',
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
  // Regression: where-pipe with an unknown eval function as the whole primary
  // used to crash with TypeError because translateWhereExpr forgot to forward
  // `ir` to translateSearchExpr, and the FunctionCall fallthrough then called
  // walkEvalFunc with ir=undefined. Should now produce unsupported, not throw.
  {
    spl: '* | where in(minute_check, "00", "30")',
    unsupportedFunc: ['eval_func_unsupported'],
    doc: 'where-in-func-regression',
    verified: 'llm',
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
  // Regression: regex pattern containing a literal apostrophe must escape it
  // as \' inside the r'...' literal so the regex literal doesn't terminate
  // early and produce invalid NRQL.
  {
    spl: '* | regex message="don\'t"',
    nrql: "FROM Log SELECT * WHERE message RLIKE r'don\\'t'",
    doc: 'regex-apostrophe-regression',
    verified: 'llm',
  },
  // Regression: `| regex foo=$bar$` (unquoted/template-variable RHS) used to
  // emit Rlike(field, null) and crash the emitter. Should now report
  // unsupported with a descriptive message.
  {
    spl: '* | regex accountUsername=$Account_Username$',
    unsupportedFunc: ['regex_command_unparsed'],
    doc: 'regex-template-var-regression',
    verified: 'llm',
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
  // head/tail BETWEEN two aggregations is unsupported: SPL keeps the first N rows
  // in stats order, but a nested-subquery LIMIT N keeps the top N by aggregate
  // value — different selections, no faithful translation. (head after a single
  // stats, with no second aggregation, is unaffected.)
  {
    spl: '* | stats count by host | head 10 | stats avg(count) as a',
    nrql: '',
    unsupportedFunc: ['head_between_aggregations'],
    doc: 'results-head',
    verified: false,
  },
  {
    spl: '* | stats count by host | tail 10 | stats avg(count) as a',
    nrql: '',
    unsupportedFunc: ['head_between_aggregations'],
    doc: 'results-head',
    verified: false,
  },
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
    verified: 'llm',
  },
  // mvexpand with function-call field name (stats list() creates literal field name)
  {
    spl: '* | mvexpand list(orderNumber)',
    unsupportedFunc: ['mvexpand_unsupported'],
    doc: 'unsupported-mvexpand',
    verified: 'llm',
  },
  // Pattern 2: dedup round-trip (~30%)
  {
    spl: '* | stats values(title) as title | mvexpand title',
    unsupportedFunc: ['mvexpand_unsupported'],
    doc: 'unsupported-mvexpand',
    verified: 'llm',
  },
  // Pattern 3: expand + aggregate by expanded field
  {
    spl: '* | eval perms=split(permissions, ",") | mvexpand perms | stats count by perms',
    warningFunc: ['facet_default_limit'],
    unsupportedFunc: ['mvexpand_unsupported'],
    doc: 'unsupported-mvexpand',
    verified: 'llm',
  },
  // Pattern 4: symmetric counting
  {
    spl: '* | eval notable_asset=mvappend(notable_src, notable_dest) | mvexpand notable_asset | stats count by notable_asset',
    warningFunc: ['facet_default_limit'],
    unsupportedFunc: ['mvexpand_unsupported'],
    doc: 'unsupported-mvexpand',
    verified: 'llm',
  },
  // Pattern 5: expand + sort only (no aggregation by field)
  {
    spl: 'index=k8s_main bopus orderType=BOPUS storeNumber=* orderNumber=* | stats list(orderNumber) AS orderNumber BY orderStatus storeNumber | mvexpand orderNumber | sort -orderNumber',
    warningFunc: ['list_order_warning', 'facet_default_limit'],
    unsupportedFunc: ['mvexpand_unsupported'],
    doc: 'unsupported-mvexpand',
    verified: 'llm',
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
    verified: 'llm',
  },
  {
    spl: '* | convert mstime(elapsed)',
    unsupportedFunc: ['convert_mstime_unsupported'],
    doc: 'fields-convert',
    verified: 'llm',
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
    verified: 'llm',
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
    verified: 'llm',
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

  // Gap #2 — dedup + stats: Task 4's regroup guard flips this from silently-wrong to
  // loud unsupported. dedup translates to `SELECT latest(timestamp) FACET userId`, which
  // does NOT expose `routeName`, so the trailing `stats count by routeName` regrouped on
  // a column the inner never produced → NRQL groups on null (silently empty). Was
  // verified:'llm' emitting that wrong NRQL; now correctly unsupported (downgraded to
  // verified:false — the prior translation was wrong, not human-confirmed).
  {
    spl: '* | dedup userId | stats count by routeName',
    nrql: '',
    warningFunc: ['dedup_facet_warning', 'dedup_limit_max_cap'],
    unsupportedFunc: ['compound_trailing_regroup_unsupported'],
    doc: 'results-dedup',
    verified: false,
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
    doc: 'reports-timechart',
    verified: 'llm',
  },
  // Gap #7 — >5 rex commands: warn about capture() limit
  {
    spl: '* | rex field=f1 "(?<a>\\w+)" | rex field=f2 "(?<b>\\w+)" | rex field=f3 "(?<c>\\w+)" | rex field=f4 "(?<d>\\w+)" | rex field=f5 "(?<e>\\w+)" | rex field=f6 "(?<f>\\w+)"',
    nrql: "FROM Log WITH capture(f1, r'.*(?P<a>\\w+).*') AS (a), capture(f2, r'.*(?P<b>\\w+).*') AS (b), capture(f3, r'.*(?P<c>\\w+).*') AS (c), capture(f4, r'.*(?P<d>\\w+).*') AS (d), capture(f5, r'.*(?P<e>\\w+).*') AS (e), capture(f6, r'.*(?P<f>\\w+).*') AS (f) SELECT *",
    warningFunc: ['rex_capture_limit'],
    doc: 'fields-rex',
    verified: 'llm',
  },
  // Gap #13 — split() multi-char delimiter
  {
    spl: '* | eval parts = split(field, "},{")',
    nrql: "FROM Log WITH split(field, '},{') AS parts SELECT *",
    warningFunc: ['split_multi_char_delimiter'],
    doc: 'fields-eval-arithmetic',
    verified: 'llm',
  },
  // Gap #3 — cascading mvexpand
  {
    spl: '* | spath input=body path=Items{} output=items | mvexpand items | spath input=items path=Channels{} output=channels | mvexpand channels',
    warningFunc: ['spath_json_only'],
    unsupportedFunc: ['mvexpand_unsupported', 'mvexpand_cascading'],
    doc: 'unsupported-mvexpand',
    verified: 'llm',
  },
  // Gap #5 — mvzip unsupported
  {
    spl: '* | eval paired = mvzip(nodes, skus)',
    unsupportedFunc: ['mvzip_unsupported'],
    doc: 'fields-eval-arithmetic',
    verified: 'llm',
  },
  // Gap #22 — streamstats
  {
    spl: '* | streamstats count as row_num',
    unsupportedFunc: ['streamstats_unsupported'],
    doc: 'reports-streamstats',
    verified: 'llm',
  },
  // Gap #10 — kvparse / extract
  {
    spl: '* | extract',
    unsupportedFunc: ['kvparse_unsupported'],
    doc: 'fields-extract',
    verified: 'llm',
  },
  // Gap #15 — list() order not preserved
  {
    spl: '* | stats list(eventType) by orderId',
    nrql: 'FROM Log SELECT uniques(eventType) FACET orderId',
    warningFunc: ['list_order_warning', 'facet_default_limit'],
    doc: 'reports-stats',
    verified: 'llm',
  },
  // Gap #4 — cross-expand field matching (two mvexpands on different fields)
  {
    spl: '* | spath input=_raw output=validation path=validations{} | mvexpand validation | spath input=_raw output=sku_data path=items{} | mvexpand sku_data',
    warningFunc: ['spath_json_only'],
    unsupportedFunc: ['mvexpand_unsupported', 'mvexpand_cascading'],
    doc: 'unsupported-mvexpand',
    verified: 'llm',
  },
  // Gap #12 — FACET default 10 warning
  {
    spl: '* | stats count by host',
    nrql: 'FROM Log SELECT count(*) FACET host',
    warningFunc: ['facet_default_limit'],
    doc: 'reports-stats',
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
    doc: 'fields-eval-arithmetic',
    verified: 'llm',
  },
  // Gap #18 — multi-column ORDER BY (already covered by sort_single_field)
  {
    spl: '* | sort host, -duration',
    nrql: 'FROM Log SELECT * ORDER BY host ASC',
    warningFunc: ['sort_single_field'],
    doc: 'results-sort',
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
    doc: 'unsupported-mvexpand',
    verified: false,
  },
  // Gap #2 — FIXME: dedup + timechart should emit nested subquery approach
  // SPL dedup keeps first event per userId (most recent in historical search).
  // The eval before dedup tags Submit as orders=1; after dedup, only users
  // whose last action was Submit retain orders=1. Then eval addtobags tags the rest.
  // Formula: (users whose last action = Submit) / (last action = AddItem) × 100
  //
  // Best-effort NRQL: nested latest(routeName) FACET userId, then filter/count.
  // Limitations: LIMIT MAX caps at 5K (a high-cardinality user field exceeds it),
  // TIMESERIES on outer query produces nulls after first bucket.
  //
  // BLOCKER: `timechart eval(...)` doesn't parse — the grammar only recognizes
  // `name(eval(...))` (e.g., count(eval(if(...)))) but not bare `eval(expr)` as a
  // top-level stats_function. A `timechart eval((sum(x)*100)/sum(y))`
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
    spl: '(routeName="AddItem" OR routeName="Submit") msg="Processed Server Request.  Status: 200" | eval orders=if(routeName=="Submit",1,0) | dedup userId | eval addtobags=if(routeName=="AddItem",1,0) | timechart eval((sum(orders)*100)/sum(addtobags)) as completionRate span=1m',
    nrql: 'FIXME: needs grammar change for timechart eval(), then nested FROM (SELECT latest(routeName) AS lastRoute FACET userId LIMIT MAX) with filter/count formula + warnings',
    doc: 'results-dedup',
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
    doc: 'reports-stats',
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
    doc: 'fields-eval-arithmetic',
    verified: false,
  },

  // ── timechart by-clause options (limit/useother/usenull) ──────────
  {
    spl: 'index=x | timechart span=1m count by service limit=0',
    nrql: "FROM Log SELECT count(*) WHERE index = 'x' FACET service LIMIT MAX TIMESERIES 1 minute",
    doc: 'timechart-by-options',
    verified: 'llm',
  },
  {
    spl: 'index=x | timechart count by ua useother=false usenull=false limit=5',
    nrql: "FROM Log SELECT count(*) WHERE index = 'x' FACET ua LIMIT 5 TIMESERIES AUTO",
    warningFunc: ['usenullNoEquivalent'],
    doc: 'timechart-by-options',
    verified: 'llm',
  },
  {
    spl: 'index=x | stats count by host source',
    nrql: "FROM Log SELECT count(*) WHERE index = 'x' FACET host, source",
    doc: 'timechart-by-options-regression',
    verified: 'llm',
  },

  // ── top multi-field parse ─────────────────────────────────────────
  {
    spl: 'index=x | top limit=10 cs_user_agent, sc_status',
    nrql: "FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*) WHERE index = 'x') AS 'percent' WHERE index = 'x' FACET cs_user_agent, sc_status ORDER BY count DESC LIMIT 10",
    doc: 'top-multifield',
    verified: 'llm',
  },
  {
    spl: 'index=x | top host by region',
    nrql: "FROM Log SELECT count(*), count(*) * 100.0 / (FROM Log SELECT count(*) WHERE index = 'x') AS 'percent' WHERE index = 'x' FACET host, region ORDER BY count DESC LIMIT 10",
    warningFunc: ['top_groupby_warning'],
    doc: 'top-multifield-regression',
    verified: 'llm',
  },

  // ── bin/bucket as-alias ───────────────────────────────────────────
  {
    spl: 'index=x | bin span=1m _time as min | stats count by min',
    nrql: "FROM Log SELECT count(*) WHERE index = 'x' TIMESERIES 1 minute",
    warningFunc: ['facet_default_limit'],
    doc: 'bin-as-alias',
    verified: 'llm',
  },

  // ── sort leniency: trailing limit, type hints, space-sign multi-key ──
  {
    spl: 'index=x | sort - time_taken limit=10',
    nrql: "FROM Log SELECT * WHERE index = 'x' ORDER BY time_taken DESC LIMIT 10",
    doc: 'sort-leniency',
    verified: 'llm',
  },
  {
    spl: 'index=x | sort num(duration)',
    nrql: "FROM Log SELECT * WHERE index = 'x' ORDER BY duration ASC",
    doc: 'sort-typehint',
    verified: 'llm',
  },
  {
    spl: 'index=x | sort -aaa username',
    nrql: "FROM Log SELECT * WHERE index = 'x' ORDER BY aaa DESC",
    warningFunc: ['sort_single_field'],
    doc: 'sort-space-multikey',
    verified: 'llm',
  },
  {
    spl: 'index=x | sort 0 host',
    nrql: "FROM Log SELECT * WHERE index = 'x' ORDER BY host ASC",
    doc: 'sort-leading-zero-regression',
    verified: 'llm',
  },

  // ── where: bang negation, leading-dot decimals, mvcount ───────────
  {
    spl: 'index=x | where !(match(f,"^SYS"))',
    nrql: "FROM Log SELECT * WHERE index = 'x' AND f NOT RLIKE r'^SYS'",
    doc: 'where-bang-negation',
    verified: 'llm',
  },
  {
    spl: 'index=x | stats count by f | where .25 > count',
    nrql: "FROM (FROM Log SELECT count(*) WHERE index = 'x' FACET f LIMIT MAX) SELECT * WHERE .25 > numeric(count)",
    doc: 'where-leading-dot-decimal',
    verified: 'llm',
  },
  {
    spl: 'index=x | where mvcount(f) > 1',
    nrql: "FROM Log SELECT * WHERE index = 'x' AND numeric(length(f)) > 1",
    warningFunc: ['eval_length_warning'],
    doc: 'where-mvcount',
    verified: 'llm',
  },
  {
    spl: 'index=x | where count != 5',
    nrql: "FROM Log SELECT * WHERE index = 'x' AND count != '5' AND numeric(count) != 5",
    doc: 'where-bang-regression',
    verified: 'llm',
  },
  {
    spl: 'index=web | where in_bytes > out_bytes',
    nrql: "FROM Log SELECT * WHERE index = 'web' AND numeric(in_bytes) > numeric(out_bytes)",
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },
  {
    spl: 'index=web | where a > b + 1',
    nrql: "FROM Log SELECT * WHERE index = 'web' AND numeric(a) > numeric(b) + 1",
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },
  {
    spl: 'index=web | where bytes > round(total / 100, 2)',
    nrql: "FROM Log SELECT * WHERE index = 'web' AND numeric(bytes) > round(numeric(total) / 100, 0.01)",
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },
  {
    spl: 'index=web | where _time > relative_time(now(), "-7d")',
    nrql: "FROM Log SELECT * WHERE index = 'web' SINCE 7 days ago",
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },
  {
    spl: 'index=web | where _time < relative_time(now(), "-1d")',
    unsupportedFunc: ['where_time_past_upper_bound_unsupported'],
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },
  {
    spl: 'index=web | where _time < now()',
    nrql: "FROM Log SELECT * WHERE index = 'web'",
    warningFunc: ['where_time_tautology_dropped'],
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },
  {
    spl: 'index=web | where created < now()',
    unsupportedFunc: ['where_nontime_relative_unsupported'],
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },
  {
    spl: 'index=web | where bytes > jparse(payload, "size")',
    unsupportedFunc: ['where_rhs_func_not_row_wise'],
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },

  // ── where-comparison-rhs regression cases ──────────────────────────
  {
    // plain numeric value: lone literal on RHS, clean output, no messages
    spl: 'index=web status > 200',
    nrql: "FROM Log SELECT * WHERE index = 'web' AND numeric(status) > 200",
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },
  {
    // bare field RHS: in where/eval an UNQUOTED rhs is a FIELD NAME (Splunk
    // docs), so `status = foo` is a field-to-field comparison → NRQL `status = foo`
    // (an attribute reference), NOT the string 'foo'. Quoting it would be wrong.
    spl: 'index=web | where status = foo',
    nrql: "FROM Log SELECT * WHERE index = 'web' AND status = foo",
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },
  {
    // function on LHS (where_func_comparison rule): mvcount → length, fires eval_length_warning
    spl: 'index=web | where mvcount(tags) > 1',
    nrql: "FROM Log SELECT * WHERE index = 'web' AND numeric(length(tags)) > 1",
    warningFunc: ['eval_length_warning'],
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },
  {
    // outer AND is NOT swallowed by the u_add RHS rule
    spl: 'index=web | where a > b AND c < d',
    nrql: "FROM Log SELECT * WHERE index = 'web' AND numeric(a) > numeric(b) AND numeric(c) < numeric(d)",
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },
  {
    // subsearch with a `search`-COMMAND comparison: `in_bytes > out_bytes` is a
    // search term, not a where pipe, so it correctly does NOT get the new RHS rule
    // (search treats an unquoted RHS as a string — see spl-reference). This is the
    // expected search-vs-where distinction, not a gap. Captured as-is.
    spl: 'index=web [ search in_bytes > out_bytes ]',
    nrql: "FROM Log SELECT * WHERE index = 'web' AND in_bytes > 'out_bytes'",
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },
  // ── Dashboard time tokens: subsearch scoping (observed via bin/spl2nrql.js) ──
  // Token inside a subsearch is dropped within the subsearch scope (warning
  // wrapped by subsearch_warning); the OUTER query gets NO SINCE/UNTIL from it.
  {
    spl: 'index=web [ search index=auth earliest=$tok.earliest$ ] | stats count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' AND index = 'auth'",
    warningFunc: ['time_token_bound_dropped', 'subsearch_warning'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  // Outer literal + subsearch token: outer SINCE preserved, NO mixed escalation
  // on the outer (flags are scope-local; the subsearch token never sets the
  // outer's sawTimeToken). Proves cross-scope isolation.
  {
    spl: 'index=web earliest=-24h [ search index=auth latest=$tok.latest$ ] | stats count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' AND index = 'auth' SINCE 24 hours ago",
    warningFunc: ['time_token_bound_dropped', 'subsearch_warning'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  // Literal + token BOTH inside the same subsearch. The subsearch body is a
  // `| search` COMMAND (not a leading search), so the mixed-bound escalation —
  // which is leading-search-only by design — does NOT fire here. The token still
  // drops loud (subsearch_warning); the window is simply not escalated. This is
  // the documented scope boundary (mid-pipe/subsearch search is out of escalation
  // scope), captured as observed behavior, NOT a silent-wrong result.
  {
    spl: 'index=web [ search index=auth earliest=-1h latest=$tok.latest$ ] | stats count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'web' AND index = 'auth'",
    warningFunc: ['time_token_bound_dropped', 'subsearch_warning'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  // Edge: token-only time bounds with NO trailing command — both bounds drop,
  // SELECT * survives with no time range.
  {
    spl: 'index=web earliest=$tok.earliest$ latest=$tok.latest$',
    nrql: "FROM Log SELECT * WHERE index = 'web'",
    warningFunc: ['time_token_bound_dropped', 'time_token_bound_dropped'],
    doc: 'dashboard-time-tokens',
    verified: 'llm',
  },
  {
    // subsearch with a `| where` PIPE: the re-parse DOES apply the new RHS rule
    // (the subsearch body is re-parsed through the same grammar). Proves the
    // spec's "reaches inside subsearches" claim for where pipes specifically.
    spl: 'index=web [ search index=x | where in_bytes > out_bytes ]',
    nrql: "FROM Log SELECT * WHERE index = 'web' AND index = 'x' AND numeric(in_bytes) > numeric(out_bytes)",
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },
  {
    // reversed-operand (numeric literal LHS) with a row-wise-unimplemented fn on
    // the RHS: NOT caught by the Task 6 gate (that gates the main Path 2b), but
    // still fails LOUD via the eval walker's own unknown-function handling — no
    // non-compiling NRQL leaks. Locks in the safe behavior.
    spl: 'index=web | where 0.25 > jparse(payload, "x")',
    unsupportedFunc: ['eval_func_unsupported'],
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },

  // ── where-comparison-rhs unsupported cases ─────────────────────────
  {
    spl: 'index=web | where _time >= now()',
    unsupportedFunc: ['where_time_future_bound_unsupported'],
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },
  {
    spl: 'index=web | where _time = now()',
    unsupportedFunc: ['where_time_point_unsupported'],
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },
  {
    spl: 'index=web | where _time > relative_time(eventField, "-1d")',
    unsupportedFunc: ['where_relative_time_nonliteral_unsupported'],
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },

  // ── where-comparison-rhs collapsed-constraint warning ──────────────
  {
    // Two lower-bound constraints in same where → collapse warning (last-writer-wins)
    // NOTE: earliest=+where in separate pipeline stages does NOT trigger this warning
    // because each stage runs translateSearchExpr with a fresh local `since` variable.
    // The collapse only fires when two _time constraints appear in the same expression.
    spl: 'index=web | where _time > relative_time(now(), "-7d") AND _time > relative_time(now(), "-1d")',
    nrql: "FROM Log SELECT * WHERE index = 'web' SINCE 1 day ago",
    warningFunc: ['where_time_constraints_collapsed'],
    doc: 'where-comparison-rhs',
    verified: 'llm',
  },

  // ── tokenizer leniency: empty list items, IN space-separation ─────
  {
    spl: 'index=x | table, _time, host',
    nrql: "FROM Log SELECT timestamp, host WHERE index = 'x'",
    doc: 'tokenizer-empty-list-item',
    verified: 'llm',
  },
  {
    spl: 'index=x f IN ("a" "b", "c")',
    nrql: "FROM Log SELECT * WHERE index = 'x' AND f IN ('a', 'b', 'c')",
    doc: 'tokenizer-in-space-separated',
    verified: 'llm',
  },
  {
    spl: 'index=x f IN ("a", "b", "c")',
    nrql: "FROM Log SELECT * WHERE index = 'x' AND f IN ('a', 'b', 'c')",
    doc: 'tokenizer-in-comma-regression',
    verified: 'llm',
  },

  // ── where(...) with no space before the paren ─────────────────────
  {
    spl: 'index=x | where(staked>0)',
    nrql: "FROM Log SELECT * WHERE index = 'x' AND numeric(staked) > 0",
    doc: 'tokenizer-where-no-space',
    verified: 'llm',
  },
  {
    spl: 'index=x | where (staked>0)',
    nrql: "FROM Log SELECT * WHERE index = 'x' AND numeric(staked) > 0",
    doc: 'tokenizer-where-space-regression',
    verified: 'llm',
  },

  // ── stats: stray comma before the by-clause ───────────────────────
  {
    spl: 'index=x | stats count, by host',
    nrql: "FROM Log SELECT count(*) WHERE index = 'x' FACET host",
    warningFunc: ['facet_default_limit'],
    doc: 'tokenizer-stats-stray-comma',
    verified: 'llm',
  },
  {
    spl: 'index=x | stats count, avg(bytes) by host',
    nrql: "FROM Log SELECT count(*), average(bytes) WHERE index = 'x' FACET host",
    warningFunc: ['facet_default_limit'],
    doc: 'tokenizer-stats-multi-fn-regression',
    verified: 'llm',
  },

  // ── quote-boundary: a closing quote acts as a term separator ──────
  {
    spl: 'index=x cs_uri_query !="*Lucky*"cs_uri_query != "*nui*"',
    nrql: "FROM Log SELECT * WHERE index = 'x' AND cs_uri_query NOT LIKE '%Lucky%' AND cs_uri_query NOT LIKE '%nui%'",
    doc: 'tokenizer-quote-boundary',
    verified: 'llm',
  },
  {
    spl: 'index="mattbotsummary"$device$',
    nrql: "FROM Log SELECT * WHERE index = 'mattbotsummary' AND {{device}}",
    doc: 'tokenizer-quote-boundary-token',
    verified: 'llm',
  },
  {
    // A closing backtick (end of macro) is a term boundary like a closing quote:
    // `mymacro`status=200 is the macro followed by a comparison, no space needed.
    spl: '`mymacro`status=200',
    nrql: "FROM Log SELECT * WHERE $mymacro AND status = '200' OR numeric(status) = 200",
    warningFunc: ['macro_translated'],
    doc: 'tokenizer-quote-boundary-macro',
    verified: 'llm',
  },
  {
    spl: 'index=x cs_uri_query !="*Lucky*" cs_uri_query != "*nui*"',
    nrql: "FROM Log SELECT * WHERE index = 'x' AND cs_uri_query NOT LIKE '%Lucky%' AND cs_uri_query NOT LIKE '%nui%'",
    doc: 'tokenizer-quote-boundary-spaced-regression',
    verified: 'llm',
  },
  {
    spl: 'index=x foo="a" OR bar="b"',
    nrql: "FROM Log SELECT * WHERE (index = 'x' AND foo = 'a') OR bar = 'b'",
    doc: 'tokenizer-quote-boundary-or-regression',
    verified: 'llm',
  },
  {
    spl: 'index=x (foo="a") | stats count',
    nrql: "FROM Log SELECT count(*) WHERE index = 'x' AND foo = 'a'",
    doc: 'tokenizer-quote-boundary-paren-regression',
    verified: 'llm',
  },

  // ── quoted field names in field/by lists ──────────────────────────
  {
    spl: 'index=x | table loyaltyId, "Datetime Start", "Datetime End"',
    nrql: "FROM Log SELECT loyaltyId, `Datetime Start`, `Datetime End` WHERE index = 'x'",
    doc: 'quoted-field-name',
    verified: 'llm',
  },
  {
    spl: 'index=x | stats count by "Container Name"',
    nrql: "FROM Log SELECT count(*) WHERE index = 'x' FACET `Container Name`",
    warningFunc: ['facet_default_limit'],
    doc: 'quoted-field-name',
    verified: 'llm',
  },

  // ── eval `+` with a string operand → now translated via unified ladder ──
  // SPL `+` is overloaded (numeric add OR string concat). The unified
  // EvalArith ladder now handles string operands by emitting concat().
  {
    spl: 'index=x | eval z = businessDate + " "',
    nrql: "FROM Log WITH concat(businessDate, ' ') AS z SELECT * WHERE index = 'x'",
    doc: 'eval-string',
    verified: 'llm',
  },
  {
    spl: 'index=x | eval z = a + " " + b',
    nrql: "FROM Log WITH concat(a, ' ', b) AS z SELECT * WHERE index = 'x'",
    doc: 'eval-string',
    verified: 'llm',
  },
  {
    spl: 'index=x | eval z = f + g',
    nrql: "FROM Log WITH numeric(f) + numeric(g) AS z SELECT * WHERE index = 'x'",
    doc: 'eval-plus-arithmetic-regression',
    verified: 'llm',
  },

  // ── EvalArith: top-level comparison + string-concat (Task 5) ──
  {
    spl: '* | eval hi = status >= 400',
    nrql: 'FROM Log WITH numeric(status) >= 400 AS hi SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'llm',
  },
  {
    spl: '* | eval z = businessDate + " "',
    nrql: "FROM Log WITH concat(businessDate, ' ') AS z SELECT *",
    doc: 'eval-string',
    verified: 'llm',
  },
  {
    spl: '* | eval full = a + " " + b',
    nrql: "FROM Log WITH concat(a, ' ', b) AS full SELECT *",
    doc: 'eval-string',
    verified: 'llm',
  },

  // ── EvalArith: stats function args via unified ladder (Task 6) ──
  {
    spl: '* | stats sum(bytes/1024)',
    nrql: 'FROM Log SELECT sum(numeric(bytes) / 1024)',
    doc: 'stats-agg',
    verified: 'llm',
  },
  {
    spl: '* | stats sum(a*2+b)',
    nrql: 'FROM Log SELECT sum(numeric(a) * 2 + numeric(b))',
    doc: 'stats-agg',
    verified: 'llm',
  },
  {
    spl: '* | stats avg(tcp.*)',
    nrql: 'FROM Log SELECT average(`tcp.*`)',
    doc: 'stats-agg',
    verified: 'llm',
  },

  // ── EvalArith: eval nested in stats arg (Task 7) ──
  // FIXME: the inner if(cond, 1, 0) should unwrap to just `cond` for the filter
  // WHERE — i.e. `filter(count(*), WHERE numeric(status) >= 400)`. Today the
  // walker emits the whole if() as the predicate (`WHERE if(..., 1, 0)`), which
  // is dubious NRQL. Unwrapping `if(cond, 1, 0)`/`if(cond, 1, null)` in the
  // evalFilter consumer (aggregationHandlers.js) is out of scope for the grammar
  // wiring task; tracked as follow-up. Asserting ACTUAL output so the test guards
  // against further drift. verified:false — NOT correct, do not promote.
  {
    spl: '* | stats sum(eval(if(status>=400,1,0)))',
    nrql: 'FROM Log SELECT filter(count(*), WHERE if(numeric(status) >= 400, 1, 0))',
    doc: 'stats-agg',
    verified: false,
  },

  // ── Unified ladder edge cases (Task 8) ──
  // Asserted against ACTUAL emitter output (captured via bin/spl2nrql.js).
  // Precedence: * binds tighter than +
  {
    spl: '* | eval r = a*2+b',
    nrql: 'FROM Log WITH numeric(a) * 2 + numeric(b) AS r SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'llm',
  },
  // Precedence: parens override
  {
    spl: '* | eval r = (a+b)*c',
    nrql: 'FROM Log WITH (numeric(a) + numeric(b)) * numeric(c) AS r SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'llm',
  },
  // Mixed arithmetic + comparison + boolean
  {
    spl: '* | eval r = if(a*2 > b AND c < 3, "y", "n")',
    nrql: "FROM Log WITH if(numeric(a) * 2 > numeric(b) AND numeric(c) < 3, 'y', 'n') AS r SELECT *",
    doc: 'eval-conditional',
    verified: 'llm',
  },
  // Unary NOT around a function
  {
    spl: '* | eval r = if(NOT isnull(x), 1, 0)',
    nrql: 'FROM Log WITH if(x IS NOT NULL, 1, 0) AS r SELECT *',
    doc: 'eval-conditional',
    verified: 'llm',
  },
  // Unary NOT around a parenthesized boolean
  {
    spl: '* | eval r = if(NOT (a AND b), 1, 0)',
    nrql: 'FROM Log WITH if(NOT (a AND b), 1, 0) AS r SELECT *',
    doc: 'eval-conditional',
    verified: 'llm',
  },
  // Concat via dot
  {
    spl: '* | eval r = a . " " . b',
    nrql: "FROM Log WITH concat(a, ' ', b) AS r SELECT *",
    doc: 'eval-string',
    verified: 'llm',
  },
  // + with numeric literal stays arithmetic
  {
    spl: '* | eval r = field + 5',
    nrql: 'FROM Log WITH numeric(field) + 5 AS r SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'llm',
  },
  // + of two bare fields → arithmetic (corpus default: field+field is numeric)
  {
    spl: '* | eval r = f + g',
    nrql: 'FROM Log WITH numeric(f) + numeric(g) AS r SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'llm',
  },
  // Modulo → mod() (emitter rewrites %)
  {
    spl: '* | eval r = a % b',
    nrql: 'FROM Log WITH mod(numeric(a), numeric(b)) AS r SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'llm',
  },
  // == maps to = (with dual-check on numeric value)
  {
    spl: '* | eval r = if(x==1, "y", "n")',
    nrql: "FROM Log WITH if(x = '1' OR numeric(x) = 1, 'y', 'n') AS r SELECT *",
    doc: 'eval-conditional',
    verified: 'llm',
  },
  // Dual-check regression: eval equality with numeric value
  {
    spl: '* | eval r = if(status=500, 1, 0)',
    nrql: "FROM Log WITH if(status = '500' OR numeric(status) = 500, 1, 0) AS r SELECT *",
    doc: 'eval-conditional',
    verified: 'llm',
  },
  // + with a string-returning function operand → concat (not arithmetic)
  {
    spl: '* | eval z = lower(a) + b',
    nrql: 'FROM Log WITH concat(lower(a), b) AS z SELECT *',
    doc: 'eval-string',
    verified: 'llm',
  },
  {
    spl: '* | eval z = tostring(cost) + suffix',
    nrql: 'FROM Log WITH concat(string(cost), suffix) AS z SELECT *',
    doc: 'eval-string',
    verified: 'llm',
  },
  // round()/if() are NOT string-returning → + stays arithmetic
  {
    spl: '* | eval r = round(a) + 1',
    nrql: 'FROM Log WITH round(a) + 1 AS r SELECT *',
    doc: 'fields-eval-arithmetic',
    verified: 'llm',
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

  // AI-DEV: This check MUST throw, not warn. Every case MUST carry a `doc:` tag.
  // The doc generator (afterAll) skips untagged cases (`if (!c.doc) continue`),
  // so an untagged case silently vanishes from SPL_TO_NRQL.md — its translation
  // is never surfaced for review. Do NOT add a skip or exception list without
  // explicit human permission. Fix the cause: add a `doc:` tag (and a matching
  // <!-- spl-cases: TAG --> sentinel, or list the tag in <!-- spl-table-tags -->).
  it('every case has a doc: tag', () => {
    const untagged = [];
    cases.forEach((c, i) => {
      if (!c.doc) untagged.push(`[${i}] ${c.spl === null ? 'null' : c.spl}`);
    });
    if (untagged.length > 0) {
      expect.fail(
        `${untagged.length} test case(s) are missing a doc: tag and would ` +
          `vanish from SPL_TO_NRQL.md. Add a doc: tag to each:\n` +
          untagged.join('\n'),
      );
    }
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

  // AI-DEV: This check MUST throw, not warn. A doc: tag with no sentinel AND no
  // spl-table-tags declaration is documentation rot — the tag points at a section
  // that does not exist. Do NOT downgrade this throw back to console.warn (or add
  // a blanket skip) without explicit human permission: a warning is how this
  // rotted to ~40 orphans before. Every doc: tag MUST either (a) have a
  // <!-- spl-cases: TAG --> / <!-- spl-table: TAG --> sentinel, or (b) be listed
  // in the <!-- spl-table-tags: ... --> directive (parser-leniency / regression
  // groupings that intentionally have no generated section). Fix the cause:
  // add a sentinel, add the tag to spl-table-tags, or delete the dead tag.
  const tableTagsMatch = doc.match(/<!-- spl-table-tags: ([^>]+?) -->/);
  const declaredTableTags = new Set(
    tableTagsMatch
      ? tableTagsMatch[1]
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
  );
  const orphanedTags = [];
  const docTags = new Set(Object.keys(groups));
  for (const tag of docTags) {
    if (!foundTags.has(tag) && !declaredTableTags.has(tag)) {
      orphanedTags.push(tag);
    }
  }
  if (orphanedTags.length > 0) {
    throw new Error(
      `Doc tag(s) with no <!-- spl-cases/spl-table --> sentinel and not in ` +
        `<!-- spl-table-tags --> in SPL_TO_NRQL.md: ${orphanedTags.join(', ')}. ` +
        `Add a sentinel section, add the tag to the spl-table-tags directive, ` +
        `or remove the dead doc: tag from its test case(s).`,
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

  // In CI (CI=true, set by Grand Central/most CI), do NOT write — instead
  // assert the committed doc already matches the generated output, so a stale
  // SPL_TO_NRQL.md fails the build loudly instead of silently dirtying the
  // git workspace. Locally, write the file so contributors regenerate on
  // `npm test` as before.
  if (process.env.CI) {
    const current = fs.readFileSync(DOC_PATH, 'utf8');
    if (current !== doc) {
      throw new Error(
        'docs/SPL_TO_NRQL.md is out of date. Run `npm test` locally and commit ' +
          'the regenerated docs/SPL_TO_NRQL.md.',
      );
    }
  } else {
    fs.writeFileSync(DOC_PATH, doc);
  }
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
