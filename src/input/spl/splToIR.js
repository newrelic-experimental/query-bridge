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
  Like,
  In,
  Wildcard,
  RawNrql,
  JoinClause,
  OrderBy,
} from '../../ir/nodes.js';
import { parseSplTime } from './splTime.js';
import {
  mapFunction,
  formatSpan,
  buildComparison,
  buildJparseComparison,
  coerceValue,
  escapeWildcard,
  wrapAsSubquery,
} from './splExprUtils.js';
import { handleEval, handleWhere, walkEvalExpr } from './evalHandlers.js';
import {
  handleTable,
  handleFields,
  handleSort,
  handleHead,
  handleRename,
  handleDedup,
  handleBin,
  handleReverse,
  handleFillnull,
  handleConvert,
  handleReplace,
  handleStrcat,
  handleMvexpand,
  handleUniq,
} from './rowHandlers.js';
import {
  handleRex,
  handleSpath,
  handleRegex,
  handleSearchPipe,
} from './extractionHandlers.js';
import {
  handleJoin,
  handleAppend,
  handleAppendpipe,
  handleInputlookup,
  handleLookup,
} from './enrichmentHandlers.js';

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

export function translateSearchExpr(node) {
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
      handleHead(cmd, ir);
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
      handleMvexpand(cmd, ir);
      return;
    case 'UniqCommand':
      handleUniq(cmd, ir);
      return;
    case 'ReverseCommand':
      handleReverse(cmd, ir);
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

function handleTimechart(cmd, ir) {
  handleStats(cmd, ir);
  ir.timeseries = cmd.span ? formatSpan(cmd.span) : 'AUTO';
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
