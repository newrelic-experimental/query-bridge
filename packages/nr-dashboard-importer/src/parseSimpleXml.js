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

/** A viz element's own <title> (string or #text), or '' when absent. */
function titleOf(vizEl) {
  if (typeof vizEl.title === 'string') return vizEl.title;
  return vizEl.title?.['#text'] ?? '';
}

/**
 * Splunk viz tags we recognize but cannot emit as a New Relic chart. They must
 * still produce a widget (carrying an unsupportedReason) so the chokepoint can
 * placeholder them — never a silent drop. `map` keeps its own vizType; the rest
 * collapse to 'unknown'.
 * @type {Record<string, import('./model.js').VizType>}
 */
const UNSUPPORTED_VIZ_TAGS = {
  event: 'unknown',
  map: 'map',
  html: 'unknown',
  viz: 'unknown',
  list: 'unknown',
};

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
      const layout = {
        x: panelIndex * Math.floor(12 / panelCount),
        y: rowIndex * 3,
        w: Math.floor(12 / panelCount),
        h: 3,
      };
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
          widgets.push(
            createWidget({
              title: titleOf(vizEl),
              vizType: resolvedType,
              rawSpl: queryOf(vizEl),
              layout,
            }),
          );
        }
      }
      // Recognized-but-unsupported viz tags must not vanish: emit a widget with
      // an unsupportedReason so the chokepoint placeholders it (loud, not silent).
      for (const [tag, vizType] of Object.entries(UNSUPPORTED_VIZ_TAGS)) {
        for (const vizEl of asArray(panel[tag])) {
          widgets.push(
            createWidget({
              title: titleOf(vizEl),
              vizType,
              rawSpl: queryOf(vizEl),
              unsupportedReason: `${tag} panels are not supported`,
              layout,
            }),
          );
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
