/**
 * IR pass: collapse over-nested post-aggregation chains.
 * Walks the SubquerySource chain (NOT via transformTree, which skips SubquerySource)
 * and folds a row-wise eval-projection layer into the aggregating layer beneath it.
 * Also extracts a median/percentile scalar via getField when a where/trailing-agg layer
 * references the keyed-object column across the subquery boundary; a list-shaped
 * (uniques/values) reference stays loud unsupported.
 */
import { Func, Alias, Identifier, Literal, Binding } from './nodes.js';
import { messages } from '../messages.js';

// Has a distributed (aggregate-capable) form in dirac DefaultNRQLProvider
// getDistributedFunctionFactories() — verified 2026-06-25.
const FOLD_SAFE_FUNCS = new Set([
  'round',
  'abs',
  'ceil',
  'floor',
  'sqrt',
  'exp',
  'ln',
  'log',
  'log2',
  'log10',
  'pow',
  'mod',
  'if',
  'case',
  'string',
  'convert',
  'getField',
  'extractfield',
]);
const NRQL_AGG_FUNCS = new Set([
  'count',
  'sum',
  'average',
  'min',
  'max',
  'median',
  'percentile',
  'stddev',
  'standarddeviation',
  'uniqueCount',
  'uniques',
  'latest',
  'earliest',
  'rate',
  'percentage',
]);

export function isFoldSafe(name) {
  return FOLD_SAFE_FUNCS.has(name);
}

export function isAggregateExpr(node) {
  if (!node) return false;
  if (node.type === 'Alias') return isAggregateExpr(node.expr);
  if (node.type === 'Function') {
    return NRQL_AGG_FUNCS.has(node.name) || node.args.some(isAggregateExpr);
  }
  if (node.type === 'BinOp')
    return isAggregateExpr(node.left) || isAggregateExpr(node.right);
  return false;
}

// Aggregating iff it groups (facet) or selects an aggregate; else row-wise.
function classifyLayer(query) {
  if (query.facet.length > 0) return 'aggregating';
  if (query.select.some(isAggregateExpr)) return 'aggregating';
  return 'rowwise';
}

// name -> defining expr for every column the inner subquery exposes.
function exposedInnerColumns(inner) {
  const map = new Map();
  for (const item of inner.select) {
    if (item.type === 'Alias') map.set(item.name, item.expr);
    else if (item.type === 'Function') {
      map.set(item.name === 'stddev' ? 'standarddeviation' : item.name, item);
    } else if (item.type === 'Identifier') map.set(item.name, item);
  }
  for (const f of inner.facet) if (f.type === 'Identifier') map.set(f.name, f);
  return map;
}

// Across a subquery boundary, median/percentile expose a KEYED OBJECT ({50: v} /
// {N: v}); a bare reference / numeric() over it resolves to null (silent-wrong).
// uniques (the NRQL form of SPL values/list) exposes a LIST — no scalar extraction
// exists. Given an inner aggregate's DEFINING expr, return the extraction a
// cross-boundary reference needs: { key } for median/percentile (median → '50',
// percentile(x, N) → String(N)); { list: true } for uniques; null for a scalar.
function extractNonScalar(innerExpr) {
  const fn =
    innerExpr?.type === 'Function'
      ? innerExpr
      : innerExpr?.type === 'Alias' && innerExpr.expr?.type === 'Function'
        ? innerExpr.expr
        : null;
  if (!fn) return null;
  if (fn.name === 'median') return { key: '50' };
  if (fn.name === 'percentile') {
    // percentile(field, N): N is the last arg (a numeric Literal). mapFunction
    // always appends it, so a missing/non-numeric N is a translator bug, not user
    // input — bail to scalar (null) rather than emit getField(col, '') silently.
    const nArg = fn.args?.[fn.args.length - 1];
    if (nArg?.type === 'Literal' && nArg.kind === 'number')
      return { key: String(nArg.value) };
    return null;
  }
  if (fn.name === 'uniques') return { list: true };
  return null;
}

// Deny-by-default copy-rewrite: rebuild the expression tree, applying `replace` at
// every node (replace returns a replacement node, or null to recurse into the
// original). Mirrors collectIdentifiers' enumerate-every-property structure so a
// reference can't hide in a node type this forgot (Not/IsNull/Like/In/DualCheck/…);
// nested subqueries are NOT descended (their refs resolve against their own inner).
function rewriteExpr(node, replace) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => rewriteExpr(n, replace));
  if (node.type === 'SubqueryExpr' || node.type === 'SubquerySource')
    return node;
  const replaced = replace(node);
  if (replaced) return replaced;
  const out = {};
  for (const key of Object.keys(node)) {
    out[key] = key === 'type' ? node[key] : rewriteExpr(node[key], replace);
  }
  return out;
}

