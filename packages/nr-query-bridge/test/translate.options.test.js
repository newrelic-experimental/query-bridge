/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { translateSplToNrql } from '../src/translate.js';
import {
  PREVIEW_FLAG_NAMES,
  normalizePreview,
  setPreview,
  getPreview,
} from '../src/previewFlags.js';

describe('normalizePreview', () => {
  it('returns every flag false when given no options at all', () => {
    const flags = normalizePreview(undefined);
    expect(flags).toEqual({
      expand: false,
      split: false,
      trim: false,
      arrayMaps: false,
      lambdas: false,
      facetEvaluables: false,
    });
  });

  it('returns every flag false for an empty options bag', () => {
    expect(normalizePreview({})).toEqual(normalizePreview(undefined));
  });

  it('returns every flag false for an empty preview bag', () => {
    expect(normalizePreview({ preview: {} })).toEqual(
      normalizePreview(undefined),
    );
  });

  it('turns on only the flag the caller named', () => {
    const flags = normalizePreview({ preview: { trim: true } });
    expect(flags.trim).toBe(true);
    expect(flags.expand).toBe(false);
    expect(flags.split).toBe(false);
    expect(flags.arrayMaps).toBe(false);
    expect(flags.lambdas).toBe(false);
    expect(flags.facetEvaluables).toBe(false);
  });

  it('coerces a truthy non-boolean to false rather than enabling a gate', () => {
    // AI-DEV: Strict `=== true`. A stringly-typed config (`{trim: 'yes'}`, or an
    // un-parsed `--preview` argv value) must NOT silently enable Beta syntax on
    // an account that would reject it. Do not relax this to a truthiness check.
    expect(normalizePreview({ preview: { trim: 'yes' } }).trim).toBe(false);
    expect(normalizePreview({ preview: { trim: 1 } }).trim).toBe(false);
  });

  it('ignores an unrecognized flag name instead of throwing', () => {
    // A consumer pinned to an older package version must not crash on a config
    // naming a flag it predates.
    const flags = normalizePreview({ preview: { noSuchFlag: true } });
    expect(flags).toEqual(normalizePreview(undefined));
    expect('noSuchFlag' in flags).toBe(false);
  });

  it('freezes the result so no handler can flip a gate mid-translation', () => {
    const flags = normalizePreview({ preview: { trim: true } });
    expect(Object.isFrozen(flags)).toBe(true);
  });

  it('does not mutate the options bag the caller passed in', () => {
    const options = { preview: { trim: true } };
    normalizePreview(options);
    expect(options).toEqual({ preview: { trim: true } });
  });

  it('exposes one flag name per documented NRQL Beta gate', () => {
    expect([...PREVIEW_FLAG_NAMES]).toEqual([
      'expand',
      'split',
      'trim',
      'arrayMaps',
      'lambdas',
      'facetEvaluables',
    ]);
  });
});

describe('setPreview / getPreview', () => {
  it('reads back the gates that were attached', () => {
    const query = { type: 'SelectQuery' };
    setPreview(query, normalizePreview({ preview: { expand: true } }));
    expect(getPreview(query).expand).toBe(true);
  });

  it('attaches the gates non-enumerably so they cannot leak into emitted IR', () => {
    // AI-DEV: Non-enumerable is load-bearing — an enumerable `_preview` would
    // show up in `JSON.stringify` IR snapshots and in structural equality,
    // breaking every IR fixture. Do not change the property descriptor.
    const query = { type: 'SelectQuery' };
    setPreview(query, normalizePreview({ preview: { expand: true } }));
    expect(Object.keys(query)).toEqual(['type']);
    expect(JSON.parse(JSON.stringify(query))).toEqual({
      type: 'SelectQuery',
    });
  });

  it('reports every gate off for a query that was never seeded', () => {
    // The failure mode of a plumbing gap is "the preview feature did not fire",
    // never invalid NRQL.
    expect(getPreview({ type: 'SelectQuery' })).toEqual(
      normalizePreview(undefined),
    );
  });

  it('reports every gate off for a missing query', () => {
    expect(getPreview(undefined)).toEqual(normalizePreview(undefined));
  });
});

describe('translateSplToNrql — options argument', () => {
  it('translates identically with no second argument and with an empty bag', () => {
    const spl = 'index=web | eval x=trim(name)';
    expect(translateSplToNrql(spl, {})).toEqual(translateSplToNrql(spl));
  });

  it('emits the GA capture() form for trim when no flag is passed', () => {
    const r = translateSplToNrql('index=web | eval x=trim(name)');
    expect(r.nrql).toBe(
      "FROM Log WITH capture(name, r'^\\s*(?P<x>(?:.*\\S)?)\\s*$') AS x " +
        "SELECT * WHERE index = 'web'",
    );
  });

  it('emits native trim() when the trim gate is on', () => {
    const r = translateSplToNrql('index=web | eval x=trim(name)', {
      preview: { trim: true },
    });
    expect(r.nrql).toBe(
      "FROM Log WITH trim(name) AS x SELECT * WHERE index = 'web'",
    );
  });

  it('keeps the gates independent — expand does not enable trim', () => {
    const spl = 'index=web | eval x=trim(name)';
    expect(translateSplToNrql(spl, { preview: { expand: true } }).nrql).toBe(
      translateSplToNrql(spl).nrql,
    );
  });

  it('keeps the gates independent — trim does not enable expand', () => {
    const spl =
      'index=web | eval p=split(tags, ",") | mvexpand p | stats count by p';
    const r = translateSplToNrql(spl, { preview: { trim: true } });
    expect(r.nrql).toBe('');
    expect(r.unsupported.length).toBeGreaterThan(0);
  });

  it('does not mutate the caller options bag', () => {
    const options = { preview: { trim: true } };
    translateSplToNrql('index=web | eval x=trim(name)', options);
    expect(options).toEqual({ preview: { trim: true } });
  });

  it('ignores an unknown preview flag rather than throwing', () => {
    const spl = 'index=web | eval x=trim(name)';
    expect(
      translateSplToNrql(spl, { preview: { noSuchFlag: true } }).nrql,
    ).toBe(translateSplToNrql(spl).nrql);
  });
});

describe('translateSplToNrql — default-off produces byte-identical output', () => {
  it('translates every real-world query identically with no options and with an empty bag', () => {
    // AI-DEV: This is the zero-regression proof for the whole preview-gating
    // mechanism: adding a second parameter to the public entry point must not
    // change ONE byte of output for a caller that does not pass it. The loop is
    // an assertion over a corpus, not a test generator — do NOT split it into
    // one `it()` per query, and do NOT weaken it to a sample.
    const corpus = JSON.parse(
      readFileSync(
        new URL('./spl/spl-real-world.json', import.meta.url),
        'utf8',
      ),
    );
    expect(corpus.length).toBeGreaterThan(0);
    for (const { spl } of corpus) {
      expect(translateSplToNrql(spl, {}), spl).toEqual(translateSplToNrql(spl));
      expect(translateSplToNrql(spl, { preview: {} }), spl).toEqual(
        translateSplToNrql(spl),
      );
    }
  });
});
