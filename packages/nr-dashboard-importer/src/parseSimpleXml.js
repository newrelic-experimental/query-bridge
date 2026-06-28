import { XMLParser } from 'fast-xml-parser';
import { createDashboardModel, createWidget, createVariable } from './model.js';
import { htmlToMarkdown } from './htmlToMarkdown.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep single children as objects; we normalize to arrays ourselves.
  isArray: () => false,
  trimValues: true,
  // Keep <html> panel bodies as RAW HTML (unparsed) for htmlToMarkdown. '*.html'
  // matches an <html> element at any depth (fast-xml-parser 5.x rewrites '*.x' to
  // '..x'). <html> is the only raw-HTML element in Simple XML, so this is targeted.
  stopNodes: ['*.html'],
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

/**
 * Raw inner HTML of a stopNode <html> element. With stopNodes it arrives as a
 * bare string, or as { '#text': '<raw>', '@_attr': … } when the <html> tag had
 * attributes (e.g. <html encoded="true">). Anything else → '' (dropped upstream).
 * @param {unknown} node
 * @returns {string}
 */
function htmlRaw(node) {
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object' && typeof node['#text'] === 'string') {
    return node['#text'];
  }
  return '';
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

/** A node's text content (string or #text), trimmed, or '' when absent. */
function textOf(v) {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v['#text'] === 'string') return v['#text'].trim();
  return '';
}

/** Read a <search><earliest>/<latest> sibling (string or #text), or '' when absent. */
function searchTimeBound(vizEl, which) {
  return textOf(vizEl.search?.[which]);
}

/**
 * Read the dashboard time picker's default range from a <fieldset>/<input
 * type="time"><default><earliest>/<latest> (BUG5/6). This is the dashboard-level
 * time range, NOT a template variable. Returns null when no time input has a
 * literal earliest/latest default.
 *
 * @returns {{earliest:string,latest:string}|null}
 */
function parseDefaultTimeRange(root) {
  const inputs = asArray(root.fieldset).flatMap((fs) => asArray(fs.input));
  for (const input of inputs) {
    if (input?.['@_type'] !== 'time') continue;
    const earliest = textOf(input.default?.earliest);
    const latest = textOf(input.default?.latest);
    if (earliest || latest) return { earliest, latest };
  }
  return null;
}

/** Read static <choice value="x">Label</choice> entries into {value,title} items. */
function parseChoices(input) {
  return asArray(input.choice).map((c) => {
    const value = typeof c === 'string' ? c : String(c['@_value'] ?? textOf(c));
    const title = textOf(c) || value;
    return { value, title };
  });
}

/**
 * Parse <fieldset>/<input> form controls into model variables (BUG6). A time
 * input is the dashboard time picker (see parseDefaultTimeRange), not a variable.
 * dropdown/radio/multiselect → enum (multiselect sets multi); text → string. A
 * dropdown backed by a <search> keeps that inner SPL as sourceQuery for later
 * translation to a type="nrql" variable. Inputs without a token bind nothing.
 *
 * @returns {import('./model.js').Variable[]}
 */
function parseVariables(root) {
  const inputs = asArray(root.fieldset).flatMap((fs) => asArray(fs.input));
  const variables = [];
  for (const input of inputs) {
    const type = input?.['@_type'];
    const name = input?.['@_token'];
    if (!name || type === 'time') continue;
    const defaultValue = textOf(input.default);
    if (type === 'text') {
      variables.push(createVariable({ name, type: 'string', defaultValue }));
    } else if (
      type === 'dropdown' ||
      type === 'radio' ||
      type === 'multiselect'
    ) {
      const sourceQuery = queryOf(input);
      variables.push(
        createVariable({
          name,
          type: 'enum',
          defaultValue,
          choices: parseChoices(input),
          multi: type === 'multiselect',
          sourceQuery: sourceQuery || null,
        }),
      );
    }
    // Other input types (checkbox, link, …) are uncommon and not yet mapped.
  }
  return variables;
}

/**
 * Fold a panel <search>'s literal <earliest>/<latest> into the SPL base search so
 * the translator emits SINCE/UNTIL (BUG5). Prepended as `earliest=… latest=…`
 * (Splunk time modifiers belong in the base search and are position-independent).
 * A `$tok$` value rides the translator's time-token drop — it never leaks into
 * SINCE. Returns the query unchanged when neither sibling is present.
 */
function foldSearchTime(query, vizEl) {
  const earliest = searchTimeBound(vizEl, 'earliest');
  const latest = searchTimeBound(vizEl, 'latest');
  const mods = [
    earliest && `earliest=${earliest}`,
    latest && `latest=${latest}`,
  ]
    .filter(Boolean)
    .join(' ');
  return mods ? `${mods} ${query}`.trim() : query;
}

