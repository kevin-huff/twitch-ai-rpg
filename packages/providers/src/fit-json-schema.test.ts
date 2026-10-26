import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fitToJsonSchema } from './fit-json-schema.js';

function fitWith(schema: z.ZodType, value: unknown) {
  return fitToJsonSchema(value, z.toJSONSchema(schema));
}

describe('fitToJsonSchema', () => {
  it('trims strings and cuts a 161 character title to 160', () => {
    const schema = z.object({ title: z.string().max(160) });
    const fitted = fitWith(schema, { title: `  ${'a'.repeat(161)}  ` }) as { title: string };
    expect(fitted.title).toBe('a'.repeat(160));
    expect(schema.parse(fitted)).toEqual(fitted);
  });

  it('cuts a long string at a space near the limit', () => {
    const schema = z.object({ text: z.string().max(300) });
    const sentence = 'The harbor lights flicker over the water. ';
    const long = sentence.repeat(20).slice(0, 400);
    const fitted = (fitWith(schema, { text: long }) as { text: string }).text;
    expect(fitted.length).toBeLessThanOrEqual(300);
    expect(fitted.length).toBeGreaterThan(280);
    expect(fitted).toBe(fitted.trimEnd());
    expect(long.startsWith(fitted)).toBe(true);
    expect(long[fitted.length]).toBe(' ');
    expect(() => schema.parse({ text: fitted })).not.toThrow();
  });

  it('cuts hard when there is no whitespace in the final 20 characters', () => {
    const schema = z.object({ text: z.string().max(50) });
    const value = `${'word '.repeat(5)}${'x'.repeat(60)}`;
    const fitted = (fitWith(schema, { text: value }) as { text: string }).text;
    expect(fitted).toBe(value.slice(0, 50));
  });

  it('only trims strings that have an enum or const', () => {
    const schema = z.object({ kind: z.enum(['alpha', 'beta']), tag: z.literal('x') });
    expect(fitWith(schema, { kind: ' alpha ', tag: ' x ' })).toEqual({ kind: 'alpha', tag: 'x' });
    expect(fitWith(schema, { kind: ' nope ', tag: 'x' })).toEqual({ kind: 'nope', tag: 'x' });
  });

  it('cuts an 11 item array to 10', () => {
    const schema = z.object({ traits: z.array(z.string()).max(10) });
    const fitted = fitWith(schema, { traits: Array.from({ length: 11 }, (_, index) => `t${index}`) }) as { traits: string[] };
    expect(fitted.traits).toHaveLength(10);
    expect(fitted.traits[9]).toBe('t9');
    expect(() => schema.parse(fitted)).not.toThrow();
  });

  it('drops blank entries from a string array whose items need a character', () => {
    const schema = z.object({ lines: z.array(z.string().min(1)).max(3) });
    const fitted = fitWith(schema, { lines: ['one', '   ', '', 'two', 'three', 'four'] }) as { lines: string[] };
    expect(fitted.lines).toEqual(['one', 'two', 'three']);
    expect(() => schema.parse(fitted)).not.toThrow();
  });

  it('keeps blank entries when the items allow empty strings', () => {
    const schema = z.object({ lines: z.array(z.string()) });
    expect(fitWith(schema, { lines: ['a', ' ', 'b'] })).toEqual({ lines: ['a', '', 'b'] });
  });

  it('rounds and clamps integers', () => {
    const schema = z.object({ seats: z.number().int().min(2).max(8) });
    expect(fitWith(schema, { seats: 12 })).toEqual({ seats: 8 });
    expect(fitWith(schema, { seats: 0.4 })).toEqual({ seats: 2 });
    expect(fitWith(schema, { seats: 4.6 })).toEqual({ seats: 5 });
    expect(fitWith(schema, { seats: 4 })).toEqual({ seats: 4 });
  });

  it('clamps plain numbers without rounding them', () => {
    const schema = z.object({ weight: z.number().min(0).max(1) });
    expect(fitWith(schema, { weight: 1.5 })).toEqual({ weight: 1 });
    expect(fitWith(schema, { weight: 0.25 })).toEqual({ weight: 0.25 });
  });

  it('keeps a null in a nullable field and fits a string in it', () => {
    const schema = z.object({ note: z.string().max(5).nullable() });
    expect(fitWith(schema, { note: null })).toEqual({ note: null });
    expect(fitWith(schema, { note: '  abcdefgh ' })).toEqual({ note: 'abcde' });
  });

  it('fits a nested object inside an array', () => {
    const schema = z.object({
      npcs: z.array(z.object({ name: z.string().min(1).max(5), tags: z.array(z.string()).max(1), level: z.number().int().max(3) })).max(2),
    });
    const fitted = fitWith(schema, {
      npcs: [
        { name: ' Bartholomew ', tags: ['a', 'b'], level: 9 },
        { name: 'Ann', tags: [], level: 1 },
        { name: 'Extra', tags: [], level: 1 },
      ],
    });
    expect(fitted).toEqual({
      npcs: [
        { name: 'Barth', tags: ['a'], level: 3 },
        { name: 'Ann', tags: [], level: 1 },
      ],
    });
    expect(() => schema.parse(fitted)).not.toThrow();
  });

  it('follows a local $ref into $defs', () => {
    const Npc = z.object({ name: z.string().max(4) });
    const schema = z.object({ first: Npc, second: Npc });
    const jsonSchema = z.toJSONSchema(schema, { reused: 'ref' }) as unknown as { properties: { first: { $ref?: string } } };
    expect(jsonSchema.properties.first.$ref).toMatch(/^#\/\$defs\//);
    expect(fitToJsonSchema({ first: { name: 'Abcdefg' }, second: { name: ' Zed ' } }, jsonSchema)).toEqual({
      first: { name: 'Abcd' },
      second: { name: 'Zed' },
    });
  });

  it('follows a $ref to the root for recursive schemas', () => {
    type Node = { name: string; kids: Node[] };
    const Node: z.ZodType<Node> = z.object({ name: z.string().max(3), get kids() { return z.array(Node).max(1); } });
    const fitted = fitWith(Node, { name: 'abcdef', kids: [{ name: 'xyzxyz', kids: [] }, { name: 'drop', kids: [] }] });
    expect(fitted).toEqual({ name: 'abc', kids: [{ name: 'xyz', kids: [] }] });
  });

  it('leaves keys that are not in the schema untouched', () => {
    const schema = z.object({ a: z.string().max(2) });
    expect(fitWith(schema, { a: 'abc', extra: ' keep ' })).toEqual({ a: 'ab', extra: ' keep ' });
  });

  it('returns a value of the wrong type unchanged so the strict parse still fails', () => {
    const schema = z.object({ title: z.string().max(5), seats: z.number().int().max(3), tags: z.array(z.string()) });
    const bad = { title: 42, seats: 'many', tags: 'one' };
    const fitted = fitWith(schema, bad);
    expect(fitted).toEqual(bad);
    expect(() => schema.parse(fitted)).toThrow();
    expect(fitWith(schema, 'not an object')).toBe('not an object');
    expect(fitWith(schema, null)).toBeNull();
  });

  it('does not mutate its input', () => {
    const schema = z.object({ title: z.string().max(3), list: z.array(z.object({ n: z.number().int().max(2) })).max(1) });
    const input = { title: ' abcdef ', list: [{ n: 9 }, { n: 8 }] };
    const snapshot = structuredClone(input);
    const fitted = fitWith(schema, input) as typeof input;
    expect(input).toEqual(snapshot);
    expect(fitted).not.toBe(input);
    expect(fitted.list).not.toBe(input.list);
    expect(fitted).toEqual({ title: 'abc', list: [{ n: 2 }] });
  });

  it('drops a lone high surrogate left by a cut inside an emoji', () => {
    const schema = { type: 'string', maxLength: 5 };
    const fitted = fitToJsonSchema('abcd\u{1F600}efg', schema) as string;
    expect(fitted).toBe('abcd');
    expect(fitted).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('keeps an emoji that fits inside the limit', () => {
    const schema = { type: 'string', maxLength: 6 };
    expect(fitToJsonSchema('abcd\u{1F600}efg', schema)).toBe('abcd\u{1F600}');
  });

  it('drops blank strings first when over maxItems', () => {
    const schema = { type: 'array', maxItems: 3, items: { type: 'string' } };
    expect(fitToJsonSchema(['', 'Rope', 'Knife', 'Lantern'], schema)).toEqual(['Rope', 'Knife', 'Lantern']);
  });

  it('keeps blank strings when at or under maxItems', () => {
    const schema = { type: 'array', maxItems: 3, items: { type: 'string' } };
    expect(fitToJsonSchema(['', 'Rope'], schema)).toEqual(['', 'Rope']);
  });
});
