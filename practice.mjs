// Dev helper: run the public practice set against this repo's main.ts via runner.ts.
// Usage: node practice.mjs [<family or key prefix>...]
// Prints each FAIL with what differed, then the practice score.
import { readFileSync } from 'node:fs';
import { runCheck } from './runner.ts';

const PRACTICE = '../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json';
const only = process.argv.slice(2);
const { checks } = JSON.parse(readFileSync(new URL(PRACTICE, import.meta.url), 'utf8'));
const picked = only.length === 0 ? checks : checks.filter((c) => only.some((o) => c.family === o || c.key.startsWith(o)));
let passed = 0;
for (const c of picked) {
  const want = { ...c.files };
  for (const [p, v] of Object.entries(c.expect.changes)) {
    if (v === null) delete want[p];
    else want[p] = v;
  }
  const got = runCheck({ id: c.key, argv: c.argv, stdin: c.stdin, files: c.files });
  const why = [];
  if (got.exit !== c.expect.exit) why.push(`exit ${got.exit}, expected ${c.expect.exit}`);
  if (got.stdout !== c.expect.stdout) why.push(`stdout ${JSON.stringify(got.stdout)}, expected ${JSON.stringify(c.expect.stdout)}`);
  for (const p of new Set([...Object.keys(want), ...Object.keys(got.files)])) {
    if (want[p] === undefined) why.push(`${p} should not exist`);
    else if (got.files[p] === undefined) why.push(`${p} is missing`);
    else if (got.files[p] !== want[p]) why.push(`${p} differs: expected ${JSON.stringify(want[p])}, got ${JSON.stringify(got.files[p])}`);
  }
  if (why.length === 0) passed += 1;
  else process.stdout.write(`FAIL ${c.family} ${c.key.slice(0, 12)} argv ${JSON.stringify(c.argv)}\n  ${why.join('\n  ')}\n`);
}
process.stdout.write(`${passed} of ${picked.length} passed${picked.length === checks.length ? `: practice score ${Math.round((1000 * passed) / checks.length)}` : ''}\n`);