// Rewrite a WHERE/SELECT reference to a keyed-object column to the WITH-bound name,
// stripping a numeric() wrapper around it (getField already yields the scalar, so
// `numeric(md50) > 10` would be redundant — the staging-validated form is `md50 > 10`).
// `bound` maps the exposed column name -> its WITH-bound alias (e.g. md -> md50).
function rewriteToBound(expr, bound) {
  return rewriteExpr(expr, (node) => {
    if (
      node.type === 'Function' &&
      node.name === 'numeric' &&
      node.args.length === 1 &&
      node.args[0].type === 'Identifier' &&
      bound.has(node.args[0].name)
    ) {
      return Identifier(bound.get(node.args[0].name));
    }
    if (node.type === 'Identifier' && bound.has(node.name))
      return Identifier(bound.get(node.name));
    return null;
  });
}

// Rewrite a trailing-aggregate arg reference to a keyed-object column to an inline
// getField(col, '<key>') (used once inside the aggregate, so no WITH needed).
// `keyed` maps the exposed column name -> its key string (e.g. md -> '50').
function rewriteToGetField(expr, keyed) {
  return rewriteExpr(expr, (node) => {
    if (node.type === 'Identifier' && keyed.has(node.name))
      return Func('getField', [
        Identifier(node.name),
        Literal(keyed.get(node.name), 'string'),
      ]);
    return null;
  });
}

// Partition the names an outer layer references into the non-scalar inner columns
// it touches: `keyed` (median/percentile, name -> key string) need getField
// extraction; `lists` (uniques/values) have no scalar form. A name whose inner
// defining expr is scalar (count/sum/avg/…) or a facet key is ignored.
function partitionNonScalarRefs(refNames, exposed) {
  const keyed = new Map();
  const lists = [];
  for (const name of refNames) {
    const def = exposed.get(name);
    const ns = extractNonScalar(def);
    if (!ns) continue;
    if (ns.list) lists.push(name);
    else keyed.set(name, ns.key);
  }
  return { keyed, lists };
}

