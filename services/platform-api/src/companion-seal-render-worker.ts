import { COMPANION_SEAL_PNG_MAX_BYTES, COMPANION_SEAL_SVG_MAX_BYTES,
  inspectCompanionSealPNG, readCompanionSealWorkerSVG } from './companion-seal-rendering.ts';

/** Private one-shot stdin/stdout protocol. No argv settings, SVG resources,
 * names, file/font paths, URLs, shell, model or inherited environment authority.
 * The parent owns the hard deadline and waits for process close after SIGKILL.
 */
async function main() {
  if (process.argv.length !== 2) throw new Error('Invalid worker protocol.');
  const input: Buffer[] = []; let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); length += bytes.length;
    if (length > COMPANION_SEAL_SVG_MAX_BYTES) throw new Error('Invalid worker protocol.');
    input.push(bytes);
  }
  const svg = readCompanionSealWorkerSVG(Buffer.concat(input, length));
  // Load native code only in this killable child, after the entire fixed
  // template/outline protocol has been validated. No image/font resolver runs.
  const { Resvg } = await import('@resvg/resvg-js');
  const image = new Resvg(svg, { font: { loadSystemFonts: false, fontFiles: [], fontDirs: [] },
    fitTo: { mode: 'width', value: 128 }, logLevel: 'off' }).render();
  if (image.width !== 128 || image.height !== 128) throw new Error('Invalid worker output.');
  const png = image.asPng();
  if (png.length > COMPANION_SEAL_PNG_MAX_BYTES) throw new Error('Invalid worker output.');
  inspectCompanionSealPNG(png);
  process.stdout.write(png, error => process.exit(error ? 1 : 0));
}

void main().catch(() => {
  process.stdin.destroy();
  // Fixed bounded text only; parent discards this pipe and never logs it.
  process.stderr.write('COMPANION_SEAL_RENDER_WORKER_FAILED\n', () => process.exit(1));
});
