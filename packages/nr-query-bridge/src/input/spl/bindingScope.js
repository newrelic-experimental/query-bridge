/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Binding names for one query level, applied in SPL pipeline order.
 *
 * Splunk reuses field names freely (`eval e=lower(e)`, `rex field=message
 * "(?<message>…)"`, `eval x=… | eval x=…`, `rename x AS e`); a NRQL `WITH` list
 * cannot. New Relic rejects (all sandbox-verified by the consumer):
 *   - a reserved binding name (`timestamp`, `eventType`, case-insensitive);
 *   - a binding that reads its own name ("Circular dependency");
 *   - the same name bound twice ("Repeated variable names");
 *   - a binding named like a column of the level's JOIN subquery ("ambiguous").
 * On such a collision the binding is given a fresh name (`parsed_<field>`, then
 * `parsed_<field>_2`, …) and only references that come AFTER it in the pipeline
 * are pointed at it — earlier references (and the binding's own source) keep the
 * raw attribute. A pre-aggregation `rename x AS e` points later reads of `e` at
 * `x`. The raw event text (`rawEventIdentifier`) is never redirected.
 *
 * Usage (splToIR pipeline loop): `beforeCommand(cmd, ir)` rewrites the command's
 * plain field lists, `afterCommand(cmd, ir)` renames what the command added, and
 * `finish(ir)` gives renamed output columns their Splunk name back.
 */
import { Alias, Identifier } from '../../ir/nodes.js';
import { mapFieldName } from './splExprUtils.js';

// Reserved as WITH binding names (case is ignored) — sandbox-verified.
const RESERVED_BINDING_NAMES = new Set(['timestamp', 'eventtype']);

const TUPLE = /^\((.*)\)$/;

// Commands whose `fields`/`groupBy` are plain reads of this level's fields.
// (Not join: its key names the subsearch's column too.)
const FIELD_LIST_COMMANDS = new Set([
  'TableCommand',
  'FieldsCommand',
  'SortCommand',
  'DedupCommand',
  'TopCommand',
  'RareCommand',
  'StatsCommand',
  'ChartCommand',
  'TimechartCommand',
]);

// A capture() binding carries its names as the tuple string "(a, b)".
function bindingNames(name) {
  const m = TUPLE.exec(name);
  return m ? m[1].split(/\s*,\s*/) : [name];
}

function formatBindingNames(names, wasTuple) {
  return wasTuple ? `(${names.join(', ')})` : names[0];
}

// Copy a node keeping its non-enumerable markers (_splName, _phrasePosition, …).
function cloneNode(node) {
  return Object.defineProperties(
    Array.isArray(node) ? [] : {},
    Object.getOwnPropertyDescriptors(node),
  );
}

// Rename Identifier references per `map`, returning the SAME object when nothing
// changed. Never crosses into a subquery (another query level has its own scope).
function renameRefs(node, map) {
  if (!node || typeof node !== 'object' || map.size === 0) return node;
  if (node.type === 'Identifier') {
    if (node._rawEvent || !map.has(node.name)) return node;
    return Identifier(map.get(node.name));
  }
  if (
    node.type === 'SubquerySource' ||
    node.type === 'SubqueryExpr' ||
    node.type === 'SelectQuery' ||
    node.type === 'JoinClause'
  ) {
    return node;
  }
  let copy = null;
  for (const [key, value] of Object.entries(node)) {
    const renamed = renameRefs(value, map);
    if (renamed !== value) {
      copy = copy || cloneNode(node);
      copy[key] = renamed;
    }
  }
  return copy || node;
}

function referencesName(node, name) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'Identifier') return !node._rawEvent && node.name === name;
  if (
    node.type === 'SubquerySource' ||
    node.type === 'SubqueryExpr' ||
    node.type === 'SelectQuery'
  ) {
    return false;
  }
  return Object.values(node).some((v) => referencesName(v, name));
}

