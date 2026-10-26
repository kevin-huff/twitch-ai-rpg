type JsonObject = Record<string, unknown>;

const WORD_BOUNDARY_WINDOW = 20;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRef(schema: JsonObject, root: unknown): unknown {
  const ref = schema['$ref'];
  if (typeof ref !== 'string') return schema;
  if (ref === '#') return root;
  const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match || !isObject(root)) return schema;
  const table = root[match[1]!];
  if (!isObject(table)) return schema;
  const name = match[2]!.replace(/~1/g, '/').replace(/~0/g, '~');
  return table[name] ?? schema;
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function schemaTypes(schema: JsonObject): string[] {
  const type = schema['type'];
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((entry): entry is string => typeof entry === 'string');
  if (isObject(schema['properties'])) return ['object'];
  if (schema['items'] !== undefined) return ['array'];
  return [];
}

function branchMatches(branch: JsonObject, value: unknown): boolean {
  const kind = jsonType(value);
  return schemaTypes(branch).some((type) => type === kind || (type === 'number' && kind === 'integer'));
}

function fitString(value: string, schema: JsonObject): string {
  const trimmed = value.trim();
  if (schema['enum'] !== undefined || schema['const'] !== undefined) return trimmed;
  const max = schema['maxLength'];
  if (typeof max !== 'number' || trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  let boundary = -1;
  for (let index = cut.length - 1; index >= Math.max(max - WORD_BOUNDARY_WINDOW, 1); index -= 1) {
    if (/\s/.test(cut[index]!)) { boundary = index; break; }
  }
  let result = (boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd();
  const last = result.charCodeAt(result.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1).trimEnd();
  return result;
}

function fitNumber(value: number, schema: JsonObject): number {
  let next = schemaTypes(schema).includes('integer') ? Math.round(value) : value;
  const min = schema['minimum'];
  const max = schema['maximum'];
  if (typeof min === 'number' && next < min) next = min;
  if (typeof max === 'number' && next > max) next = max;
  return next;
}

function fit(value: unknown, schema: unknown, root: unknown, depth: number): unknown {
  if (!isObject(schema) || depth > 64) return value;
  const resolved = resolveRef(schema, root);
  if (resolved !== schema) return isObject(resolved) ? fit(value, resolved, root, depth + 1) : value;

  const branches = Array.isArray(schema['anyOf']) ? schema['anyOf'] : Array.isArray(schema['oneOf']) ? schema['oneOf'] : undefined;
  if (branches) {
    const options = branches.map((branch) => (isObject(branch) ? resolveRef(branch, root) : branch)).filter(isObject);
    if (value === null && options.some((branch) => schemaTypes(branch).includes('null'))) return null;
    const match = options.find((branch) => branchMatches(branch, value));
    return match ? fit(value, match, root, depth + 1) : value;
  }

  const types = schemaTypes(schema);
  if (typeof value === 'string' && types.includes('string')) return fitString(value, schema);
  if (typeof value === 'number' && Number.isFinite(value) && (types.includes('number') || types.includes('integer'))) return fitNumber(value, schema);
  if (Array.isArray(value) && types.includes('array')) {
    const itemSchema = schema['items'];
    let items: unknown[] = value;
    if (isObject(itemSchema)) {
      const resolvedItem = resolveRef(itemSchema, root);
      const stringItems = isObject(resolvedItem) && schemaTypes(resolvedItem).includes('string');
      const minLength = isObject(resolvedItem) ? resolvedItem['minLength'] : undefined;
      if (stringItems && typeof minLength === 'number' && minLength >= 1) {
        items = items.filter((entry) => !(typeof entry === 'string' && entry.trim().length === 0));
      }
      items = items.map((entry) => fit(entry, itemSchema, root, depth + 1));
    }
    const maxItems = schema['maxItems'];
    if (typeof maxItems !== 'number' || items.length <= maxItems) return items;
    const resolvedItems = isObject(itemSchema) ? resolveRef(itemSchema, root) : undefined;
    if (isObject(resolvedItems) && schemaTypes(resolvedItems).includes('string')) {
      items = items.filter((entry) => !(typeof entry === 'string' && entry.trim().length === 0));
    }
    return items.slice(0, maxItems);
  }
  if (isObject(value) && types.includes('object')) {
    const properties = schema['properties'];
    if (!isObject(properties)) return { ...value };
    const next: JsonObject = { ...value };
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) next[key] = fit(value[key], propertySchema, root, depth + 1);
    }
    return next;
  }
  return value;
}

export function fitToJsonSchema(value: unknown, schema: unknown): unknown {
  return fit(value, schema, schema, 0);
}
