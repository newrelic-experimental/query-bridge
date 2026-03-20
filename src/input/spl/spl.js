/**
 * SPL-to-NRQL translator.
 *
 * Entry point: translateSplToNrql(splString) -> structured clause fragment object.
 * The caller (nrqlQueryBuilder or a bulk migration tool) assembles the full NRQL string.
 */
import {
  escapeAttributeNameForNrql,
  escapeStringLiteralForNrql,
  escapeStringWildcardForNrql,
} from '../../output/nrql/nrqlEncoding.js';

import * as parser from './splParser.js';

const UNSUPPORTED_COMMANDS = {
  // Aggregation variants
  transaction: 'transaction has no NRQL equivalent',
  // eventstats: translated via handleEventstats
  streamstats: 'streamstats has no NRQL equivalent',

  // Multivalue
  makemv: 'multivalue fields have no NRQL equivalent',
  mvcombine: 'multivalue fields have no NRQL equivalent',
  nomv: 'multivalue fields have no NRQL equivalent',

  // Enrichment / external data
  iplocation: 'iplocation has no NRQL equivalent',
  // inputlookup is handled by the grammar → handleInputlookup

  // Write / output commands
  collect: 'write commands have no NRQL equivalent',
  outputlookup: 'write commands have no NRQL equivalent',
  outputcsv: 'write commands have no NRQL equivalent',
  sendemail: 'write commands have no NRQL equivalent',
  sendalert: 'write commands have no NRQL equivalent',
  mcollect: 'write commands have no NRQL equivalent',
  meventcollect: 'write commands have no NRQL equivalent',
  tscollect: 'write commands have no NRQL equivalent',

  // Looping / multi-search
  map: 'map has no NRQL equivalent',
  multisearch: 'multisearch has no NRQL equivalent',
  set: 'set (union/diff/intersect) has no direct NRQL equivalent',
  union: 'union has no direct NRQL equivalent',
  foreach:
    'foreach requires dynamic field name iteration not available in NRQL; enumerate fields manually',

  // Splunk-specific / data model
  // tstats: now handled by grammar → TstatsCommand handler
  datamodel: 'datamodel is Splunk-specific; no NRQL equivalent',
  pivot: 'pivot is Splunk-specific; no NRQL equivalent',
  from: 'SPL from (data model/lookup source) is Splunk-specific; use NRQL FROM',

  // ML / analytics
  apply: 'ML model application has no NRQL equivalent',
  // predict: now handled by grammar → handlePredict
  anomalies: 'anomaly detection is Splunk-specific; no NRQL equivalent',
  anomalousvalue: 'anomaly detection is Splunk-specific; no NRQL equivalent',
  cluster: 'cluster has no NRQL equivalent',
  kmeans: 'kmeans clustering has no NRQL equivalent',
  outlier: 'outlier detection has no NRQL equivalent',
  trendline: 'trendline (moving averages) has no NRQL equivalent',
  x11: 'x11 (seasonal decomposition) has no NRQL equivalent',

  // Field extraction / transformation
  extract:
    'extract (automatic field extraction) has no NRQL equivalent; use capture() for regex extraction or jparse() for JSON fields',
  kvform:
    'kvform (form-based extraction) has no NRQL equivalent; use capture() for regex extraction or aparse() for anchor parsing',
  multikv: 'multikv (table-formatted extraction) has no NRQL equivalent',
  xmlkv:
    'xmlkv auto-extracts XML fields; use jparse() for JSON or capture() for specific XML fields in NRQL',
  xpath: 'xpath has no NRQL equivalent; consider spath for JSON',
  xmlunescape: 'xmlunescape has no NRQL equivalent',

  // Format / reshape
  transpose: 'transpose has no NRQL equivalent',
  untable: 'untable has no NRQL equivalent',
  xyseries: 'xyseries has no NRQL equivalent',
  timewrap:
    'timewrap has no NRQL equivalent; use COMPARE WITH for time comparison',
  // convert is handled by the grammar → handleConvert
  tojson: 'tojson has no NRQL equivalent',
  makecontinuous: 'makecontinuous has no NRQL equivalent',

  // Display / UI
  highlight: 'highlight is a Splunk UI feature; no NRQL equivalent',
  iconify: 'iconify is a Splunk UI feature; no NRQL equivalent',
  tags: 'tags is Splunk-specific; no NRQL equivalent',

  // Metadata / admin
  metadata: 'metadata is Splunk-specific; no NRQL equivalent',
  metasearch: 'metasearch is Splunk-specific; no NRQL equivalent',
  dbinspect: 'dbinspect is Splunk-specific; no NRQL equivalent',
  audit: 'audit is Splunk-specific; no NRQL equivalent',
  rest: 'rest (REST API access) is Splunk-specific; no NRQL equivalent',
  walklex: 'walklex is Splunk-specific; no NRQL equivalent',

  // CSV / file I/O
  inputcsv: 'inputcsv has no NRQL equivalent',
  appendcsv: 'appendcsv has no NRQL equivalent',
  outputtext: 'outputtext has no NRQL equivalent',

  // Job / search management
  loadjob: 'loadjob is Splunk-specific; no NRQL equivalent',
  savedsearch: 'savedsearch is Splunk-specific; no NRQL equivalent',
  localop: 'localop is Splunk-specific; no NRQL equivalent',
  redistribute: 'redistribute is Splunk-specific; no NRQL equivalent',

  // Misc
  abstract: 'abstract has no NRQL equivalent',
  accum: 'accum has no NRQL equivalent; consider WITH for running calculations',
  addcoltotals: 'addcoltotals has no NRQL equivalent',
  addinfo: 'addinfo is Splunk-specific; no NRQL equivalent',
  addtotals: 'addtotals has no NRQL equivalent',
  diff: 'diff has no NRQL equivalent',
  findtypes: 'findtypes is Splunk-specific; no NRQL equivalent',
  format: 'format is Splunk-specific; no NRQL equivalent',
  geom: 'geom has no NRQL equivalent',
  geostats: 'geostats has no NRQL equivalent',
  localize: 'localize is Splunk-specific; no NRQL equivalent',
  makeresults: 'makeresults has no NRQL equivalent',
  overlap: 'overlap is Splunk-specific; no NRQL equivalent',
  rangemap: 'rangemap has no NRQL equivalent',
  reltime: 'reltime has no NRQL equivalent',
  require: 'require is Splunk-specific; no NRQL equivalent',
  return: 'return is Splunk-specific subsearch syntax; no NRQL equivalent',
  rtorder: 'rtorder is Splunk-specific; no NRQL equivalent',
  script: 'script (external scripts) has no NRQL equivalent',
  scrub: 'scrub (anonymization) has no NRQL equivalent',
  searchtxn: 'searchtxn is Splunk-specific; no NRQL equivalent',
  selfjoin:
    'selfjoin has no NRQL equivalent; consider JOIN with same event type',
  setfields: 'setfields has no NRQL equivalent',
  tail: 'tail has no NRQL equivalent (NRQL has no reverse-order limit)',
  typeahead: 'typeahead is Splunk-specific; no NRQL equivalent',
  typer: 'typer is Splunk-specific; no NRQL equivalent',

  // Summary indexing variants (Splunk-specific)
  sichart: 'sichart (summary indexing) is Splunk-specific; no NRQL equivalent',
  sirare: 'sirare (summary indexing) is Splunk-specific; no NRQL equivalent',
  sistats: 'sistats (summary indexing) is Splunk-specific; no NRQL equivalent',
  sitimechart:
    'sitimechart (summary indexing) is Splunk-specific; no NRQL equivalent',
  sitop: 'sitop (summary indexing) is Splunk-specific; no NRQL equivalent',

  // Metrics
  mstats:
    'mstats targets Splunk metrics indexes; translate to FROM Metric SELECT ... in NRQL (requires metric ingestion via Prometheus, OTel, or Metric API)',
  mpreview: 'mpreview is Splunk metrics-specific; no NRQL equivalent',
  msearch: 'msearch is Splunk metrics-specific; no NRQL equivalent',
  mcatalog: 'mcatalog is Splunk metrics-specific; no NRQL equivalent',
};

function emptyResult() {
  return {
    where: '',
    select: [],
    facet: [],
    orderBy: [],
    limit: null,
    since: null,
    until: null,
    timeseries: null,
    with: [],
    join: [],
    from: null,
    errors: [],
    warnings: [],
    unsupported: [],
    unexpandedMacros: [],
    predict: false,
    // Map of field name → replace() expression for | replace commands.
    // Applied to facet/select after all commands are processed.
    fieldReplacements: {},
  };
}

