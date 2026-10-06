import Ajv, { type ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';
import type { jsonSchemaValidator, JsonSchemaType } from '@modelcontextprotocol/client';

// Never coerce, remove or fill user data, load remote refs, or log schema content.
const options = { strict: false, allErrors: false, logger: false as const, addUsedSchema: false, validateFormats: true };
const legacy = addFormats(new Ajv(options));
const modern = addFormats(new Ajv2020(options));
const validators = new Map<string, ValidateFunction>();
const unreachable = ['items', 'prefixItems', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'patternProperties', 'dependentSchemas', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', '$defs', 'definitions'];
const schemaMaps = new Set(['patternProperties', 'dependentSchemas', '$defs', 'definitions']);
/** Silent SEP-2243 check; header names use the bounded ASCII subset accepted by our HTTP policy. */
export function validMcpHeaderSchema(schema: Record<string, unknown>): boolean {
  const names = new Set<string>(); let nodes = 0;
  function visit(value: unknown, reachable: boolean, depth: number): boolean {
    if (++nodes > 2048 || depth > 24) return false;
    if (!value || typeof value !== 'object') return true;
    const node = value as Record<string, unknown>;
    if (Object.hasOwn(node, 'x-mcp-header')) {
      const name = node['x-mcp-header'];
      if (!reachable || depth === 0 || typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(name) || typeof node.type !== 'string' || !['string', 'integer', 'boolean'].includes(node.type) || names.has(name.toLowerCase())) return false;
      names.add(name.toLowerCase());
    }
    if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
      for (const child of Object.values(node.properties)) if (!visit(child, reachable, depth + 1)) return false;
    }
    for (const key of unreachable) {
      const child = node[key]; if (child === undefined) continue;
      const children = Array.isArray(child) ? child : child && typeof child === 'object' && schemaMaps.has(key) ? Object.values(child) : [child];
      for (const branch of children) if (!visit(branch, false, depth + 1)) return false;
    }
    return true;
  }
  return visit(schema, true, 0);
}
export function compileMcpSchema(schema: Record<string, unknown>): ValidateFunction {
  const dialect = schema.$schema;
  if (dialect !== undefined && !['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema'].includes(String(dialect))) throw new Error('Unsupported MCP schema dialect');
  const key = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
  const cached = validators.get(key);
  if (cached) { validators.delete(key); validators.set(key, cached); return cached; }
  const engine = typeof dialect === 'string' && dialect.includes('draft-07') ? legacy : modern;
  const normalized = engine === legacy && dialect === 'https://json-schema.org/draft-07/schema#'
    ? { ...schema, $schema: 'http://json-schema.org/draft-07/schema#' } : schema;
  const validate = engine.compile(normalized);
  engine.removeSchema(normalized);
  validators.set(key, validate);
  if (validators.size > 256) validators.delete(validators.keys().next().value!);
  return validate;
}
/** The SDK's validator hook keeps protocol/output validation without private warnings. */
export const mcpSchemaValidator: jsonSchemaValidator = {
  getValidator<T>(schema: JsonSchemaType) {
    const validate = compileMcpSchema(schema as Record<string, unknown>);
    return value => validate(value) ? { valid: true, data: value as T, errorMessage: undefined }
      : { valid: false, data: undefined, errorMessage: 'MCP data did not match its declared schema.' };
  },
};
