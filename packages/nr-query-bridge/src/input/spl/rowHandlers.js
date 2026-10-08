/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Row transform command handlers.
 *
 * Handlers for SPL commands that reshape, filter, or transform
 * individual rows without aggregation: fields, sort, head, rename,
 * dedup, bin, reverse, fillnull, strcat, convert, replace, etc.
 */
import {
  Identifier,
  Literal,
  Func,
  BinOp,
  Alias,
  OrderBy,
  Wildcard,
  Binding,
  ExpandClause,
} from '../../ir/nodes.js';
import {
  mapFieldName,
  formatSpan,
  looksLikeNumber,
  rawEventIdentifier,
  collectionBindingOf,
} from './splExprUtils.js';
import { recognizeWildcardRename, collectRefs } from './wildcardRename.js';
import { messages } from '../../messages.js';
import { getPreview } from '../../previewFlags.js';

export function handleTable(cmd, ir) {
  if (ir._hasAggregation) {
    projectAggregatedColumns(cmd.fields, ir, 'table');
    return;
  }
  const select = selectEventFields(cmd.fields, ir, 'table');
  if (select) ir.select = select;
}

export function handleFields(cmd, ir) {
  if (cmd.mode === '-') {
    // fields - X removes X from select (if explicit) or is a no-op
    // In NRQL, there's no way to exclude fields from SELECT *
    ir.warnings.push(messages.fields_exclude_limited());
  } else if (ir._hasAggregation) {
    projectAggregatedColumns(cmd.fields, ir, 'fields');
  } else {
    const select = selectEventFields(cmd.fields, ir, 'fields');
    if (select) ir.select = select;
  }
}

// table/fields over raw events → SELECT of those attributes. A `name*` wildcard
// or a `fn(x)` stats-column name has no event-attribute equivalent → unsupported.
function selectEventFields(fields, ir, command) {
  const bad = fields.filter(
    (f) => f !== '*' && (f.includes('*') || /\(.*\)$/.test(f)),
  );
  if (bad.length > 0) {
    for (const f of bad) {
      ir.unsupported.push(
        f.includes('*')
          ? messages.list_wildcard_field(command, f)
          : messages.list_stats_column_without_stats(command, f),
      );
    }
    return null;
  }
  // `table _raw` shows the whole raw event. In New Relic that is every attribute
  // (SELECT *, rendered as a log table) — `message` alone is one attribute, and
  // is absent when the Log API flattened a JSON-only message into attributes.
  // SELECT * is a superset of any other listed field.
  if (fields.includes('_raw')) {
    ir.warnings.push(messages.list_raw_select_all(command));
    return [Wildcard()];
  }
  return fields.map((f) => Identifier(mapFieldName(f)));
}

// A `*` glob as a RegExp over whole names.
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

/**
 * table/fields AFTER an aggregation is a projection of the aggregated columns,
 * never a SELECT of event attributes (`SELECT a, c … FACET a` is invalid NRQL
 * and drops the aggregate). Keeps the listed aggregate columns; FACET keys are
 * always returned by NRQL, so an unlisted key stays (warned). Listed names the
 * aggregation doesn't produce show as empty columns in Splunk — warned and
 * skipped.
 *
 * Flat aggregation: filter ir.select. Wrapped (a where/eval already made the
 * aggregation a subquery): the outer SELECT names inner columns row-wise.
 */