export function translateSplToNrql(spl) {
  if (!spl || !spl.trim()) {
    return emptyResult();
  }

  // Strip YAML multiline indicators that leak into SPL from dashboard exports
  spl = spl.replace(/^>-?\s*\n/, '');

  const result = emptyResult();
  let ast;

  try {
    ast = parser.parse(spl);
  } catch (e) {
    let msg = 'Failed to parse SPL';
    if (e.location) {
      msg += ` at line ${e.location.start.line}:${e.location.start.column}`;
    }
    msg += `: ${e.message}`;
    result.errors.push(msg);
    return result;
  }

  if (ast.search) {
    result.where = translateSearchExpr(ast.search, result);
  }

  for (const cmd of ast.commands) {
    handleCommand(cmd, result, ast);
  }

  // Apply | replace field replacements.
  // If there's aggregation (facet), rewrite facet entries with replace().
  // Otherwise, inline the replace() into select.
  const replacements = result.fieldReplacements;
  if (Object.keys(replacements).length > 0) {
    const hasAggregation = result.facet.length > 0;
    for (const [field, expr] of Object.entries(replacements)) {
      if (hasAggregation) {
        const idx = result.facet.indexOf(field);
        if (idx !== -1) {
          result.facet[idx] = expr;
        }
      } else {
        result.select.push(expr);
      }
    }
  }

  // When a command is fully unsupported and the query has no meaningful output
  // beyond the default FROM Log SELECT *, clear the output so the assembler
  // produces nothing. The unsupported messages are the only useful output.
  if (
    result.unsupported.length > 0 &&
    result.select.length === 0 &&
    !result.where &&
    result.with.length === 0 &&
    result.join.length === 0 &&
    result.facet.length === 0
  ) {
    result.from = '__none__';
  }

  return result;
}

// --- Search expression translation ---

function translateSearchExpr(node, result) {
  if (!node) return '';

  switch (node.type) {
    case 'BooleanOp':
      return translateBooleanOp(node, result);
    case 'Not':
      return translateNot(node, result);
    case 'Comparison':
      return translateComparison(node);
    case 'InComparison':
      return translateInComparison(node);
    case 'BareKeyword':
      return translateBareKeyword(node);
    case 'TimeConstraint':
      return translateTimeConstraint(node, result);
    case 'Macro':
      return translateMacro(node, result);
    case 'TemplateVariable':
      return `{{${node.name}}}`;
    case 'NotSubsearch':
      result.unsupported.push(
        'NOT [subsearch] exclusion pattern; manually convert to NOT IN or WHERE NOT conditions in NRQL',
      );
      return '';
    default:
      result.warnings.push(`Unknown search node type: ${node.type}`);
      return '';
  }
}

function translateBooleanOp(node, result) {
  let left = translateSearchExpr(node.left, result);
  let right = translateSearchExpr(node.right, result);

  if (!left && !right) return '';
  if (!left) return right;
  if (!right) return left;

  // NRQL has reversed precedence: OR binds tighter than AND (opposite of SQL/SPL).
  // To preserve SPL semantics we must parenthesize children whose operator would
  // otherwise be regrouped by NRQL's precedence rules.
  if (node.operator === 'AND') {
    // (a OR b) AND c — parens needed so NRQL doesn't steal the OR
    if (node.left.type === 'BooleanOp' && node.left.operator === 'OR') {
      left = `(${left})`;
    }
    if (node.right.type === 'BooleanOp' && node.right.operator === 'OR') {
      right = `(${right})`;
    }
  } else if (node.operator === 'OR') {
    // a OR (b AND c) — parens needed because NRQL OR binds tighter than AND
    if (node.left.type === 'BooleanOp' && node.left.operator === 'AND') {
      left = `(${left})`;
    }
    if (node.right.type === 'BooleanOp' && node.right.operator === 'AND') {
      right = `(${right})`;
    }
  }

  return `${left} ${node.operator} ${right}`;
}

function translateNot(node, result) {
  const inner = translateSearchExpr(node.operand, result);
  if (!inner) return '';
  if (node.operand.type === 'BooleanOp') {
    return `NOT (${inner})`;
  }
  return `NOT ${inner}`;
}

function translateComparison(node) {
  const { field, value, operator: op } = node;

  // Metadata fields (index, sourcetype, source, host) are translated as
  // attribute filters. No warning needed — this is the expected mapping.

  if (value.includes('*')) {
    const escapedField = escapeField(field);
    if (op === '=') return `${escapedField} LIKE '${escapeWildcard(value)}'`;
    if (op === '!=')
      return `${escapedField} NOT LIKE '${escapeWildcard(value)}'`;
  }

  return formatNumericAwareComparison(field, op, value);
}

function translateInComparison(node) {
  const escapedField = escapeField(node.field);
  const hasWildcards = node.values.some((v) => v.includes('*'));

  if (hasWildcards) {
    const parts = node.values.map((v) => {
      if (v.includes('*')) return `${escapedField} LIKE '${escapeWildcard(v)}'`;
      return `${escapedField} = ${formatValue(v)}`;
    });
    return `(${parts.join(' OR ')})`;
  }

  return `${escapedField} IN (${node.values.map(formatValue).join(', ')})`;
}

function translateBareKeyword(node) {
  const value = node.value;
  if (!value || value === '*') return '';
  // SPL bare keywords search _raw (the raw log line), not all fields.
  // NRQL equivalent: message LIKE '%term%' (case-insensitive by default).
  const escaped = escapeWildcard(value);
  return `message LIKE '%${escaped}%'`;
}

function translateTimeConstraint(node, result) {
  const { nrql, warning } = parseSplTime(node.value);
  if (warning) result.warnings.push(warning);
  if (nrql) {
    if (node.param === 'earliest') {
      result.since = nrql;
    } else {
      result.until = nrql;
    }
  }
  return '';
}

// Assumes customer has created an NRQL macro with the same name as the SPL macro.
// NRQL macros use $name syntax and support parameters via $name(arg1, arg2).
// Ref: newrelic.atlassian.net/wiki/spaces/DIA/pages/5137268737
function translateMacro(node, result) {
  const argsStr = node.args.length > 0 ? `(${node.args.join(', ')})` : '';
  const nrqlMacro = `$${node.name}${argsStr}`;
  result.warnings.push(
    `SPL macro \`${node.name}\` translated to NRQL macro ${nrqlMacro}; ensure a matching NRQL macro exists`,
  );
  result.unexpandedMacros.push({ name: node.name, args: node.args });
  return nrqlMacro;
}

// --- Command handlers ---

function handleCommand(cmd, result, ast) {
  switch (cmd.type) {
    case 'StatsCommand':
      return handleStats(cmd, result);
    case 'TimechartCommand':
      return handleTimechart(cmd, result);
    case 'ChartCommand':
      return handleStats(cmd, result);
    case 'WhereCommand':
      return handleWhere(cmd, result);
    case 'SearchCommand':
      return handleSearchPipe(cmd, result);
    case 'TableCommand':
      return handleTable(cmd, result);
    case 'FieldsCommand':
      return handleFields(cmd, result);
    case 'SortCommand':
      return handleSort(cmd, result);
    case 'HeadCommand':
      result.limit = cmd.count;
      return;
    case 'TopCommand':
      return handleTop(cmd, result);
    case 'RenameCommand':
      return handleRename(cmd, result);
    case 'DedupCommand':
      return handleDedup(cmd, result);
    case 'EvalCommand':
      return handleEval(cmd, result);
    case 'SpathCommand':
      return handleSpath(cmd, result);
    case 'JoinCommand':
      return handleJoin(cmd, result);
    case 'AppendCommand':
      return handleAppend(cmd, result, 'append');
    case 'AppendcolsCommand':
      return handleAppend(cmd, result, 'appendcols');
    case 'AppendpipeCommand':
      return handleAppendpipe(cmd, result);
    case 'RegexCommand':
      return handleRegex(cmd, result);
    case 'FillnullCommand':
      return handleFillnull(cmd, result);
    case 'RareCommand':
      return handleRare(cmd, result);
    case 'ReverseCommand':
      result.orderBy.push('timestamp ASC');
      return;
    case 'StrcatCommand':
      return handleStrcat(cmd, result);
    case 'UniqCommand':
      result.unsupported.push(
        'uniq has no direct NRQL equivalent; use uniques(field) to get distinct values of a field, or use FACET field LIMIT MAX for deduplication',
      );
      return;
    case 'MvexpandCommand':
      return handleMvexpand(cmd, result, ast);
    case 'ReplaceCommand': {
      const rField = escapeField(cmd.field);
      const pairs = cmd.pairs || [
        { oldValue: cmd.oldValue, newValue: cmd.newValue },
      ];
      // Chain replace() calls for multiple pairs: replace(replace(field, old1, new1), old2, new2)
      let expr = rField;
      for (const pair of pairs) {
        const rOld = `'${escapeStringLiteralForNrql(pair.oldValue)}'`;
        const rNew = `'${escapeStringLiteralForNrql(pair.newValue)}'`;
        expr = `replace(${expr}, ${rOld}, ${rNew})`;
      }
      result.fieldReplacements[rField] = expr;
      return;
    }
    case 'TstatsCommand':
      result.unsupported.push(
        'tstats queries target Splunk CIM data models which normalize events from multiple sourcetypes into a standard schema. To translate, identify which sourcetypes populate the data model in your Splunk deployment, then query those events directly using their raw field names.',
      );
      return;
    case 'PredictCommand':
      result.predict = true;
      if (!result.timeseries) {
        result.warnings.push(
          'PREDICT requires TIMESERIES; add a timechart or bin _time before predict',
        );
      }
      return;
    case 'EventstatsCommand':
      return handleEventstats(cmd, result);
    case 'ConvertCommand':
      return handleConvert(cmd, result);
    case 'RexCommand':
      return handleRex(cmd, result);
    case 'LookupCommand':
      return handleLookup(cmd, result);
    case 'InputlookupCommand':
      return handleInputlookup(cmd, result);
    case 'BinCommand':
      // bin _time span=X → TIMESERIES X (with count(*) default)
      // bin field span=N → SELECT histogram(field, N)
      // Ref: docs.newrelic.com/docs/nrql/using-nrql/nrql-segment-your-data-buckets/
      if (cmd.field === '_time' && cmd.span) {
        result.timeseries = formatSpan(cmd.span);
        // TIMESERIES requires an aggregate; default to count(*) if none present
        if (result.select.length === 0) {
          result.select.push('count(*)');
        }
      } else if (cmd.field && cmd.width) {
        // histogram() is a SELECT-level aggregation, not a FACET function
        result.select.push(
          `histogram(${escapeField(cmd.field)}, ${cmd.width})`,
        );
      } else {
        result.unsupported.push(
          'bin command not fully supported; use TIMESERIES for time or histogram() for numeric fields',
        );
      }
      return;
    case 'MacroCommand': {
      const argsStr = cmd.args.length > 0 ? `(${cmd.args.join(', ')})` : '';
      const nrqlMacro = `$${cmd.name}${argsStr}`;
      result.warnings.push(
        `SPL macro \`${cmd.name}\` translated to NRQL macro ${nrqlMacro}; ensure a matching NRQL macro exists`,
      );
      result.unexpandedMacros.push({ name: cmd.name, args: cmd.args });
      // Emit macro as a WHERE fragment — NRQL gateway will expand it
      if (result.where) {
        result.where += ` AND ${nrqlMacro}`;
      } else {
        result.where = nrqlMacro;
      }
      return;
    }
    case 'UnsupportedCommand':
      result.unsupported.push(
        UNSUPPORTED_COMMANDS[cmd.name] ||
          `SPL command '${cmd.name}' has no known NRQL equivalent`,
      );
      return;
    default:
      result.unsupported.push(`Unknown command type: ${cmd.type}`);
  }
}

