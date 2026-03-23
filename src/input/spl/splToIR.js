/**
 * SPL AST → IR translation (Pass 1).
 *
 * Walks the PEG.js-produced SPL AST and builds an IR query plan.
 * Each SPL command transforms the IR structurally.
 */
import {
  SelectQuery,
  Identifier,
  Literal,
  BinOp,
  Not,
  Func,
  Alias,
  IsNull,
  Like,
  In,
  Wildcard,
  Regex,
  Rlike,
  RawNrql,
  Binding,
  JoinClause,
  OrderBy,
  DualCheck,
} from '../../ir/nodes.js';
import { parseSplTime } from './splTime.js';
import * as parser from './splParser.js';
import {
  mapFieldName,
  mapFunction,
  formatSpan,
  buildComparison,
  buildJparseComparison,
  coerceValue,
  isNumeric,
  buildArithmeticExpr,
  exprReferencesField,
  looksLikeNumber,
  escapeWildcard,
} from './splExprUtils.js';

/**
 * Main entry: translate a parsed SPL AST into an IR query plan.
 */
export function translateAstToIR(ast) {
  const ir = SelectQuery();

  // Search clause → WHERE
  if (ast.search) {
    const { expr, warnings, unsupported, since, until } = translateSearchExpr(
      ast.search,
    );
    if (expr) ir.where = expr;
    if (since) ir.since = since;
    if (until) ir.until = until;
    // NRQL requires SINCE < UNTIL; default SINCE is 1h which may overlap UNTIL
    if (until && !since) {
      ir.since = '24 hours ago';
      ir.warnings.push(
        'SPL latest without earliest defaults to 24h lookback in Splunk; added SINCE 24 hours ago to match',
      );
    }
    ir.warnings.push(...warnings);
    ir.unsupported.push(...unsupported);
  }

  // Pipeline: each command transforms the IR
  for (const cmd of ast.commands) {
    applyCommand(cmd, ir);
  }

  // Remove _time from FACET when TIMESERIES is present (TIMESERIES already groups by time)
  if (ir.timeseries && ir.facet.length > 0) {
    ir.facet = ir.facet.filter(
      (f) =>
        !(
          f.type === 'Identifier' &&
          (f.name === '_time' || f.name === 'timestamp')
        ),
    );
  }

  return ir;
}

// ── Search expression → IR expression tree ───────────────────

function translateSearchExpr(node) {
  const warnings = [];
  const unsupported = [];
  let since = null;
  let until = null;

  function walk(node) {
    if (!node) return null;

    switch (node.type) {
      case 'BooleanOp': {
        const left = walk(node.left);
        const right = walk(node.right);
        if (!left && !right) return null;
        if (!left) return right;
        if (!right) return left;
        return BinOp(node.operator, left, right);
      }

      case 'Not': {
        const inner = walk(node.operand);
        if (!inner) return null;
        return Not(inner);
      }

      case 'Comparison': {
        let { field, value, operator: op } = node;

        // SPL metadata field _raw → NRQL message
        if (field === '_raw') {
          field = 'message';
          warnings.push('_raw is not a valid NRQL field; mapped to message');
        }

        // JSON array field: field{}.sub or field{N}.sub → jparse translation
        if (/\{\d*\}/.test(field)) {
          const isIndexed = /\{\d+\}/.test(field);
          const jpath = field.replace(/\{(\d*)\}/g, (_, n) =>
            n ? `[${n}]` : '[*]',
          );
          const jparsed = Func('jparse', [
            Identifier('message'),
            Literal(jpath, 'string'),
          ]);

          // Wildcard values: use LIKE on jparse result
          if (value.includes('*')) {
            const pattern = escapeWildcard(value);
            if (op === '=') return Like(jparsed, pattern);
            if (op === '!=') return Not(Like(jparsed, pattern));
          }

          // Indexed access {N}: scalar result, use direct comparison
          if (isIndexed) {
            return buildJparseComparison(jparsed, op, value);
          }

          // Wildcard array {}: use contains for = and !=
          if (op === '=')
            return Func('contains', [jparsed, Literal(value, 'string')]);
          if (op === '!=')
            return Not(Func('contains', [jparsed, Literal(value, 'string')]));
          // For ordering operators on arrays, fall through to backtick-quoted literal
        }

        const fieldExpr = Identifier(field);

        // Infix like operator: name like "test%"
        if (op === 'like') {
          const pattern = value.replace(/\*/g, '%');
          return Like(fieldExpr, pattern);
        }

        if (value.includes('*')) {
          const pattern = escapeWildcard(value);
          if (op === '=') return Like(fieldExpr, pattern);
          if (op === '!=') return Not(Like(fieldExpr, pattern));
        }

        return buildComparison(field, op, value);
      }

      case 'InComparison': {
        // JSON array field: field{}.sub IN (a, b) → contains(jparse(...), a) OR contains(jparse(...), b)
        if (node.field.includes('{}')) {
          const jpath = node.field.replace(/\{\}/g, '[*]');
          const jparsed = Func('jparse', [
            Identifier('message'),
            Literal(jpath, 'string'),
          ]);
          const parts = node.values.map((v) =>
            Func('contains', [jparsed, Literal(v, 'string')]),
          );
          return parts.reduce(
            (acc, p) => (acc ? BinOp('OR', acc, p) : p),
            null,
          );
        }

        const fieldExpr = Identifier(node.field);
        const hasWildcards = node.values.some((v) => v.includes('*'));

        if (hasWildcards) {
          const parts = node.values.map((v) => {
            if (v.includes('*')) return Like(fieldExpr, escapeWildcard(v));
            return BinOp('=', fieldExpr, coerceValue(v));
          });
          return parts.reduce(
            (acc, p) => (acc ? BinOp('OR', acc, p) : p),
            null,
          );
        }

        return In(fieldExpr, node.values.map(coerceValue));
      }

      case 'BareKeyword': {
        const { value } = node;
        if (!value || value === '*') return null;
        const escaped = escapeWildcard(value);
        return Like(Identifier('message'), `%${escaped}%`);
      }

      case 'TimeConstraint': {
        const { nrql, warning } = parseSplTime(node.value);
        if (warning) warnings.push(warning);
        if (nrql) {
          if (node.param === 'earliest') since = nrql;
          else until = nrql;
        }
        return null;
      }

      case 'Macro': {
        const argsStr = node.args.length > 0 ? `(${node.args.join(', ')})` : '';
        const nrqlMacro = `$${node.name}${argsStr}`;
        warnings.push(
          `SPL macro \`${node.name}\` translated to NRQL macro ${nrqlMacro}; ensure a matching NRQL macro exists`,
        );
        // Emit macro reference as a raw identifier (NRQL gateway expands it)
        return Identifier(nrqlMacro);
      }

      case 'TemplateVariable':
        if (node.name.endsWith('.earliest')) {
          since = `{{${node.name}}}`;
          return null;
        }
        if (node.name.endsWith('.latest')) {
          until = `{{${node.name}}}`;
          return null;
        }
        return Identifier(`{{${node.name}}}`);

      case 'NotSubsearch': {
        const lookupMatch = node.rawText.match(/\|\s*inputlookup\s+([\w.-]+)/);
        if (lookupMatch) {
          const tableName = lookupMatch[1]
            .replace(/\.csv$/, '')
            .replace(/[.-]/g, '_');
          warnings.push(
            `NOT [|inputlookup ${lookupMatch[1]}] translated to NOT IN lookup subquery. ` +
              `Replace {{column}} with the exclusion field name from ${lookupMatch[1]}. ` +
              `Upload the CSV to New Relic Lookup tables as '${tableName}'.`,
          );
          return RawNrql(
            `{{column}} NOT IN (FROM lookup(${tableName}) SELECT {{column}} LIMIT MAX)`,
          );
        }
        unsupported.push(
          'NOT [subsearch] exclusion pattern; manually convert to NOT IN or WHERE NOT conditions in NRQL',
        );
        return null;
      }

      default:
        warnings.push(`Unknown search node type: ${node.type}`);
        return null;
    }
  }

  const expr = walk(node);
  return { expr, warnings, unsupported, since, until };
}

