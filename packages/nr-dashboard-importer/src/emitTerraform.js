/**
 * Emit a runnable Terraform skeleton for a translated dashboard model.
 * Three files: dashboard.tf (resource), versions.tf (provider pin),
 * variables.tf (account_id + sensitive key + provider block). NO backend
 * block — state config is environment-specific and belongs to the user.
 *
 * @typedef {import('./model.js').VizType} VizType
 */

/** neutral vizType → Terraform widget block name (Phase-1 subset). */
const WIDGET_BLOCK = {
  line: 'widget_line',
  table: 'widget_table',
  billboard: 'widget_billboard',
  markdown: 'widget_markdown',
};

/** Escape a string for an HCL double-quoted literal. */
function hclString(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\$\{/g, () => '$${')
    .replace(/%\{/g, () => '%%{');
}

/** Render the account_id line — literal when given, else the variable reference. */
function accountIdLine(accountId) {
  return accountId === null || accountId === undefined
    ? 'account_id = var.account_id'
    : `account_id = ${accountId}`;
}

/** Render one widget block. */
function widgetBlock(widget, accountId) {
  const block = WIDGET_BLOCK[widget.vizType] ?? 'widget_markdown';
  const lines = [];
  lines.push(`  ${block} {`);
  lines.push(`    title  = "${hclString(widget.title)}"`);
  lines.push(`    row    = ${widget.layout.y + 1}`);
  lines.push(`    column = ${widget.layout.x + 1}`);
  lines.push(`    width  = ${widget.layout.w}`);
  lines.push(`    height = ${widget.layout.h}`);
  if (widget.vizType === 'markdown') {
    lines.push(`    text = "${hclString(widget.placeholderText)}"`);
  } else {
    lines.push(`    nrql_query {`);
    lines.push(`      ${accountIdLine(accountId)}`);
    lines.push(`      query      = "${hclString(widget.nrql)}"`);
    lines.push(`    }`);
  }
  lines.push(`  }`);
  return lines.join('\n');
}

/** Stable, lowercase, hyphenated slug for resource labels and filenames. */
export function slugify(title) {
  const slug =
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'dashboard';
  return /^\d/.test(slug) ? `_${slug}` : slug;
}

/**
 * @param {{title:string, description:string, widgets:any[]}} model
 * @param {{accountId:number|null}} opts
 * @returns {{'dashboard.tf':string, 'versions.tf':string, 'variables.tf':string}}
 */
export function emitTerraform(model, opts) {
  const accountId = opts?.accountId ?? null;
  const slug = slugify(model.title);

  const widgetBlocks = model.widgets
    .map((w) => widgetBlock(w, accountId))
    .join('\n\n');
  const dashboardTf = [
    `resource "newrelic_one_dashboard" "${slug}" {`,
    `  name        = "${hclString(model.title)}"`,
    `  description = "${hclString(model.description)}"`,
    ``,
    `  page {`,
    `    name = "${hclString(model.title)}"`,
    ``,
    widgetBlocks,
    `  }`,
    `}`,
    ``,
  ].join('\n');

  const versionsTf = [
    `terraform {`,
    `  required_providers {`,
    `    newrelic = {`,
    `      source  = "newrelic/newrelic"`,
    `      version = "~> 3"`,
    `    }`,
    `  }`,
    `}`,
    ``,
  ].join('\n');

  const variablesTf = [
    `variable "account_id" {`,
    `  type        = number`,
    `  description = "New Relic account ID."`,
    `}`,
    ``,
    `variable "newrelic_api_key" {`,
    `  type        = string`,
    `  sensitive   = true`,
    `  description = "New Relic User API key. Provide via TF_VAR_newrelic_api_key / NEW_RELIC_API_KEY env — never a literal value here."`,
    `}`,
    ``,
    `provider "newrelic" {`,
    `  account_id = var.account_id`,
    `  api_key    = var.newrelic_api_key`,
    `  region     = "US"`,
    `}`,
    ``,
  ].join('\n');

  return {
    'dashboard.tf': dashboardTf,
    'versions.tf': versionsTf,
    'variables.tf': variablesTf,
  };
}