function projectAggregatedColumns(fields, ir, command) {
  const wrapped = ir.dataSource?.type === 'SubquerySource';
  const matches = (name, f) =>
    !!name && (f.includes('*') ? globToRegExp(f).test(name) : name === f);

  // Columns on offer: [{ names (Splunk-visible names), entry (select entry or
  // null), ref (outer reference name when wrapped), facet }]
  const columns = [];
  const facetNames = new Set();
  const facetSource = wrapped ? ir.dataSource.query.facet : ir.facet;
  for (const f of facetSource) {
    if (f.type === 'Identifier') {
      facetNames.add(f.name);
      columns.push({ names: [f.name], ref: f.name, facet: true });
    }
  }
  const nameOf = (e) =>
    e.type === 'Alias'
      ? [e.name]
      : [e._splName, e.type === 'Function' ? e.name : null].filter(Boolean);
  if (wrapped && ir.select.length === 0) {
    for (const e of ir.dataSource.query.select) {
      // A subquery exposes an aggregate under its alias or bare NRQL name.
      const names = nameOf(e);
      if (names.length > 0) columns.push({ names, ref: e.name, entry: null });
    }
  } else {
    for (const e of ir.select) {
      if (e.type === 'Identifier' && facetNames.has(e.name)) continue;
      columns.push({ names: nameOf(e), entry: e });
    }
  }

  const kept = [];
  const missing = [];
  for (const f of fields) {
    const hits = columns.filter((c) => c.names.some((n) => matches(n, f)));
    if (hits.length === 0) {
      if (f !== '*') missing.push(f);
      continue;
    }
    for (const h of hits) if (!kept.includes(h)) kept.push(h);
  }
  if (fields.includes('*')) return; // everything stays

  const keptAggs = kept.filter((c) => !c.facet);
  const unlistedFacets = [...facetNames].filter(
    (n) => !kept.some((c) => c.facet && c.ref === n),
  );
  if (missing.length > 0) {
    ir.warnings.push(messages.list_column_not_produced(command, missing));
  }

  if (wrapped && ir.select.length === 0) {
    // Outer row-wise projection over the subquery's exposed columns (nothing
    // matched → leave SELECT *).
    ir.select = kept.map((c) => Identifier(c.ref));
    return;
  }
  if (keptAggs.length === 0) {
    // NRQL needs at least one aggregate alongside FACET; keep them all.
    ir.warnings.push(messages.list_keeps_aggregates(command));
  } else {
    const dropped = columns.filter((c) => !c.facet && !keptAggs.includes(c));
    ir.select = ir.select.filter((e) => !dropped.some((c) => c.entry === e));
  }
  if (unlistedFacets.length > 0) {
    ir.warnings.push(messages.list_keeps_facets(command, unlistedFacets));
  }
}

export function handleSort(cmd, ir) {
  if (cmd.fields.length > 0) {
    const first = cmd.fields[0];
    let field = first.field;
    // `sort -dc(requestId)`: the column an unaliased `stats dc(requestId)`
    // produced. Resolve it to that aggregate's output name.
    if (/\(.*\)$/.test(field)) {
      const col = ir.select.find(
        (e) => e.type !== 'Alias' && e._splName === field,
      );
      if (!col) {
        ir.unsupported.push(messages.sort_unknown_stats_column(field));
        return;
      }
      field = col.name;
    }
    ir.orderBy = OrderBy(Identifier(field), first.direction === 'desc');
  }
  // Additional sort fields become ORDER BY field1 DESC, field2 ASC
  // NRQL only supports single ORDER BY — warn if multiple
  if (cmd.fields.length > 1) {
    ir.warnings.push(messages.sort_single_field());
  }
  // SPL `sort N field` / `sort field limit=N` caps the result to N rows.
  // `sort 0 ...` means unlimited, so leave ir.limit unset.
  if (cmd.limit != null && cmd.limit > 0) {
    ir.limit = cmd.limit;
  }
}

export function handleHead(cmd, ir) {
  // A head between two aggregations can't be expressed faithfully (see
  // handleStats). Mark it so the next aggregation can fail loud; harmless if no
  // second aggregation follows (head after a single stats is a valid LIMIT N).
  if (ir._hasAggregation) ir._headBetweenAgg = true;
  ir.limit = cmd.count;
}

export function handleTail(cmd, ir) {
  if (ir._hasAggregation) ir._headBetweenAgg = true;
  ir.limit = cmd.count;
  ir.orderBy = OrderBy(Identifier('timestamp'), false); // ASC = oldest first
}

