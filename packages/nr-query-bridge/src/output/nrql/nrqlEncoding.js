/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

const escapeStringRegexp = (str) => str.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');

/*
    There are three types of "strings" in NRQL:

      - Attribute names:
          - surrounded by backticks
          - so backticks and backslashes are escaped by a backslash
      - String literals:
          - surrounded by single quotes
          - so single quotes and backslashes are escaped by a backslash
      - String wildcards (strings that go after "LIKE" and "NOT LIKE"):
          - surrounded by single quotes
          - the percent character is the wildcard
          - so single quotes, percent characters, and backslashes are escaped by a backslash
 */

const commonMetacharacters = {
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\f': '\\f',
  '\b': '\\b',
  '\v': '\\v',
};

const attributeNameMetacharacters = {
  ...commonMetacharacters,
  '`': '\\`',
};

const stringLiteralMetacharacters = {
  ...commonMetacharacters,
  "'": "\\'",
};

const stringWildcardMetacharacters = {
  ...commonMetacharacters,
  "'": "\\'",
  '%': '\\%',
};

function escapeWith(metacharacters, value) {
  let escaped = value;
  Object.entries(metacharacters).forEach(([character, escapeSequence]) => {
    escaped = escaped.replace(
      new RegExp(escapeStringRegexp(character), 'g'),
      escapeSequence,
    );
  });
  return escaped;
}

/**
 * Backtick-escape an attribute name for safe use in NRQL.
 * @param {string} attributeName
 * @returns {string}
 */
const escapeAttributeNameForNrql = (attributeName) =>
  escapeWith(attributeNameMetacharacters, attributeName);

/**
 * Single-quote-escape a string literal for safe use in NRQL.
 * Non-string input is returned unchanged.
 * @param {string} string
 * @returns {string}
 */
const escapeStringLiteralForNrql = (string) => {
  if (typeof string !== 'string') return string;
  return escapeWith(stringLiteralMetacharacters, string);
};

/**
 * Percent-escape a string for use as a NRQL LIKE wildcard pattern.
 * @param {string} string
 * @returns {string}
 */
const escapeStringWildcardForNrql = (string) =>
  escapeWith(stringWildcardMetacharacters, string);

// Regex literals use r'...' syntax. NRQL accepts \' to embed a literal
// apostrophe inside the regex literal (verified against the platform). The
// pattern's own backslashes are part of the regex grammar and must NOT be
// doubled — that would alter regex semantics.
const escapeRegexPatternForNrql = (pattern) =>
  typeof pattern === 'string' ? pattern.replace(/'/g, "\\'") : pattern;

export {
  escapeAttributeNameForNrql,
  escapeStringLiteralForNrql,
  escapeStringWildcardForNrql,
  escapeRegexPatternForNrql,
};
