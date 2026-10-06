import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const OUT_DIR = resolve(__dirname, '..', '..', '.output-field-lab');
const FLAVOR_DIR = join(OUT_DIR, 'chrome-mv3');

const FORBIDDEN_RUNTIME_MARKERS = [
  'https://api.edaix.io',
  'https://edaix.io',
  'requestSubmit',
  'runtime.sendMessage',
  'runtime.connect',
  'chrome.storage',
  'browser.storage',
  'chrome.tabs',
  'browser.tabs',
  'chrome.scripting',
  'browser.scripting',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'sendBeacon',
  'WebSocket',
  'EventSource',
  'BroadcastChannel',
  'MessageChannel',
  'MessagePort',
  'sendMessage',
  'postMessage',
  'dispatchEvent',
  'CacheStorage',
  'caches',
  'FileSystemDirectoryHandle',
  'FileSystemFileHandle',
  'showDirectoryPicker',
  'getDirectory',
  'navigator.storage',
  'document.cookie',
  'cookieStore',
  'cookie',
  'HTMLFormElement',
  'Reflect.apply',
  'trustTelemetry',
  'TRUST_TELEMETRY',
  'EdAIX Connected Lab',
  'edaix-pilot-ua5-panel-v1',
      'edaix-pilot-ua5-panel-v2',
  'edaix-pilot-ua5-content-v1',
      'edaix-pilot-ua5-content-v2',
  'pilot-ua5/profile-payload-request',
] as const;

const OBSOLETE_FIELD_LAB_MARKERS = [
  'SYNTHETIC_ADMITTED',
  'NOT_CONNECTED',
  'field-lab.invalid',
  'PROFILE_AUTH_UNAVAILABLE',
] as const;

const FORBIDDEN_RUNTIME_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['console authority', /\bconsole\b/u],
  ['direct submit call', /\.submit\s*(?:\?\.\s*)?\(/u],
  [
    'submit call/apply/bind',
    /\.submit\s*(?:(?:\?\.|\.)\s*(?:call|apply|bind)|(?:\?\.)?\s*\[\s*["'`](?:call|apply|bind)["'`]\s*\])\s*(?:\?\.\s*)?\(/u,
  ],
  ['computed submit call', /\[\s*["'`]submit["'`]\s*\]\s*(?:\?\.\s*)?\(/u],
  [
    'computed submit call/apply/bind',
    /\[\s*["'`]submit["'`]\s*\]\s*(?:(?:\?\.|\.)\s*(?:call|apply|bind)|(?:\?\.)?\s*\[\s*["'`](?:call|apply|bind)["'`]\s*\])\s*(?:\?\.\s*)?\(/u,
  ],
  [
    'reflective submit call',
    /Reflect\s*\.\s*apply\s*\(\s*[^,\n]{0,200}(?:\.submit|\[\s*["'`]submit["'`]\s*\])/u,
  ],
];

function runtimeBoundaryViolations(text: string): string[] {
  return [
    ...FORBIDDEN_RUNTIME_MARKERS
      .filter((marker) => text.includes(marker))
      .map((marker) => `marker:${marker}`),
    ...FORBIDDEN_RUNTIME_PATTERNS
      .filter(([, pattern]) => pattern.test(text))
      .map(([label]) => `pattern:${label}`),
  ];
}

function artifactFiles(path = FLAVOR_DIR): string[] {
  expect(existsSync(FLAVOR_DIR), `missing Field Lab artifact: ${FLAVOR_DIR}`).toBe(true);
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(path, entry.name);
    return entry.isDirectory()
      ? artifactFiles(fullPath)
      : [fullPath.slice(FLAVOR_DIR.length + 1)];
  });
}

function loadManifest(): Record<string, unknown> {
  const manifestPath = join(FLAVOR_DIR, 'manifest.json');
  expect(existsSync(manifestPath), `missing Field Lab manifest: ${manifestPath}`).toBe(true);
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

describe('Field Lab unpacked artifact', () => {
  it('has one exact side-panel-only manifest authority surface', () => {
    expect(loadManifest()).toEqual({
      manifest_version: 3,
      name: 'EdAIX Field Lab (Unpacked Dev)',
      description: 'Value-free production-port boundary inspector; no host writes',
      version: '0.0.0',
      side_panel: { default_path: 'sidepanel.html' },
      permissions: ['sidePanel'],
    });
  });

  it('contains exactly the side panel and its two compiled assets', () => {
    const files = artifactFiles();
    expect(files).toHaveLength(4);
    expect(files).toContain('manifest.json');
    expect(files).toContain('sidepanel.html');
    expect(files.filter((file) => /^chunks\/sidepanel-[\w-]+\.js$/u.test(file))).toHaveLength(1);
    expect(files.filter((file) => /^assets\/sidepanel-[\w-]+\.css$/u.test(file))).toHaveLength(1);
    expect(files.filter((file) => /background|content-scripts|apply\.js/iu.test(file))).toEqual([]);
  });

  it('contains the production UA-4 default-off boundary without the retired mock probes', () => {
    const files = artifactFiles();
    const text = files
      .map((file) => readFileSync(join(FLAVOR_DIR, file), 'utf8'))
      .join('\n');

    for (const marker of [
      'PILOT_CAPABILITY_DISABLED',
      'CALLED_FAIL_CLOSED',
      'HELD_DEFAULT_OFF',
      'NOT_MATERIALIZED',
      'ZERO_SUBMIT',
      'product-panel/interaction-prototype',
    ]) expect(text, marker).toContain(marker);

    for (const marker of OBSOLETE_FIELD_LAB_MARKERS) {
      expect(text, marker).not.toContain(marker);
    }
    expect(runtimeBoundaryViolations(text)).toEqual([]);
  });

  it('rejects representative indirect authority primitives', () => {
    for (const hostile of [
      'console["warn"]("leak")',
      'globalThis["console"]["warn"]("leak")',
      'const c = console; c.warn("leak")',
      'const channel = new MessageChannel()',
      'self["caches"].open("field-lab")',
      'navigator["storage"]["getDirectory"]()',
      'document["cookie"] = "field-lab=1"',
      'window["postMessage"]({}, "*")',
      'chrome.runtime["sendMessage"]({})',
      'form["submit"].apply(form)',
      'form["submit"]?.call(form)',
      'form["submit"].apply?.(form)',
      'form["submit"]["call"](form)',
      'form.submit?.call(form)',
      'form.submit.call?.(form)',
      'form.submit["call"](form)',
      'Reflect.apply(form.submit, form, [])',
    ]) expect(runtimeBoundaryViolations(hostile), hostile).not.toEqual([]);
  });
});