// The first exposed column name produced by TWO inner SELECT entries, or null.
// `exposedInnerColumns` collapses duplicates into a Map keeping the LAST, but NRQL keeps
// the FIRST (`DistributedFunctionLeaf.flattenResultLeaf`) — so a getField extracting the
// LAST entry's key reads the FIRST entry's (wrong-shaped) value → null. No faithful
// translation; the extraction branches must bail loud (mirrors handleEval's collision
// check). Mirrors exposedInnerColumns' naming (Alias → its name; bare func → func name,
// stddev→standarddeviation; bare Identifier → its name) but counts duplicates.
function duplicateExposedName(inner) {
  const seen = new Set();
  const nameOf = (item) => {
    if (item.type === 'Alias') return item.name;
    if (item.type === 'Function')
      return item.name === 'stddev' ? 'standarddeviation' : item.name;
    if (item.type === 'Identifier') return item.name;
    return null;
  };
  for (const item of inner.select) {
    const name = nameOf(item);
    if (name == null) continue;
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return null;
}

// Pick a name not already taken (an exposed inner column, or an earlier synthesized
// bound name). The naive `${col}${key}` (e.g. md50) can collide with a real exposed
// column — `… median(d) as md, avg(d) as md50 …` — silently shadowing it (the user's
// md50 filter would read the median). Append `_2`, `_3`, … until free.
function pickFreeName(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Replace exposed-name references with their inner defining expr, and strip
// numeric() around a substituted aggregate (aggregates are already numeric).
function inlineExposed(expr, exposed) {
  if (!expr) return expr;
  if (expr.type === 'Identifier' && exposed.has(expr.name))
    return exposed.get(expr.name);
  if (expr.type === 'Function') {
    const args = expr.args.map((a) => inlineExposed(a, exposed));
    if (
      expr.name === 'numeric' &&
      args.length === 1 &&
      isAggregateExpr(args[0])
    )
      return args[0];
    return Func(expr.name, args);
  }
  if (expr.type === 'BinOp') {
    return {
      ...expr,
      left: inlineExposed(expr.left, exposed),
      right: inlineExposed(expr.right, exposed),
    };
  }
  if (expr.type === 'Alias')
    return Alias(inlineExposed(expr.expr, exposed), expr.name);
  return expr;
}

// True unless a fold-blocker function would wrap a substituted aggregate,
// OR an identifier is referenced that isn't exposed by the inner query.
function canFoldEval(expr, exposed) {
  if (!expr) return true;
  if (expr.type === 'Identifier') {
    // An identifier that isn't in the inner's exposed columns can't be resolved
    // after folding — the merged query has no source for it.
    return exposed.has(expr.name);
  }
  if (expr.type === 'Literal') return true;
  if (expr.type === 'Function') {
    const wrapsAgg = expr.args.some((a) => refersAggregate(a, exposed));
    if (wrapsAgg && expr.name !== 'numeric' && !isFoldSafe(expr.name))
      return false;
    return expr.args.every((a) => canFoldEval(a, exposed));
  }
  if (expr.type === 'BinOp')
    return canFoldEval(expr.left, exposed) && canFoldEval(expr.right, exposed);
  if (expr.type === 'Alias') return canFoldEval(expr.expr, exposed);
  return true;
}
function refersAggregate(expr, exposed) {
  if (!expr) return false;
  if (expr.type === 'Identifier') {
    const def = exposed.get(expr.name);
    return def ? isAggregateExpr(def) : false;
  }
  if (expr.type === 'Function')
    return expr.args.some((a) => refersAggregate(a, exposed));
  if (expr.type === 'BinOp')
    return (
      refersAggregate(expr.left, exposed) ||
      refersAggregate(expr.right, exposed)
    );
  if (expr.type === 'Alias') return refersAggregate(expr.expr, exposed);
  return false;
}

// True when an eval expression references any inner FACET key (a `by` event field).
// Such a reference is a fold-BLOCKER: flattening the eval into the aggregating layer
// would select on an event field beside an aggregate/FACET, which NRQL rejects ("FACET
// cannot be used when selecting on event fields"; aggregate × event-field is invalid) —
// silent-wrong if emitted anyway. Deny-by-default via collectIdentifiers: any facet-key
// identifier ANYWHERE in the expression (bare `host`, `if(host=…)`, `count * len(host)`)
// blocks the flat fold and routes to the subquery fallback, where the facet key is an
// exposed event column the outer row-wise SELECT can reference legally.
function refersFacetKey(expr, facetNames) {
  if (facetNames.size === 0) return false;
  const refs = new Set();
  collectIdentifiers(expr, refs);
  for (const name of refs) if (facetNames.has(name)) return true;
  return false;
}

// True when an inner SELECT entry is a bare aggregate — `count(*)`, `sum(x)`, or
// such an aggregate merely re-aliased (`sum(x) as total`). An Alias wrapping an
// EXPRESSION (`a = count(*)/60`) is eval-derived, NOT a bare aggregate.
function isBareAggregateEntry(item) {
  const e = item.type === 'Alias' ? item.expr : item;
  return e?.type === 'Function' && NRQL_AGG_FUNCS.has(e.name);
}

// The column name a subquery exposes for one inner SELECT entry (bare func name,
// stddev→standarddeviation; an alias re-keys it).
export function exposedNameOf(item) {
  if (item.type === 'Alias') return item.name;
  if (item.type === 'Function')
    return item.name === 'stddev' ? 'standarddeviation' : item.name;
  if (item.type === 'Identifier') return item.name;
  return null;
}

// Fold a row-wise eval layer (outer) into its aggregating inner. Returns the merged
// query, or null if not foldable (caller keeps the subquery).
//
// SAFETY: every outer SELECT column must be accountable — either a foldable eval
// Alias, or a bare facet-key identifier that FACET re-supplies. Any other column
// (a rex capture, a wildcard, a non-facet projection) would be SILENTLY DROPPED by
// the fold, so we bail and keep the subquery. Likewise an eval that references a
// column the inner does not expose is unfoldable → bail.
//
// COLUMN RETENTION (additive): Splunk's eval ADDS a column and keeps the existing
// ones. So the merge KEEPS the inner's eval-derived columns (a prior folded eval)
// and DROPS only its bare raw aggregates — option A: facet keys + eval results,
// raw aggregates dropped and flagged via eval_after_agg_drops_source.
function foldEvalLayer(outer, inner, warnings, droppedAcc) {
  // The outer carries its own WITH bindings (e.g. a rex/spath capture added after
  // the aggregation). Hoisting them onto the flattened query would change the rows
  // they bind over — keep the subquery so those bindings stay intact, untouched.
  if (outer.bindings && outer.bindings.length > 0) return null;
  const exposed = exposedInnerColumns(inner);
  const facetNames = new Set(
    inner.facet.filter((f) => f.type === 'Identifier').map((f) => f.name),
  );
  const evalItems = [];
  for (const item of outer.select) {
    if (item.type === 'Alias') {
      if (!canFoldEval(item.expr, exposed)) return null;
      // A folded eval that references a facet key would emit `<event-field> … FACET
      // <event-field>` — invalid NRQL even though the functions are fold-safe. Block
      // the flat fold and keep the subquery (the same fallback the concat blocker uses);
      // the facet key is then an exposed event column the outer SELECT references legally.
      if (refersFacetKey(item.expr, facetNames)) return null;
      evalItems.push(item);
    } else if (item.type === 'Identifier' && facetNames.has(item.name)) {
      // facet key — dropped from SELECT; FACET re-supplies it. Safe.
    } else {
      // Unaccounted column (rex capture, wildcard, non-facet field) — folding
      // would drop it silently. Keep the subquery instead.
      return null;
    }
  }
  if (evalItems.length === 0) return null; // nothing to fold
  const folded = evalItems.map((s) =>
    Alias(inlineExposed(s.expr, exposed), s.name),
  );
  // Additive: keep the inner's eval-derived columns; drop its bare raw aggregates.
  const keptInner = inner.select.filter(
    (item) => item.type === 'Alias' && !isBareAggregateEntry(item),
  );
  const dropped = inner.select
    .filter(isBareAggregateEntry)
    .map(exposedNameOf)
    .filter(Boolean);
  if (dropped.length > 0) {
    if (warnings) warnings.push(messages.eval_after_agg_drops_source(dropped));
    // Record dropped names so a later orderBy referencing one is caught (silent
    // mis-order otherwise). select/where references are already caught by canFoldEval
    // / unexposedReference; orderBy is not folded through those.
    if (droppedAcc) for (const n of dropped) droppedAcc.add(n);
  }
  return {
    // Base on the ROOT (outer) IR so its warnings/errors/unsupported/orderBy/
    // since/until survive the fold; only the query SHAPE is flattened from inner.
    ...outer,
    dataSource: inner.dataSource,
    select: [...keptInner, ...folded],
    facet: inner.facet,
    where: inner.where,
    bindings: inner.bindings ?? [],
    // Keep the inner's LIMIT MAX so all aggregated groups are returned. Splunk
    // computes all groups; dropping the limit would silently cap at NRQL's
    // default 10. An explicit outer limit (rare) wins.
    limit: outer.limit ?? inner.limit,
    timeseries: outer.timeseries ?? inner.timeseries,
  };
}

// True when a layer's only row-wise content is a WHERE — empty bindings, and a
// SELECT that projects nothing but bare facet-key identifiers or `*` (no eval
// columns, no captures). Two such layers stack as `WHERE a` over `WHERE b`; they
// AND-fold into one legal WHERE over the shared aggregating inner.
function isWhereOnlyLayer(query) {
  return (
    classifyLayer(query) === 'rowwise' &&
    query.where.length > 0 &&
    query.bindings.length === 0 &&
    query.select.every((s) => s.type === 'Identifier' || s.type === 'Wildcard')
  );
}

export function foldPostAggregation(ir, warnings, dropped, rootUnsupported) {
  // The root IR's warnings array + dropped-name set + unsupported array, threaded
  // through the recursion so a fold (or guard) deep in the chain records its diagnosis
  // on the TOP-LEVEL result — the emitter only reads the root IR's arrays. A regroup
  // hazard on a NESTED aggregating layer (`stats|stats(bad)|where` wraps the bad regroup
  // one level down) must surface on the root, or it emits silently-wrong nested NRQL.
  const w = warnings ?? ir.warnings ?? [];
  const d = dropped ?? new Set();
  const u = rootUnsupported ?? ir.unsupported ?? [];
  const ds = ir.dataSource;
  if (!ds || ds.type !== 'SubquerySource') return ir;
  // Don't fold when the outer already has unsupported/error messages — those
  // signals must survive the optimizer so the caller emits '' not wrong NRQL.
  if (
    (ir.unsupported && ir.unsupported.length > 0) ||
    (ir.errors && ir.errors.length > 0)
  ) {
    return ir;
  }
  const inner = ds.query;
  // Recurse first so nested chains collapse innermost-outward.
  const collapsedInner = foldPostAggregation(inner, w, d, u);
  // Merge a row-wise where-only layer sitting on another row-wise where-only layer
  // into one: concatenate the WHERE arrays (joined by AND at emit) and keep the
  // inner's dataSource. The merged single where-layer then sits over whatever the
  // inner read from — a legal single subquery once that inner is aggregating. The
  // post-pass guards (unexposedReference, hasRowwiseInner, orderByRefsDropped) still
  // run on the result, so a merged WHERE referencing a fold-dropped column stays
  // loud unsupported rather than emitting silently-wrong NRQL.
  if (
    isWhereOnlyLayer(ir) &&
    collapsedInner.dataSource?.type === 'SubquerySource' &&
    isWhereOnlyLayer(collapsedInner)
  ) {
    // Base on the OUTER (root) IR so its orderBy/limit/since/until/warnings/errors/
    // unsupported survive the merge — a trailing `sort`/`head` sets those on the
    // root where-layer, and `...collapsedInner` would silently drop them. Take only
    // the query SHAPE (dataSource + concatenated WHERE) from the inner where-layer.
    // Mirrors foldEvalLayer's outer-based merge.
    const merged = {
      ...ir,
      dataSource: collapsedInner.dataSource,
      where: [...collapsedInner.where, ...ir.where],
      facet: collapsedInner.facet,
      bindings: collapsedInner.bindings ?? [],
      select: ir.select.length ? ir.select : collapsedInner.select,
      limit: ir.limit ?? collapsedInner.limit,
    };
    return foldPostAggregation(merged, w, d, u);
  }
  // Cross-boundary non-scalar reference in a WHERE layer (`stats median(d) as md … |
  // where md>10`). md is a keyed object ({50: v}) across the subquery boundary, so the
  // built `numeric(md) > 10` resolves to null (silent-wrong). Extract the scalar with a
  // single `WITH getField(md,'50') AS md50` binding on this layer and rewrite the WHERE +
  // SELECT references to the bound name. A list-shaped column (uniques/values) has no
  // scalar form → loud unsupported. Only the keyed/list columns are touched; a scalar
  // (count/sum/avg) reference is left to the existing where handling.
  if (
    classifyLayer(ir) === 'rowwise' &&
    classifyLayer(collapsedInner) === 'aggregating' &&
    ir.where.length > 0
  ) {
    const exposed = exposedInnerColumns(collapsedInner);
    const refs = new Set();
    for (const cond of ir.where) collectIdentifiers(cond, refs);
    for (const item of ir.select) collectIdentifiers(item, refs);
    const { keyed, lists } = partitionNonScalarRefs(refs, exposed);
    // Collision guard: a column we'd extract is exposed by TWO inner aggregates — NRQL
    // keeps the first, our getField keys off the last → null. No faithful translation.
    const dup = duplicateExposedName(collapsedInner);
    if (dup && (keyed.has(dup) || lists.includes(dup))) {
      u.push(messages.subquery_name_collision(dup));
      return {
        ...ir,
        dataSource: { type: 'SubquerySource', query: collapsedInner },
      };
    }
    if (lists.length > 0) {
      // No faithful scalar extraction for a list across the boundary — loud unsupported.
      u.push(messages.eval_after_agg_nonscalar(lists[0]));
      return {
        ...ir,
        dataSource: { type: 'SubquerySource', query: collapsedInner },
      };
    }
    if (keyed.size > 0) {
      // Bind getField once per keyed column; reference the bound name in WHERE + SELECT.
      // The bound name must avoid colliding with a real exposed column (a `... as md50`
      // would otherwise be shadowed → user's md50 filter silently reads the median) and
      // with another bound name we are creating in this same layer.
      const taken = new Set(exposed.keys());
      const bound = new Map(); // exposed name -> bound name (md -> md50)
      const newBindings = [...(ir.bindings ?? [])];
      for (const [name, key] of keyed) {
        const boundName = pickFreeName(`${name}${key}`, taken);
        taken.add(boundName);
        bound.set(name, boundName);
        newBindings.push(
          Binding(
            boundName,
            Func('getField', [Identifier(name), Literal(key, 'string')]),
          ),
        );
      }
      const newWhere = ir.where.map((c) => rewriteToBound(c, bound));
      // Project the bound names (staging-validated form is `SELECT md50`, not `SELECT *`),
      // rewriting any existing select references too.
      const newSelect =
        ir.select.length > 0
          ? ir.select.map((s) => rewriteToBound(s, bound))
          : [...bound.values()].map((b) => Identifier(b));
      return {
        ...ir,
        dataSource: { type: 'SubquerySource', query: collapsedInner },
        bindings: newBindings,
        where: newWhere,
        select: newSelect,
      };
    }
  }
  if (
    classifyLayer(ir) === 'rowwise' &&
    classifyLayer(collapsedInner) === 'aggregating' &&
    ir.where.length === 0
  ) {
    const merged = foldEvalLayer(ir, collapsedInner, w, d);
    if (merged) return foldPostAggregation(merged, w, d, u);
  }
  // Trailing re-aggregation regroup guard. An aggregating outer over an aggregating
  // inner (`stats … | stats … by X`, including the eval-led `stats | eval | stats`
  // once the eval has folded into the inner) is legal NRQL agg-over-agg ONLY when the
  // outer's FACET keys are a subset of the inner's exposed columns. A regroup key the
  // inner never produced groups on null → silently empty. Loud unsupported over wrong.
  // EXEMPT: time-bucket fields (`_time`/`timestamp`/`bin _time as X` aliases). They are
  // stripped from the inner facet when TIMESERIES is present (stripTimeBucketFacets), so
  // they are not "exposed" — yet TIMESERIES re-supplies them, so a `… | timechart … |
  // stats … by _time` regroup is faithful and must NOT be flagged. NOTE: ds is already
  // a SubquerySource (checked above) and collapsedInner is its (folded) query.
  if (
    classifyLayer(ir) === 'aggregating' &&
    classifyLayer(collapsedInner) === 'aggregating'
  ) {
    // Cross-boundary non-scalar reference in a trailing aggregate arg (`stats median(d)
    // as md … | stats avg(md)`). md is a keyed object ({50: v}); a bare `average(md)`
    // resolves to null (silent-wrong). Inline getField(md,'50') into the aggregate arg
    // (used once, so no WITH). A list-shaped (uniques/values) reference has no scalar
    // form → loud unsupported. Done BEFORE the regroup check below, which inspects FACET
    // keys (orthogonal); a getField'd SELECT still flows through that guard.
    const exposed = exposedInnerColumns(collapsedInner);
    const selectRefs = new Set();
    for (const item of ir.select) collectIdentifiers(item, selectRefs);
    const { keyed, lists } = partitionNonScalarRefs(selectRefs, exposed);
    // Collision guard: a column we'd extract is exposed by TWO inner aggregates — NRQL
    // keeps the first, our getField keys off the last → null. No faithful translation.
    const dup = duplicateExposedName(collapsedInner);
    if (dup && (keyed.has(dup) || lists.includes(dup))) {
      u.push(messages.subquery_name_collision(dup));
      return {
        ...ir,
        dataSource: { type: 'SubquerySource', query: collapsedInner },
      };
    }
    if (lists.length > 0) {
      u.push(messages.eval_after_agg_nonscalar(lists[0]));
      return {
        ...ir,
        dataSource: { type: 'SubquerySource', query: collapsedInner },
      };
    }
    if (keyed.size > 0) {
      ir = {
        ...ir,
        select: ir.select.map((s) => rewriteToGetField(s, keyed)),
      };
    }
    const names = new Set(exposedInnerColumns(collapsedInner).keys());
    const timeAliases = ir._timeBucketAliases ?? new Set();
    // Time-bucket facet keys (_time/timestamp/bin-aliases) are re-supplied by
    // TIMESERIES — but ONLY when the inner actually carries one. A plain
    // `stats … by host | stats … by _time` has no TIMESERIES, so `_time` is a real
    // unexposed regroup (silent group-on-null) and must NOT be exempted by name alone.
    const innerHasTimeseries = Boolean(collapsedInner.timeseries);
    const isTimeBucketField = (name) =>
      name === '_time' || name === 'timestamp' || timeAliases.has(name);
    const missing = ir.facet.find(
      (f) =>
        f.type === 'Identifier' &&
        !names.has(f.name) &&
        !(innerHasTimeseries && isTimeBucketField(f.name)),
    );
    if (missing) {
      // Push onto the ROOT unsupported (threaded) so the diagnosis surfaces even when
      // this aggregating layer is itself nested under a later step (`stats|stats|where`
      // wraps the bad regroup one level down). The emitter reads only the root arrays.
      u.push(messages.compound_trailing_regroup_unsupported(missing.name));
      // Substitute the collapsed (eval-folded) inner so the post-pass residual checks
      // (hasRowwiseInner / hasUnexposedReference) see a clean agg-over-agg and do NOT
      // pile on a second, generic compound_collapse_unsupported. This regroup message
      // is the specific, correct diagnosis; the chain still emits '' (unsupported set).
      return {
        ...ir,
        dataSource: { type: 'SubquerySource', query: collapsedInner },
      };
    }
  }
  return {
    ...ir,
    dataSource: { type: 'SubquerySource', query: collapsedInner },
  };
}

// A SubquerySource inner that is row-wise is an illegal nested-aggregation inner.
function hasRowwiseInner(query) {
  const ds = query.dataSource;
  if (!ds || ds.type !== 'SubquerySource') return false;
  if (classifyLayer(ds.query) === 'rowwise') return true;
  return hasRowwiseInner(ds.query);
}

// Collect the bare-field (Identifier) names referenced anywhere in an expression.
// Deny-by-default walk: recurse EVERY object/array-valued property so a dropped-column
// reference cannot hide in a node type this function forgot to enumerate (Not, IsNull,
// Like, Rlike, In, DualCheck, …). The only nodes we must NOT descend into are nested
// subqueries — their references resolve against their OWN inner, not this query level.
function collectIdentifiers(node, acc) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectIdentifiers(n, acc));
    return;
  }
  if (node.type === 'Identifier') {
    acc.add(node.name);
    return;
  }
  if (node.type === 'SubqueryExpr' || node.type === 'SubquerySource') return;
  for (const key of Object.keys(node)) {
    if (key === 'type') continue;
    collectIdentifiers(node[key], acc);
  }
}

