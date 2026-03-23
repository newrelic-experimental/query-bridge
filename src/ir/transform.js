/**
 * Generic bottom-up IR tree walker.
 *
 * Walks every node in an IR tree, applying `fn` to each node after
 * its children have already been transformed (bottom-up order).
 *
 * Does NOT recurse into SubqueryExpr or SubquerySource — those are
 * independent query scopes. Passes that need to optimize inside
 * subqueries must explicitly call transformTree on the inner query.
 */

/**
 * @param {object|null|undefined} node
 * @param {(node: object) => object} fn
 * @returns {object|null|undefined}
 */
export function transformTree(node, fn) {
  if (!node || typeof node !== 'object') return node;

  const transformed = transformChildren(node, fn);
  return fn(transformed);
}

function transformChildren(node, fn) {
  switch (node.type) {
    // ── Leaf nodes (no children) ──
    case 'Identifier':
    case 'Literal':
    case 'Wildcard':
    case 'Regex':
    case 'RawNrql':
    case 'EventType':
    case 'Lookup':
      return node;

    // ── Boundary nodes (don't cross into subqueries) ──
    case 'SubqueryExpr':
    case 'SubquerySource':
      return node;

    // ── Expression nodes ──
    case 'BinOp':
      return {
        ...node,
        left: transformTree(node.left, fn),
        right: transformTree(node.right, fn),
      };

    case 'Not':
      return { ...node, child: transformTree(node.child, fn) };

    case 'Function':
      return { ...node, args: node.args.map((a) => transformTree(a, fn)) };

    case 'Alias':
      return { ...node, expr: transformTree(node.expr, fn) };

    case 'IsNull':
      return { ...node, child: transformTree(node.child, fn) };

    case 'Like':
      return { ...node, field: transformTree(node.field, fn) };

    case 'In':
      return { ...node, field: transformTree(node.field, fn) };

    case 'Rlike':
      return { ...node, field: transformTree(node.field, fn) };

    case 'DualCheck':
      return { ...node, field: transformTree(node.field, fn) };

    // ── Structural nodes ──
    case 'OrderBy':
      return { ...node, field: transformTree(node.field, fn) };

    case 'JoinClause':
      return { ...node, subquery: transformTree(node.subquery, fn) };

    // ── Query-level nodes ──
    case 'SelectQuery':
      return {
        ...node,
        select: node.select.map((s) => transformTree(s, fn)),
        where: node.where ? transformTree(node.where, fn) : null,
        facet: node.facet.map((f) => transformTree(f, fn)),
        bindings: node.bindings.map((b) => ({
          ...b,
          expr: transformTree(b.expr, fn),
        })),
        join: node.join ? transformTree(node.join, fn) : null,
        orderBy: node.orderBy ? transformTree(node.orderBy, fn) : null,
        dataSource: node.dataSource
          ? transformTree(node.dataSource, fn)
          : node.dataSource,
      };

    default:
      return node;
  }
}