function wrapAsSubquery(result) {
  const innerFrom = result.from || 'Log';
  const innerWith = result.with.length ? ` WITH ${result.with.join(', ')}` : '';
  const innerSelect = result.select.length
    ? result.select.join(', ')
    : 'count(*)';
  const innerWhere = result.where ? ` WHERE ${result.where}` : '';
  const innerFacet = result.facet.length
    ? ` FACET ${result.facet.join(', ')}`
    : '';
  const innerLimit = result.facet.length ? ' LIMIT MAX' : '';

  result.from = `(FROM ${innerFrom}${innerWith} SELECT ${innerSelect}${innerWhere}${innerFacet}${innerLimit})`;
  result.select = [];
  result.facet = [];
  result.with = [];
  result.where = '';
}

function handleStats(cmd, result) {
  if (result._hasStatsAggregation && result.select.length > 0) {
    wrapAsSubquery(result);
  } else if (result.select.length > 0) {
    result.select = [];
    result.facet = [];
  }

  for (const fn of cmd.functions) {
    if (fn.evalFilter) {
      // count(eval(expr)) → filter(count(*), WHERE expr)
      const filterExpr = fn.evalFilter.replace(
        /[a-zA-Z_][a-zA-Z0-9_]*/g,
        (match) => {
          if (/^(AND|OR|NOT|true|false|null)$/i.test(match)) return match;
          return `numeric(${escapeField(match)})`;
        },
      );
      const aliasStr = fn.alias
        ? ` AS '${escapeStringLiteralForNrql(fn.alias)}'`
        : '';
      result.select.push(`filter(count(*), WHERE ${filterExpr})${aliasStr}`);
      continue;
    }
    const mapped = mapSplFunction(fn.name, fn.args);
    if (mapped.warning) result.warnings.push(mapped.warning);
    if (mapped.nrql) {
      const aliasStr = fn.alias
        ? ` AS '${escapeStringLiteralForNrql(fn.alias)}'`
        : '';
      result.select.push(mapped.nrql + aliasStr);
    }
  }

  for (const field of cmd.groupBy) {
    result.facet.push(escapeField(field));
  }

  result._hasAggregation = true;
  result._hasStatsAggregation = true;
}

function handleMvexpand(cmd, result, ast) {
  // mvexpand creates one row per value in a multivalue field.
  // NRQL has no row multiplication, but many mvexpand patterns work without it:
  //
  // 1. expand-then-filter: | mvexpand field | search field="x"
  //    → The NRQL WHERE clause already filters; no expansion needed.
  //
  // 2. dedup round-trip: | stats values(f) | mvexpand f
  //    → Skip the round-trip; use FACET or uniques() directly.
  //
  // 3. expand-then-aggregate: | mvexpand field | stats count by field
  //    → Truly needs row multiplication. Unsupported.
  //
  // 4. symmetric counting: | eval x=mvappend(a,b) | mvexpand x | stats count by x
  //    → Truly needs row multiplication. Unsupported.

  const field = cmd.field;

  // Look at subsequent commands to determine if expansion is actually needed
  const cmdIndex = ast.commands.indexOf(cmd);
  const remaining = ast.commands.slice(cmdIndex + 1);

  // Check if any subsequent command aggregates BY the expanded field
  const aggregatesByField = remaining.some(
    (c) =>
      (c.type === 'StatsCommand' ||
        c.type === 'TimechartCommand' ||
        c.type === 'ChartCommand') &&
      c.groupBy &&
      c.groupBy.includes(field),
  );

  if (aggregatesByField) {
    // Pattern 3/4: needs actual row multiplication — unsupported
    result.unsupported.push(
      `mvexpand ${field} followed by aggregation requires row multiplication, which NRQL cannot do; ` +
        `consider restructuring the data at ingest time (one event per ${field} value)`,
    );
  } else {
    // Pattern 1/2: the NRQL output works without expansion
    result.warnings.push(
      `mvexpand ${field} skipped; NRQL does not expand multivalue fields into rows, ` +
        `but filtering and selection on the field still work`,
    );
  }
}

function handleEventstats(cmd, result) {
  // eventstats adds aggregated values as new columns to every row.
  // NRQL equivalent: subquery JOIN enriches rows with aggregated data.
  //   FROM Log JOIN (FROM Log SELECT func(field) FACET groupBy LIMIT MAX) ON groupBy SELECT *
  // Without BY clause, there's no NRQL equivalent for adding a global scalar to every row.

  const subSelectParts = [];
  for (const fn of cmd.functions) {
    const mapped = mapSplFunction(fn.name, fn.args);
    if (mapped.warning) result.warnings.push(mapped.warning);
    if (mapped.nrql) {
      const alias = fn.alias || fn.args[0] || fn.name;
      subSelectParts.push(
        `${mapped.nrql} AS '${escapeStringLiteralForNrql(alias)}'`,
      );
    }
  }

  if (subSelectParts.length === 0) return;

  if (cmd.groupBy.length > 0) {
    const facetFields = cmd.groupBy.map(escapeField);
    const fromClause = result.from || 'Log';
    if (facetFields.length === 1) {
      const subquery =
        `FROM ${fromClause} SELECT ${subSelectParts.join(', ')} ` +
        `FACET ${facetFields.join(', ')} LIMIT MAX`;
      const onClause = `${facetFields[0]} = ${facetFields[0]}`;
      result.join.push(`(${subquery}) ON ${onClause}`);
    } else {
      // NRQL JOIN only supports a single ON key; multi-key BY cannot be translated
      result.unsupported.push(
        `eventstats with multiple BY fields (${cmd.groupBy.join(', ')}) ` +
          `cannot be translated; NRQL subquery JOIN only supports a single ON key`,
      );
      return;
    }
    result.warnings.push(
      'NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit',
    );
  } else {
    // No BY clause — global aggregate added to every row via scalar subquery.
    // NRQL supports inline subqueries: SELECT *, (SELECT func() FROM Log) AS alias
    const fromClause = result.from || 'Log';
    for (const fn of cmd.functions) {
      const mapped = mapSplFunction(fn.name, fn.args);
      if (mapped.warning) result.warnings.push(mapped.warning);
      if (mapped.nrql) {
        const alias = fn.alias || fn.args[0] || fn.name;
        result.select.push(
          `(SELECT ${mapped.nrql} FROM ${fromClause}) AS '${escapeStringLiteralForNrql(alias)}'`,
        );
      }
    }
  }
}

function handleTimechart(cmd, result) {
  handleStats(cmd, result);
  result.timeseries = cmd.span ? formatSpan(cmd.span) : 'AUTO';
}

function handleWhere(cmd, result) {
  const whereClause = translateWhereExpr(cmd.expression, result);
  if (!whereClause) return;

  if (result._hasAggregation) {
    // Wrap the aggregation as a subquery so WHERE filters aggregated results
    wrapAsSubquery(result);
    result.where = whereClause;
    result._hasAggregation = false;
  } else {
    result.where = result.where
      ? `${result.where} AND ${whereClause}`
      : whereClause;
  }
}

