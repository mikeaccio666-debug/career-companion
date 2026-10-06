import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_EXTENSION_ID } from '../../lib/developmentIdentity';

const OUT_DIR = resolve(__dirname, '..', '..', '.output-local');

function artifactFiles(path = OUT_DIR): string[] {
  expect(existsSync(OUT_DIR), `missing default artifact: ${OUT_DIR}`).toBe(true);
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(path, entry.name);
    return entry.isDirectory()
      ? artifactFiles(fullPath)
      : [fullPath.slice(OUT_DIR.length + 1)];
  });
}

function loadManifest(): Record<string, unknown> {
  const manifestPath = join(OUT_DIR, 'chrome-mv3', 'manifest.json');
  expect(existsSync(manifestPath), `missing default manifest: ${manifestPath}`).toBe(true);
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

describe('default extension artifact excludes Field Lab', () => {
  it('keeps the established background/content-script identity', () => {
    const manifest = loadManifest();
    expect(manifest.permissions).toEqual(['storage', 'alarms']);
    expect((manifest.background as { service_worker?: unknown }).service_worker).toBe(
      'background.js',
    );
    expect((manifest.content_scripts as Array<{ js?: string[] }>)[0]?.js).toEqual([
      'content-scripts/apply.js',
    ]);
    // Embedded ATS boards serve the form from a cross-origin iframe; the top
    // document yields to it (gate/frameArbitration), so the script has to be
    // allowed into that frame or no frame fills anything.
    expect(
      (manifest.content_scripts as Array<{ all_frames?: boolean }>)[0]?.all_frames,
    ).toBe(true);
    expect(manifest).not.toHaveProperty('side_panel');
    expect(manifest).not.toHaveProperty('sidebar_action');
    expect(manifest.permissions).not.toContain('sidePanel');
  });

  it('contains no Field Lab entrypoint, asset, or unique runtime marker', () => {
    const files = artifactFiles();
    expect(files).toContain('chrome-mv3/background.js');
    expect(files).toContain('chrome-mv3/content-scripts/apply.js');
    expect(files.filter((file) => /sidepanel|field-lab/iu.test(file))).toEqual([]);

    const text = files
      .map((file) => readFileSync(join(OUT_DIR, file), 'utf8'))
      .join('\n');
    for (const marker of [
      'DEV FIELD LAB',
      'EdAIX Field Lab',
      'field-lab/value-free-probe',
      'FIELD_LAB_DISCOVERY_BOUNDARY_VIOLATION',
      'FIELD_LAB_ADAPTER_UNAVAILABLE',
      'field-lab.invalid',
      'UA-4_PUBLIC_SEAM',
      'NOT_CONNECTED',
      'Run value-free adapter probes',
      'product-panel/interaction-prototype',
      'EdAIX Connected Lab',
      'edaix-pilot-ua5-panel-v1',
      'edaix-pilot-ua5-panel-v2',
      'edaix-pilot-ua5-content-v1',
      'edaix-pilot-ua5-content-v2',
      'pilot-ua5/profile-payload-request',
      '--fl-',
      '.fl-',
    ]) expect(text, marker).not.toContain(marker);
  });
});

describe('the ordinary artifact installs as one stable extension', () => {
  it('pins its id with a manifest key, so it is not a new extension on every machine', () => {
    const manifest = loadManifest();
    // Without this an unpacked build's id follows its directory path. Nothing that
    // pins an id can then match it -- not the portal's configured app id, not the
    // API's allowed extension origins -- and the symptom is "it will not connect",
    // which points nowhere near the manifest. Regression: the key was added for
    // the ordinary package in 613d524ed and a later refactor left it only on the
    // connected branch.
    expect(typeof manifest.key, 'the default manifest carries no key').toBe('string');
    const derived = [...createHash('sha256')
      .update(Buffer.from(manifest.key as string, 'base64'))
      .digest('hex')
      .slice(0, 32)]
      .map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16)))
      .join('');
    expect(derived).toBe(LOCAL_EXTENSION_ID);
  });
});

it('does not ship the default-off assistant read bridge', () => {
  const text = artifactFiles().map(file => readFileSync(join(OUT_DIR, file), 'utf8')).join('\n');
  expect(text).not.toContain('assistant/read-v1');
  expect(text).not.toContain('edaix/assistant-read-v1');
});


describe('new-product default package stays within local development', () => {
  it('allows only the local API and portal, and excludes the previous product runtime', () => {
    const manifest = loadManifest();
    expect(manifest.host_permissions).toEqual(['http://localhost:3000/*']);
    expect(manifest.externally_connectable).toEqual({ matches: ['http://localhost:3100/*'] });
    const worker = readFileSync(join(OUT_DIR, 'chrome-mv3/background.js'), 'utf8');
    expect(worker).not.toContain('https://api.argoland.ai');
    expect(worker).not.toContain('https://api-edaix-test.argoland.ai');
  });
});
