/**
 * Sniff the format of a single dashboard payload string.
 *
 * Phase 1 supports ONLY a standalone Simple XML string. REST envelopes and
 * Dashboard Studio are recognized and rejected loudly (loud failure over a
 * silent mis-route) so later phases can extend this without surprise.
 *
 * @param {string} input - raw dashboard payload (file contents or stdin).
 * @returns {'simple-xml'} the detected format.
 * @throws {Error} for not-yet-supported formats.
 */
export function detectFormat(input) {
  const trimmed = input.trimStart();

  // REST export envelope: JSON object with an entry array carrying eai:data.
  if (trimmed.startsWith('{') && /"eai:data"/.test(trimmed)) {
    throw new Error(
      'Splunk REST envelope (dashboards.json) is not yet supported — that is Phase 2.',
    );
  }

  // Strip an optional XML declaration so the root-element check sees the real root.
  const body = trimmed.replace(/^<\?xml[^>]*\?>\s*/, '');

  // Dashboard Studio: <dashboard version="2"> (XML-wrapped) or pure JSON graph.
  if (/^<dashboard\b[^>]*\bversion\s*=\s*["']2/.test(body)) {
    throw new Error(
      'Dashboard Studio (version 2) is not yet supported — that is Phase 3.',
    );
  }
  if (body.startsWith('{') && /"dataSources"|"visualizations"/.test(body)) {
    throw new Error(
      'Dashboard Studio (pure JSON) is not yet supported — that is Phase 3.',
    );
  }

  // Simple XML: <form> or <dashboard version="1...">/<dashboard> (no version).
  if (/^<form\b/.test(body) || /^<dashboard\b/.test(body)) {
    return 'simple-xml';
  }

  throw new Error(
    'Unrecognized dashboard format: expected a Splunk Simple XML <form> or <dashboard>.',
  );
}
