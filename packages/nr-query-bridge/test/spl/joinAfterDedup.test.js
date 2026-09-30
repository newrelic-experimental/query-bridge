/*
 * Copyright 2026 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { translateSplToNrql } from '../../src/translate.js';
import { messages } from '../../src/messages.js';

describe('dedup before a join', () => {
  it('replaces the keys-only dedup warning once the join makes the dedup carry a field', () => {
    const result = translateSplToNrql(
      'index=web | dedup s | join type=left s [search index=web | dedup s | table s, m] | table s, m, region',
    );
    expect(result.warnings).toContain(
      messages.dedup_latest_per_field(['region']),
    );
    expect(result.warnings).not.toContain(messages.dedup_facet_warning());
  });
});