// When a query reads from a SubquerySource it can reference ONLY the columns that
// subquery exposes — raw fields are gone after aggregation. A reference to a name
// the inner does not expose means an earlier fold dropped a raw aggregate that a
// later step still needs (e.g. `eval a=count/60 | eval b=count/120`, or
// `… | where count>5`): the bare `count` would resolve to null → silently-wrong
// NRQL. Return the first such name, or null.
function unexposedReference(query) {
  const ds = query.dataSource;
  if (!ds || ds.type !== 'SubquerySource') return null;
  const exposed = new Set(exposedInnerColumns(ds.query).keys());
  // This layer's own WITH bindings introduce names usable in its SELECT/WHERE (e.g.
  // a getField extraction `WITH getField(md,'50') AS md50`). Treat them as available,
  // but FIRST verify each binding's OWN expression only references exposed columns —
  // a binding over a fold-dropped aggregate is still the silent-null hazard.
  const bindingRefs = new Set();
  for (const b of query.bindings ?? []) collectIdentifiers(b.expr, bindingRefs);
  for (const name of bindingRefs) if (!exposed.has(name)) return name;
  for (const b of query.bindings ?? []) exposed.add(b.name);
  const refs = new Set();
  for (const item of query.select) collectIdentifiers(item, refs);
  for (const cond of query.where) collectIdentifiers(cond, refs);
  // NOTE: FACET keys are NOT checked here. A trailing `stats … by <non-exposed>`
  // (regroup) is the same silent-wrong class but needs regroup-aware handling
  // (time-bucket fields like _time are legitimately available, dedup interacts) —
  // that is Task 4's `compound_trailing_regroup_unsupported`. Owned there, not here.
  for (const name of refs) if (!exposed.has(name)) return name;
  return null;
}

