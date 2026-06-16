/**
 * Row transform command handlers.
 *
 * Handlers for SPL commands that reshape, filter, or transform
 * individual rows without aggregation: fields, sort, head, rename,
 * dedup, bin, reverse, fillnull, strcat, convert, replace, etc.
 */
import {
  Identifier,
  Literal,
  Func,
  Alias,
  OrderBy,
  Wildcard,
  Binding,
} from '../../ir/nodes.js';
import { mapFieldName, formatSpan, looksLikeNumber } from './splExprUtils.js';
import { messages } from '../../messages.js';

export function handleTable(cmd, ir) {
  ir.select = cmd.fields.map((f) => Identifier(mapFieldName(f)));
}

export function handleFields(cmd, ir) {
  if (cmd.mode === '-') {
    // fields - X removes X from select (if explicit) or is a no-op
    // In NRQL, there's no way to exclude fields from SELECT *
    ir.warnings.push(messages.fields_exclude_limited());
  } else {
    ir.select = cmd.fields.map((f) => Identifier(mapFieldName(f)));
  }
}

export function handleSort(cmd, ir) {
  if (cmd.fields.length > 0) {
    const first = cmd.fields[0];
    ir.orderBy = OrderBy(Identifier(first.field), first.direction === 'desc');
  }
  // Additional sort fields become ORDER BY field1 DESC, field2 ASC
  // NRQL only supports single ORDER BY — warn if multiple
  if (cmd.fields.length > 1) {
    ir.warnings.push(messages.sort_single_field());
  }
  // SPL `sort N field` / `sort field limit=N` caps the result to N rows.
  // `sort 0 ...` means unlimited, so leave ir.limit unset.
  if (cmd.limit != null && cmd.limit > 0) {
    ir.limit = cmd.limit;
  }
}

export function handleHead(cmd, ir) {
  ir.limit = cmd.count;
}

export function handleTail(cmd, ir) {
  ir.limit = cmd.count;
  ir.orderBy = OrderBy(Identifier('timestamp'), false); // ASC = oldest first
}

export function handleRename(cmd, ir) {
  let added = 0;
  for (const rename of cmd.renames) {
    if (rename.from.includes('*') || rename.to.includes('*')) {
      ir.unsupported.push(messages.rename_wildcard(rename.from, rename.to));
      continue;
    }
    if (/[()]/.test(rename.from)) {
      ir.unsupported.push(messages.rename_parens(rename.from));
      continue;
    }
    // If renaming a stats alias, fold into the existing alias instead of adding a new one
    const existingIdx = ir.select.findIndex(
      (s) => s.type === 'Alias' && s.name === rename.from,
    );
    if (existingIdx >= 0) {
      ir.select[existingIdx] = Alias(ir.select[existingIdx].expr, rename.to);
    } else {
      ir.select.push(Alias(Identifier(mapFieldName(rename.from)), rename.to));
    }
    added++;
  }
  // Keep all other fields — NRQL has no rename-and-drop-original
  if (added > 0 && !ir._hasAggregation) {
    ir.select.push(Wildcard());
    ir.warnings.push(messages.rename_keeps_original());
  }
}

// TODO: dedup sortby — SPL `dedup host sortby -duration` keeps the row with
//   the highest duration per host. Our grammar doesn't parse sortby/keepevents
//   options, and the handler ignores sort order (always uses latest()).
//   Source: splunk-to-nr migration guide (docs/references/splunk-to-nr-migration-guide.md)
//   Feasibility: grammar change + handler change to use max()/min() instead of latest().
export function handleDedup(cmd, ir) {
  for (const field of cmd.fields) {
    const id = Identifier(field);
    if (!ir.facet.some((f) => f.name === field)) {
      ir.facet.push(id);
    }
  }
  if (ir.select.length === 0) {
    ir.select.push(Func('latest', [Identifier('timestamp')]));
  }
  ir.limit = 'MAX';
  ir._hasAggregation = true;
  ir.warnings.push(messages.dedup_facet_warning());
}

export function handleBin(cmd, ir) {
  if (
    cmd.span &&
    typeof cmd.span === 'object' &&
    cmd.span.type === 'SpanToken'
  ) {
    ir.unsupported.push(messages.span_token_unsupported(`$${cmd.span.name}$`));
    return;
  }
  if (cmd.field === '_time' && cmd.span) {
    ir.timeseries = formatSpan(cmd.span);
    if (cmd.alias) {
      // `bin _time as X` names the time bucket. NRQL has no named time bucket;
      // downstream references to the alias map to TIMESERIES, so record the name
      // and strip it from FACET later (splToIR FACET-strip pass).
      if (!ir._timeBucketAliases) ir._timeBucketAliases = new Set();
      ir._timeBucketAliases.add(cmd.alias);
    }
    if (ir.select.length === 0) {
      ir.select.push(Func('count', []));
    }
  } else if (cmd.field && (cmd.span || cmd.width)) {
    // Numeric bin → histogram(field, width)
    const width = cmd.width || Number(cmd.span);
    ir.select = [
      Func('histogram', [Identifier(cmd.field), Literal(width, 'number')]),
    ];
    ir._hasAggregation = true;
  } else {
    ir.unsupported.push(messages.bin_unsupported());
  }
}

