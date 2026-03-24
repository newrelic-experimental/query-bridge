# GHE Rendering Test

Delete this file after testing.

## Alert syntax (github.com style)

> [!NOTE]
> This is a note — should have blue background

> [!TIP]
> This is a tip — should have green background

> [!WARNING]
> This is a warning — should have yellow background

> [!CAUTION]
> This is a caution — should have red background

## Blockquote with emoji (fallback)

> ✅ **Confirmed by human**
>
> ```
> SPL:  index=web status=500 | stats count by host
> NRQL: FROM Log SELECT count(*) WHERE index = 'web' AND status = '500' OR numeric(status) = 500 FACET host
> ```
>
> ⚠️ NRQL rename keeps original field names alongside aliases

## Details/summary

<details>
<summary>Click to expand</summary>

This should be collapsible.

</details>

## Table approach

| SPL | NRQL | Status |
|---|---|---|
| `index=web status=500` | `FROM Log SELECT * WHERE index = 'web' AND ...` | ✅ LLM |
| `\| stats count by host` | `SELECT count(*) FACET host` | ✅ Human |

## Diff code block (colored lines)

```diff
+ SPL:  index=web status=500 | stats count by host
+ NRQL: FROM Log SELECT count(*) WHERE index = 'web' FACET host
! ⚠ warning message here
- ✗ unsupported message here
```