export function handleRename(cmd, ir) {
  let added = 0;
  for (const rename of cmd.renames) {
    if (rename.from.includes('*') || rename.to.includes('*')) {
      const mark = recognizeWildcardRename(rename.from, rename.to);
      if (mark) {
        ir._wildcardRenames = ir._wildcardRenames || [];
        ir._wildcardRenames.push({ ...mark, beforeNames: collectRefs(ir) });
        continue; // consumed post-loop by applyWildcardRenames
      }
      ir.unsupported.push(messages.rename_wildcard(rename.from, rename.to));
      continue;
    }
    if (/[()]/.test(rename.from)) {
      ir.unsupported.push(messages.rename_parens(rename.from));
      continue;
    }
    // If renaming a stats alias, fold into the existing alias instead of adding a new one
    const existingIdx = ir.select.findIndex(
      (s) => s.type === 'Alias' && s.name === rename.from,
    );
    if (existingIdx >= 0) {
      ir.select[existingIdx] = Alias(ir.select[existingIdx].expr, rename.to);
    } else if (ir._hasAggregation && renameAggregateColumn(ir, rename)) {
      // An aggregate or group-by column of this level: alias it in place.
      // Re-selecting it by name is invalid NRQL (`count` is not a column;
      // a FACET key in SELECT is "not constant in its context").
    } else {
      ir.select.push(Alias(Identifier(mapFieldName(rename.from)), rename.to));
    }
    added++;
  }
  // Keep all other fields — NRQL has no rename-and-drop-original
  if (added > 0 && !ir._hasAggregation) {
    ir.select.push(Wildcard());
    ir.warnings.push(messages.rename_keeps_original());
  }
}

// `rename count AS Count` / `rename Task AS Detail` after a flat aggregation:
// alias the unaliased aggregate Splunk calls `count`, or the FACET key. Returns
// false when the name is neither (the caller keeps its old behavior).
function renameAggregateColumn(ir, rename) {
  if (ir.dataSource && ir.dataSource.type === 'SubquerySource') return false;
  const aggIdx = ir.select.findIndex(
    (e) => e.type !== 'Alias' && e._splName === rename.from,
  );
  if (aggIdx >= 0) {
    ir.select[aggIdx] = Alias(ir.select[aggIdx], rename.to);
    return true;
  }
  const key = mapFieldName(rename.from);
  const facetIdx = ir.facet.findIndex(
    (f) =>
      (f.type === 'Identifier' && f.name === key) ||
      (f.type === 'Alias' && f.name === rename.from),
  );
  if (facetIdx < 0) return false;
  const facet = ir.facet[facetIdx];
  ir.facet[facetIdx] = Alias(
    facet.type === 'Alias' ? facet.expr : facet,
    rename.to,
  );
  return true;
}

// TODO: dedup sortby — SPL `dedup host sortby -duration` keeps the row with
//   the highest duration per host. Our grammar doesn't parse sortby/keepevents
//   options, and the handler ignores sort order (always uses latest()).
//   Source: splunk-to-nr migration guide (docs/references/splunk-to-nr-migration-guide.md)
//   Feasibility: grammar change + handler change to use max()/min() instead of latest().
export function handleDedup(cmd, ir) {
  // `dedup N f` keeps N events per key; a FACET collapses to one row per key.
  if (cmd.count != null && cmd.count !== 1) {
    ir.unsupported.push(messages.dedup_count_unsupported(cmd.count));
    return;
  }
  // Only plain counts follow (splToIR lookahead): stay row-wise and let the
  // aggregation count distinct keys — no nesting, no 5,000-key FACET cap.
  if (cmd._countDistinct) {
    ir._dedupCountKey = cmd.fields[0];
    ir.warnings.push(messages.dedup_unique_count(cmd.fields[0]));
    return;
  }
  const isOverEvents = !ir._hasAggregation;
  const carried = isOverEvents ? getDedupCarriedColumns(cmd, ir) : null;
  for (const field of cmd.fields) {
    const id = Identifier(field);
    if (!ir.facet.some((f) => f.name === field)) {
      ir.facet.push(id);
    }
  }
  if (carried && carried.length > 0) {
    ir.select = carried;
  } else if (ir.select.length === 0) {
    ir.select.push(Func('latest', [Identifier('timestamp')]));
  }
  ir.limit = 'MAX';
  ir._hasAggregation = true;
  ir._dedupLevel = isOverEvents; // a later join may carry more (handleJoin)
  if (carried && carried.length > 0) {
    ir.warnings.push(
      messages.dedup_latest_per_field(carried.map((c) => c.name)),
    );
  } else {
    ir.warnings.push(messages.dedup_facet_warning());
  }
}