// Walk the whole SubquerySource chain for the unexposed-reference hazard.
function hasUnexposedReference(query) {
  if (unexposedReference(query)) return true;
  const ds = query.dataSource;
  if (ds && ds.type === 'SubquerySource')
    return hasUnexposedReference(ds.query);
  return false;
}

// A sort on a fold-DROPPED aggregate (`stats count … | eval a=count/60 | sort count`)
// references a name that no longer exists after folding — NRQL silently mis-orders
// (verified staging acct 1). Same silent-wrong class as unexposedReference, third
// surface. Keyed on the dropped-name SET (not "any unavailable name"), so a pre-existing
// orderBy that drops nothing — top's `count`, reverse's timestamp — is left untouched.
function orderByRefsDropped(query, dropped) {
  if (dropped.size > 0 && query.orderBy) {
    const refs = new Set();
    collectIdentifiers(query.orderBy, refs);
    for (const name of refs) if (dropped.has(name)) return true;
  }
  const ds = query.dataSource;
  if (ds && ds.type === 'SubquerySource')
    return orderByRefsDropped(ds.query, dropped);
  return false;
}

// A reference to a non-scalar inner column (median/percentile keyed object, or a
// uniques list) that is NOT wrapped in getField() crosses the subquery boundary as
// that raw object/list — a bare `md`/`numeric(md)`/`concat(md, …)`/`ORDER BY md`/`FACET
// md` over it resolves to null/garbage (silent-wrong; FACET groups on bogus "0"/"1"
// buckets, ORDER BY sorts on the object — both staging-confirmed). The WHERE and
// trailing-agg branches getField-extract (or bail loud) their SELECT/WHERE references;
// this is the catch-all for EVERY remaining boundary surface — an eval-PROJECTION that
// couldn't fold flat (`eval x = md . "ms"`), plus orderBy (`sort -md`) and facet
// (`stats count by md`) which no extraction branch rewrites. Walk ALL of
// select/where/bindings/orderBy/facet; a non-scalar reference outside getField is loud
// unsupported. Returns the offending column name, or null. getField(col, …) is the
// sanctioned wrap, so we do NOT descend into its first arg.
function unextractedNonScalarReference(query) {
  const ds = query.dataSource;
  if (!ds || ds.type !== 'SubquerySource') return null;
  const exposed = exposedInnerColumns(ds.query);
  let found = null;
  const visit = (node) => {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.type === 'SubqueryExpr' || node.type === 'SubquerySource') return;
    // getField(col, key) is the sanctioned extraction — its column arg is protected.
    if (
      node.type === 'Function' &&
      (node.name === 'getField' || node.name === 'extractfield') &&
      node.args.length >= 1 &&
      node.args[0].type === 'Identifier'
    ) {
      node.args.slice(1).forEach(visit);
      return;
    }
    if (
      node.type === 'Identifier' &&
      extractNonScalar(exposed.get(node.name))
    ) {
      found = node.name;
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === 'type') continue;
      visit(node[key]);
    }
  };
  for (const item of query.select) visit(item);
  for (const cond of query.where) visit(cond);
  for (const b of query.bindings ?? []) visit(b.expr);
  // orderBy / facet are NOT rewritten by any extraction branch — a keyed-object/list
  // column reaching ORDER BY or FACET sorts-on-object / groups-on-bogus-buckets.
  if (query.orderBy) visit(query.orderBy);
  for (const f of query.facet) visit(f);
  return found;
}

