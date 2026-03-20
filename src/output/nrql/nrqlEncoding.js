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

const escapeAttributeNameForNrql = (attributeName) =>
  escapeWith(attributeNameMetacharacters, attributeName);

const escapeStringLiteralForNrql = (string) => {
  if (typeof string !== 'string') return string;
  return escapeWith(stringLiteralMetacharacters, string);
};

const escapeStringWildcardForNrql = (string) =>
  escapeWith(stringWildcardMetacharacters, string);

export {
  escapeAttributeNameForNrql,
  escapeStringLiteralForNrql,
  escapeStringWildcardForNrql,
};
