// docs/playground/playground.js
import { translateSplToNrql } from '../../src/index.js';
import { EXAMPLES } from './examples.js';

const DEBOUNCE_MS = 250;

// Classify a translator result into a visual state.
function classify(result) {
  if (result.unsupported?.length || result.errors?.length) return 'red';
  if (result.warnings?.length) return 'amber';
  if (result.nrql) return 'green';
  return 'neutral';
}

// Render one translation result into a row's output element.
function renderOutput(outputEl, spl) {
  outputEl.className = 'row-output';
  outputEl.textContent = '';
  if (!spl.trim()) {
    outputEl.classList.add('is-neutral');
    return;
  }

  let result;
  try {
    result = translateSplToNrql(spl);
  } catch (e) {
    outputEl.classList.add('is-red');
    const crash = document.createElement('span');
    crash.className = 'crash-line';
    crash.textContent = `translator crashed: ${e.message}`;
    outputEl.appendChild(crash);
    return;
  }

  const state = classify(result);
  outputEl.classList.add(`is-${state}`);

  if (result.nrql) {
    outputEl.appendChild(document.createTextNode(result.nrql));
  }
  for (const w of result.warnings || []) {
    const line = document.createElement('span');
    line.className = 'warn-line';
    line.textContent = `⚠ ${w}`;
    outputEl.appendChild(line);
  }
  for (const u of result.unsupported || []) {
    const line = document.createElement('span');
    line.className = 'crash-line';
    line.textContent = `✕ unsupported: ${u}`;
    outputEl.appendChild(line);
  }
  for (const err of result.errors || []) {
    const line = document.createElement('span');
    line.className = 'crash-line';
    line.textContent = `✕ error: ${err}`;
    outputEl.appendChild(line);
  }
}

// Build one SPL row. Returns the row element.
function createRow(initialSpl = '') {
  const row = document.createElement('div');
  row.className = 'row';

  const top = document.createElement('div');
  top.className = 'row-top';

  const input = document.createElement('input');
  input.className = 'row-input';
  input.type = 'text';
  input.placeholder = 'index=web status=500 | stats count by host';
  input.value = initialSpl;

  const submit = document.createElement('button');
  submit.className = 'row-submit';
  submit.textContent = 'Submit';

  const remove = document.createElement('button');
  remove.className = 'row-remove';
  remove.textContent = '×';
  remove.title = 'Remove line';

  const output = document.createElement('div');
  output.className = 'row-output';

  const translate = () => renderOutput(output, input.value);

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(translate, DEBOUNCE_MS);
  });
  submit.addEventListener('click', () => {
    clearTimeout(timer);
    translate();
  });
  remove.addEventListener('click', () => row.remove());

  top.appendChild(input);
  top.appendChild(submit);
  top.appendChild(remove);
  row.appendChild(top);
  row.appendChild(output);

  if (initialSpl) translate();
  return row;
}

function init() {
  // Note: the file:// "must be served" banner is handled by an inline classic
  // script in index.html — it must run even when this module fails to load,
  // which is exactly the file:// case (ES module imports are blocked there).
  const rows = document.getElementById('rows');
  const rail = document.getElementById('rail-items');

  // Examples rail — clicking loads the example into the first (top) row and
  // re-translates it, rather than appending a new row. If no row exists yet
  // (all removed), create one.
  for (const { label, spl } of EXAMPLES) {
    const btn = document.createElement('button');
    btn.className = 'rail-item';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      const firstInput = rows.querySelector('.row-input');
      if (!firstInput) {
        rows.appendChild(createRow(spl));
        return;
      }
      firstInput.value = spl;
      // Trigger an immediate translation via the row's Submit button (which
      // cancels any pending debounce and re-renders the output).
      firstInput
        .closest('.row')
        .querySelector('.row-submit')
        .click();
    });
    rail.appendChild(btn);
  }

  // Seed with one starter row (gallery model: editor seeded with one query).
  rows.appendChild(createRow(EXAMPLES[0].spl));

  document.getElementById('add-line').addEventListener('click', () => {
    rows.appendChild(createRow(''));
  });
}

init();
