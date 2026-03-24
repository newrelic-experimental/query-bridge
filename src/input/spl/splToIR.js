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
  Like,
  In,
  RawNrql,
} from '../../ir/nodes.js';
import { parseSplTime } from './splTime.js';
import {
  buildComparison,
  buildJparseComparison,
  coerceValue,
  escapeWildcard,
  normalizeSubsearch,
} from './splExprUtils.js';
import * as parser from './splParser.js';
import { handleEval, handleWhere } from './evalHandlers.js';
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
import {
  handleStats,
  handleTimechart,
  handleTop,
  handleRare,
  handleEventstats,
} from './aggregationHandlers.js';

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

      case 'TopLevelSubsearch': {
        // [subsearch] at the top level — Splunk runs the inner search and
        // uses results as search terms. We parse the subsearch and fold its
        // WHERE clause into the outer query.
        try {
          const subAst = parser.parse(normalizeSubsearch(node.rawText));
          const subIR = translateAstToIR(subAst);
          for (const w of subIR.warnings) warnings.push(`subsearch: ${w}`);
          for (const u of subIR.unsupported)
            unsupported.push(`subsearch: ${u}`);
          return subIR.where;
        } catch (e) {
          unsupported.push(`[subsearch] could not be parsed: ${e.message}`);
          return null;
        }
      }

      default:
        warnings.push(`Unknown search node type: ${node.type}`);
        return null;
    }
  }

  const expr = walk(node);
  return { expr, warnings, unsupported, since, until };
}

// ── Command dispatch ─────────────────────────────────────────

const handlers = {
  // Aggregation
  StatsCommand: handleStats,
  TimechartCommand: handleTimechart,
  ChartCommand: handleStats, // chart is structurally same as stats
  TopCommand: handleTop,
  RareCommand: handleRare,
  TableCommand: handleTable,
  EventstatsCommand: handleEventstats,

  // Enrichment
  JoinCommand: handleJoin,
  AppendpipeCommand: handleAppendpipe,
  InputlookupCommand: handleInputlookup,
  LookupCommand: handleLookup,

  // Extraction
  RexCommand: handleRex,
  SpathCommand: handleSpath,
  RegexCommand: handleRegex,
  SearchCommand: handleSearchPipe,

  // Eval
  EvalCommand: handleEval,
  WhereCommand: handleWhere,

  // Row transforms
  FieldsCommand: handleFields,
  SortCommand: handleSort,
  HeadCommand: handleHead,
  RenameCommand: handleRename,
  DedupCommand: handleDedup,
  BinCommand: handleBin,
  ReverseCommand: handleReverse,
  FillnullCommand: handleFillnull,
  StrcatCommand: handleStrcat,
  ConvertCommand: handleConvert,
  ReplaceCommand: handleReplace,
  MvexpandCommand: handleMvexpand,
  UniqCommand: handleUniq,
};

function applyCommand(cmd, ir) {
  const handler = handlers[cmd.type];
  if (handler) {
    handler(cmd, ir);
    return;
  }

  // Commands with inline logic that doesn't fit the handler pattern
  switch (cmd.type) {
    case 'AppendCommand':
    case 'AppendcolsCommand':
      handleAppend(
        cmd,
        ir,
        cmd.type === 'AppendcolsCommand' ? 'appendcols' : 'append',
      );
      return;
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
