/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { translateSplToNrql } from '../src/translate.js';
import { messages } from '../src/messages.js';
import * as irToNrql from '../src/output/nrql/irToNrql.js';

describe('translateSplToNrql — empty-without-reason contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports an internal error when the emitter produces no NRQL and nothing explains why', () => {
    vi.spyOn(irToNrql, 'emitQuery').mockReturnValue('');
    const r = translateSplToNrql('index=web | stats count');
    expect(r.nrql).toBe('');
    expect(r.errors).toEqual([messages.empty_translation_internal()]);
  });
});

describe('translateSplToNrql — parse errors name the failing stage', () => {
  it('names the stage that failed', () => {
    const r = translateSplToNrql('index=web | stats count | sort -dc(x');
    expect(r.errors[0]).toContain("in stage 'sort -dc(x'");
  });

  it('does not split stages on a pipe inside a quoted string', () => {
    const r = translateSplToNrql('index=web msg="a|b" | sort -dc(x');
    expect(r.errors[0]).toContain("in stage 'sort -dc(x'");
  });

  it('does not split stages on a pipe inside a subsearch', () => {
    const r = translateSplToNrql(
      'index=web [search index=x | fields host] | sort -dc(x',
    );
    expect(r.errors[0]).toContain("in stage 'sort -dc(x'");
  });

  it('skips an escaped quote when tracking quoted strings', () => {
    const r = translateSplToNrql('index=web msg="a\\"|b" | sort -dc(x');
    expect(r.errors[0]).toContain("in stage 'sort -dc(x'");
  });

  it('truncates a long stage', () => {
    const long = `sort ${'f'.repeat(90)}(`;
    const r = translateSplToNrql(`index=web | ${long}`);
    expect(r.errors[0]).toContain(`in stage '${long.slice(0, 77)}...'`);
  });
});

describe('messages — optional detail', () => {
  it('rex_parse_failed without raw text', () => {
    expect(messages.rex_parse_failed('')).toBe(
      'rex command could not be parsed',
    );
  });

  it('command_args_unparsed without a parser detail', () => {
    expect(messages.command_args_unparsed('where', null)).toBe(
      "SPL 'where' arguments could not be parsed",
    );
  });
});