function handleSearchPipe(cmd, result) {
  const clause = translateSearchExpr(cmd.expression, result);
  if (clause) {
    result.where = result.where ? `${result.where} AND ${clause}` : clause;
  }
}

function handleTable(cmd, result) {
  for (const field of cmd.fields) {
    // SPL _time is Splunk's timestamp; NRQL events always include timestamp implicitly.
    if (field === '_time') continue;
    result.select.push(field === '*' ? '*' : escapeField(field));
  }
}

function handleFields(cmd, result) {
  if (cmd.mode === '-') {
    result.unsupported.push(
      `fields - (exclude) has no NRQL equivalent; NRQL cannot exclude specific fields from SELECT *`,
    );
    return;
  }
  for (const field of cmd.fields) {
    if (field === '_time') continue;
    result.select.push(field === '*' ? '*' : escapeField(field));
  }
}

function handleSort(cmd, result) {
  for (const sf of cmd.fields) {
    result.orderBy.push(
      `${sf.field} ${sf.direction === 'desc' ? 'DESC' : 'ASC'}`,
    );
  }
}

// SPL `top N field by group` returns top N per group (partitioned top-N).
// NRQL has no equivalent — subqueries can't reference outer query attributes,
// FACET CASES is for custom grouping, and JOIN is for combining datasets.
// Current translation emits global top across all FACET combinations.
// Ref: docs.newrelic.com/docs/nrql/using-nrql/subqueries-in-nrql/
//      docs.newrelic.com/docs/nrql/using-nrql/subquery-joins/
function handleTop(cmd, result) {
  const countAlias = cmd.countfield
    ? ` AS '${escapeStringLiteralForNrql(cmd.countfield)}'`
    : '';
  result.select.push(`count(*)${countAlias}`);
  result.facet.push(escapeField(cmd.field));
  result.limit = cmd.count === 0 ? 'MAX' : cmd.count;

  if (cmd.showperc !== false) {
    const fromClause = result.from || 'Log';
    const whereClause = result.where ? ` WHERE ${result.where}` : '';
    const percAlias = cmd.percentfield
      ? escapeStringLiteralForNrql(cmd.percentfield)
      : 'percent';
    result.select.push(
      `count(*) * 100.0 / (SELECT count(*) FROM ${fromClause}${whereClause}) AS '${percAlias}'`,
    );
  }

  if (cmd.groupBy.length > 0) {
    for (const field of cmd.groupBy) {
      result.facet.push(escapeField(field));
    }
    result.warnings.push(
      `top with groupBy approximated as global FACET; SPL top returns top ${cmd.count} per group`,
    );
  }

  result._hasAggregation = true;

  if (cmd.useother) {
    result.warnings.push(
      'useother=true not supported; NRQL FACET has no "OTHER" bucket',
    );
  }
}

function handleRename(cmd, result) {
  for (const rename of cmd.renames) {
    if (rename.from.includes('*') || rename.to.includes('*')) {
      result.unsupported.push(
        `Wildcard rename (${rename.from} as ${rename.to}) not supported in NRQL; rename specific fields`,
      );
      continue;
    }
    let found = false;
    const escapedFrom = escapeField(rename.from);
    result.select = result.select.map((s) => {
      if (s === escapedFrom || s.endsWith(`AS '${rename.from}'`)) {
        found = true;
        return `${s.replace(/ AS '.*'$/, '')} AS '${escapeStringLiteralForNrql(rename.to)}'`;
      }
      return s;
    });
    if (!found) {
      result.select.push(
        `${escapedFrom} AS '${escapeStringLiteralForNrql(rename.to)}'`,
      );
    }
  }
}

function handleDedup(cmd, result) {
  for (const field of cmd.fields) {
    const escaped = escapeField(field);
    if (!result.facet.includes(escaped)) {
      result.facet.push(escaped);
    }
  }
  if (result.select.length === 0) {
    result.select.push('latest(timestamp)');
  }
  result.limit = 'MAX';
  result._hasAggregation = true;
  result.warnings.push(
    'dedup translated to FACET; add latest(field) for each field you want to keep',
  );
}

function handleConvert(cmd, result) {
  if (cmd.rawText) {
    result.unsupported.push(
      `convert command could not be fully parsed: ${cmd.rawText}`,
    );
    return;
  }
  for (const spec of cmd.specs) {
    const translated = translateConvertFunc(spec, result);
    if (translated) {
      // When no alias is given, SPL convert overwrites the field in-place.
      // NRQL WITH clause can't alias to the same name (circular dependency),
      // so we append _converted when alias matches the source field.
      let alias = spec.alias || spec.field;
      if (alias === spec.field) {
        alias = `${spec.field}_converted`;
        result.warnings.push(
          `convert ${spec.name}(${spec.field}): NRQL cannot overwrite a field in-place; aliased to ${alias}`,
        );
      }
      result.with.push(
        `${translated} AS \`${escapeAttributeNameForNrql(alias)}\``,
      );
    }
  }
}

function translateConvertFunc(spec, result) {
  const field = escapeField(spec.field);
  switch (spec.name) {
    case 'num':
      return `numeric(${field})`;
    case 'rmcomma':
      return `numeric(replace(${field}, ',', ''))`;
    case 'ctime':
      return `toDatetime(${field})`;
    case 'mktime':
      result.warnings.push(
        'mktime translated to toTimestamp(); expects ISO 8601 or epoch format in NRQL',
      );
      return `toTimestamp(${field})`;
    case 'dur2sec':
      // Combined if() handles both HH:MM:SS (contains ':') and Go-style durations (µs/ms/s)
      result.warnings.push(
        'dur2sec translated with multi-branch if(); supports Go-style durations (µs/ms/s) and HH:MM:SS format',
      );
      return (
        `if(${field} LIKE '%:%', ` +
        `numeric(substring(${field}, 0, position(${field}, ':', 0))) * 3600 + ` +
        `numeric(substring(${field}, position(${field}, ':', 0) + 1, position(${field}, ':', 1) - position(${field}, ':', 0) - 1)) * 60 + ` +
        `numeric(substring(${field}, position(${field}, ':', 1) + 1)), ` +
        `if(${field} LIKE '%µs', numeric(substring(${field}, 0, length(${field}) - 3)) / 1000000, ` +
        `if(${field} LIKE '%ms', numeric(substring(${field}, 0, length(${field}) - 2)) / 1000, ` +
        `if(${field} LIKE '%s', numeric(substring(${field}, 0, length(${field}) - 1)), ` +
        `numeric(${field})))))`
      );
    case 'mstime':
      // MM:SS.SSS → seconds
      return (
        `numeric(substring(${field}, 0, position(${field}, ':', 0))) * 60 + ` +
        `numeric(substring(${field}, position(${field}, ':', 0) + 1))`
      );
    case 'rmunit':
      result.unsupported.push(
        "rmunit not supported; NRQL numeric() can't strip arbitrary unit suffixes. Consider normalizing units at ingest time",
      );
      return null;
    case 'memk':
      result.unsupported.push(
        'memk not supported; memory data in New Relic is typically already numeric (bytes). Consider normalizing at ingest time',
      );
      return null;
    case 'auto':
      result.unsupported.push(
        'auto not supported; use num() for explicit numeric conversion',
      );
      return null;
    default:
      result.unsupported.push(
        `convert function '${spec.name}' is not supported`,
      );
      return null;
  }
}

// Assumes customer has uploaded a lookup table with the same name via the Lookups UI.
// Assumes customer has uploaded a lookup table with the same name via the Lookups UI.
// Emits a JOIN clause fragment for the caller to assemble.
// Note: TIMESERIES is supported in the outer query but not inside the joined subquery.
// Ref: docs.newrelic.com/docs/nrql/using-nrql/subquery-joins/
function handleLookup(cmd, result) {
  const table = cmd.table;
  // Use the alias as the join key if provided (lookup table keyField AS alias)
  const joinKey = cmd.keyAlias
    ? escapeField(cmd.keyAlias)
    : escapeField(cmd.key);
  const lookupKey = escapeField(cmd.key);
  // JOIN subqueries require at least 2 SELECT values (join key + data fields)
  let outputFields;
  if (cmd.outputFields.length > 0) {
    // outputFields are {name, alias} objects
    const escaped = cmd.outputFields.map((f) => {
      const field = escapeField(f.name);
      return f.alias ? `${field} AS '${f.alias}'` : field;
    });
    // Always include the join key so the subquery has ≥2 values
    if (
      !escaped.some((f) => f === lookupKey || f.startsWith(lookupKey + ' '))
    ) {
      escaped.unshift(lookupKey);
    }
    outputFields = escaped.join(', ');
  } else {
    outputFields = '*';
  }

  const onClause = cmd.keyAlias
    ? `${joinKey} = ${lookupKey}`
    : `${lookupKey} = ${lookupKey}`;
  result.join.push(
    `(FROM lookup(${table}) SELECT ${outputFields} LIMIT MAX) ON ${onClause}`,
  );
  result.warnings.push(
    `Ensure lookup table '${table}' is uploaded via the Lookups UI`,
  );
}

