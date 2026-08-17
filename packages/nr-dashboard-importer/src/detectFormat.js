/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

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

  // Dashboard Studio: XML-wrapped (<dashboard version="2">) or pure JSON graph.
  // Handle on both the hinted path (envelope) and the sniff path so the
  // payload is always the stripped inner JSON, never the XML wrapper.
  if (
    hint === 'studio' ||
    /^<dashboard\b[^>]*\bversion\s*=\s*["']2/.test(body)
  ) {
    // XML-wrapped Studio: strip the wrapper + CDATA to the inner JSON.
    if (/^<dashboard\b[^>]*\bversion\s*=\s*["']2/.test(body)) {
      const m = body.match(
        /<definition>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/definition>/,
      );
      if (!m)
        throw new Error('Studio v2 dashboard has no <definition> CDATA JSON.');
      return [{ format: 'studio', payload: m[1].trim() }];
    }
    // Pure-JSON Studio (hint === 'studio' but body is JSON, not XML).
    return [{ format: 'studio', payload }];
  }

  // Studio pure JSON (no hint, sniffed by shape).
  if (body.startsWith('{') && /"dataSources"|"visualizations"/.test(body)) {
    return [{ format: 'studio', payload }];
  }

  // If a hint was supplied by the envelope router, trust it over sniffing.
  if (hint === 'simple-xml') {
    return [{ format: 'simple-xml', payload }];
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
