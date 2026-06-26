/**
 * Sniff the format of a single dashboard payload string.
 *
 * @param {string} payload - raw dashboard payload (XML or JSON).
 * @param {'simple-xml'|'studio'} [hint] - format hint from envelope routing.
 * @returns {{format:'simple-xml'|'studio', payload:string}[]} detected units.
 * @throws {Error} for not-yet-supported formats.
 */
function detectUnit(payload, hint) {
  const trimmed = payload.trimStart();

  // Strip an optional XML declaration so the root-element check sees the real root.
  const body = trimmed.replace(/^<\?xml[^>]*\?>\s*/, '');

  // If a hint was supplied by the envelope router, trust it over sniffing.
  if (hint === 'studio') {
    // Dashboard Studio: not yet supported — that is Phase 3.
    // Accept the hint and return the unit; CDATA-stripping will happen there.
    return [{ format: 'studio', payload }];
  }
  if (hint === 'simple-xml') {
    return [{ format: 'simple-xml', payload }];
  }

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
    return [{ format: 'simple-xml', payload }];
  }

  throw new Error(
    'Unrecognized dashboard format: expected a Splunk Simple XML <form> or <dashboard>.',
  );
}

/**
 * Detect the format(s) of a dashboard input string.
 *
 * Handles three shapes:
 *   - Splunk REST export envelope: `{"entry":[…]}` with `"eai:data"` fields.
 *   - Dashboard Studio XML: `<dashboard version="2">…</dashboard>`.
 *   - Simple XML: `<form>` or `<dashboard>` (no version 2).
 *
 * @param {string} input - raw dashboard payload (file contents or stdin).
 * @returns {{format:'simple-xml'|'studio', payload:string}[]} detected units.
 * @throws {Error} for not-yet-supported formats or malformed envelopes.
 */
export function detectFormat(input) {
  const trimmed = input.trimStart();

  // REST export envelope: JSON object with an entry array carrying eai:data.
  if (trimmed.startsWith('{') && /"eai:data"/.test(trimmed)) {
    const env = JSON.parse(trimmed);
    if (!Array.isArray(env.entry)) {
      throw new Error('Splunk REST envelope has no entry[] array.');
    }
    const units = [];
    for (const e of env.entry) {
      const content = e?.content ?? {};
      if (content.isDashboard === false) continue; // non-dashboard view
      const payload = content['eai:data'];
      if (typeof payload !== 'string') continue;
      const format =
        String(content.version ?? '') === '2' ? 'studio' : 'simple-xml';
      // Re-run the single-payload unwrap (Task 3 handles Studio CDATA strip).
      units.push(...detectUnit(payload, format));
    }
    return units;
  }

  return detectUnit(input);
}
