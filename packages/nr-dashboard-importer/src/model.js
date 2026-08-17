/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

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
 * @property {string} name           the Splunk input token, e.g. "category"
 * @property {'enum'|'string'|'nrql'} type
 * @property {string} defaultValue   the <default> value ('' when none)
 * @property {{value:string,title:string}[]} choices  enum items (empty otherwise)
 * @property {boolean} multi         multiselect (NR is_multi_selection)
 * @property {string|null} sourceQuery  inner search SPL for a search-backed dropdown
 *
 * @typedef {object} Widget
 * @property {string} title
 * @property {VizType} vizType
 * @property {string} rawSpl
 * @property {string|null} baseRef
 * @property {string|null} unsupportedReason
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
 * @param {Partial<Variable> & {name: string, type: Variable['type']}} fields
 * @returns {Variable}
 */
export function createVariable(fields) {
  return {
    name: fields.name,
    type: fields.type,
    defaultValue: fields.defaultValue ?? '',
    choices: fields.choices ?? [],
    multi: fields.multi ?? false,
    sourceQuery: fields.sourceQuery ?? null,
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
    unsupportedReason: fields.unsupportedReason ?? null,
    options: fields.options ?? {},
    layout: fields.layout ?? { x: 0, y: 0, w: 12, h: 3 },
  };
}
