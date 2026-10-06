import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { workflowHash } from '@companion/ai-core';

export interface McpCatalogEntry {
  id: string; name: string; description?: string; url: string;
  tools: { name: string; schemaHash: string }[];
  /** Service credentials only; this is not a user's third-party OAuth grant. */
  bearerToken?: string;
}
export interface McpCatalogConfig { entries: McpCatalogEntry[]; fixtureOrigins: string[]; }
export const mcpSchemaHash = (schema: Record<string, unknown>, outputSchema?: Record<string, unknown>): string =>
  workflowHash(outputSchema === undefined ? schema : { inputSchema: schema, outputSchema });
export function mcpCatalogHash(entry: McpCatalogEntry): string {
  return workflowHash({ version: 1, id: entry.id, name: entry.name, url: entry.url, tools: entry.tools,
    credential: entry.bearerToken ? createHash('sha256').update(entry.bearerToken).digest('hex') : null });
}
const id = /^[a-z][a-z0-9_-]{0,63}$/;
const tool = /^[A-Za-z0-9_.-]{1,128}$/;
const hash = /^[a-f0-9]{64}$/;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP catalog entries must be objects');
  return value as Record<string, unknown>;
}
function label(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function loopback(host: string): boolean { return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'; }
export function readMcpConfig(env: NodeJS.ProcessEnv = process.env): McpCatalogConfig {
  const fixtureOrigins: string[] = [];
  if (env.PLATFORM_MCP_FIXTURE_ORIGINS !== undefined) {
    if (env.NODE_ENV === 'production') throw new Error('Production cannot enable MCP loopback fixtures');
    for (const origin of env.PLATFORM_MCP_FIXTURE_ORIGINS.split(',')) {
      let parsed: URL; try { parsed = new URL(origin); } catch { throw new Error('MCP fixture origins must be exact loopback origins'); }
      if (parsed.origin !== origin || parsed.protocol !== 'http:' || !loopback(parsed.hostname) || parsed.username || parsed.password) throw new Error('MCP fixture origins must be exact loopback origins');
      fixtureOrigins.push(origin);
    }
  }
  if (env.PLATFORM_MCP_CATALOG_FILE === undefined) return { entries: [], fixtureOrigins };
  const file = env.PLATFORM_MCP_CATALOG_FILE;
  if (!file.trim() || file !== file.trim()) throw new Error('MCP catalog must name an explicit server file');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('MCP catalog must be a file of at most 64 KiB');
  const data = record(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 20 || Object.keys(data).some(key => !['version', 'entries'].includes(key))) throw new Error('MCP catalog requires version 1 and at most 20 entries');
  const entries = data.entries.map(raw => {
    const item = record(raw);
    if (Object.keys(item).some(key => !['id', 'name', 'description', 'url', 'tools', 'bearerEnv'].includes(key)) || typeof item.id !== 'string' || !id.test(item.id) || !label(item.name, 100) || item.description !== undefined && !label(item.description, 1000)) throw new Error('Invalid reviewed MCP catalog entry');
    if (typeof item.url !== 'string' || item.url.length > 4096 || /[\x00-\x20\x7f]/.test(item.url)) throw new Error('MCP endpoints must be explicit HTTPS URLs');
    let url: URL; try { url = new URL(item.url); } catch { throw new Error('MCP endpoints must be explicit HTTPS URLs'); }
    if (url.username || url.password || url.search || url.hash || !url.hostname || url.hostname.includes('*') || (url.protocol !== 'https:' && !(url.protocol === 'http:' && fixtureOrigins.includes(url.origin)))) throw new Error('MCP endpoints must be explicit HTTPS URLs or approved local fixtures');
    if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !fixtureOrigins.includes(url.origin)) throw new Error('MCP public endpoints must use DNS hostnames');
    if (!Array.isArray(item.tools) || !item.tools.length || item.tools.length > 20) throw new Error('MCP entries require one to twenty reviewed tools');
    const tools = item.tools.map(rawTool => { const entry = record(rawTool); if (Object.keys(entry).some(key => !['name', 'schemaHash'].includes(key)) || typeof entry.name !== 'string' || !tool.test(entry.name) || typeof entry.schemaHash !== 'string' || !hash.test(entry.schemaHash)) throw new Error('MCP tools require a reviewed name and schema hash'); return { name: entry.name, schemaHash: entry.schemaHash }; });
    if (new Set(tools.map(entry => entry.name)).size !== tools.length) throw new Error('MCP tool names must be distinct');
    let bearerToken: string | undefined;
    if (item.bearerEnv !== undefined) {
      if (typeof item.bearerEnv !== 'string' || !/^MCP_[A-Z0-9_]{1,100}$/.test(item.bearerEnv)) throw new Error('MCP service credentials require an explicit MCP_ environment variable');
      bearerToken = env[item.bearerEnv];
      if (typeof bearerToken !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(bearerToken)) throw new Error('The configured MCP service credential is unavailable');
    }
    return { id: item.id as string, name: item.name, description: item.description as string | undefined, url: url.href, tools, ...(bearerToken ? { bearerToken } : {}) };
  });
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('MCP catalog IDs must be distinct');
  return { entries, fixtureOrigins };
}