export function handleReverse(cmd, ir) {
  ir.orderBy = OrderBy(Identifier('timestamp'), false);
  if (ir._hasAggregation) {
    ir.warnings.push(messages.reverse_after_agg());
  }
}

export function handleFillnull(cmd, ir) {
  const fillValue = cmd.value || '0';
  // SPL fillnull default is string '0', not numeric 0 — only use numeric
  // when the user explicitly provided a value= that looks like a number
  const litValue =
    cmd.value && looksLikeNumber(fillValue)
      ? Literal(Number(fillValue), 'number')
      : Literal(fillValue, 'string');
  if (cmd.fields && cmd.fields.length > 0) {
    // Store substitutions — downstream references to these fields get (field OR default) inlined
    if (!ir._fillnullMap) ir._fillnullMap = {};
    for (const field of cmd.fields) {
      ir._fillnullMap[field] = litValue;
    }
  } else {
    ir.unsupported.push(messages.fillnull_no_fields());
  }
}

export function handleConvert(cmd, ir) {
  // Grammar produces: { specs: [{name, field, alias}, ...], rawText: string|null }
  const specs = cmd.specs;
  if (!specs || specs.length === 0) {
    if (cmd.rawText) {
      ir.unsupported.push(messages.convert_parse_failed(cmd.rawText));
    }
    return;
  }
  for (const spec of specs) {
    const { name: func, field, alias } = spec;
    const outputName = alias || `${field}_converted`;
    let expr;
    switch (func.toLowerCase()) {
      case 'num':
        expr = Func('numeric', [Identifier(field)]);
        break;
      case 'auto':
        ir.unsupported.push(messages.convert_auto_unsupported(field));
        return;
      case 'rmcomma':
        // '1,234' → numeric(replace(field, ',', ''))
        expr = Func('numeric', [
          Func('replace', [
            Identifier(field),
            Literal(',', 'string'),
            Literal('', 'string'),
          ]),
        ]);
        break;
      case 'ctime':
        // epoch ms → datetime string
        expr = Func('toDatetime', [Identifier(field)]);
        break;
      case 'mktime':
        // datetime string → epoch ms
        expr = Func('toTimestamp', [Identifier(field)]);
        break;
      case 'dur2sec':
        ir.unsupported.push(messages.convert_dur2sec_unsupported(field));
        return;
      case 'mstime':
        ir.unsupported.push(messages.convert_mstime_unsupported(field));
        return;
      default:
        ir.unsupported.push(messages.convert_func_unsupported(func, field));
        continue;
    }
    if (alias) {
      ir.bindings.push(Binding(alias, expr));
    } else {
      ir.bindings.push(Binding(outputName, expr));
      ir.warnings.push(messages.convert_alias_warning(func, field, outputName));
    }
  }
}

export function handleReplace(cmd, ir) {
  const field = cmd.field;
  const pairs = cmd.pairs || [
    { oldValue: cmd.oldValue, newValue: cmd.newValue },
  ];

  let expr = Identifier(field);
  for (const pair of pairs) {
    expr = Func('replace', [
      expr,
      Literal(pair.oldValue, 'string'),
      Literal(pair.newValue, 'string'),
    ]);
  }
  // Store as field replacement — will be applied to FACET or SELECT
  ir._fieldReplacements = ir._fieldReplacements || {};
  ir._fieldReplacements[field] = expr;
}

export function handleStrcat(cmd, ir) {
  // strcat field1 "sep" field2 destField
  // Grammar produces: { parts: [{type:'field',value:'host'}, {type:'literal',value:':'}, ...] }
  // Last part is the destination field, rest are concat args
  const parts = cmd.parts;
  if (!parts || parts.length < 2) {
    ir.unsupported.push(messages.strcat_too_few_args());
    return;
  }
  const destPart = parts[parts.length - 1];
  const destField = destPart.value;
  const concatArgs = parts.slice(0, -1).map((p) => {
    if (p.type === 'literal') return Literal(p.value, 'string');
    return Identifier(p.value);
  });
  ir.bindings.push(Binding(destField, Func('concat', concatArgs)));
}

export function handleMvexpand(cmd, ir) {
  ir.unsupported.push(messages.mvexpand_unsupported());
}

export function handleUniq(_cmd, ir) {
  ir.unsupported.push(messages.uniq_unsupported());
}
