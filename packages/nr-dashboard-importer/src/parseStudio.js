import { createDashboardModel, createWidget } from './model.js';

const CANVAS_W = 1200; // Studio default canvas width (confirm in Task 0 recon)
const ROW_PX = 100; // Studio row-height assumption (confirm in Task 0 recon)

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

/** Studio pixel position → NR 12-column grid {x,y,w,h}. */
function pxToGrid(pos, canvasW) {
  const W = canvasW || CANVAS_W;
  const x = clamp(Math.round((pos.x / W) * 12), 0, 11);
  const w = clamp(Math.round((pos.w / W) * 12), 1, 12 - x);
  const y = Math.max(0, Math.round((pos.y ?? 0) / ROW_PX));
  const h = Math.max(1, Math.round((pos.h ?? ROW_PX) / ROW_PX));
  return { x, y, w, h };
}

/** Resolve a dataSource id to SPL. ds.chain / savedSearch / csv handled in Task 6. */
function resolveDataSource(dsId, dataSources) {
  const ds = dataSources[dsId];
  if (!ds) {
    return {
      rawSpl: '',
      unsupportedReason: dsId ? `data source "${dsId}" not found` : null,
    };
  }
  if (ds.type === 'ds.search')
    return { rawSpl: ds.options?.query ?? '', unsupportedReason: null };
  return {
    rawSpl: '',
    unsupportedReason: `data source type "${ds.type}" not yet handled`,
  };
}

function buildWidget(viz, dataSources, layout) {
  const vizType = VIZ_MAP[viz.type] ?? 'unknown';
  const resolved = resolveDataSource(viz.dataSources?.primary, dataSources);
  return createWidget({
    title: viz.title ?? '',
    vizType,
    rawSpl: resolved.rawSpl,
    unsupportedReason:
      vizType === 'unknown'
        ? `no New Relic equivalent for Studio visualization "${viz.type}"`
        : resolved.unsupportedReason,
    layout,
  });
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
    widgets.push(
      buildWidget(viz, dataSources, pxToGrid(item.position ?? {}, canvasW)),
    );
  }
  return createDashboardModel({
    title: doc.title ?? doc.label ?? '',
    description: doc.description ?? '',
    sourceFormat: 'studio',
    widgets,
  });
}

export { VIZ_MAP, DECORATION };