// ── Command handlers ─────────────────────────────────────────

function applyCommand(cmd, ir) {
  switch (cmd.type) {
    case 'StatsCommand':
      return handleStats(cmd, ir);
    case 'WhereCommand':
      return handleWhere(cmd, ir);
    case 'EvalCommand':
      return handleEval(cmd, ir);
    case 'TableCommand':
      return handleTable(cmd, ir);
    case 'FieldsCommand':
      return handleFields(cmd, ir);
    case 'SortCommand':
      return handleSort(cmd, ir);
    case 'HeadCommand':
      ir.limit = cmd.count;
      return;
    case 'RenameCommand':
      return handleRename(cmd, ir);
    case 'DedupCommand':
      return handleDedup(cmd, ir);
    case 'TimechartCommand':
      return handleTimechart(cmd, ir);
    case 'ChartCommand':
      return handleStats(cmd, ir); // chart is structurally same as stats
    case 'BinCommand':
      return handleBin(cmd, ir);
    case 'TopCommand':
      return handleTop(cmd, ir);
    case 'RareCommand':
      return handleRare(cmd, ir);
    case 'RexCommand':
      return handleRex(cmd, ir);
    case 'SpathCommand':
      return handleSpath(cmd, ir);
    case 'RegexCommand':
      return handleRegex(cmd, ir);
    case 'SearchCommand':
      return handleSearchPipe(cmd, ir);
    case 'JoinCommand':
      return handleJoin(cmd, ir);
    case 'AppendCommand':
    case 'AppendcolsCommand':
      return handleAppend(
        cmd,
        ir,
        cmd.type === 'AppendcolsCommand' ? 'appendcols' : 'append',
      );
    case 'AppendpipeCommand':
      return handleAppendpipe(cmd, ir);
    case 'EventstatsCommand':
      return handleEventstats(cmd, ir);
    case 'ConvertCommand':
      return handleConvert(cmd, ir);
    case 'ReplaceCommand':
      return handleReplace(cmd, ir);
    case 'StrcatCommand':
      return handleStrcat(cmd, ir);
    case 'FillnullCommand':
      return handleFillnull(cmd, ir);
    case 'InputlookupCommand':
      return handleInputlookup(cmd, ir);
    case 'LookupCommand':
      return handleLookup(cmd, ir);
    case 'PredictCommand':
      ir.predict = true;
      if (!ir.timeseries) {
        ir.timeseries = 'AUTO';
        ir.warnings.push(
          'PREDICT requires TIMESERIES; added TIMESERIES AUTO automatically',
        );
      }
      if (ir.select.length === 0) {
        ir.select.push(Func('count', []));
      }
      return;
    case 'TstatsCommand':
      ir.unsupported.push(
        'tstats queries target Splunk CIM data models which normalize events from multiple sourcetypes into a standard schema. To translate, identify which sourcetypes populate the data model in your Splunk deployment, then query those events directly using their raw field names.',
      );
      return;
    case 'MacroCommand': {
      const argsStr = cmd.args.length > 0 ? `(${cmd.args.join(', ')})` : '';
      const nrqlMacro = `$${cmd.name}${argsStr}`;
      ir.warnings.push(
        `SPL macro \`${cmd.name}\` translated to NRQL macro ${nrqlMacro}; ensure a matching NRQL macro exists`,
      );
      const macroExpr = Identifier(nrqlMacro);
      ir.where = ir.where ? BinOp('AND', ir.where, macroExpr) : macroExpr;
      return;
    }
    case 'MvexpandCommand':
      ir.warnings.push(
        `mvexpand ${cmd.field} skipped; NRQL does not expand multivalue fields into rows, but filtering and selection on the field still work`,
      );
      return;
    case 'UniqCommand':
      ir.unsupported.push('uniq has no direct NRQL equivalent');
      return;
    case 'ReverseCommand':
      ir.orderBy = OrderBy(Identifier('timestamp'), false);
      return;
    case 'UnsupportedCommand':
      ir.unsupported.push(
        `SPL command '${cmd.name}' has no known NRQL equivalent`,
      );
      return;
    default:
      ir.unsupported.push(`command '${cmd.type}' not yet implemented`);
      return;
  }
}

function handleStats(cmd, ir) {
  // If already aggregated, wrap current IR as a subquery source
  if (ir._hasAggregation && ir.select.length > 0) {
    wrapAsSubquery(ir);
  } else if (ir.select.length > 0) {
    // Non-aggregation select (e.g., from table/fields) — clear it
    ir.select = [];
    ir.facet = [];
  }

  ir.select = [];
  ir.facet = [];

  for (const fn of cmd.functions) {
    if (fn.evalFilter) {
      // count(eval(expr)) → filter(count(*), WHERE expr)
      const filterCondition = walkEvalExpr(fn.evalFilter, ir);
      const filterExpr = Func(
        'filter',
        [Func('count', []), filterCondition].filter(Boolean),
      );
      const expr = fn.alias ? Alias(filterExpr, fn.alias) : filterExpr;
      ir.select.push(expr);
      continue;
    }

    const mapped = mapFunction(fn.name, fn.args);
    if (mapped.warning) ir.warnings.push(mapped.warning);
    if (mapped.expr) {
      const expr = fn.alias ? Alias(mapped.expr, fn.alias) : mapped.expr;
      ir.select.push(expr);
    }
  }

  if (cmd.groupBy.length > 0) {
    ir.facet = cmd.groupBy.map(Identifier);
  }

  ir._hasAggregation = true;
}

function handleWhere(cmd, ir) {
  // If after aggregation, wrap as subquery and filter the outer query
  if (ir._hasAggregation) {
    wrapAsSubquery(ir);
  }

  // The PEG grammar uses `expression` not `expr`
  const whereNode = cmd.expression || cmd.expr;
  const expr = translateWhereExpr(whereNode, ir);
  if (expr) {
    ir.where = ir.where ? BinOp('AND', ir.where, expr) : expr;
  }
}

function handleEval(cmd, ir) {
  // eval creates bindings: WITH expr AS name
  translateEvalExpr(cmd, ir);
}

function handleTable(cmd, ir) {
  ir.select = cmd.fields.map((f) => Identifier(mapFieldName(f)));
}