// The fields `dedup` must keep for the steps after it: each is carried as
// `latest(f) AS 'f'` beside FACET <keys>, so a later eval/where/stats reads it in
// the level above (sandbox-verified). Also turns an earlier raw projection
// (`table a b | dedup k`) into latest() columns — `SELECT a … FACET k` is
// invalid. null when the later reads can't be enumerated (dedup then keeps only
// its keys, as before).
function getDedupCarriedColumns(cmd, ir) {
  const refs = cmd._downstreamRefs;
  if (!refs) return null;
  const keys = new Set(cmd.fields.map(mapFieldName));
  const columns = [];
  const add = (name, expr) => {
    if (keys.has(name) || columns.some((c) => c.name === name)) return;
    const column = Alias(Func('latest', [expr]), name);
    column.carried = true; // a per-key row value, not an aggregate (fold pass)
    columns.push(column);
  };
  for (const item of ir.select) {
    if (item.type === 'Identifier') add(item.name, item);
    else if (item.type === 'Alias') add(item.name, item.expr);
    else if (item.type !== 'Wildcard') return null;
  }
  for (const name of refs.fields) {
    const field = mapFieldName(name);
    add(field, field === 'message' ? rawEventIdentifier() : Identifier(field));
  }
  return columns;
}

export function handleBin(cmd, ir) {
  if (
    cmd.span &&
    typeof cmd.span === 'object' &&
    cmd.span.type === 'SpanToken'
  ) {
    ir.unsupported.push(messages.span_token_unsupported(`$${cmd.span.name}$`));
    return;
  }
  if (cmd.field === '_time' && cmd.span) {
    ir.timeseries = formatSpan(cmd.span);
    if (cmd.alias) {
      // `bin _time as X` names the time bucket. NRQL has no named time bucket;
      // downstream references to the alias map to TIMESERIES, so record the name
      // and strip it from FACET later (splToIR FACET-strip pass).
      if (!ir._timeBucketAliases) ir._timeBucketAliases = new Set();
      ir._timeBucketAliases.add(cmd.alias);
    }
    if (ir.select.length === 0) {
      ir.select.push(Func('count', []));
    }
  } else if (cmd.field && (cmd.span || cmd.width)) {
    const width = cmd.width || Number(cmd.span);
    const binned = Number.isFinite(width) && width !== 0;
    if (getPreview(ir).facetEvaluables && binned) {
      // `bin f span=N | stats … by f` groups by the bucket. `FACET <computed
      // expression>` expresses that directly, so point later references at
      // `floor(numeric(f)/N)*N` — Splunk's label is the bucket's LOWER BOUND,
      // hence the `*N` rather than a bare bucket index.
      //
      // Deliberately does NOT set `_hasAggregation`: this is a row-wise
      // bucketing, and marking it as an aggregation is what makes the following
      // `stats` wrap as a subquery and fail `compound_collapse_unsupported`.
      ir._fieldReplacements = ir._fieldReplacements || {};
      ir._fieldReplacements[cmd.alias || cmd.field] = BinOp(
        '*',
        Func('floor', [
          BinOp(
            '/',
            Func('numeric', [Identifier(cmd.field)]),
            Literal(width, 'number'),
          ),
        ]),
        Literal(width, 'number'),
      );
      ir.warnings.push(messages.bin_facet_expression(cmd.field, width));
    } else {
      // Numeric bin → histogram(field, width)
      ir.select = [
        Func('histogram', [Identifier(cmd.field), Literal(width, 'number')]),
      ];
      ir._hasAggregation = true;
    }
  } else {
    ir.unsupported.push(messages.bin_unsupported());
  }
}

export function handleReverse(cmd, ir) {
  ir.orderBy = OrderBy(Identifier('timestamp'), false);
  if (ir._hasAggregation) {
    ir.warnings.push(messages.reverse_after_agg());
  }
}

// The select entry of a column this flat aggregation level produces (its alias
// or Splunk name), or undefined.
function getAggregateOutput(ir, field) {
  if (!ir._hasAggregation) return undefined;
  if (ir.dataSource && ir.dataSource.type === 'SubquerySource')
    return undefined;
  return ir.select.find((e) =>
    e.type === 'Alias' ? e.name === field : e._splName === field,
  );
}

// Aggregates an empty bucket reports as 0 (not null) — sandbox-verified:
// count/sum give 0, average gives null.
const ZERO_WHEN_EMPTY = new Set(['count', 'sum', 'uniqueCount']);

function isZeroWhenEmpty(entry) {
  let e = entry.type === 'Alias' ? entry.expr : entry;
  if (e.type === 'Function' && e.name === 'filter') e = e.args[0];
  return e.type === 'Function' && ZERO_WHEN_EMPTY.has(e.name);
}

