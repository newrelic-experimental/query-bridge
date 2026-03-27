# Type Strictness Rules

## IR Node Factories — No Null Arguments

Functions in `src/ir/nodes.js` (`Func`, `BinOp`, `Alias`, `Like`, `Not`, `In`, `OrderBy`, etc.) require `IRNode` arguments, never `IRNode | null`. If you're passing something that might be null, handle the null *before* calling the factory.

This is the enforcement boundary. If a tree walker returns null for a child node, the caller must decide what to do — warn, skip, or mark unsupported — before constructing IR.

## No Silent Null Dropping

Never use `.filter(Boolean)` to silently drop nulls from IR node arrays. Instead:

- If nulls mean the expression is invalid, push an unsupported message and bail
- If nulls are expected and ignorable (rare — justify with a comment), filter explicitly: `// drop untranslatable args — these are optional in SPL`
- Default: treat unexpected nulls as translation failures, not silent skips

The `.filter(Boolean)` pattern is how conditions get silently dropped from WHERE clauses and arguments vanish from function calls. Every instance should be audited.

## Tree Walker Return Types

Functions like `walkEvalExpr` and `translateSearchExpr` legitimately return `IRNode | null`. Null means "this SPL node doesn't produce an IR node" (e.g., bare `*`, time constraints consumed by SINCE/UNTIL).

Callers must handle the null explicitly. The combiner pattern:
```javascript
// Good — loud failure when a required operand can't be translated
const left = walk(node.left);
const right = walk(node.right);
if (!left || !right) {
  ir.unsupported.push('could not translate both sides of expression');
  return null;
}
return BinOp(node.op, left, right);
```

## No `any` Types

Use `unknown` and narrow, not `any`. If a function accepts multiple types, use a union: `string | number`, not `any`.

Union types are fine when they represent real alternatives. `string | number | null | IRNode` is a smell — the function is doing too many things.