/** Commands that aggregate or reshape rows — a base search using one cannot be
 * safely composed with a post-process pipeline (it would need subquery wrapping). */
const TRANSFORMING_COMMAND =
  /\|\s*(stats|timechart|chart|top|rare|dedup|eval)\b/i;

/**
 * Collect every `<search id="…">` in the document into an id → {query, base, ref}
 * map (base searches are usually global, but they can nest, so walk the tree).
 */
function collectSearchIds(node, map) {
  if (!node || typeof node !== 'object') return;
  for (const [key, val] of Object.entries(node)) {
    for (const item of asArray(val)) {
      if (!item || typeof item !== 'object') continue;
      if (key === 'search' && item['@_id']) {
        map.set(item['@_id'], {
          query: textOf(item.query),
          base: item['@_base'] ?? null,
          ref: item['@_ref'] ?? null,
        });
      }
      collectSearchIds(item, map);
    }
  }
}

/**
 * Resolve a panel `<search base="id">` post-process panel (BUG7). A non-
 * transforming base composes as `base | post-process` so the base scope reaches
 * the NRQL. A transforming base (stats/timechart/…), a missing id, a saved-search
 * `ref=`, or a chained base (the base itself has a base) cannot be safely merged →
 * unsupportedReason placeholder. Returns { composed?, baseRef, unsupportedReason }.
 */
function resolveBaseSearch(vizEl, baseMap) {
  const baseId = vizEl.search?.['@_base'];
  if (!baseId) return { baseRef: null, unsupportedReason: null };
  const post = queryOf(vizEl);
  const base = baseMap.get(baseId);
  if (!base || !base.query) {
    return {
      baseRef: baseId,
      unsupportedReason: `base search "${baseId}" not found in the dashboard`,
    };
  }
  if (base.ref || base.base) {
    return {
      baseRef: baseId,
      unsupportedReason: `base search "${baseId}" is a chained or saved-search reference, which cannot be resolved`,
    };
  }
  if (TRANSFORMING_COMMAND.test(base.query)) {
    return {
      baseRef: baseId,
      unsupportedReason: `base search "${baseId}" is transforming (stats/timechart/etc.) and cannot be composed with a post-process pipeline`,
    };
  }
  const composed = post
    ? `${base.query} | ${post.replace(/^\|\s*/, '')}`
    : base.query;
  return { baseRef: baseId, composed, unsupportedReason: null };
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

  // Document-wide id → query map so panel <search base="id"> can resolve scope.
  const baseMap = new Map();
  collectSearchIds(root, baseMap);

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
      // Splunk panels may title at the panel level instead of the viz level;
      // a viz's own <title> wins, falling back to the panel's (BUG4).
      const panelTitle = titleOf(panel);
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
          // A base-search panel composes (or placeholders); otherwise fold any
          // per-panel <search> earliest/latest into the base search.
          const base = resolveBaseSearch(vizEl, baseMap);
          const rawSpl =
            base.composed != null
              ? base.composed
              : foldSearchTime(queryOf(vizEl), vizEl);
          widgets.push(
            createWidget({
              title: titleOf(vizEl) || panelTitle,
              vizType: resolvedType,
              rawSpl,
              baseRef: base.baseRef,
              unsupportedReason: base.unsupportedReason,
              layout,
            }),
          );
        }
      }
      // <html> panels are static text → clean NR markdown widgets (mirrors the
      // Studio splunk.markdown path; translateWidgets emits a {vizType:'markdown',
      // options.text} widget as a clean widget_markdown). An empty/CSS-only body
      // converts to '' → dropped (no widget, no placeholder), like Studio's
      // image-without-URL drop. NR's renderer sanitizes link schemes, so we emit
      // every link faithfully and add no scheme filtering.
      for (const htmlEl of asArray(panel.html)) {
        const text = htmlToMarkdown(htmlRaw(htmlEl));
        if (text === '') continue;
        widgets.push(
          createWidget({
            title: panelTitle,
            vizType: 'markdown',
            options: { text },
            layout,
          }),
        );
      }
      // Recognized-but-unsupported viz tags must not vanish: emit a widget with
      // an unsupportedReason so the chokepoint placeholders it (loud, not silent).
      for (const [tag, vizType] of Object.entries(UNSUPPORTED_VIZ_TAGS)) {
        for (const vizEl of asArray(panel[tag])) {
          widgets.push(
            createWidget({
              title: titleOf(vizEl) || panelTitle,
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
    variables: parseVariables(root),
    defaultTimeRange: parseDefaultTimeRange(root),
    widgets,
  });
}