// Walk the whole SubquerySource chain for the unextracted-non-scalar hazard.
// Returns the first offending column name, or null.
function findUnextractedNonScalarReference(query) {
  const here = unextractedNonScalarReference(query);
  if (here) return here;
  const ds = query.dataSource;
  if (ds && ds.type === 'SubquerySource')
    return findUnextractedNonScalarReference(ds.query);
  return null;
}

// Inner aggregating subqueries need LIMIT MAX so the outer sees all facet rows.
function ensureInnerLimitMax(query) {
  const ds = query.dataSource;
  if (ds && ds.type === 'SubquerySource') {
    const inner = ds.query;
    if (inner.facet.length > 0 && inner.limit == null) inner.limit = 'MAX';
    ensureInnerLimitMax(inner);
  }
}

// Wrap the recursive folder so warning-threading and the residual-legality checks
// stay out of its signature.
export function foldPostAggregationPass(ir) {
  const dropped = new Set();
  // Count unsupported BEFORE the fold so we can tell whether a fold branch pushed its
  // own specific diagnosis (collision / non-scalar list / regroup) — if so, the generic
  // post-pass guards below must NOT pile a second, redundant message onto the same chain.
  const unsupportedBefore = (ir.unsupported ?? []).length;
  const folded = foldPostAggregation(ir, ir.warnings, dropped);
  const foldPushedUnsupported = folded.unsupported.length > unsupportedBefore;
  // Loud failure over silent-wrong: a residual row-wise nested inner, or any
  // reference to a column the inner subquery no longer exposes (a dropped raw
  // aggregate a later step still needs), cannot be emitted as correct NRQL.
  if (
    hasRowwiseInner(folded) ||
    hasUnexposedReference(folded) ||
    orderByRefsDropped(folded, dropped)
  ) {
    folded.unsupported.push(messages.compound_collapse_unsupported());
  } else {
    ensureInnerLimitMax(folded);
  }
  // Separate, specific diagnosis: a non-scalar (median/percentile/uniques) column
  // referenced across the boundary OUTSIDE getField() on ANY surface — an eval-projection
  // that couldn't fold flat (`eval x = md . "ms"`), or an orderBy/facet (`sort -md`,
  // `stats count by md`) that no extraction branch rewrites. Skip when a fold branch
  // already pushed a specific diagnosis (e.g. a collision bail leaves a bare ref the
  // branch deliberately did NOT rewrite — its collision message is the better one).
  if (!foldPushedUnsupported) {
    const unextracted = findUnextractedNonScalarReference(folded);
    if (unextracted) {
      folded.unsupported.push(messages.eval_after_agg_nonscalar(unextracted));
    }
  }
  return folded;
}