function handleFields(cmd, ir) {
  if (cmd.mode === '-') {
    // fields - X removes X from select (if explicit) or is a no-op
    // In NRQL, there's no way to exclude fields from SELECT *
    ir.warnings.push('fields - (exclude mode) has limited NRQL support');
  } else {
    ir.select = cmd.fields.map((f) => Identifier(mapFieldName(f)));
  }
}

function handleSort(cmd, ir) {
  if (cmd.fields.length > 0) {
    const first = cmd.fields[0];
    ir.orderBy = OrderBy(Identifier(first.field), first.direction === 'desc');
  }
  // Additional sort fields become ORDER BY field1 DESC, field2 ASC
  // NRQL only supports single ORDER BY — warn if multiple
  if (cmd.fields.length > 1) {
    ir.warnings.push(
      'NRQL ORDER BY supports only one field; additional sort fields ignored',
    );
  }
}

function handleRename(cmd, ir) {
  let added = 0;
  for (const rename of cmd.renames) {
    if (rename.from.includes('*') || rename.to.includes('*')) {
      ir.unsupported.push(
        `Wildcard rename (${rename.from} as ${rename.to}) not supported in NRQL; rename specific fields`,
      );
      continue;
    }
    if (/[()]/.test(rename.from)) {
      ir.unsupported.push(
        `Cannot rename field with parentheses in name: "${rename.from}"`,
      );
      continue;
    }
    // If renaming a stats alias, fold into the existing alias instead of adding a new one
    const existingIdx = ir.select.findIndex(
      (s) => s.type === 'Alias' && s.name === rename.from,
    );
    if (existingIdx >= 0) {
      ir.select[existingIdx] = Alias(ir.select[existingIdx].expr, rename.to);
    } else {
      ir.select.push(Alias(Identifier(mapFieldName(rename.from)), rename.to));
    }
    added++;
  }
  // Keep all other fields — NRQL has no rename-and-drop-original
  if (added > 0 && !ir._hasAggregation) {
    ir.select.push(Wildcard());
    ir.warnings.push(
      'NRQL rename keeps original field names alongside aliases',
    );
  }
}

function handleDedup(cmd, ir) {
  for (const field of cmd.fields) {
    const id = Identifier(field);
    if (!ir.facet.some((f) => f.name === field)) {
      ir.facet.push(id);
    }
  }
  if (ir.select.length === 0) {
    ir.select.push(Func('latest', [Identifier('timestamp')]));
  }
  ir.limit = 'MAX';
  ir._hasAggregation = true;
  ir.warnings.push(
    'dedup translated to FACET; add latest(field) for each field you want to keep',
  );
}

function handleTimechart(cmd, ir) {
  handleStats(cmd, ir);
  ir.timeseries = cmd.span ? formatSpan(cmd.span) : 'AUTO';
}

function handleBin(cmd, ir) {
  if (cmd.field === '_time' && cmd.span) {
    ir.timeseries = formatSpan(cmd.span);
    if (ir.select.length === 0) {
      ir.select.push(Func('count', []));
    }
  } else if (cmd.field && (cmd.span || cmd.width)) {
    // Numeric bin → histogram(field, width)
    const width = cmd.width || Number(cmd.span);
    ir.select = [
      Func('histogram', [Identifier(cmd.field), Literal(width, 'number')]),
    ];
    ir._hasAggregation = true;
  } else {
    ir.unsupported.push(
      'bin command not fully supported; use TIMESERIES for time or histogram() for numeric fields',
    );
  }
}

function handleTop(cmd, ir) {
  // count(*) with optional alias from countfield
  const countExpr = cmd.countfield
    ? Alias(Func('count', []), cmd.countfield)
    : Func('count', []);
  ir.select = [countExpr];

  // Percent column: count(*) * 100.0 / (SELECT count(*) FROM Log [WHERE ...])
  if (cmd.showperc !== false) {
    const subqWhere = ir.where ? { ...ir.where } : null;
    const subquery = SelectQuery({
      select: [Func('count', [])],
      where: subqWhere,
    });
    const percentExpr = BinOp(
      '/',
      BinOp('*', Func('count', []), RawNrql('100.0')),
      { type: 'SubqueryExpr', query: subquery },
    );
    const percentAlias = cmd.percentfield || 'percent';
    ir.select.push(Alias(percentExpr, percentAlias));
  }

  ir.facet = [Identifier(cmd.field)];
  if (cmd.groupBy && cmd.groupBy.length > 0) {
    ir.facet.push(...cmd.groupBy.map(Identifier));
    ir.warnings.push(
      'top with groupBy: NRQL FACET groups all fields together; SPL groups within each by-field value',
    );
  }
  ir.orderBy = OrderBy(Identifier('count'), true);

  // limit=0 means unlimited in SPL
  ir.limit = cmd.count === 0 ? 'MAX' : cmd.count || 10;

  if (cmd.useother) {
    ir.warnings.push(
      'useother: NRQL pie chart automatically shows an "Other" category for values outside LIMIT',
    );
  }

  ir._hasAggregation = true;
}

function handleRare(cmd, ir) {
  ir.select = [Func('count', [])];
  ir.facet = [Identifier(cmd.field)];
  if (cmd.groupBy && cmd.groupBy.length > 0) {
    ir.facet.push(...cmd.groupBy.map(Identifier));
  }
  ir.orderBy = OrderBy(Identifier('count'), false); // ASC for rare
  ir.limit = cmd.count || 10;
  ir._hasAggregation = true;
}

