/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDashboardModel, createVariable, createWidget } from './model.js';

const CANVAS_W = 1200; // Studio default canvas width (px); layout→grid is approximate
const ROW_PX = 100; // Studio row-height (px) used to scale into NR grid rows

/** Studio visualization type → neutral vizType. Corpus-confirmed 2026-06-25. */
const VIZ_MAP = {
  'splunk.table': 'table',
  'splunk.events': 'table',
  'splunk.singlevalue': 'billboard',
  'splunk.singlevalueradial': 'billboard',
  'splunk.markergauge': 'billboard',
  'splunk.fillergauge': 'billboard',
  'splunk.markdown': 'markdown',
  'splunk.line': 'line',
  'splunk.column': 'column',
  'splunk.bar': 'bar',
  'splunk.area': 'area',
  'splunk.pie': 'pie',
  'splunk.scatter': 'scatter',
  'splunk.choropleth.svg': 'map',
};
/** Pure-shape decorations: no query, no widget (silently dropped). */
const DECORATION = new Set(['splunk.rectangle', 'splunk.ellipse']);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// (The interim eval/head-after-transforming guard was removed once the translator's
// fold-post-aggregation pass landed: eval-after-stats now folds correctly and
// head-between-aggregations loud-fails at the translator — so composing and
// delegating is safe for every chain shape.)

/** Studio pixel position → NR 12-column grid {x,y,w,h}. */
function pxToGrid(pos, canvasW) {
  const W = canvasW || CANVAS_W;
  const x = clamp(Math.round(((pos.x ?? 0) / W) * 12), 0, 11);
  const w = clamp(Math.round(((pos.w ?? 0) / W) * 12), 1, 12 - x);
  const y = Math.max(0, Math.round((pos.y ?? 0) / ROW_PX));
  const h = Math.max(1, Math.round((pos.h ?? ROW_PX) / ROW_PX));
  return { x, y, w, h };
}

/** Resolve a dataSource id to SPL, walking ds.chain recursively. */
function resolveDataSource(dsId, dataSources, seen = new Set()) {
  const ds = dataSources[dsId];
  if (!ds) {
    return {
      rawSpl: '',
      unsupportedReason: dsId ? `data source "${dsId}" not found` : null,
    };
  }
  if (ds.type === 'ds.search') {
    return { rawSpl: ds.options?.query ?? '', unsupportedReason: null };
  }
  if (ds.type === 'ds.chain') {
    if (seen.has(dsId)) {
      return {
        rawSpl: '',
        unsupportedReason: `data source chain cycles at "${dsId}"`,
      };
    }
    seen.add(dsId);
    const parent = resolveDataSource(ds.options?.extend, dataSources, seen);
    if (parent.unsupportedReason) return parent; // propagate missing/savedSearch/cycle
    const fragment = (ds.options?.query ?? '').replace(/^\s*\|?\s*/, '').trim();
    if (!fragment) return { rawSpl: parent.rawSpl, unsupportedReason: null };
    // Compose unconditionally and delegate: the translator either folds the
    // post-aggregation chain or loud-fails it (chokepoint → placeholder).
    return {
      rawSpl: `${parent.rawSpl} | ${fragment}`,
      unsupportedReason: null,
    };
  }
  // ds.savedSearch / ds.csv — no inline SPL in the document.
  return {
    rawSpl: '',
    unsupportedReason: `data source "${dsId}" is a ${ds.type} (no inline query)`,
  };
}

function titleOf(viz) {
  return String(viz.title ?? viz.options?.title ?? '').trim();
}

function buildWidget(viz, dataSources, layout) {
  if (DECORATION.has(viz.type)) return null; // pure shape — dropped, no widget
  if (viz.type === 'splunk.image') {
    const src = viz.options?.src ?? '';
    if (/^https?:\/\//i.test(src)) {
      return createWidget({
        title: titleOf(viz),
        vizType: 'markdown',
        options: { text: `![](${src})` },
        layout,
      });
    }
    return null; // image without a usable URL — dropped, not placeholdered
  }
  if (viz.type === 'splunk.markdown') {
    const md = viz.options?.markdown;
    if (typeof md === 'string' && md.trim() !== '') {
      return createWidget({
        title: titleOf(viz),
        vizType: 'markdown',
        options: { text: md },
        layout,
      });
    }
    // no markdown body → fall through to a loud empty-query placeholder
  }
  const vizType = VIZ_MAP[viz.type] ?? 'unknown';
  const resolved = resolveDataSource(viz.dataSources?.primary, dataSources);
  return createWidget({
    title: titleOf(viz),
    vizType,
    rawSpl: resolved.rawSpl,
    unsupportedReason:
      vizType === 'unknown'
        ? `no New Relic equivalent for Studio visualization "${viz.type}"`
        : resolved.unsupportedReason,
    layout,
  });
}

function parseInputs(inputs) {
  const variables = [];
  let defaultTimeRange = null;
  for (const [id, input] of Object.entries(inputs)) {
    const opts = input.options ?? {};
    const name = opts.token ?? id;
    if (input.type === 'input.timerange') {
      if (defaultTimeRange) continue; // first time input wins (NR has one picker)
      const dv = String(opts.defaultValue ?? '');
      if (dv.includes(',')) {
        const [earliest, latest] = dv.split(',');
        defaultTimeRange = { earliest: earliest.trim(), latest: latest.trim() };
      }
      continue; // named preset (no comma) → skip; time input never becomes a variable
    }
    if (input.type === 'input.text') {
      variables.push(
        createVariable({
          name,
          type: 'string',
          defaultValue: String(opts.defaultValue ?? ''),
        }),
      );
      continue;
    }
    if (input.type === 'input.dropdown' || input.type === 'input.multiselect') {
      const multi = input.type === 'input.multiselect';
      const items = Array.isArray(opts.items) ? opts.items : [];
      if (items.length) {
        const choices = items.map((it) => ({
          value: String(it.value ?? it.label ?? ''),
          title: String(it.label ?? it.value ?? ''),
        }));
        variables.push(
          createVariable({
            name,
            type: 'enum',
            choices,
            defaultValue: String(opts.defaultValue ?? ''),
            multi,
          }),
        );
      } else {
        // Search-backed or empty: degrade to free-text (nrql-backed Studio dropdowns deferred).
        variables.push(
          createVariable({
            name,
            type: 'string',
            defaultValue: String(opts.defaultValue ?? ''),
            multi,
          }),
        );
      }
    }
    // Unknown input type → no variable (not silently wrong; simply absent).
  }
  return { variables, defaultTimeRange };
}

/** @param {string} json Studio dashboard JSON (CDATA already stripped by detectFormat). */
export function parseStudio(json) {
  const doc = JSON.parse(json);
  const dataSources = doc.dataSources ?? {};
  const visualizations = doc.visualizations ?? {};
  const structure = doc.layout?.structure ?? [];
  const canvasW = doc.layout?.options?.width ?? CANVAS_W;

  const widgets = [];
  for (const item of structure) {
    const viz = visualizations[item.item];
    if (!viz) continue; // structure points at a missing viz — nothing to emit
    const widget = buildWidget(
      viz,
      dataSources,
      pxToGrid(item.position ?? {}, canvasW),
    );
    if (widget) widgets.push(widget);
  }
  const { variables, defaultTimeRange } = parseInputs(doc.inputs ?? {});
  return createDashboardModel({
    title: doc.title ?? doc.label ?? '',
    description: doc.description ?? '',
    sourceFormat: 'studio',
    variables,
    defaultTimeRange,
    widgets,
  });
}

export { VIZ_MAP, DECORATION };
