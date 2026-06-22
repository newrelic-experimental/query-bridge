import { XMLParser } from 'fast-xml-parser';
import { createDashboardModel, createWidget } from './model.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep single children as objects; we normalize to arrays ourselves.
  isArray: () => false,
  trimValues: true,
});

/**
 * charting.chart enum → neutral vizType. Default 'line' when absent (Splunk default).
 * @type {Record<string, import('./model.js').VizType>}
 */
const CHART_TYPE_MAP = {
  line: 'line',
  area: 'area',
  bar: 'bar',
  column: 'column',
  pie: 'pie',
  scatter: 'scatter',
};

/** Coerce a value that may be a single object or an array into an array. */
function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Extract the option[name="charting.chart"] value from a viz element's <option> list. */
function chartingChart(vizEl) {
  for (const opt of asArray(vizEl.option)) {
    if (opt?.['@_name'] === 'charting.chart') {
      return typeof opt['#text'] === 'string'
        ? opt['#text']
        : String(opt['#text'] ?? '');
    }
  }
  return undefined;
}

/** Pull the query string from a viz element's <search><query>. */
function queryOf(vizEl) {
  const search = vizEl.search;
  const query = search?.query;
  if (typeof query === 'string') return query.trim();
  if (query && typeof query['#text'] === 'string') return query['#text'].trim();
  return '';
}

/**
 * Parse a Splunk Simple XML dashboard string into a DashboardModel.
 * Phase 1: <label>/<description>, rows of panels with <chart>/<table>/<single>.
 *
 * @param {string} xml
 * @returns {import('./model.js').DashboardModel}
 */
export function parseSimpleXml(xml) {
  const tree = parser.parse(xml);
  const root = tree.form ?? tree.dashboard ?? {};

  const title =
    typeof root.label === 'string' ? root.label : (root.label?.['#text'] ?? '');
  const description =
    typeof root.description === 'string'
      ? root.description
      : (root.description?.['#text'] ?? '');

  const widgets = [];
  const rows = asArray(root.row);
  rows.forEach((row, rowIndex) => {
    const panels = asArray(row.panel);
    const panelCount = panels.length || 1;
    panels.forEach((panel, panelIndex) => {
      // A panel can hold chart/table/single children in document order.
      for (const [
        tag,
        vizType,
      ] of /** @type {[string, import('./model.js').VizType][]} */ ([
        ['chart', 'line'],
        ['table', 'table'],
        ['single', 'billboard'],
      ])) {
        for (const vizEl of asArray(panel[tag])) {
          let resolvedType = vizType;
          if (tag === 'chart') {
            const ct = chartingChart(vizEl);
            resolvedType = CHART_TYPE_MAP[ct ?? 'line'] ?? 'line';
          }
          const w = createWidget({
            title:
              typeof vizEl.title === 'string'
                ? vizEl.title
                : (vizEl.title?.['#text'] ?? ''),
            vizType: resolvedType,
            rawSpl: queryOf(vizEl),
            layout: {
              x: panelIndex * Math.floor(12 / panelCount),
              y: rowIndex * 3,
              w: Math.floor(12 / panelCount),
              h: 3,
            },
          });
          widgets.push(w);
        }
      }
    });
  });

  return createDashboardModel({
    title,
    description,
    sourceFormat: 'simple-xml',
    widgets,
  });
}
