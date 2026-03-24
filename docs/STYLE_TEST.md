# Style Test for SPL-to-NRQL Examples

Delete this file after picking a style.

---

## Option 1: Current (single diff block)

```diff
  🤖 Confirmed by LLM
  SPL:  index=web status=500 | stats count by host
  NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
! ⚠ append translated to filter()
```

## Option 2: Arrow separator, no labels

```diff
  🤖 Confirmed by LLM
  index=web status=500 | stats count by host
  → FROM Log SELECT count(*) WHERE index = 'web' FACET host
! ⚠ append translated to filter()
```

## Option 3: Blank line between SPL and NRQL

```diff
  🤖 Confirmed by LLM
  SPL:  index=web status=500 | stats count by host

  NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
! ⚠ append translated to filter()
```

## Option 4: Badge as green + line

```diff
+ 🤖 Confirmed by LLM
  SPL:  index=web status=500 | stats count by host
  NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
! ⚠ append translated to filter()
```

## Option 5: Two blocks — plain code + diff warnings

```
🤖 Confirmed by LLM
SPL:  index=web status=500 | stats count by host
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
```
```diff
! ⚠ append translated to filter()
```

## Option 6: Two blocks — arrow style + diff warnings

```
index=web status=500 | stats count by host
→ FROM Log SELECT count(*) WHERE index = 'web' FACET host
```
🤖 Confirmed by LLM
```diff
! ⚠ append translated to filter()
```

## Option 7: Blockquote with nested code

> ```
> SPL:  index=web status=500 | stats count by host
> NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
> ```
> 🤖 Confirmed by LLM
> ⚠ append translated to filter()

## Option 8: TIP alert with code

> [!TIP]
> ```
> SPL:  index=web status=500 | stats count by host
> NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
> ```
> ⚠ append translated to filter()

## Option 9: NOTE alert with code

> [!NOTE]
> ```
> SPL:  index=web status=500 | stats count by host
> NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
> ```

> [!WARNING]
> append translated to filter()

## Option 10: Details/summary per example

<details>
<summary>🤖 <code>index=web status=500 | stats count by host</code></summary>

```
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
```
⚠ append translated to filter()

</details>

## Option 11: Table with expandable details

| SPL | Status |
|---|---|
| <details><summary>`index=web status=500 \| stats count by host`</summary>`FROM Log SELECT count(*) WHERE index = 'web' FACET host`<br>⚠ append translated to filter()</details> | 🤖 LLM |

## Option 12: Horizontal rule separators

🤖 Confirmed by LLM
```
SPL:  index=web status=500 | stats count by host
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
```
> ⚠ append translated to filter()

---

## Option 13: Bold labels outside code

**SPL:** `index=web status=500 | stats count by host`

**NRQL:** `FROM Log SELECT count(*) WHERE index = 'web' FACET host`

🤖 Confirmed by LLM — ⚠ append translated to filter()

---

## Option 14: Definition list style

**`index=web status=500 | stats count by host`** 🤖

> ```
> FROM Log SELECT count(*) WHERE index = 'web' FACET host
> ```
> ⚠ append translated to filter()

## Option 15: Diff with box drawing separators

```diff
  🤖 Confirmed by LLM
  ─────────────────────────────────────────
  SPL:  index=web status=500 | stats count by host
  NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
  ─────────────────────────────────────────
! ⚠ append translated to filter()
```

## Option 16: Color-coded prefix badges

```diff
+ ✅ VERIFIED
  SPL:  index=web status=500 | stats count by host
  NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
! ⚠ append translated to filter()
```

## Option 17: Unsupported example (for comparison)

```diff
- ❌ UNSUPPORTED
  SPL:  | transaction session_id maxpause=5m
- ✗ transaction has no NRQL equivalent
```

## Option 18: Two-tone — green badge + yellow warning

```diff
+ 🤖 Confirmed by LLM
  SPL:  index=web status=500 | stats count by host
  NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
! ⚠ append translated to filter()
- ✗ some unsupported thing
```

## Option 19: Compact — one line per concept

```diff
+ 🤖 LLM
  index=web status=500 | stats count by host → FROM Log SELECT count(*) WHERE index = 'web' FACET host
! ⚠ append translated to filter()
```

## Option 20: WARNING alert for notes, plain code for query

```
SPL:  index=web status=500 | stats count by host
NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
```
✅ Confirmed by human

> [!WARNING]
> append translated to filter(); if the subsearch targets a different index or sourcetype, the filter() WHERE clause may need adjustment

## Bonus: Unsupported with CAUTION alert

```
SPL:  | transaction session_id maxpause=5m
```
❓ Not confirmed

> [!CAUTION]
> transaction has no NRQL equivalent
