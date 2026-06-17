import {
  Identifier,
  Literal,
  BinOp,
  Not,
  Func,
  DualCheck,
  SelectQuery,
} from '../../src/ir/nodes.js';
import { optimize } from '../../src/ir/optimize.js';

describe('optimize', () => {
  describe('eliminateDoubleNot', () => {
    it('NOT(NOT(x)) → x', () => {
      const ir = SelectQuery({ where: [Not(Not(Identifier('a')))] });
      const result = optimize(ir);
      expect(result.where[0]).toEqual(Identifier('a'));
    });

    it('NOT(NOT(NOT(NOT(x)))) → x (nested pairs)', () => {
      const ir = SelectQuery({
        where: [Not(Not(Not(Not(Identifier('a')))))],
      });
      const result = optimize(ir);
      expect(result.where[0]).toEqual(Identifier('a'));
    });

    it('single NOT is preserved', () => {
      const ir = SelectQuery({ where: [Not(Identifier('a'))] });
      const result = optimize(ir);
      expect(result.where[0]).toEqual(Not(Identifier('a')));
    });

    it('triple NOT reduces to single NOT', () => {
      const ir = SelectQuery({ where: [Not(Not(Not(Identifier('a'))))] });
      const result = optimize(ir);
      expect(result.where[0]).toEqual(Not(Identifier('a')));
    });
  });

  describe('foldConstants', () => {
    it('folds addition: 2 + 3 → 5', () => {
      const ir = SelectQuery({
        select: [BinOp('+', Literal(2, 'number'), Literal(3, 'number'))],
      });
      const result = optimize(ir);
      expect(result.select[0]).toEqual(Literal(5, 'number'));
    });

    it('folds subtraction: 10 - 4 → 6', () => {
      const ir = SelectQuery({
        select: [BinOp('-', Literal(10, 'number'), Literal(4, 'number'))],
      });
      const result = optimize(ir);
      expect(result.select[0]).toEqual(Literal(6, 'number'));
    });

    it('folds multiplication: 3 * 7 → 21', () => {
      const ir = SelectQuery({
        select: [BinOp('*', Literal(3, 'number'), Literal(7, 'number'))],
      });
      const result = optimize(ir);
      expect(result.select[0]).toEqual(Literal(21, 'number'));
    });

    it('folds division: 10 / 2 → 5', () => {
      const ir = SelectQuery({
        select: [BinOp('/', Literal(10, 'number'), Literal(2, 'number'))],
      });
      const result = optimize(ir);
      expect(result.select[0]).toEqual(Literal(5, 'number'));
    });

    it('does NOT fold division by zero', () => {
      const expr = BinOp('/', Literal(10, 'number'), Literal(0, 'number'));
      const ir = SelectQuery({ select: [expr] });
      const result = optimize(ir);
      expect(result.select[0]).toEqual(expr);
    });

    it('does NOT fold modulo by zero', () => {
      const expr = BinOp('%', Literal(10, 'number'), Literal(0, 'number'));
      const ir = SelectQuery({ select: [expr] });
      const result = optimize(ir);
      expect(result.select[0]).toEqual(expr);
    });

    it('does NOT fold string literals', () => {
      const expr = BinOp('+', Literal('a', 'string'), Literal('b', 'string'));
      const ir = SelectQuery({ select: [expr] });
      const result = optimize(ir);
      expect(result.select[0]).toEqual(expr);
    });

    it('does NOT fold mixed types', () => {
      const expr = BinOp('+', Literal(1, 'number'), Identifier('x'));
      const ir = SelectQuery({ select: [expr] });
      const result = optimize(ir);
      expect(result.select[0]).toEqual(expr);
    });

    it('folds nested arithmetic: (2 + 3) * 4 → 20', () => {
      const ir = SelectQuery({
        select: [
          BinOp(
            '*',
            BinOp('+', Literal(2, 'number'), Literal(3, 'number')),
            Literal(4, 'number'),
          ),
        ],
      });
      const result = optimize(ir);
      expect(result.select[0]).toEqual(Literal(20, 'number'));
    });

    it('does NOT fold boolean ops as arithmetic', () => {
      // foldConstants should not treat AND/OR as arithmetic ops
      // (tautology pass may still simplify: true AND false → false)
      const ir = SelectQuery({
        select: [
          BinOp('AND', Literal(true, 'boolean'), Literal(false, 'boolean')),
        ],
      });
      const result = optimize(ir);
      // tautology pass reduces true AND x → x, so result is Literal(false)
      // The key: foldConstants didn't try to compute true + false = 1
      expect(result.select[0]).toEqual(Literal(false, 'boolean'));
    });
  });

  describe('eliminateTautologies', () => {
    it('x AND true → x', () => {
      const ir = SelectQuery({
        where: [BinOp('AND', Identifier('a'), Literal(true, 'boolean'))],
      });
      const result = optimize(ir);
      expect(result.where[0]).toEqual(Identifier('a'));
    });

    it('true AND x → x', () => {
      const ir = SelectQuery({
        where: [BinOp('AND', Literal(true, 'boolean'), Identifier('a'))],
      });
      const result = optimize(ir);
      expect(result.where[0]).toEqual(Identifier('a'));
    });

    it('x OR false → x', () => {
      const ir = SelectQuery({
        where: [BinOp('OR', Identifier('a'), Literal(false, 'boolean'))],
      });
      const result = optimize(ir);
      expect(result.where[0]).toEqual(Identifier('a'));
    });

    it('false OR x → x', () => {
      const ir = SelectQuery({
        where: [BinOp('OR', Literal(false, 'boolean'), Identifier('a'))],
      });
      const result = optimize(ir);
      expect(result.where[0]).toEqual(Identifier('a'));
    });

    it('preserves non-tautological expressions', () => {
      const expr = BinOp('AND', Identifier('a'), Identifier('b'));
      const ir = SelectQuery({ where: [expr] });
      const result = optimize(ir);
      expect(result.where[0]).toEqual(expr);
    });
  });

  describe('expandDualChecks', () => {
    it("expands equality: DualCheck(field, =, 500) → field = '500' OR numeric(field) = 500", () => {
      const ir = SelectQuery({
        where: [DualCheck(Identifier('status'), '=', Literal(500, 'number'))],
      });
      const result = optimize(ir);
      expect(result.where[0]).toEqual(
        BinOp(
          'OR',
          BinOp('=', Identifier('status'), Literal('500', 'string')),
          BinOp(
            '=',
            Func('numeric', [Identifier('status')]),
            Literal(500, 'number'),
          ),
        ),
      );
    });

    it("expands inequality: DualCheck(field, !=, 500) → field != '500' AND numeric(field) != 500", () => {
      const ir = SelectQuery({
        where: [DualCheck(Identifier('status'), '!=', Literal(500, 'number'))],
      });
      const result = optimize(ir);
      expect(result.where[0]).toEqual(
        BinOp(
          'AND',
          BinOp('!=', Identifier('status'), Literal('500', 'string')),
          BinOp(
            '!=',
            Func('numeric', [Identifier('status')]),
            Literal(500, 'number'),
          ),
        ),
      );
    });

    it('expands DualCheck nested in AND', () => {
      const ir = SelectQuery({
        where: [
          BinOp(
            'AND',
            DualCheck(Identifier('status'), '=', Literal(200, 'number')),
            Identifier('other'),
          ),
        ],
      });
      const result = optimize(ir);
      expect(result.where[0].left).toEqual(
        BinOp(
          'OR',
          BinOp('=', Identifier('status'), Literal('200', 'string')),
          BinOp(
            '=',
            Func('numeric', [Identifier('status')]),
            Literal(200, 'number'),
          ),
        ),
      );
      expect(result.where[0].right).toEqual(Identifier('other'));
    });

    it('handles float values: DualCheck(field, =, 3.14)', () => {
      const ir = SelectQuery({
        where: [DualCheck(Identifier('score'), '=', Literal(3.14, 'number'))],
      });
      const result = optimize(ir);
      expect(result.where[0]).toEqual(
        BinOp(
          'OR',
          BinOp('=', Identifier('score'), Literal('3.14', 'string')),
          BinOp(
            '=',
            Func('numeric', [Identifier('score')]),
            Literal(3.14, 'number'),
          ),
        ),
      );
    });

    it('handles complex field expression (e.g., from jparse)', () => {
      const field = Func('lower', [Identifier('status')]);
      const ir = SelectQuery({
        where: [DualCheck(field, '=', Literal(200, 'number'))],
      });
      const result = optimize(ir);
      expect(result.where[0]).toEqual(
        BinOp(
          'OR',
          BinOp(
            '=',
            Func('lower', [Identifier('status')]),
            Literal('200', 'string'),
          ),
          BinOp(
            '=',
            Func('numeric', [Func('lower', [Identifier('status')])]),
            Literal(200, 'number'),
          ),
        ),
      );
    });
  });

  describe('pipeline composition', () => {
    it('applies multiple passes: NOT(NOT(x)) AND true → x', () => {
      const ir = SelectQuery({
        where: [
          BinOp('AND', Not(Not(Identifier('a'))), Literal(true, 'boolean')),
        ],
      });
      const result = optimize(ir);
      expect(result.where[0]).toEqual(Identifier('a'));
    });

    it('preserves warnings/unsupported/errors arrays', () => {
      const ir = SelectQuery({
        where: [Identifier('a')],
        warnings: ['w1'],
        unsupported: ['u1'],
        errors: ['e1'],
      });
      const result = optimize(ir);
      expect(result.warnings).toEqual(['w1']);
      expect(result.unsupported).toEqual(['u1']);
      expect(result.errors).toEqual(['e1']);
    });
  });
});