// The column names a JOIN subquery exposes to the outer level.
function joinColumns(join) {
  const cols = new Set();
  const q = join.subquery;
  for (const e of [...q.select, ...q.facet]) {
    if (e.type === 'Identifier') cols.add(e.name);
    else if (e.type === 'Alias') cols.add(e.name);
  }
  return cols;
}

export function createBindingScope() {
  /** @type {Map<string, string>} SPL field name → the NRQL name that now holds it */
  const map = new Map();
  /** @type {Set<string>} every binding name emitted at this level */
  const bound = new Set();
  /** @type {Map<string, string>} fresh NRQL name → the SPL field it stands for */
  const splNameOf = new Map();
  /** @type {Set<string>} */
  let joinCols = new Set();
  const processed = new WeakSet();
  // For a retroactive (JOIN) rename: where-list length when each binding was made.
  const whereLenAt = new Map();

  function freshName(field) {
    let name = `parsed_${field}`;
    for (let n = 2; bound.has(name) || map.has(name); n++) {
      name = `parsed_${field}_${n}`;
    }
    return name;
  }

  function needsFreshName(name, expr) {
    return (
      RESERVED_BINDING_NAMES.has(name.toLowerCase()) ||
      bound.has(name) ||
      joinCols.has(name) ||
      referencesName(expr, name)
    );
  }

  function assignName(field, expr) {
    if (needsFreshName(field, expr)) {
      const fresh = freshName(field);
      map.set(field, fresh);
      splNameOf.set(fresh, field);
      bound.add(fresh);
      return fresh;
    }
    // The field is now this binding, under its own name.
    map.delete(field);
    bound.add(field);
    return field;
  }

  function renameList(list) {
    return list.map((e) => {
      if (processed.has(e)) return e;
      const renamed = renameRefs(e, map);
      if (renamed && typeof renamed === 'object') processed.add(renamed);
      return renamed;
    });
  }

  // A JOIN brought in subquery columns: any binding at this level with one of
  // those names must move to a fresh name, retroactively (the WITH list and
  // the ON key are emitted after the JOIN).
  function handleNewJoin(ir) {
    joinCols = joinColumns(ir.join);
    for (const b of ir.bindings) {
      const wasTuple = TUPLE.test(b.name);
      const names = bindingNames(b.name);
      if (!names.some((n) => joinCols.has(n))) continue;
      const since = whereLenAt.get(b) ?? 0;
      const renamedNames = names.map((n) => {
        if (!joinCols.has(n)) return n;
        bound.delete(n);
        const fresh = freshName(n);
        splNameOf.set(fresh, n);
        bound.add(fresh);
        const local = new Map([[n, fresh]]);
        // Later bindings and later WHERE terms read the renamed binding.
        const idx = ir.bindings.indexOf(b);
        for (let i = idx + 1; i < ir.bindings.length; i++) {
          ir.bindings[i].expr = renameRefs(ir.bindings[i].expr, local);
        }
        for (let i = since; i < ir.where.length; i++) {
          ir.where[i] = renameRefs(ir.where[i], local);
        }
        map.set(n, fresh);
        return fresh;
      });
      b.name = formatBindingNames(renamedNames, wasTuple);
    }
    const key = ir.join.onKey;
    if (key && key.type === 'Identifier' && map.has(key.name)) {
      ir.join.onLookupKey = Identifier(key.name);
      ir.join.onKey = Identifier(map.get(key.name));
    }
  }

  return {
    /**
     * Mark what exists before the pipeline (the base search's WHERE terms) as
     * already resolved: it reads raw attributes, whatever is bound later.
     */
    seed(ir) {
      for (const e of [
        ...ir.where,
        ...ir.select,
        ...ir.facet,
        ...ir.bindings,
      ]) {
        if (e && typeof e === 'object') processed.add(e);
      }
    },

    /**
     * Rewrite a command's plain field-name lists (table/fields/sort/dedup/top/
     * rare and aggregation `by`) before its handler runs, so a handler that
     * matches names against existing IR (e.g. a projection after stats) sees
     * the NRQL name.
     */
    beforeCommand(cmd) {
      if (map.size === 0 || !FIELD_LIST_COMMANDS.has(cmd.type)) return;
      const rename = (f) => (typeof f === 'string' && map.get(f)) || f;
      if (Array.isArray(cmd.fields)) {
        cmd.fields = cmd.fields.map((f) =>
          f && typeof f === 'object' && 'field' in f
            ? { ...f, field: rename(f.field) }
            : rename(f),
        );
      }
      if (Array.isArray(cmd.groupBy)) cmd.groupBy = cmd.groupBy.map(rename);
      if (cmd.type === 'RareCommand' && typeof cmd.field === 'string') {
        cmd.field = rename(cmd.field);
      }
    },

    /** Rename what `cmd` added to `ir`, in pipeline order. */
    afterCommand(cmd, ir, wasAggregated) {
      // New bindings (only before an aggregation — after it, eval projects
      // `expr AS name` columns on the outer query instead).
      if (!wasAggregated) {
        for (const b of ir.bindings) {
          if (processed.has(b)) continue;
          b.expr = renameRefs(b.expr, map);
          const wasTuple = TUPLE.test(b.name);
          const names = bindingNames(b.name).map((n) => assignName(n, b.expr));
          b.name = formatBindingNames(names, wasTuple);
          processed.add(b);
          whereLenAt.set(b, ir.where.length);
        }
      }
      ir.where = renameList(ir.where);
      ir.select = renameList(ir.select);
      ir.facet = renameList(ir.facet);
      if (ir.orderBy && !processed.has(ir.orderBy)) {
        ir.orderBy = renameRefs(ir.orderBy, map);
        processed.add(ir.orderBy);
      }
      if (ir.join && !processed.has(ir.join)) {
        processed.add(ir.join);
        // eventstats' subquery re-runs this level (same bindings), so its key
        // and arguments read the binding names too — as does the ON key.
        if (cmd.type === 'EventstatsCommand' && map.size > 0) {
          const q = ir.join.subquery;
          q.select = q.select.map((e) => renameRefs(e, map));
          q.facet = q.facet.map((e) => renameRefs(e, map));
          ir.join.onKey = renameRefs(ir.join.onKey, map);
        }
        handleNewJoin(ir);
      }
      // `rename x AS e` before an aggregation: later reads of e read x.
      if (cmd.type === 'RenameCommand' && !wasAggregated) {
        for (const r of cmd.renames || []) {
          if (/[*()]/.test(r.from) || /[*()]/.test(r.to)) continue;
          const from = mapFieldName(r.from);
          const target = map.get(from) || from;
          if (target === r.to) continue;
          map.set(r.to, target);
          splNameOf.set(target, splNameOf.get(target) || r.to);
        }
      }
      // After an aggregation, an eval column `expr AS name` is the field now.
      if (wasAggregated) {
        for (const e of ir.select) {
          if (e.type === 'Alias') map.delete(e.name);
        }
      }
    },

    /**
     * Give a renamed output column its Splunk name back on a flat query:
     * `FACET parsed_e AS 'e'`, `SELECT parsed_e AS 'e'`. (A nested query's
     * outer level reads the inner's exposed NRQL name; left as is — except a
     * JOIN level over a dedup subquery, whose renames ran on that level.)
     */
    finish(ir) {
      if (splNameOf.size === 0) return;
      if (
        ir.dataSource &&
        ir.dataSource.type === 'SubquerySource' &&
        !ir.join
      ) {
        return;
      }
      const relabel = (e, inSelect) => {
        if (e.type !== 'Identifier' || !splNameOf.has(e.name)) return e;
        const splName = splNameOf.get(e.name);
        // In a raw SELECT the event's own timestamp column wins over an alias
        // 'timestamp' (sandbox-verified), so keep the fresh name visible there.
        if (inSelect && splName.toLowerCase() === 'timestamp') return e;
        return Alias(e, splName);
      };
      ir.facet = ir.facet.map((e) => relabel(e, false));
      ir.select = ir.select.map((e) => relabel(e, true));
    },
  };
}
