/**
 * The neutral dashboard model — the seam between Splunk parsers and NR emitters.
 * Both parsers target this shape; all emitters consume it. Nothing downstream of
 * the parsers branches on sourceFormat.
 *
 * @typedef {object} DashboardModel
 * @property {string} title
 * @property {string} description
 * @property {'simple-xml'|'studio'} sourceFormat
 * @property {Variable[]} variables
 * @property {{earliest:string,latest:string}|null} defaultTimeRange
 * @property {Widget[]} widgets
 *
 * @typedef {object} Variable
 * @property {string} name
 * @property {'enum'|'string'} type
 * @property {string} defaultValue
 * @property {string[]} choices
 * @property {string|null} sourceQuery
 *
 * @typedef {object} Widget
 * @property {string} title
 * @property {VizType} vizType
 * @property {string} rawSpl
 * @property {string|null} baseRef
 * @property {Record<string, unknown>} options
 * @property {{x:number,y:number,w:number,h:number}} layout
 *
 * @typedef {'line'|'area'|'bar'|'column'|'pie'|'scatter'|'billboard'|'table'|'markdown'|'map'|'unknown'} VizType
 */

/** The neutral vizType enum — the contract between parsers and emitters. */
export const VIZ_TYPES = Object.freeze([
  'line',
  'area',
  'bar',
  'column',
  'pie',
  'scatter',
  'billboard',
  'table',
  'markdown',
  'map',
  'unknown',
]);

/**
 * @param {Partial<DashboardModel> & {title: string}} fields
 * @returns {DashboardModel}
 */
export function createDashboardModel(fields) {
  return {
    title: fields.title,
    description: fields.description ?? '',
    sourceFormat: fields.sourceFormat ?? 'simple-xml',
    variables: fields.variables ?? [],
    defaultTimeRange: fields.defaultTimeRange ?? null,
    widgets: fields.widgets ?? [],
  };
}

/**
 * @param {Partial<Widget> & {title: string, vizType: VizType}} fields
 * @returns {Widget}
 */
export function createWidget(fields) {
  return {
    title: fields.title,
    vizType: fields.vizType,
    rawSpl: fields.rawSpl ?? '',
    baseRef: fields.baseRef ?? null,
    options: fields.options ?? {},
    layout: fields.layout ?? { x: 0, y: 0, w: 12, h: 3 },
  };
}
