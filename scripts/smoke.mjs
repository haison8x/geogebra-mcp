// End-to-end smoke test: spawns the built server over stdio with a real MCP client and
// exercises every tool against geogebra.org/calculator.
//   npm run build && npm run smoke            (headless)
//   npm run smoke -- --headed                 (watch it draw)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const headed = process.argv.includes('--headed');
const work = mkdtempSync(join(tmpdir(), 'geogebra-mcp-smoke-'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: { ...process.env, GGB_HEADLESS: headed ? '0' : '1', GGB_PROFILE_DIR: join(work, 'profile') },
  stderr: 'inherit',
});
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // plain-text reply
  }
  return { res, text, json };
};

const { tools } = await client.listTools();
check(tools.length === 11, `listTools → ${tools.map((t) => t.name).join(', ')}`);
const { resources } = await client.listResources();
check(resources.some((r) => r.uri === 'geogebra://rules'), 'rules resource listed');
const prompt = await client.getPrompt({ name: 'draw_geometry_problem', arguments: { problem: 'Cho tam giác ABC' } });
check(prompt.messages[0].content.text.includes('Cho tam giác ABC'), 'prompt embeds the problem');

await call('ggb_clear');
let r = await call('ggb_run_commands', {
  commands: [
    'A = (-1, 6)', 'B = (-3, 0)', 'C = (7, 0)',
    'a = Segment(B, C)', 'b = Segment(A, C)', 'c = Segment(A, B)',
    'ShowLabel(a, false)', 'ShowLabel(b, false)', 'ShowLabel(c, false)',
    'H = ClosestPoint(Line(A, C), B)', 'h = Segment(A, H)', 'ShowLabel(h, false)',
    'M = Midpoint(B, C)', 'omega = Circle(A, B, C)', 'O = Center(omega)',
  ],
});
check(r.json?.summary.startsWith('15/15'), `triangle construction: ${r.json?.summary}`);

r = await call('ggb_run_commands', { commands: ['X = Midpoint(A, Q)', 'Y = Foo(A)', 'Z = (1, 2'] , stop_on_error: false });
console.log(JSON.stringify(r.json?.results, null, 1));
check(r.json?.results.every((x) => !x.ok && x.hints?.length), 'failures come with hints');
check(r.json?.results[0].hints.some((h) => h.includes('Q')), 'unknown object Q detected');

r = await call('ggb_run_commands', { commands: ['P = Intersect(omega, Line(A, M))', 'x = (1, 1)'], stop_on_error: false });
console.log(JSON.stringify(r.json?.results, null, 1));
check(r.json?.results[0].warnings?.some((w) => w.includes('several objects')), 'two-point intersect warning');
check(r.json?.results[1].warnings?.some((w) => w.includes('reserved')), 'reserved name warning');
await call('ggb_undo');

// The user says: "H must be the foot of the altitude from A, not from B" → redefine.
r = await call('ggb_get_state', { names: ['H'] });
check(r.json?.objects[0].definition.includes('ClosestPoint'), `state of H: ${JSON.stringify(r.json?.objects[0])}`);
r = await call('ggb_run_commands', { commands: ['H = ClosestPoint(Line(B, C), A)'] });
check(r.json?.results[0].ok && !r.json?.results[0].created, `redefine H keeps dependents: ${JSON.stringify(r.json?.results[0])}`);

r = await call('ggb_evaluate', { expressions: ['Angle(A, H, B)', 'Distance(B, M) == Distance(M, C)', 'AreCollinear(B, H, C)', 'Foo(1)'] });
console.log(JSON.stringify(r.json));
check(r.json?.[0].value?.startsWith('90'), 'altitude is perpendicular');
check(r.json?.[1].value === 'true' && r.json?.[2].value === 'true', 'midpoint + collinear checks true');
check(r.json?.[3].ok === false, 'bad expression reported');

r = await call('ggb_get_state', {});
check(!r.json?.objects.some((o) => o.name.startsWith('mcpTmp')), 'evaluate leaves no temp objects');
const stateA = r.json?.objects.find((o) => o.name === 'A');
check(stateA?.usedBy?.includes('omega'), `A.usedBy = ${stateA?.usedBy}`);

r = await call('ggb_set_style', { names: ['omega', 'nope'], color: '#d32f2f', line_style: 'dashed', caption: '(O)' });
check(r.json?.applied?.includes('omega') && r.json?.missing?.includes('nope'), 'set_style');

r = await call('ggb_fit_view', { padding: 0.1 });
check(!!r.json?.view, `fit_view → ${JSON.stringify(r.json?.view)}`);

r = await call('ggb_screenshot');
const img = r.res.content.find((c) => c.type === 'image');
check(img && img.data.length > 1000, 'screenshot returns an image');
writeFileSync(join(work, 'figure.png'), Buffer.from(img.data, 'base64'));

await call('ggb_snapshot', { action: 'save', name: 'v1' });
r = await call('ggb_delete', { names: ['B'] });
check(r.json?.removed.length > 3, `delete B cascades: ${r.json?.removed}`);
r = await call('ggb_undo');
r = await call('ggb_get_state', { names: ['B', 'omega'] });
check(r.json?.count === 2, 'undo restores deleted objects');
await call('ggb_clear');
r = await call('ggb_snapshot', { action: 'restore', name: 'v1' });
r = await call('ggb_get_state', {});
check(r.json?.objects.some((o) => o.name === 'omega'), 'snapshot restore');

const ggbFile = join(work, 'figure.ggb');
r = await call('ggb_export', { format: 'ggb', path: ggbFile });
check(statSync(ggbFile).size > 1000, `export ggb → ${ggbFile}`);

console.log(`\nScreenshot: ${join(work, 'figure.png')}`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED');
await client.close();
process.exit(failures ? 1 : 0);