function handleRex(cmd, ir) {
  if (cmd.mode === 'sed') {
    ir.unsupported.push('rex mode=sed has no NRQL equivalent');
    return;
  }
  if (cmd.mode !== 'extract' || !cmd.pattern) {
    ir.unsupported.push('rex command could not be parsed');
    return;
  }

  // Extract named group names — match (?P<name>) or (?<name>) but NOT (?<=) or (?<!)
  const groupRegex = /\(\?(?:P<|<)([a-zA-Z_]\w*)>/g;
  const names = [];
  let match;
  while ((match = groupRegex.exec(cmd.pattern)) !== null) {
    names.push(match[1]);
  }

  if (names.length === 0) {
    ir.unsupported.push(
      'rex pattern has no named capture groups; nothing to extract',
    );
    return;
  }

  if (cmd.maxMatch) {
    ir.unsupported.push(
      'rex max_match not supported; NRQL capture() returns first match only',
    );
  }

  // Detect PCRE lookbehind/lookahead — NRQL capture() rejects these
  if (/\(\?<=|\(\?<!|\(\?=|\(\?!/.test(cmd.pattern)) {
    ir.unsupported.push(
      'rex pattern uses lookahead/lookbehind assertions which NRQL capture() does not support; rewrite the regex without lookaround',
    );
    return;
  }

  // Build capture() expression(s)
  const field = cmd.field === '_raw' ? 'message' : cmd.field;
  // Convert (?<name>) to (?P<name>) — NRQL capture() uses Python regex syntax
  // Only convert named groups ((?<identifier>)), not lookbehind (?<=) or lookahead (?=)
  const normalizedPattern = cmd.pattern.replace(
    /\(\?<([a-zA-Z_]\w*)>/g,
    '(?P<$1>',
  );
  // Avoid redundant .* when pattern already anchors with .* or .+
  const prefix = /^\.[*+]/.test(normalizedPattern) ? '' : '.*';
  const suffix = /\.[*+]$/.test(normalizedPattern) ? '' : '.*';
  const fullPattern = `${prefix}${normalizedPattern}${suffix}`;

  if (names.length === 1) {
    // Single capture group — one binding
    const captureExpr = Func('capture', [
      Identifier(field),
      Regex(fullPattern),
    ]);
    ir.bindings.push(Binding(`(${names[0]})`, captureExpr));
  } else {
    // Multiple capture groups — one capture() call per group.
    // Each call keeps one (?P<name>...) and converts the rest to non-capturing (?:...).
    for (const targetName of names) {
      const perGroupPattern = fullPattern.replace(
        /\(\?P<([a-zA-Z_]\w*)>/g,
        (match, name) => (name === targetName ? match : '(?:'),
      );
      const captureExpr = Func('capture', [
        Identifier(field),
        Regex(perGroupPattern),
      ]);
      ir.bindings.push(Binding(targetName, captureExpr));
    }
  }
}

function handleSpath(cmd, ir) {
  if (!cmd.path) {
    ir.unsupported.push(
      'spath without path= does auto-extraction, which has no NRQL equivalent; specify path= to extract a specific JSON field',
    );
    return;
  }
  const rawInput = cmd.input || 'message';
  const input = rawInput === '_raw' ? 'message' : rawInput;
  // Default output name is last segment of path (SPL convention)
  const output =
    cmd.output ||
    cmd.path
      .split('.')
      .pop()
      .replace(/[{}[\]*]/g, '');
  const jsonPath = cmd.path.replace(/\{[^}]*\}/g, '[*]');
  ir.bindings.push(
    Binding(
      output,
      Func('jparse', [Identifier(input), Literal(jsonPath, 'string')]),
    ),
  );
  ir.warnings.push(
    'jparse() only works on JSON data; if the input is XML, use capture() with a regex pattern instead',
  );
}

function handleRegex(cmd, ir) {
  const field = cmd.field || '_raw';
  const fieldId = field === '_raw' ? Identifier('message') : Identifier(field);
  const pattern = cmd.pattern;
  if (cmd.negate) {
    const rlike = Not(Rlike(fieldId, pattern));
    ir.where = ir.where ? BinOp('AND', ir.where, rlike) : rlike;
  } else {
    const rlike = Rlike(fieldId, pattern);
    ir.where = ir.where ? BinOp('AND', ir.where, rlike) : rlike;
  }
}

function handleSearchPipe(cmd, ir) {
  // | search is like an additional WHERE clause
  const searchNode = cmd.search || cmd.expression;
  if (searchNode) {
    const { expr, warnings, unsupported } = translateSearchExpr(searchNode);
    if (expr) {
      ir.where = ir.where ? BinOp('AND', ir.where, expr) : expr;
    }
    ir.warnings.push(...warnings);
    ir.unsupported.push(...unsupported);
  }
}

function handleJoin(cmd, ir) {
  if (cmd.joinType === 'outer') {
    ir.unsupported.push(
      'NRQL does not support full outer join; only INNER and LEFT joins are available',
    );
    return;
  }

  let subIR;
  try {
    const subAst = parser.parse(cmd.subsearch.trim());
    subIR = translateAstToIR(subAst);
  } catch (e) {
    ir.unsupported.push(`join subsearch could not be parsed: ${e.message}`);
    return;
  }

  for (const w of subIR.warnings) ir.warnings.push(`join subsearch: ${w}`);
  for (const u of subIR.unsupported)
    ir.unsupported.push(`join subsearch: ${u}`);

  const key = Identifier(cmd.field);
  const joinType = (cmd.joinType || 'inner').toUpperCase();

  // NRQL requires the join key in FACET, not SELECT.
  // If the subsearch used table/fields (explicit SELECT, no FACET),
  // move the join key from SELECT to FACET.
  let subSelect = subIR.select.length > 0 ? subIR.select : [Wildcard()];
  let subFacet = subIR.facet;
  if (subFacet.length === 0) {
    // Remove join key from SELECT if present, add to FACET
    subSelect = subSelect.filter(
      (s) => !(s.type === 'Identifier' && s.name === cmd.field),
    );
    if (subSelect.length === 0) subSelect = [Wildcard()];
    subFacet = [key];
  }

  ir.join = JoinClause(
    SelectQuery({
      dataSource: subIR.dataSource,
      bindings: subIR.bindings,
      select: subSelect,
      where: subIR.where,
      facet: subFacet,
      limit: subIR.limit || 'MAX',
    }),
    key,
    joinType,
  );
  ir.warnings.push(
    'NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit',
  );
}

/**
 * Wrap the current IR state as a subquery source.
 * The current select/facet/where/bindings become the inner query,
 * and the IR is reset for the outer query.
 */
function wrapAsSubquery(ir) {
  const innerQuery = SelectQuery({
    dataSource: ir.dataSource,
    bindings: [...ir.bindings],
    select: [...ir.select],
    where: ir.where,
    facet: [...ir.facet],
    limit: ir.facet.length > 0 ? 'MAX' : ir.limit,
  });

  ir.dataSource = { type: 'SubquerySource', query: innerQuery };
  ir.select = [];
  ir.facet = [];
  ir.bindings = [];
  ir.where = null;
}

function handleFillnull(cmd, ir) {
  const fillValue = cmd.value || '0';
  // SPL fillnull default is string '0', not numeric 0 — only use numeric
  // when the user explicitly provided a value= that looks like a number
  const litValue =
    cmd.value && looksLikeNumber(fillValue)
      ? Literal(Number(fillValue), 'number')
      : Literal(fillValue, 'string');
  if (cmd.fields && cmd.fields.length > 0) {
    // Store substitutions — downstream references to these fields get (field OR default) inlined
    if (!ir._fillnullMap) ir._fillnullMap = {};
    for (const field of cmd.fields) {
      ir._fillnullMap[field] = litValue;
    }
  } else {
    ir.unsupported.push(
      'fillnull without field list not supported — NRQL requires explicit field names',
    );
  }
}

function handleAppendpipe(cmd, ir) {
  // appendpipe forks current results and runs a sub-pipeline on the copy.
  // Common patterns:
  //   1. Empty result guard: appendpipe [stats count | where count==0] — no-op in NRQL
  //   2. Totals row: appendpipe [stats sum(count) as total | eval status="TOTAL"]
  //      → translatable as nested aggregation, but the "append as new row" part
  //        has no NRQL equivalent. The aggregation itself is expressible.

  // Parse the sub-pipeline to understand what it does
  let subIR;
  try {
    const subAst = parser.parse(cmd.subsearch.trim());
    subIR = translateAstToIR(subAst);
  } catch (e) {
    ir.unsupported.push(
      `appendpipe subsearch could not be parsed: ${e.message}`,
    );
    return;
  }

  // Pattern 1: empty result guard — the sub-pipeline just checks if count==0
  // This is a no-op in NRQL (empty results are handled natively)
  const isEmptyGuard =
    subIR.select.some(
      (s) => s.type === 'Function' && s.name === 'count' && s.args.length === 0,
    ) && subIR.where;

  if (isEmptyGuard) {
    ir.warnings.push(
      'appendpipe empty-result guard ignored; NRQL handles empty results natively',
    );
    return;
  }

  // Pattern 2: totals/summary row — the sub-pipeline aggregates current results
  // We can't append a row, but we note the aggregation intent
  ir.warnings.push(
    'appendpipe adds summary rows to results; NRQL cannot append rows to a query. ' +
      'The sub-pipeline aggregation is available as a nested query, but the "append as new row" behavior must be handled by the UI.',
  );
}

function handleAppend(cmd, ir, label) {
  // Parse and translate the subsearch
  let subIR;
  try {
    const subAst = parser.parse(cmd.subsearch.trim());
    subIR = translateAstToIR(subAst);
  } catch (e) {
    ir.unsupported.push(`${label} subsearch could not be parsed: ${e.message}`);
    return;
  }

  // Forward subsearch warnings/unsupported
  for (const w of subIR.warnings) ir.warnings.push(`${label} subsearch: ${w}`);
  for (const u of subIR.unsupported)
    ir.unsupported.push(`${label} subsearch: ${u}`);

  // Both sides must have aggregations to merge
  if (ir.select.length === 0 || subIR.select.length === 0) {
    ir.unsupported.push(
      `${label} with subsearch cannot be automatically translated; consider using filter() to compute multiple aggregations in a single query`,
    );
    return;
  }

  // Check FACET compatibility
  const mainFacetStr = ir.facet.map((f) => f.name || '').join(',');
  const subFacetStr = subIR.facet.map((f) => f.name || '').join(',');

  if (mainFacetStr !== subFacetStr) {
    ir.unsupported.push(
      `${label} with subsearch cannot be automatically translated; the main query and subsearch group by different fields`,
    );
    return;
  }

  // Same WHERE → just merge SELECT lists
  // Different WHERE → wrap each in filter()
  const mainWhere = ir.where;
  const subWhere = subIR.where;

  if (exprsEqual(mainWhere, subWhere)) {
    for (const s of subIR.select) ir.select.push(s);
    ir.warnings.push(
      `${label} merged into a single query; SPL append runs the subsearch independently, but here both sides query the same events`,
    );
  } else {
    // Wrap each SELECT expression in filter(expr, WHERE condition)
    ir.select = ir.select.map((s) => wrapInFilter(s, mainWhere));
    for (const s of subIR.select) {
      ir.select.push(wrapInFilter(s, subWhere));
    }
    ir.where = null;
    ir.warnings.push(
      `${label} translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment since both sides now query FROM Log`,
    );
  }
}

function wrapInFilter(selectExpr, whereCondition) {
  if (!whereCondition) return selectExpr;
  // If the expression is aliased, wrap the inner part in filter
  if (selectExpr.type === 'Alias') {
    return Alias(
      Func('filter', [selectExpr.expr, whereCondition]),
      selectExpr.name,
    );
  }
  return Func('filter', [selectExpr, whereCondition]);
}

function exprsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function handleInputlookup(cmd, ir) {
  ir.dataSource = { type: 'Lookup', name: cmd.table };
  ir.warnings.push(
    `Ensure lookup table '${cmd.table}' is uploaded via the Lookups UI`,
  );
  if (cmd.where) {
    const whereExpr = walkEvalExpr(cmd.where, ir);
    if (whereExpr) {
      ir.where = ir.where ? BinOp('AND', ir.where, whereExpr) : whereExpr;
    }
    ir.warnings.push(
      'inputlookup WHERE condition translated as-is; verify field names match the lookup table schema',
    );
  }
}

function handleEventstats(cmd, ir) {
  const subSelect = [];
  for (const fn of cmd.functions) {
    const mapped = mapFunction(fn.name, fn.args);
    if (mapped.warning) ir.warnings.push(mapped.warning);
    if (mapped.expr) {
      const alias = fn.alias || fn.args[0] || fn.name;
      subSelect.push(Alias(mapped.expr, alias));
    }
  }

  if (subSelect.length === 0) return;

  if (cmd.groupBy.length === 0) {
    // eventstats without BY → scalar subquery in SELECT
    // e.g., eventstats count AS total → (SELECT count(*) FROM Log) AS 'total'
    // NRQL WITH clause cannot contain aggregate functions, so we use
    // scalar subqueries appended to SELECT instead.
    let subquery;
    if (ir._hasAggregation) {
      // After stats: the eventstats references aggregated fields (e.g., sum(appCount)),
      // so the subquery must wrap the current stats as a nested aggregation
      const innerQuery = SelectQuery({
        dataSource: { ...ir.dataSource },
        select: [...ir.select],
        where: ir.where ? { ...ir.where } : null,
        facet: [...ir.facet],
        limit: 'MAX',
      });
      subquery = SelectQuery({
        dataSource: { type: 'SubquerySource', query: innerQuery },
        select: subSelect.map((s) => s.expr),
      });
    } else {
      subquery = SelectQuery({
        dataSource: { ...ir.dataSource },
        select: subSelect.map((s) => s.expr),
        where: ir.where ? { ...ir.where } : null,
      });
    }
    // Preserve existing SELECT (or add * if empty) so original fields are kept
    if (ir.select.length === 0) {
      ir.select.push(Wildcard());
    }
    for (const s of subSelect) {
      ir.select.push(Alias({ type: 'SubqueryExpr', query: subquery }, s.name));
    }
    ir.warnings.push(
      'eventstats without BY translated as scalar subquery in SELECT; ' +
        'for percentage calculations, use the subquery result in downstream eval',
    );
    return;
  }

  if (cmd.groupBy.length > 1) {
    ir.unsupported.push(
      `eventstats with multiple BY fields (${cmd.groupBy.join(', ')}) cannot be translated; NRQL subquery JOIN only supports a single ON key`,
    );
    return;
  }

  // eventstats with single BY → subquery JOIN
  const onKey = Identifier(cmd.groupBy[0]);
  const subquery = SelectQuery({
    dataSource: ir.dataSource,
    select: subSelect,
    facet: [onKey],
    limit: 'MAX',
  });

  ir.join = JoinClause(subquery, onKey);
  ir.warnings.push(
    'NRQL subquery JOIN has a 5,000-row limit and 1:100 cardinality limit',
  );
}

function handleLookup(cmd, ir) {
  // lookup table keyField [AS eventField] [OUTPUT outField1, outField2]
  // Translate as subquery JOIN on the key field
  // NRQL JOIN requires the join key to be produced by FACET in the subquery
  const eventField = cmd.keyAlias || cmd.key;
  const lookupKey = cmd.key;
  const outputFields = cmd.outputFields || [];
  const selectExprs =
    outputFields.length > 0
      ? outputFields.map((f) =>
          f.alias ? Alias(Identifier(f.name), f.alias) : Identifier(f.name),
        )
      : [Wildcard()];
  const subquery = SelectQuery({
    dataSource: { type: 'Lookup', name: cmd.table },
    select: selectExprs,
    facet: [Identifier(lookupKey)],
    limit: 'MAX',
  });
  const join = JoinClause(subquery, Identifier(eventField));
  // When lookup key differs from event field (username AS user), store both
  if (lookupKey !== eventField) {
    join.onLookupKey = Identifier(lookupKey);
  }
  ir.join = join;
  ir.warnings.push(
    `Ensure lookup table '${cmd.table}' is uploaded via the Lookups UI`,
  );
}

function handleConvert(cmd, ir) {
  // Grammar produces: { specs: [{name, field, alias}, ...], rawText: string|null }
  const specs = cmd.specs;
  if (!specs || specs.length === 0) {
    if (cmd.rawText) {
      ir.unsupported.push(
        `convert command could not be fully parsed: ${cmd.rawText}`,
      );
    }
    return;
  }
  for (const spec of specs) {
    const { name: func, field, alias } = spec;
    const outputName = alias || `${field}_converted`;
    let expr;
    switch (func.toLowerCase()) {
      case 'num':
        expr = Func('numeric', [Identifier(field)]);
        break;
      case 'auto':
        expr = Func('numeric', [Identifier(field)]);
        break;
      case 'rmcomma':
        // '1,234' → numeric(replace(field, ',', ''))
        expr = Func('numeric', [
          Func('replace', [
            Identifier(field),
            Literal(',', 'string'),
            Literal('', 'string'),
          ]),
        ]);
        break;
      case 'ctime':
        // epoch ms → datetime string
        expr = Func('toDatetime', [Identifier(field)]);
        break;
      case 'mktime':
        // datetime string → epoch ms
        expr = Func('toTimestamp', [Identifier(field)]);
        break;
      case 'dur2sec': {
        // Duration string → seconds. NRQL has no built-in; approximate with warning.
        ir.warnings.push(
          `convert dur2sec(${field}): NRQL has no duration parser; using numeric(${field}) as approximation — verify data format`,
        );
        expr = Func('numeric', [Identifier(field)]);
        break;
      }
      case 'mstime': {
        // mm:ss.ms → seconds. NRQL has no built-in; approximate with warning.
        ir.warnings.push(
          `convert mstime(${field}): NRQL has no mm:ss.ms parser; using numeric(${field}) as approximation — verify data format`,
        );
        expr = Func('numeric', [Identifier(field)]);
        break;
      }
      default:
        ir.unsupported.push(`convert ${func}(${field}) not supported in NRQL`);
        continue;
    }
    if (alias) {
      ir.bindings.push(Binding(alias, expr));
    } else {
      ir.bindings.push(Binding(outputName, expr));
      ir.warnings.push(
        `convert ${func}(${field}): NRQL cannot overwrite a field in-place; aliased to ${outputName}`,
      );
    }
  }
}

function handleReplace(cmd, ir) {
  const field = cmd.field;
  const pairs = cmd.pairs || [
    { oldValue: cmd.oldValue, newValue: cmd.newValue },
  ];

  let expr = Identifier(field);
  for (const pair of pairs) {
    expr = Func('replace', [
      expr,
      Literal(pair.oldValue, 'string'),
      Literal(pair.newValue, 'string'),
    ]);
  }
  // Store as field replacement — will be applied to FACET or SELECT
  ir._fieldReplacements = ir._fieldReplacements || {};
  ir._fieldReplacements[field] = expr;
}

function handleStrcat(cmd, ir) {
  // strcat field1 "sep" field2 destField
  // Grammar produces: { parts: [{type:'field',value:'host'}, {type:'literal',value:':'}, ...] }
  // Last part is the destination field, rest are concat args
  const parts = cmd.parts;
  if (!parts || parts.length < 2) {
    ir.unsupported.push('strcat requires at least 2 arguments');
    return;
  }
  const destPart = parts[parts.length - 1];
  const destField = destPart.value;
  const concatArgs = parts.slice(0, -1).map((p) => {
    if (p.type === 'literal') return Literal(p.value, 'string');
    return Identifier(p.value);
  });
  ir.bindings.push(Binding(destField, Func('concat', concatArgs)));
}

function translateWhereExpr(expr, ir) {
  if (!expr) return null;
  // The where pipe uses the same AST format as search expressions
  // (BooleanOp, Comparison, etc.), not eval expressions (EvalFunc, etc.)
  // However, where_primary can also contain eval-like function calls
  // and comparisons. We need to handle both formats.
  const { expr: irExpr, warnings, unsupported } = translateSearchExpr(expr);
  ir.warnings.push(...warnings);
  ir.unsupported.push(...unsupported);
  if (irExpr) return irExpr;
  // Fallback: try eval expression walker for eval-style where expressions
  return walkEvalExpr(expr, ir);
}

function translateEvalExpr(cmd, ir) {
  if (cmd.rawText) {
    // Try dot-concat: field = expr . expr . ...
    if (tryParseDotConcat(cmd.rawText, ir)) return null;
    ir.unsupported.push(`eval expression not supported: ${cmd.rawText}`);
    return null;
  }
  // Return the first assignment's expression as IR
  // (cmd has assignments array from the PEG grammar)
  if (cmd.assignments) {
    for (const assignment of cmd.assignments) {
      ir._currentAlias = assignment.field;
      const expr = walkEvalExpr(assignment.expr, ir);
      if (expr) {
        // NRQL WITH clause can't alias to a field that the expression references
        // (circular dependency). In that case, inline into SELECT instead.
        if (exprReferencesField(expr, assignment.field)) {
          ir.select.push(expr);
        } else {
          ir.bindings.push(Binding(assignment.field, expr));
        }
      }
    }
    return null; // bindings/selects added directly
  }
  // Simple single-field eval
  if (cmd.expr) {
    return walkEvalExpr(cmd.expr, ir);
  }
  return null;
}

/**
 * Try to parse a rawText eval as dot-concat: field = expr . expr . ...
 * SPL uses `.` (with spaces) as string concatenation operator.
 * Returns null if the rawText doesn't match this pattern.
 */
function tryParseDotConcat(rawText, ir) {
  // Match: field = stuff . stuff [. stuff ...]
  const eqIdx = rawText.indexOf('=');
  if (eqIdx < 0) return null;
  const field = rawText.slice(0, eqIdx).trim();
  const rhs = rawText.slice(eqIdx + 1).trim();
  // Split on ` . ` (space-dot-space) to distinguish from field.name dots
  const parts = rhs.split(/\s+\.\s+/);
  if (parts.length < 2) return null;
  const concatArgs = parts.map((p) => {
    const trimmed = p.trim();
    // Quoted string
    const strMatch = trimmed.match(/^"(.*)"$|^'(.*)'$/);
    if (strMatch) return Literal(strMatch[1] || strMatch[2] || '', 'string');
    // Number
    if (looksLikeNumber(trimmed)) return Literal(Number(trimmed), 'number');
    // Field name
    return Identifier(trimmed === '_time' ? 'timestamp' : trimmed);
  });
  ir.bindings.push(Binding(field, Func('concat', concatArgs)));
  return true; // signal success; bindings added directly
}

/**
 * Walk an eval expression AST node and produce an IR expression.
 * Handles: EvalFunc, EvalComparison, EvalBoolOp, EvalParens, StringLiteral, bare strings.
 */
function walkEvalExpr(node, ir) {
  if (!node) return null;

  // Bare string — could be field name, number, comparison, or arithmetic expression
  if (typeof node === 'string') {
    if (looksLikeNumber(node)) return Literal(Number(node), 'number');
    if (node === '_time') return Identifier('timestamp');
    // Comparison operators in raw strings (from eval_inner_expr): status>=400, EventCode=4648
    const cmpMatch = node.match(
      /^([a-zA-Z_][\w.]*)\s*(>=|<=|!=|>|<|==|=)\s*(.+)$/,
    );
    if (cmpMatch) {
      const [, field, rawOp, rawValue] = cmpMatch;
      const op = rawOp === '==' ? '=' : rawOp;
      const fieldId = Identifier(field === '_time' ? 'timestamp' : field);
      // Strip surrounding quotes from value if present
      const value =
        (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))
          ? rawValue.slice(1, -1)
          : rawValue;
      if (isNumeric(value)) {
        if (op === '=' || op === '!=') {
          const strCmp = BinOp(op, fieldId, Literal(value, 'string'));
          const numCmp = BinOp(
            op,
            Func('numeric', [fieldId]),
            Literal(Number(value), 'number'),
          );
          return BinOp(op === '=' ? 'OR' : 'AND', strCmp, numCmp);
        }
        return BinOp(
          op,
          Func('numeric', [fieldId]),
          Literal(Number(value), 'number'),
        );
      }
      return BinOp(op, fieldId, Literal(value, 'string'));
    }
    // If the string contains arithmetic operators, parse it into a BinOp tree
    if (/[+\-*/%]/.test(node) && /[a-zA-Z]/.test(node)) {
      return buildArithmeticExpr(node);
    }
    return Identifier(node);
  }

  switch (node.type) {
    case 'EvalFunc':
      return walkEvalFunc(node, ir);

    case 'StringLiteral':
      return Literal(node.value, 'string');

    case 'EvalComparison': {
      const left = walkEvalExpr(node.left, ir);
      const right = walkEvalExpr(node.right, ir);
      if (!left || !right) return null;
      const op = node.op === '==' ? '=' : node.op;
      // For ordering operators on plain fields, wrap in numeric()
      if (['>', '>=', '<', '<='].includes(op)) {
        const numLeft = needsNumeric(node.left)
          ? Func('numeric', [left])
          : left;
        const numRight = needsNumeric(node.right)
          ? Func('numeric', [right])
          : right;
        return BinOp(op, numLeft, numRight);
      }
      // Equality with numeric value: dual-check (string match OR numeric match)
      if (
        (op === '=' || op === '!=') &&
        right.type === 'Literal' &&
        right.kind === 'number' &&
        left.type === 'Identifier'
      ) {
        return DualCheck(left, op, right);
      }
      return BinOp(op, left, right);
    }

    case 'EvalBoolOp': {
      const left = walkEvalExpr(node.left, ir);
      const right = walkEvalExpr(node.right, ir);
      if (!left || !right) return null;
      return BinOp(node.op, left, right);
    }

    case 'EvalParens':
      return walkEvalExpr(node.inner, ir);

    case 'FunctionCall':
      // Where-pipe grammar produces FunctionCall, not EvalFunc — normalize and delegate
      return walkEvalFunc({ name: node.name, args: node.args }, ir);

    default:
      // Unknown node type — treat as bare string
      return Identifier(String(node));
  }
}

function walkEvalFunc(node, ir) {
  const name = node.name.toLowerCase();
  const args = node.args;

  switch (name) {
    case 'if': {
      if (args.length < 2) return null;
      return Func('if', args.map((a) => walkEvalExpr(a, ir)).filter(Boolean));
    }

    case 'case': {
      // case(cond1, val1, cond2, val2, ...) → nested if()
      // Detect 1=1 default and true() default
      let effectiveArgs = [...args];
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
        expr = walkEvalExpr(effectiveArgs[effectiveArgs.length - 1], ir);
        for (let i = effectiveArgs.length - 3; i >= 0; i -= 2) {
          const cond = walkEvalExpr(effectiveArgs[i], ir);
          const val = walkEvalExpr(effectiveArgs[i + 1], ir);
          expr = Func('if', [cond, val, expr].filter(Boolean));
        }
      } else {
        expr = Literal(null, 'null');
        for (let i = effectiveArgs.length - 2; i >= 0; i -= 2) {
          const cond = walkEvalExpr(effectiveArgs[i], ir);
          const val = walkEvalExpr(effectiveArgs[i + 1], ir);
          expr = Func('if', [cond, val, expr].filter(Boolean));
        }
      }
      return expr;
    }

    case 'coalesce': {
      // NRQL (a OR b OR c) is null-coalescing — chain with OR
      const coalesceArgs = args.map((a) => walkEvalExpr(a, ir)).filter(Boolean);
      if (coalesceArgs.length === 0) return null;
      if (coalesceArgs.length === 1) return coalesceArgs[0];
      return coalesceArgs.reduce((acc, arg) => BinOp('OR', acc, arg));
    }

    case 'trim': {
      const child = walkEvalExpr(args[0], ir);
      const gn = ir._currentAlias || '_t';
      return child
        ? Func('capture', [child, Regex(`^\\s*(?P<${gn}>.*\\S)\\s*$`)])
        : null;
    }
    case 'ltrim': {
      const child = walkEvalExpr(args[0], ir);
      const gn = ir._currentAlias || '_t';
      return child
        ? Func('capture', [child, Regex(`^\\s*(?P<${gn}>.*)$`)])
        : null;
    }
    case 'rtrim': {
      const child = walkEvalExpr(args[0], ir);
      const gn = ir._currentAlias || '_t';
      return child
        ? Func('capture', [child, Regex(`^(?P<${gn}>.*\\S)\\s*$`)])
        : null;
    }

    case 'lower':
    case 'upper':
    case 'abs':
    case 'ceil':
    case 'ceiling':
    case 'floor':
    case 'sqrt':
    case 'exp':
    case 'ln':
      return Func(name, args.map((a) => walkEvalExpr(a, ir)).filter(Boolean));

    case 'round': {
      const val = walkEvalExpr(args[0], ir);
      if (!val) return null;
      if (args.length >= 2) {
        // SPL round(val, N) = N decimal places
        // NRQL round(val, N) = nearest multiple of N
        // Convert: round(val, 2) → round(val, 0.01)
        const decPlaces = walkEvalExpr(args[1], ir);
        const decVal = decPlaces?.type === 'Literal' ? decPlaces.value : null;
        if (decVal != null && typeof decVal === 'number') {
          return Func('round', [val, Literal(Math.pow(10, -decVal), 'number')]);
        }
        return Func('round', [val, decPlaces]);
      }
      return Func('round', [val]);
    }

    case 'len':
    case 'length':
    case 'mvcount': {
      ir.warnings.push(
        'length() returns string length in NRQL, not multivalue count; results may differ for non-array fields',
      );
      return Func(
        'length',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );
    }

    case 'substr': {
      // SPL substr is 1-indexed, NRQL substring is 0-indexed — subtract 1 from positive start
      const translated = args.map((a) => walkEvalExpr(a, ir)).filter(Boolean);
      if (translated.length >= 2) {
        const start = translated[1];
        if (
          start.type === 'Literal' &&
          start.kind === 'number' &&
          start.value > 0
        ) {
          translated[1] = Literal(start.value - 1, 'number');
        } else if (start.type !== 'Literal') {
          translated[1] = BinOp('-', start, Literal(1, 'number'));
        }
        // Negative indices pass through unchanged (both SPL and NRQL count from end)
      }
      return Func('substring', translated);
    }

    case 'replace': {
      const translated = args.map((a) => walkEvalExpr(a, ir)).filter(Boolean);
      // SPL replace() uses regex; NRQL replace() is literal-only
      if (
        args.length >= 2 &&
        typeof args[1] === 'object' &&
        args[1].type === 'StringLiteral'
      ) {
        const pattern = args[1].value;
        // URLs/paths use ? and + as literals — skip word-quantifier
        // check for strings that look like URLs or paths
        const isUrlOrPath = /^\/|:\/\//.test(pattern);
        // Detect regex syntax in the post-parse value. The parser already
        // interprets escapes (\t→tab, \d→d), so we check for structural
        // patterns: char classes, groups, dot-quantifiers, brace repetition,
        // anchors, alternation, quantifiers after word/group/class chars.
        // For URL/path patterns, skip \w[+*?] to avoid false positives
        // on query strings (?key=val) and encoded spaces (+)
        const regexCoreRe =
          /\[.*\]|\(.*\)|\.[*+?]|\{\d+[,}]|^\^|\$$|\||\)[+*?]|\][+*?]/;
        const wordQuantifierRe = /\w[+*?]/;
        if (
          regexCoreRe.test(pattern) ||
          (!isUrlOrPath && wordQuantifierRe.test(pattern))
        ) {
          ir.unsupported.push(
            `replace() with regex pattern '${pattern}' not supported — NRQL replace() is literal-only`,
          );
        }
      }
      return Func('replace', translated);
    }

    case 'isnull':
      return IsNull(walkEvalExpr(args[0], ir));

    case 'isnotnull': {
      const child = walkEvalExpr(args[0], ir);
      return child ? Not(IsNull(child)) : null;
    }

    case 'isint':
    case 'isnum': {
      // SPL isint()/isnum() → NRQL numeric(field) IS NOT NULL
      const child = walkEvalExpr(args[0], ir);
      return child ? Not(IsNull(Func('numeric', [child]))) : null;
    }

    case 'like': {
      const field = walkEvalExpr(args[0], ir);
      // Pattern arg may be a raw string (from where-pipe FunctionCall)
      const rawPat = args[1];
      const patStr =
        typeof rawPat === 'string'
          ? rawPat
          : rawPat?.type === 'StringLiteral'
            ? rawPat.value
            : (walkEvalExpr(rawPat, ir)?.value ?? String(rawPat));
      if (field && patStr) {
        // Convert SPL wildcards to NRQL: * → %
        const nrqlPattern = patStr.replace(/\*/g, '%');
        return Like(field, nrqlPattern);
      }
      return null;
    }

    case 'cidrmatch': {
      // cidrmatch("10.0.0.0/8", src_ip) → cidrAddress(src_ip, 8) = '10.0.0.0/8'
      const rawCidr = args[0];
      const cidrStr =
        typeof rawCidr === 'string'
          ? rawCidr
          : rawCidr?.type === 'StringLiteral'
            ? rawCidr.value
            : (walkEvalExpr(rawCidr, ir)?.value ?? String(rawCidr));
      const ipField = walkEvalExpr(args[1], ir);
      if (cidrStr && ipField) {
        const prefixMatch = cidrStr.match(/\/(\d+)$/);
        const prefix = prefixMatch ? Number(prefixMatch[1]) : 24;
        return BinOp(
          '=',
          Func('cidrAddress', [ipField, Literal(prefix, 'number')]),
          Literal(cidrStr, 'string'),
        );
      }
      return null;
    }

    case 'match': {
      const field = walkEvalExpr(args[0], ir);
      // Pattern arg may be a raw string (from where-pipe FunctionCall)
      // or a StringLiteral/Literal node (from eval AST)
      const rawPattern = args[1];
      const patternStr =
        typeof rawPattern === 'string'
          ? rawPattern
          : rawPattern?.type === 'StringLiteral'
            ? rawPattern.value
            : (walkEvalExpr(rawPattern, ir)?.value ?? String(rawPattern));
      if (field && patternStr) {
        return Rlike(field, patternStr);
      }
      return null;
    }

    case 'tonumber': {
      return Func(
        'numeric',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );
    }

    case 'now':
      return Func('now', []);

    case 'null':
      return Literal(null, 'null');

    case 'true':
      return Func('true', []);

    case 'mvjoin':
      ir.unsupported.push(
        'mvjoin() has no NRQL equivalent — NRQL cannot join array elements into a delimited string',
      );
      return walkEvalExpr(args[0], ir);

    case 'mvappend':
      return Func(
        'mvappend',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );

    case 'mvsort':
      return Func(
        'mvsort',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );

    case 'mvindex': {
      if (args.length < 2) {
        ir.warnings.push(
          'mvindex() requires at least 2 arguments (field, index)',
        );
        return walkEvalExpr(args[0], ir);
      }
      return Func(
        'getField',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );
    }

    case 'split': {
      return Func(
        'split',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );
    }

    case 'pow':
      return Func('pow', args.map((a) => walkEvalExpr(a, ir)).filter(Boolean));

    case 'log': {
      // SPL log(val) = log base 10; log(val, base) = log with base
      // NRQL log(val, base) requires two args; log10(val) for base 10
      const logArgs = args.map((a) => walkEvalExpr(a, ir)).filter(Boolean);
      if (logArgs.length === 1) return Func('log10', logArgs);
      return Func('log', logArgs);
    }

    case 'log10':
      return Func(
        'log10',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );

    case 'log2':
      return Func('log2', args.map((a) => walkEvalExpr(a, ir)).filter(Boolean));

    case 'tostring':
      // SPL tostring() → NRQL string()
      return Func(
        'string',
        args.map((a) => walkEvalExpr(a, ir)).filter(Boolean),
      );

    case 'json_extract':
    case 'spath': {
      // SPL json_extract(field, "$.path") or spath(field, "path") → jparse(field, 'path')
      const fieldArg = walkEvalExpr(args[0], ir);
      const pathArg = args[1];
      let path =
        typeof pathArg === 'string'
          ? pathArg
          : (pathArg && pathArg.value) || '';
      // Strip JSONPath $. prefix — jparse uses bare paths
      path = path.replace(/^\$\.?/, '');
      // Convert Splunk {} array notation to [] for jparse
      path = path.replace(/\{(\d*)\}/g, (_, n) => (n ? `[${n}]` : '[*]'));
      return Func('jparse', [fieldArg, Literal(path, 'string')]);
    }

    case 'typeof':
    case 'isbool':
    case 'isstr': {
      ir.unsupported.push(`eval function ${name}() has no NRQL equivalent`);
      return null;
    }

    default: {
      // Unknown function — pass through with warning
      ir.unsupported.push(`eval function ${name}() has no NRQL equivalent`);
      return Func(name, args.map((a) => walkEvalExpr(a, ir)).filter(Boolean));
    }
  }
}

function needsNumeric(node) {
  return (
    typeof node === 'string' &&
    !looksLikeNumber(node) &&
    !/[+\-*/%()]/.test(node)
  );
}

function isTrueCondition(node) {
  if (typeof node === 'string') return node === '1' || node === 'true';
  if (node && node.type === 'EvalComparison') {
    return node.left === '1' && node.op === '=' && node.right === '1';
  }
  return !!(node && node.type === 'EvalFunc' && node.name === 'true');
}