function handleInputlookup(cmd, result) {
  result.from = `lookup(${cmd.table})`;
  result.warnings.push(
    `Ensure lookup table '${cmd.table}' is uploaded via the Lookups UI`,
  );
  if (cmd.append) {
    result.warnings.push(
      'inputlookup append=true has no NRQL equivalent; lookup table replaces the result set instead of appending to it',
    );
  }
  if (cmd.where) {
    result.warnings.push(
      'inputlookup WHERE condition translated as-is; verify field names match the lookup table schema',
    );
    const whereClause = cmd.where.trim();
    if (result.where) {
      result.where += ` AND ${whereClause}`;
    } else {
      result.where = whereClause;
    }
  }
}

const NAMED_GROUP_REGEX = /\(\?<([^>]+)>/g;
const PCRE_ONLY_REGEX = /\(\?<=|\(\?<!|\(\?=|\(\?!|\(\?>|\\[0-9]/;

function handleRex(cmd, result) {
  if (cmd.mode === 'sed') {
    result.unsupported.push(
      'rex mode=sed (regex substitution) has no NRQL equivalent',
    );
    return;
  }

  if (cmd.mode !== 'extract' || !cmd.pattern) {
    result.unsupported.push('rex command could not be parsed');
    return;
  }

  // Extract named group names from the pattern
  const names = [];
  let match;
  const groupRegex = /\(\?(?:P<|<)([^>]+)>/g;
  while ((match = groupRegex.exec(cmd.pattern)) !== null) {
    names.push(match[1]);
  }

  if (names.length === 0) {
    result.unsupported.push(
      'rex pattern has no named capture groups; nothing to extract',
    );
    return;
  }

  if (cmd.maxMatch) {
    result.unsupported.push(
      'rex max_match not supported; NRQL capture() returns first match only',
    );
  }

  // Check for PCRE-only features that RE2 doesn't support
  if (PCRE_ONLY_REGEX.test(cmd.pattern)) {
    result.warnings.push(
      'SPL uses a PCRE-style regex engine, while NRQL uses an RE2-style regex engine. We have tried to translate it, but you need to check this carefully.',
    );
  }

  // Convert (?<name>...) to (?P<name>...) for RE2/NRQL
  const nrqlPattern = cmd.pattern.replace(NAMED_GROUP_REGEX, '(?P<$1>');

  // Map _raw to message (NR standard log attribute)
  const field = cmd.field === '_raw' ? 'message' : cmd.field;

  // Pad with .* for full-string match (NRQL capture must match entire input)
  const fullPattern = `.*${nrqlPattern}.*`;

  result.with.push(
    `capture(${escapeField(field)}, r'${fullPattern}') AS (${names.join(', ')})`,
  );
}

function handleRegex(cmd, result) {
  if (!cmd.pattern) {
    result.unsupported.push(
      `regex command could not be parsed: ${cmd.rawText || ''}`,
    );
    return;
  }

  const field = cmd.field === '_raw' ? 'message' : cmd.field;
  const escapedField = escapeField(field);
  // Regex patterns must not be string-escaped — backslashes are regex syntax
  const pattern = cmd.pattern;
  const op = cmd.negate ? 'NOT RLIKE' : 'RLIKE';
  const clause = `${escapedField} ${op} '${pattern}'`;

  result.where = result.where ? `${result.where} AND ${clause}` : clause;
}

function handleFillnull(cmd, result) {
  if (cmd.fields.length === 0) {
    result.warnings.push(
      'fillnull without field list applies to all fields; specify fields for NRQL translation',
    );
    return;
  }

  const defaultValue = looksLikeNumber(cmd.value)
    ? cmd.value
    : `'${escapeStringLiteralForNrql(cmd.value)}'`;

  for (const field of cmd.fields) {
    const escaped = escapeField(field);
    // NRQL WITH cannot alias a field to itself (circular dependency).
    // Use a suffixed alias name to avoid the conflict.
    const alias = `\`${escapeAttributeNameForNrql(field)}_filled\``;
    result.with.push(
      `if(${escaped} IS NULL, ${defaultValue}, ${escaped}) AS ${alias}`,
    );
  }
  result.warnings.push(
    'fillnull creates new fields with _filled suffix to avoid NRQL circular dependency; ' +
      'downstream references may need updating',
  );
}

function handleRare(cmd, result) {
  result.select.push('count(*)');
  result.facet.push(escapeField(cmd.field));
  result.orderBy.push('count ASC');
  result.limit = cmd.count;

  for (const field of cmd.groupBy) {
    result.facet.push(escapeField(field));
  }

  result._hasAggregation = true;
}

function handleStrcat(cmd, result) {
  if (cmd.parts.length < 2) {
    result.unsupported.push('strcat requires at least two arguments');
    return;
  }

  // Last part is the destination field
  const dest = cmd.parts[cmd.parts.length - 1];
  const sources = cmd.parts.slice(0, -1);

  const concatArgs = sources
    .map((p) =>
      p.type === 'literal'
        ? `'${escapeStringLiteralForNrql(p.value)}'`
        : escapeField(p.value),
    )
    .join(', ');

  result.with.push(`concat(${concatArgs}) AS ${escapeField(dest.value)}`);
}

function handleJoin(cmd, result) {
  if (cmd.joinType === 'outer') {
    result.unsupported.push(
      'NRQL does not support full outer join; only INNER and LEFT joins are available',
    );
    return;
  }

  const joinType = cmd.joinType.toUpperCase();
  const key = escapeField(cmd.field);

  // Recursively translate the subsearch
  const sub = translateSplToNrql(cmd.subsearch.trim());

  // Forward subsearch warnings/unsupported to the parent result
  for (const w of sub.warnings) result.warnings.push(`join subsearch: ${w}`);
  for (const u of sub.unsupported)
    result.unsupported.push(`join subsearch: ${u}`);

  const selectClause = sub.select.length > 0 ? sub.select.join(', ') : '*';
  const whereClause = sub.where ? ` WHERE ${sub.where}` : '';
  const facetClause =
    sub.facet.length > 0 ? ` FACET ${sub.facet.join(', ')}` : '';
  const limitClause = sub.limit ? ` LIMIT ${sub.limit}` : ' LIMIT MAX';

  const subquery = `SELECT ${selectClause} FROM Log${whereClause}${facetClause}${limitClause}`;

  result.join.push(`${joinType} (${subquery}) ON ${key} = ${key}`);
  result.warnings.push(
    'NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit',
  );
}

function handleAppendpipe(cmd, result) {
  result.warnings.push(
    'appendpipe ignored; NRQL handles empty results natively',
  );
}

function handleAppend(cmd, result, label = 'append') {
  // Recursively translate the subsearch (same pattern as handleJoin)
  const sub = translateSplToNrql(cmd.subsearch.trim());

  // Forward subsearch warnings/unsupported to the parent result
  for (const w of sub.warnings)
    result.warnings.push(`${label} subsearch: ${w}`);
  for (const u of sub.unsupported)
    result.unsupported.push(`${label} subsearch: ${u}`);

  // Both sides must have aggregations to merge
  if (result.select.length === 0 || sub.select.length === 0) {
    result.unsupported.push(
      `${label} with subsearch cannot be automatically translated; consider using filter() to compute multiple aggregations in a single query`,
    );
    return;
  }

  // If both sides have matching FACET, keep it; if they differ, bail
  const mainFacet = result.facet.join(', ');
  const subFacet = sub.facet.join(', ');
  if (mainFacet !== subFacet) {
    result.unsupported.push(
      `${label} with subsearch cannot be automatically translated; the main query and subsearch group by different fields`,
    );
    return;
  }

  const mainWhere = result.where || '';
  const subWhere = sub.where || '';

  // Pattern A: Same WHERE (or both empty) — just merge the SELECT lists
  if (mainWhere === subWhere) {
    for (const s of sub.select) result.select.push(s);
    result.warnings.push(
      `${label} merged into a single query; SPL append runs the subsearch independently, but here both sides query the same events`,
    );
    return;
  }

  // Pattern B: Different WHERE — wrap each aggregation in filter()
  // filter() works with any aggregation: filter(count(*), WHERE ...), filter(average(x), WHERE ...), etc.
  // Handles both aliased ("avg(x) AS name") and bare ("avg(x)") aggregations.
  const aliasPattern = /^(.+)\s+AS\s+(.+)$/i;

  function wrapInFilter(selectExpr, whereClause) {
    const cond = whereClause ? `WHERE ${whereClause}` : '';
    const m = selectExpr.match(aliasPattern);
    if (m) {
      return `filter(${m[1]}, ${cond}) AS ${m[2]}`;
    }
    return `filter(${selectExpr}, ${cond})`;
  }

  result.select = result.select.map((s) => wrapInFilter(s, mainWhere));
  for (const s of sub.select) {
    result.select.push(wrapInFilter(s, subWhere));
  }
  result.where = '';
  result.warnings.push(
    `${label} translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log`,
  );
}

function buildEvalExpr(exprStr) {
  // The grammar returns a string like "bytes / 1024" with field names unescaped.
  const hasArithmetic = /[+\-*/%]/.test(exprStr);
  let nrql = exprStr.replace(/[a-zA-Z_][a-zA-Z0-9_.\-:]*/g, (match) => {
    // Wrap field references in numeric() when the expression contains arithmetic —
    // Splunk coerces strings to numbers automatically, NRQL needs numeric().
    return hasArithmetic
      ? `numeric(${escapeField(match)})`
      : escapeField(match);
  });
  // NRQL uses mod(a, b) not infix a % b
  nrql = nrql.replace(/(\S+)\s*%\s*(\S+)/g, 'mod($1, $2)');
  return nrql;
}

/**
 * Build a NRQL expression to extract the Nth element from a delimited string.
 * Translates SPL's mvindex(split(field, delim), N) pattern.
 *
 * Element 0: substring(field, 0, position(field, delim, 0))
 * Element N: substring(field, position(field, delim, N-1) + delimLen,
 *              position(field, delim, N) - position(field, delim, N-1) - delimLen)
 *
 * For the last element (when position returns null for the Nth delimiter),
 * NRQL substring with null length returns empty — so we use an if() guard.
 */
function buildSplitIndexExpr(field, delim, n) {
  // Strip quotes from delimiter to get raw char for length calc
  const rawDelim = delim.replace(/^'|'$/g, '');
  const delimLen = rawDelim.length;
  if (n === 0) {
    return `substring(${field}, 0, position(${field}, ${delim}, 0))`;
  }
  const prevPos = `position(${field}, ${delim}, ${n - 1})`;
  const currPos = `position(${field}, ${delim}, ${n})`;
  // Use if() to handle last element: when currPos is null, take everything from prevPos+delimLen
  return `if(${currPos} IS NULL, substring(${field}, ${prevPos} + ${delimLen}), substring(${field}, ${prevPos} + ${delimLen}, ${currPos} - ${prevPos} - ${delimLen}))`;
}

/**
 * Build a NRQL expression for replace(field, literal, replacement).
 * Only handles simple literal deletion (replacement = '') or literal substitution.
 * Regex patterns are not supported — those stay unsupported.
 */

function handleEval(cmd, result) {
  if (cmd.rawText) {
    result.unsupported.push(`eval expression not supported: ${cmd.rawText}`);
    return;
  }
  for (const assignment of cmd.assignments) {
    const field = escapeField(assignment.field);
    const expr = assignment.expr;
    const translated =
      typeof expr === 'object'
        ? translateEvalNode(expr, result)
        : buildEvalExpr(expr);
    // NRQL WITH clause can't alias to the same name (circular dependency).
    // If the expression references the field being assigned, inline into SELECT instead.
    if (translated.includes(field)) {
      result.select.push(translated);
    } else {
      result.with.push(`${translated} AS ${field}`);
    }
  }
}

function translateEvalNode(node, result) {
  if (typeof node === 'string') return buildEvalExpr(node);

  switch (node.type) {
    case 'EvalFunc':
      return translateEvalFunc(node, result);
    case 'StringLiteral':
      return `'${escapeStringLiteralForNrql(node.value)}'`;
    case 'EvalComparison': {
      const left = translateEvalNode(node.left, result);
      const right = translateEvalNode(node.right, result);
      const op = node.op === '==' ? '=' : node.op;
      // For ordering operators, wrap plain field names in numeric().
      // buildEvalExpr already handles arithmetic expressions (adds numeric()
      // to each field), so only wrap simple field names here.
      if (['>', '>=', '<', '<='].includes(op)) {
        const isPlainField = (raw) =>
          typeof raw === 'string' &&
          !looksLikeNumber(raw) &&
          !/[+\-*/%()]/.test(raw);
        const numLeft = isPlainField(node.left) ? `numeric(${left})` : left;
        const numRight = isPlainField(node.right) ? `numeric(${right})` : right;
        return `${numLeft} ${op} ${numRight}`;
      }
      return `${left} ${op} ${right}`;
    }
    case 'EvalBoolOp': {
      const left = translateEvalNode(node.left, result);
      const right = translateEvalNode(node.right, result);
      return `${left} ${node.op} ${right}`;
    }
    case 'EvalParens':
      return `(${translateEvalNode(node.inner, result)})`;
    default:
      return String(node);
  }
}

function translateEvalFunc(node, result) {
  const name = node.name;
  const args = node.args;

  switch (name) {
    case 'if': {
      if (args.length !== 3) {
        result.warnings.push('if() expects 3 arguments');
        return '';
      }
      return `if(${translateEvalNode(args[0], result)}, ${translateEvalNode(args[1], result)}, ${translateEvalNode(args[2], result)})`;
    }

    case 'case': {
      if (args.length < 2) {
        result.warnings.push('case() expects at least 2 arguments');
        return '';
      }
      // Detect SPL's 1=1 default idiom: if last condition is 1=1, treat its value as default
      let effectiveArgs = args;
      let hasDefault = args.length % 2 === 1;
      if (
        !hasDefault &&
        args.length >= 2 &&
        isTrueCondition(args[args.length - 2])
      ) {
        hasDefault = true;
        effectiveArgs = [...args.slice(0, -2), args[args.length - 1]];
      }
      let expr;
      if (hasDefault) {
        expr = translateEvalNode(
          effectiveArgs[effectiveArgs.length - 1],
          result,
        );
        for (let i = effectiveArgs.length - 3; i >= 0; i -= 2) {
          const cond = translateEvalNode(effectiveArgs[i], result);
          const val = translateEvalNode(effectiveArgs[i + 1], result);
          expr = `if(${cond}, ${val}, ${expr})`;
        }
      } else {
        expr = 'NULL';
        for (let i = effectiveArgs.length - 2; i >= 0; i -= 2) {
          const cond = translateEvalNode(effectiveArgs[i], result);
          const val = translateEvalNode(effectiveArgs[i + 1], result);
          expr = `if(${cond}, ${val}, ${expr})`;
        }
      }
      return expr;
    }

    case 'mvcount':
    case 'len':
    case 'length': {
      if (args.length >= 1) {
        const field = translateEvalNode(args[0], result);
        result.warnings.push(
          'length() returns string length in NRQL, not multivalue count; results may differ for non-array fields',
        );
        return `length(${field})`;
      }
      return '';
    }

    case 'mvindex': {
      if (args.length >= 2) {
        const firstArg = args[0];
        const idx = translateEvalNode(args[1], result);
        // Detect mvindex(split(field, delim), N) → position/substring extraction
        if (
          firstArg &&
          firstArg.type === 'EvalFunc' &&
          firstArg.name === 'split' &&
          firstArg.args.length >= 2 &&
          looksLikeNumber(idx)
        ) {
          const splitField = translateEvalNode(firstArg.args[0], result);
          const delim = translateEvalNode(firstArg.args[1], result);
          const n = parseInt(idx, 10);
          result.warnings.push(
            'mvindex(split()) translated to position()/substring(); assumes single-character delimiter and fixed element count',
          );
          return buildSplitIndexExpr(splitField, delim, n);
        }
        const field = translateEvalNode(firstArg, result);
        result.warnings.push(
          'mvindex() translated to getField(); works for JSON arrays but not Splunk multivalue fields',
        );
        return `getField(${field}, ${idx})`;
      }
      result.warnings.push('mvindex() requires at least 2 arguments');
      return '';
    }

    case 'like': {
      // like(field, "pattern%") → field LIKE 'pattern%'
      if (args.length < 2) return '';
      const likeField = translateEvalNode(args[0], result);
      const likePattern = translateEvalNode(args[1], result);
      return `${likeField} LIKE ${likePattern}`;
    }

    case 'mvjoin': {
      // mvjoin(field, delim) — NRQL has no direct equivalent, but when used
      // with uniques()/values() in a subquery, FACET on the result already
      // groups by the combination. Skip mvjoin and just reference the field.
      const mvjField = translateEvalNode(args[0], result);
      result.warnings.push(
        'mvjoin() skipped; NRQL subquery FACET on uniques() already groups by value combination',
      );
      return mvjField;
    }

    case 'coalesce': {
      if (args.length < 1) {
        result.warnings.push('coalesce() requires at least 1 argument');
        return '';
      }
      // NRQL has no coalesce(); translate to nested if(... IS NOT NULL, ...)
      const coalArgs = args.map((a) => translateEvalNode(a, result));
      let coalExpr = coalArgs[coalArgs.length - 1];
      for (let ci = coalArgs.length - 2; ci >= 0; ci--) {
        coalExpr = `if(${coalArgs[ci]} IS NOT NULL, ${coalArgs[ci]}, ${coalExpr})`;
      }
      return coalExpr;
    }

    case 'lower': {
      if (args.length < 1) return '';
      return `lower(${translateEvalNode(args[0], result)})`;
    }

    case 'upper': {
      if (args.length < 1) return '';
      return `upper(${translateEvalNode(args[0], result)})`;
    }

    case 'substr': {
      // substr(field, start[, length]) → substring(field, start-1[, length])
      // SPL uses 1-based start index, NRQL uses 0-based
      if (args.length < 2) {
        result.warnings.push('substr() requires at least 2 arguments');
        return '';
      }
      const subField = translateEvalNode(args[0], result);
      const subStart = translateEvalNode(args[1], result);
      // Adjust 1-based to 0-based: subtract 1 from positive start index
      // Negative offsets mean "from end" in both SPL and NRQL — no adjustment needed
      const startNum = looksLikeNumber(String(args[1]))
        ? Number(args[1])
        : null;
      const adjustedStart =
        startNum !== null
          ? startNum < 0
            ? String(startNum)
            : String(startNum - 1)
          : `${subStart} - 1`;
      result.warnings.push(
        'substr() translated to substring() with start index adjusted from 1-based (SPL) to 0-based (NRQL)',
      );
      if (args.length >= 3) {
        const subLen = translateEvalNode(args[2], result);
        return `substring(${subField}, ${adjustedStart}, ${subLen})`;
      }
      return `substring(${subField}, ${adjustedStart})`;
    }

    case 'trim':
    case 'ltrim':
    case 'rtrim': {
      if (args.length < 1) return '';
      result.unsupported.push(
        `${name}() has no NRQL equivalent; NRQL does not have trim/ltrim/rtrim functions`,
      );
      // Fall through with the raw field reference so the query doesn't break entirely
      return translateEvalNode(args[0], result);
    }

    case 'replace': {
      // replace(field, pattern, replacement)
      if (args.length < 3) {
        result.unsupported.push('replace() requires 3 arguments');
        return '';
      }
      const replField = translateEvalNode(args[0], result);
      const replSearch = translateEvalNode(args[1], result);
      const replWith = translateEvalNode(args[2], result);
      // Check if the search pattern looks like a regex (has regex metacharacters)
      const rawSearch =
        typeof args[1] === 'object' && args[1].type === 'StringLiteral'
          ? args[1].value
          : null;
      const hasRegex =
        rawSearch &&
        (/\\[dDwWsSbB]/.test(rawSearch) || // regex character classes
          /[*+?]/.test(rawSearch) || // quantifiers
          /\[.*\]/.test(rawSearch) || // character sets
          /\(.*\)/.test(rawSearch) || // groups
          /\^|\$/.test(rawSearch)); // anchors
      if (hasRegex) {
        result.unsupported.push(
          'replace() with regex pattern has no NRQL equivalent; NRQL replace() only supports literal strings',
        );
        return replField;
      }
      // NRQL replace() supports literal string replacement and replaces all occurrences
      return `replace(${replField}, ${replSearch}, ${replWith})`;
    }

    case 'abs': {
      if (args.length < 1) return '';
      return `abs(${translateEvalNode(args[0], result)})`;
    }

    case 'ceil':
    case 'ceiling': {
      if (args.length < 1) return '';
      return `ceil(${translateEvalNode(args[0], result)})`;
    }

    case 'floor': {
      if (args.length < 1) return '';
      return `floor(${translateEvalNode(args[0], result)})`;
    }

    case 'round': {
      if (args.length < 1) return '';
      const roundArgs = args.map((a) => translateEvalNode(a, result));
      return `round(${roundArgs.join(', ')})`;
    }

    case 'sqrt': {
      if (args.length < 1) return '';
      return `sqrt(${translateEvalNode(args[0], result)})`;
    }

    case 'log': {
      if (args.length < 1) return '';
      if (args.length === 1) {
        // SPL log(x) is base 10; NRQL log() requires two args
        return `log10(${translateEvalNode(args[0], result)})`;
      }
      // log(x, base) — pass through
      return `log(${translateEvalNode(args[0], result)}, ${translateEvalNode(args[1], result)})`;
    }
    case 'ln': {
      if (args.length < 1) return '';
      return `ln(${translateEvalNode(args[0], result)})`;
    }

    case 'pow': {
      if (args.length < 2) return '';
      return `pow(${translateEvalNode(args[0], result)}, ${translateEvalNode(args[1], result)})`;
    }

    case 'exact':
    case 'tostring':
    case 'tonumber': {
      if (args.length < 1) return '';
      result.warnings.push(
        `${name}() has no direct NRQL equivalent; type coercion works differently in NRQL`,
      );
      return translateEvalNode(args[0], result);
    }

    case 'isnull': {
      if (args.length < 1) return '';
      return `${translateEvalNode(args[0], result)} IS NULL`;
    }

    case 'isnotnull': {
      if (args.length < 1) return '';
      return `${translateEvalNode(args[0], result)} IS NOT NULL`;
    }

    case 'null': {
      return 'NULL';
    }

    default: {
      result.unsupported.push(`eval function ${name}() has no NRQL equivalent`);
      return `${name}(${args.map((a) => translateEvalNode(a, result)).join(', ')})`;
    }
  }
}

function handleSpath(cmd, result) {
  if (!cmd.path) {
    result.unsupported.push(
      'spath without path= does auto-extraction, which has no NRQL equivalent; specify path= to extract a specific JSON field',
    );
    return;
  }

  const input = cmd.input === '_raw' || !cmd.input ? 'message' : cmd.input;
  // Convert Splunk array notation {} and {*} to jparse [*] notation
  const path = cmd.path.replace(/\{\*?\}/g, '[*]');

  // Default output alias: last segment of path (e.g., "user.name" → "name")
  const output = cmd.output || cmd.path.split('.').pop();

  result.with.push(
    `jparse(${escapeField(input)}, '${path}') AS \`${escapeAttributeNameForNrql(output)}\``,
  );
  result.warnings.push(
    'jparse() only works on JSON data; if the input is XML, use capture() with a regex pattern instead',
  );
}

// --- Where expression translation (for | where commands) ---

function translateWhereExpr(node, result) {
  if (!node) return '';

  switch (node.type) {
    case 'BooleanOp': {
      const left = translateWhereExpr(node.left, result);
      const right = translateWhereExpr(node.right, result);
      if (!left) return right;
      if (!right) return left;
      return `${left} ${node.operator} ${right}`;
    }
    case 'Not': {
      const inner = translateWhereExpr(node.operand, result);
      return inner ? `NOT ${inner}` : '';
    }
    case 'Comparison':
      return formatNumericAwareComparison(
        node.field,
        node.operator,
        node.value,
      );
    case 'FunctionCall':
      return translateWhereFunction(node, result);
    default:
      result.warnings.push(`Unsupported where expression type: ${node.type}`);
      return '';
  }
}

function translateWhereFunction(node, result) {
  const name = node.name.toLowerCase();
  const field = node.args[0];

  if (name === 'isnull') return `${escapeField(field)} IS NULL`;
  if (name === 'isnotnull') return `${escapeField(field)} IS NOT NULL`;
  if (name === 'like')
    return `${escapeField(field)} LIKE '${escapeWildcard(node.args[1] || '')}'`;
  if (name === 'match')
    return `${escapeField(field)} RLIKE '${escapeStringLiteralForNrql(node.args[1] || '')}'`;
  if (name === 'isint' || name === 'isnum' || name === 'isnumber') {
    result.warnings.push(
      `${name}() approximated with numeric(); NRQL has no exact integer check`,
    );
    return `numeric(${escapeField(field)}) IS NOT NULL`;
  }
  if (name === 'cidrmatch') {
    const cidr = node.args[0] || '';
    const cidrField = node.args[1];
    const prefixMatch = cidr.match(/\/(\d+)$/);
    if (cidrField && prefixMatch) {
      const prefix = prefixMatch[1];
      return `cidrAddress(${escapeField(cidrField)}, ${prefix}) = '${escapeStringLiteralForNrql(cidr)}'`;
    }
    result.warnings.push(
      `cidrmatch() could not be parsed; expected cidrmatch("cidr", field)`,
    );
    return '';
  }
  result.unsupported.push(
    `SPL where function ${name}() has no known NRQL equivalent`,
  );
  return '';
}

// --- Utility functions ---

// Shared between formatSpan() and parseSplTime().
const UNIT_MAP = {
  s: 'second',
  m: 'minute',
  h: 'hour',
  d: 'day',
  w: 'week',
  M: 'month',
  mon: 'month',
  y: 'year',
};

function escapeField(field) {
  return `\`${escapeAttributeNameForNrql(field)}\``;
}

function escapeWildcard(value) {
  return value.split('*').map(escapeStringWildcardForNrql).join('%');
}

function formatValue(value) {
  return looksLikeNumber(value)
    ? value
    : `'${escapeStringLiteralForNrql(value)}'`;
}

/** Formats `field op value`, quoting strings and leaving numbers bare. */
function formatComparison(escapedField, op, value) {
  if ((op === '=' || op === '!=') && !looksLikeNumber(value)) {
    return `${escapedField} ${op} '${escapeStringLiteralForNrql(value)}'`;
  }
  return `${escapedField} ${op} ${value}`;
}

/**
 * Splunk treats all fields as strings but coerces to numeric when both sides
 * look like numbers.  NRQL is stricter — the field has a concrete type.
 * For = / != we emit both the string and numeric check so the query matches
 * regardless of how the field is stored.  For ordering operators (>, >=, <, <=)
 * we wrap the field in numeric() since those only make sense numerically.
 */
function formatNumericAwareComparison(field, op, value) {
  const escapedField = escapeField(field);
  if (op === 'like') {
    return `${escapedField} LIKE '${escapeStringLiteralForNrql(value)}'`;
  }
  if (looksLikeNumber(value)) {
    if (op === '=') {
      return `(${escapedField} = '${value}' OR numeric(${escapedField}) = ${value})`;
    }
    if (op === '!=') {
      return `(${escapedField} != '${value}' AND numeric(${escapedField}) != ${value})`;
    }
    return `numeric(${escapedField}) ${op} ${value}`;
  }
  return formatComparison(escapedField, op, value);
}

function isTrueCondition(node) {
  return (
    node &&
    node.type === 'EvalComparison' &&
    (node.op === '=' || node.op === '==') &&
    node.left === '1' &&
    node.right === '1'
  );
}

function looksLikeNumber(value) {
  if (!value || value === '') return false;
  if (/^-?0\d/.test(value)) return false;
  return /^-?\d+(\.\d+)?$/.test(value);
}

function formatSpan(span) {
  const match = span.match(/^(\d+)([smhdwMy])$/);
  if (!match) return span;

  const num = match[1];
  const unit = UNIT_MAP[match[2]];
  if (!unit) return span;

  return `${num} ${num === '1' ? unit : unit + 's'}`;
}

// ── SPL function mapping ────────────────────────────────────────

const PERC_REGEX = /^perc(\d+)$/;
const P_REGEX = /^p(\d+)$/;
const EXACTPERC_REGEX = /^exactperc(\d+)$/;
const UPPERPERC_REGEX = /^upperperc(\d+)$/;

const SPL_FUNCTIONS = {
  count: { nrql: 'count' },
  dc: { nrql: 'uniqueCount' },
  distinct_count: { nrql: 'uniqueCount' },
  avg: { nrql: 'average' },
  mean: { nrql: 'average' },
  sum: { nrql: 'sum' },
  min: { nrql: 'min' },
  max: { nrql: 'max' },
  median: { nrql: 'median' },
  stdev: { nrql: 'stddev' },
  stdevp: {
    nrql: 'stddev',
    warning:
      'SPL stdevp() is population stddev; mapped to NRQL stddev() which is sample stddev. Results may differ.',
  },
  values: { nrql: 'uniques' },
  estdc: {
    nrql: 'uniqueCount',
    warning:
      'SPL estdc() is an estimate; NRQL uniqueCount() is also an approximation',
  },
  earliest: { nrql: 'earliest' },
  latest: { nrql: 'latest' },
  first: {
    nrql: 'latest',
    warning: 'SPL first() returns newest event; mapped to NRQL latest()',
  },
  last: {
    nrql: 'earliest',
    warning: 'SPL last() returns oldest event; mapped to NRQL earliest()',
  },
};

function escapeArg(arg) {
  // SPL _time → NRQL timestamp
  if (arg === '_time') return 'timestamp';
  if (/[+\-*/%()]/.test(arg)) return buildEvalExpr(arg);
  return arg;
}

function mapSplFunction(name, args) {
  const lowerName = name.toLowerCase();
  const entry = SPL_FUNCTIONS[lowerName];

  if (entry) {
    const nrqlName = entry.nrql;
    const nrqlArgs =
      lowerName === 'count' && args.length === 0
        ? '*'
        : args.map(escapeArg).join(', ');
    return {
      nrql: `${nrqlName}(${nrqlArgs})`,
      warning: entry.warning || null,
    };
  }

  // percN(field), pN(field), exactpercN(field), upperpercN(field) -> percentile(field, N)
  let percMatch =
    lowerName.match(PERC_REGEX) ||
    lowerName.match(P_REGEX) ||
    lowerName.match(EXACTPERC_REGEX) ||
    lowerName.match(UPPERPERC_REGEX);
  if (percMatch) {
    const n = percMatch[1];
    const field = args[0] ? escapeArg(args[0]) : '*';
    const variant = lowerName.match(EXACTPERC_REGEX)
      ? 'exactperc'
      : lowerName.match(UPPERPERC_REGEX)
        ? 'upperperc'
        : null;
    return {
      nrql: `percentile(${field}, ${n})`,
      warning: variant
        ? `SPL ${variant}${n}() mapped to NRQL percentile(); precision may differ`
        : null,
    };
  }

  // per_second/per_minute/per_hour/per_day -> rate(sum(field), 1 unit)
  const perMatch = lowerName.match(/^per_(second|minute|hour|day)$/);
  if (perMatch) {
    const field = args[0] || '*';
    const unit = perMatch[1];
    return {
      nrql: `rate(sum(${field}), 1 ${unit})`,
      warning: `SPL ${lowerName}() approximated as NRQL rate(sum(), 1 ${unit})`,
    };
  }

  // rate(field) -> rate(sum(field), 1 second)
  if (lowerName === 'rate') {
    const field = args[0] || '*';
    return {
      nrql: `rate(sum(${field}), 1 second)`,
      warning: 'SPL rate() approximated as NRQL rate(sum(), 1 second)',
    };
  }

  // list() -> uniques() — NRQL has no aggregator that preserves duplicates
  if (lowerName === 'list') {
    const field = args[0] || '*';
    return {
      nrql: `uniques(${field})`,
      warning: `SPL list() mapped to NRQL uniques(); duplicates will be removed`,
    };
  }

  // Functions with no NRQL equivalent — give specific messages
  const NO_EQUIV = {
    estdc_error:
      'estdc_error() (estimated distinct count error) has no NRQL equivalent',
    mode: 'mode() has no direct NRQL equivalent; consider FACET field LIMIT 1 to find most common value',
    sumsq: 'sumsq() (sum of squares) has no NRQL equivalent',
    var: 'var() (sample variance) has no NRQL equivalent',
    varp: 'varp() (population variance) has no NRQL equivalent',
    earliest_time:
      'earliest_time() has no NRQL equivalent; earliest() returns the value, not the timestamp',
    latest_time:
      'latest_time() has no NRQL equivalent; latest() returns the value, not the timestamp',
    rate_avg: 'rate_avg() is Splunk metrics-specific; no NRQL equivalent',
    rate_sum: 'rate_sum() is Splunk metrics-specific; no NRQL equivalent',
  };

  if (NO_EQUIV[lowerName]) {
    return {
      nrql: null,
      warning: `SPL ${NO_EQUIV[lowerName]}`,
    };
  }

  return {
    nrql: null,
    warning: `SPL function ${name}() has no known NRQL equivalent`,
  };
}

// ── SPL time parsing ────────────────────────────────────────────

const SNAP_ONLY_MAP = {
  h: 'this hour',
  d: 'today',
  w: 'this week',
  mon: 'this month',
  q: 'this quarter',
  y: 'this year',
};

const TIME_REGEX = /^(-?)(\d+)(s|m|h|d|w|mon|y)(@[a-z]+)?$/i;
const SNAP_ONLY_REGEX = /^@([a-z]+)$/i;

export function parseSplTime(timeStr) {
  if (!timeStr) return { nrql: null, warning: null };

  // Strip time alignment suffix (@h, @d, etc.) — NRQL doesn't support time snapping
  // Only strip when there's a relative time before the snap (e.g., -24h@h), not snap-only (@d)
  let strippedSnap = null;
  const alignMatch = timeStr.match(/^(.+?)(@[smhdw])$/i);
  if (alignMatch) {
    strippedSnap = alignMatch[2];
    timeStr = alignMatch[1];
  }

  if (timeStr.toLowerCase() === 'now') {
    return { nrql: null, warning: null };
  }

  const snapMatch = timeStr.match(SNAP_ONLY_REGEX);
  if (snapMatch) {
    const snapUnit = snapMatch[1].toLowerCase();
    const mapped = SNAP_ONLY_MAP[snapUnit];
    if (mapped) return { nrql: mapped, warning: null };
    return {
      nrql: 'today',
      warning: `SPL snap-to time '@${snapUnit}' approximated as 'today'`,
    };
  }

  const match = timeStr.match(TIME_REGEX);
  if (!match) {
    return {
      nrql: null,
      warning: `Unrecognized SPL time expression: ${timeStr}`,
    };
  }

  const [, sign, numStr, unit, snap] = match;
  const num = parseInt(numStr, 10);
  const nrqlUnit = UNIT_MAP[unit.toLowerCase()];

  if (!nrqlUnit) {
    return {
      nrql: null,
      warning: `Unrecognized SPL time unit: ${unit}`,
    };
  }

  const plural = num === 1 ? nrqlUnit : nrqlUnit + 's';
  const direction = sign === '-' ? 'ago' : 'from now';
  const nrql = `${num} ${plural} ${direction}`;

  const effectiveSnap = snap || strippedSnap;
  const warning = effectiveSnap
    ? `SPL snap-to time '${effectiveSnap}' ignored; NRQL SINCE/UNTIL does not support rounding to unit boundaries. Use 'today', 'this week', etc. for snap-only expressions.`
    : null;

  return { nrql, warning };
}