export function handleFillnull(cmd, ir) {
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
      const aggregate = getAggregateOutput(ir, field);
      if (aggregate) {
        // `timechart count … | fillnull value=0 x`: x is an aggregate of this
        // level, not a column NRQL can re-read (`x OR 0` is rejected). An
        // empty count/sum bucket already shows as 0; anything else can't be set.
        if (Number(fillValue) === 0 && isZeroWhenEmpty(aggregate)) {
          ir.warnings.push(messages.fillnull_aggregate_zero(field));
        } else {
          ir.unsupported.push(messages.fillnull_aggregate_value(field));
        }
        continue;
      }
      ir._fillnullMap[field] = litValue;
    }
  } else {
    ir.unsupported.push(messages.fillnull_no_fields());
  }
}

export function handleConvert(cmd, ir) {
  // Grammar produces: { specs: [{name, field, alias}, ...], rawText: string|null }
  const specs = cmd.specs;
  if (!specs || specs.length === 0) {
    if (cmd.rawText) {
      ir.unsupported.push(messages.convert_parse_failed(cmd.rawText));
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
        ir.unsupported.push(messages.convert_auto_unsupported(field));
        return;
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
      case 'dur2sec':
        ir.unsupported.push(messages.convert_dur2sec_unsupported(field));
        return;
      case 'mstime':
        ir.unsupported.push(messages.convert_mstime_unsupported(field));
        return;
      default:
        ir.unsupported.push(messages.convert_func_unsupported(func, field));
        continue;
    }
    if (alias) {
      ir.bindings.push(Binding(alias, expr));
    } else {
      ir.bindings.push(Binding(outputName, expr));
      ir.warnings.push(messages.convert_alias_warning(func, field, outputName));
    }
  }
}

export function handleReplace(cmd, ir) {
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

export function handleStrcat(cmd, ir) {
  // strcat field1 "sep" field2 destField
  // Grammar produces: { parts: [{type:'field',value:'host'}, {type:'literal',value:':'}, ...] }
  // Last part is the destination field, rest are concat args
  const parts = cmd.parts;
  if (!parts || parts.length < 2) {
    ir.unsupported.push(messages.strcat_too_few_args());
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

export function handleMvexpand(cmd, ir) {
  const preview = getPreview(ir);
  const source = preview.expand ? collectionBindingOf(cmd.field, ir) : null;
  if (!source) {
    // No `Expand` opt-in, or the field is not a provable collection.
    ir.unsupported.push(messages.mvexpand_unsupported());
    return;
  }

  // AI-DEV: EXPAND combined with JOIN is a known Limited Preview defect. Stay
  // loud until it is re-verified against a flag-enabled account rather than
  // emitting a query whose row multiplication is undefined.
  if (ir.join) {
    ir.unsupported.push(messages.expand_with_join_unsupported());
    return;
  }

  // The alias MUST differ from the source binding name: the original attribute
  // stays readable on every replayed row, so reusing the name would leave
  // downstream `stats ... by field` grouping on the whole list.
  const alias = pickExpandAlias(cmd.field, ir);
  ir.expand.push(ExpandClause(Identifier(source.name), alias));

  // Point later references at the per-element binding. applyFieldReplacements
  // relabels output columns back to the Splunk name (`perms_expanded AS
  // 'perms'`) and leaves the EXPAND source itself alone.
  ir._fieldReplacements = ir._fieldReplacements || {};
  ir._fieldReplacements[cmd.field] = Identifier(alias);

  // NRQL EXPAND is capped at 1:100 and TRUNCATES SILENTLY — the query keeps
  // running, so without this the user cannot tell a long list was cut.
  ir.warnings.push(messages.expand_truncation_cap());

  // SPL `mvexpand field limit=N` caps elements per event; NRQL has no per-event
  // EXPAND limit, only the fixed 1:100 cap.
  if (cmd.limit != null) {
    ir.warnings.push(messages.expand_limit_ignored(cmd.limit));
  }
}

// A per-element binding name that collides with no existing binding, select
// alias, or facet key.
function pickExpandAlias(field, ir) {
  const taken = new Set(ir.bindings.map((b) => b.name));
  let candidate = `${field}_expanded`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${field}_expanded${n}`;
    n++;
  }
  return candidate;
}

export function handleUniq(_cmd, ir) {
  ir.unsupported.push(messages.uniq_unsupported());
}
