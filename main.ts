// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, standard library only; run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
// Implements unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits, with
// three-tier line matching, all-or-nothing writes, and the exact output/exit rules of SPEC.md.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

interface MoveRec {
  old: string;
  new: string;
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function norm(s: string, tier: number): string {
  if (tier === 1) return stripTrailing(s);
  if (tier === 2) return stripBoth(s);
  return s;
}

/** A file's text split at its own line break, with its final-break flag. */
interface Parts {
  br: string;
  lines: string[];
  final: boolean;
}

function fileParts(text: string): Parts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const pieces = text.split(br);
  const final = text.endsWith(br);
  if (final) pieces.pop();
  return { br, lines: pieces, final };
}

function serializeParts(p: Parts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

/** A file an edit creates (LF, ends with a break when it has any lines). */
function createdText(lines: string[]): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree, moves: MoveRec[]) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** Positions where O matches the file's lines at the given tier (overlaps allowed). */
function occurrences(fileLines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (norm(fileLines[i + j]!, tier) !== norm(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** First tier at which O occurs at least once, with its positions. */
function findTier(fileLines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (const t of tiers(strict)) {
    const occ = occurrences(fileLines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NewItem {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Build the replacement lines for O matched at `pos` in the file's lines. */
function buildNew(items: NewItem[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (o.length === 0) return items.map((x) => x.text);
  const f = leadingWs(fileLines[pos]!);
  const p = leadingWs(o[0]!);
  const out: string[] = [];
  for (const x of items) {
    if (x.ctx) {
      out.push(fileLines[pos + x.oIdx]!);
    } else if (tier === 2) {
      const t = x.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(x.text);
    }
  }
  return out;
}

/** Split O/N items out of unified/V4A body items. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNL: boolean;
}

function splitItems(items: BodyItem[]): { o: string[]; nItems: NewItem[] } {
  const o: string[] = [];
  const nItems: NewItem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      nItems.push({ text: it.text, ctx: true, oIdx: o.length });
      o.push(it.text);
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else {
      nItems.push({ text: it.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, nItems };
}

/* ------------------------------------------------------------------ JSON (§9) */

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const parts = fileParts(before);
      if (line < 0 || line > parts.lines.length) throw new Fail('no-match', p);
      const lines = [...parts.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, serializeParts({ br: parts.br, lines, final: parts.final }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------- Unified (§6) */

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface Section {
  old: string | null;
  new: string | null;
  hasPair: boolean;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { old: m[1]!, new: m[2]!, hasPair: false, createFlag: false, deleteFlag: false, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i += 1;
      const raw: string[] = [];
      while (i < n) {
        const l = lines[i]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          raw.push(l);
          i += 1;
          continue;
        }
        break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const items: BodyItem[] = [];
      for (const r of raw) {
        if (r.startsWith('\\')) {
          if (items.length > 0) items[items.length - 1]!.noNL = true;
          continue;
        }
        if (r === '') items.push({ kind: 'ctx', text: '', noNL: false });
        else if (r[0] === ' ') items.push({ kind: 'ctx', text: r.slice(1), noNL: false });
        else if (r[0] === '-') items.push({ kind: 'old', text: r.slice(1), noNL: false });
        else items.push({ kind: 'new', text: r.slice(1), noNL: false });
      }
      cur.hunks.push({ a, items });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // In a section header.
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.old = headerPath(line);
          cur.new = headerPath(lines[i + 1]!);
          cur.hasPair = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        // rename names the paths only when no ---/+++ pair does.
        if (!cur.hasPair) cur.old = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!cur.hasPair) cur.new = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.createFlag = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deleteFlag = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = { old: headerPath(line), new: headerPath(lines[i + 1]!), hasPair: true, createFlag: false, deleteFlag: false, hunks: [] };
      sections.push(cur);
      i += 2;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');

  const applyHunks = (text: string, hunks: Hunk[], path: string): string => {
    const start = fileParts(text);
    let curLines = [...start.lines];
    let final = start.final;
    let d = 0;
    for (const h of hunks) {
      const { o, nItems } = splitItems(h.items);
      let lastCtxNewNoNL = false;
      for (let k = h.items.length - 1; k >= 0; k -= 1) {
        const it = h.items[k]!;
        if (it.kind === 'ctx' || it.kind === 'new') {
          lastCtxNewNoNL = it.noNL;
          break;
        }
      }
      if (o.length === 0) {
        const pos = Math.min(h.a + d, curLines.length);
        const atEnd = pos === curLines.length;
        const ins = buildNew(nItems, o, curLines, pos, 0);
        curLines = [...curLines.slice(0, pos), ...ins, ...curLines.slice(pos)];
        if (atEnd && ins.length > 0) final = !lastCtxNewNoNL;
        d += ins.length;
      } else {
        const found = findTier(curLines, o, strict);
        if (found === null) throw new Fail('no-match', path);
        const target = h.a - 1 + d;
        let best = found.occ[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.occ) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const atEnd = best + o.length === curLines.length;
        const rep = buildNew(nItems, o, curLines, best, found.tier);
        curLines = [...curLines.slice(0, best), ...rep, ...curLines.slice(best + o.length)];
        if (atEnd) final = !lastCtxNewNoNL;
        d += rep.length - o.length;
      }
    }
    return serializeParts({ br: start.br, lines: curLines, final });
  };

  return sections.map((sec) => {
    const oldP = sec.old;
    const newP = sec.new;
    const hunks = sec.hunks;
    const createFlag = sec.createFlag;
    const deleteFlag = sec.deleteFlag;
    return (tree: Tree, moves: MoveRec[]) => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      const isCreate = oldP === null || createFlag;
      const isDelete = newP === null || deleteFlag;
      if (isCreate) {
        const np = newP!;
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        let lastNoNL = false;
        for (const h of hunks) {
          for (const it of h.items) {
            if (it.kind === 'new') {
              plus.push(it.text);
              lastNoNL = it.noNL;
            }
          }
        }
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (lastNoNL ? '' : '\n'));
        return;
      }
      if (isDelete) {
        const op = oldP!;
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      if (oldP !== newP) {
        const op = oldP!;
        const np = newP!;
        const before = tree.get(op);
        if (before === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const out = applyHunks(before, hunks, op);
        tree.now.set(np, out);
        tree.now.set(op, null);
        moves.push({ old: op, new: np });
        return;
      }
      const p = oldP!;
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(before, hunks, p));
    };
  });
}

/* ------------------------------------------------------- SEARCH/REPLACE (§7) */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const s = i;
      let path: string | null = null;
      for (let j = s - 1; j > prevReplace; j -= 1) {
        const l = lines[j]!;
        if (!blank(l) && !l.trim().startsWith('```')) {
          path = l.trim();
          break;
        }
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new Exit2(`error: parse ${s + 1}`);
      }
      let eq = -1;
      for (let k = s + 1; k < n; k += 1) {
        if (lines[k]!.trimEnd() === '=======') {
          eq = k;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
      let rep = -1;
      for (let k = eq + 1; k < n; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
      blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevReplace = rep;
      prevPath = path;
      i = rep + 1;
      continue;
    }
    i += 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    const path = b.path;
    const oldLines = b.oldLines;
    const newLines = b.newLines;
    return (tree: Tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, createdText(newLines));
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const parts = fileParts(before);
      const found = findTier(parts.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.occ.length !== 1) throw new Fail('ambiguous', path);
      const pos = found.occ[0]!;
      const nItems: NewItem[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
      const rep = buildNew(nItems, oldLines, parts.lines, pos, found.tier);
      const curLines = [...parts.lines.slice(0, pos), ...rep, ...parts.lines.slice(pos + oldLines.length)];
      tree.now.set(path, serializeParts({ br: parts.br, lines: curLines, final: parts.final }));
    };
  });
}

/* ------------------------------------------------------------------- V4A (§8) */

interface Chunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: Chunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const prefixes: Array<{ prefix: string; kind: 'add' | 'delete' | 'update' }> = [
    { prefix: '*** Add File: ', kind: 'add' },
    { prefix: '*** Delete File: ', kind: 'delete' },
    { prefix: '*** Update File: ', kind: 'update' },
  ];
  const isSectionStart = (l: string): boolean => prefixes.some((x) => l.startsWith(x.prefix));
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const hit = prefixes.find((x) => lines[i]!.startsWith(x.prefix));
    if (hit === undefined) throw new Exit2(`error: parse ${i + 1}`);
    const sectionLine = i;
    const path = lines[i]!.slice(hit.prefix.length).trim();
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) j += 1;
    const raw: string[] = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const lineNo = (idx: number): number => sectionLine + 2 + idx;
    if (hit.kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${lineNo(k)}`);
      }
      sections.push({ kind: 'add', path, lines: fileLines, moveTo: null, chunks: [] });
    } else if (hit.kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${lineNo(0)}`);
      sections.push({ kind: 'delete', path, lines: [], moveTo: null, chunks: [] });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: Chunk[] = [];
      while (idx < raw.length) {
        let anchor: string | null = null;
        let eof = false;
        const l = raw[idx]!;
        if (l.startsWith('@@')) {
          const a = l.slice(2).trim();
          anchor = a === '' ? null : a;
          idx += 1;
        } else if (l === '*** End of File') {
          eof = true;
          idx += 1;
          chunks.push({ anchor: null, items: [], eof: true });
          continue;
        } else if (chunks.length === 0 && (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+')) {
          // First chunk starting at a body line: no anchor.
        } else {
          throw new Exit2(`error: parse ${lineNo(idx)}`);
        }
        const items: BodyItem[] = [];
        while (idx < raw.length) {
          const b = raw[idx]!;
          if (b.startsWith('@@')) break;
          if (b === '*** End of File') {
            eof = true;
            idx += 1;
            break;
          }
          if (b === '') items.push({ kind: 'ctx', text: '', noNL: false });
          else if (b[0] === ' ') items.push({ kind: 'ctx', text: b.slice(1), noNL: false });
          else if (b[0] === '-') items.push({ kind: 'old', text: b.slice(1), noNL: false });
          else if (b[0] === '+') items.push({ kind: 'new', text: b.slice(1), noNL: false });
          else throw new Exit2(`error: parse ${lineNo(idx)}`);
          idx += 1;
        }
        chunks.push({ anchor, items, eof });
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine + 1}`);
      sections.push({ kind: 'update', path, lines: [], moveTo, chunks });
    }
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((sec) => {
    const path = sec.path;
    const moveTo = sec.moveTo;
    const chunks = sec.chunks;
    const fileLines = sec.lines;
    const kind = sec.kind;
    return (tree: Tree, moves: MoveRec[]) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (kind === 'add') {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, createdText(fileLines));
        return;
      }
      if (kind === 'delete') {
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const parts = fileParts(before);
      let curLines = [...parts.lines];
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          let foundPos: number | null = null;
          for (const t of tiers(strict)) {
            for (let p = cursor; p < curLines.length; p += 1) {
              if (norm(curLines[p]!, t) === norm(ch.anchor!, t)) {
                foundPos = p;
                break;
              }
            }
            if (foundPos !== null) break;
          }
          if (foundPos === null) throw new Fail('no-match', path);
          cursor = foundPos + 1;
        }
        const { o, nItems } = splitItems(ch.items);
        if (ch.eof) {
          if (o.length === 0) {
            const pos = curLines.length;
            const ins = buildNew(nItems, o, curLines, pos, 0);
            curLines = [...curLines, ...ins];
            cursor = pos + ins.length;
          } else {
            let picked: { tier: number; pos: number } | null = null;
            for (const t of tiers(strict)) {
              const occ = occurrences(curLines, o, t).filter((p) => p >= cursor && p + o.length === curLines.length);
              if (occ.length > 0) {
                picked = { tier: t, pos: occ[0]! };
                break;
              }
            }
            if (picked === null) throw new Fail('no-match', path);
            const rep = buildNew(nItems, o, curLines, picked.pos, picked.tier);
            curLines = [...curLines.slice(0, picked.pos), ...rep];
            cursor = picked.pos + rep.length;
          }
        } else if (o.length === 0) {
          const pos = cursor;
          const ins = buildNew(nItems, o, curLines, pos, 0);
          curLines = [...curLines.slice(0, pos), ...ins, ...curLines.slice(pos)];
          cursor = pos + ins.length;
        } else {
          let picked: { tier: number; pos: number } | null = null;
          for (const t of tiers(strict)) {
            const occ = occurrences(curLines, o, t).filter((p) => p >= cursor);
            if (occ.length > 0) {
              picked = { tier: t, pos: occ[0]! };
              break;
            }
          }
          if (picked === null) throw new Fail('no-match', path);
          const rep = buildNew(nItems, o, curLines, picked.pos, picked.tier);
          curLines = [...curLines.slice(0, picked.pos), ...rep, ...curLines.slice(picked.pos + o.length)];
          cursor = picked.pos + rep.length;
        }
      }
      const out = serializeParts({ br: parts.br, lines: curLines, final: parts.final });
      if (moveTo !== null) {
        tree.now.set(moveTo, out);
        tree.now.set(path, null);
        moves.push({ old: path, new: moveTo });
      } else {
        tree.now.set(path, out);
      }
    };
  });
}

/* ------------------------------------------------------------------- Driver */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: MoveRec[] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const finalState = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) rows.push({ key: p, line: `A ${p}` });
    else if (now === null) rows.push({ key: p, line: `D ${p}` });
    else rows.push({ key: p, line: `M ${p}` });
  }
  for (const m of moves) {
    const wasOld = tree.original(m.old);
    const wasNew = tree.original(m.new);
    if (wasOld === null || wasNew !== null) continue;
    if (finalState(m.old) !== null || finalState(m.new) === null) continue;
    const di = rows.findIndex((r) => r.line === `D ${m.old}`);
    const ai = rows.findIndex((r) => r.line === `A ${m.new}`);
    if (di < 0 || ai < 0) continue;
    rows.splice(Math.max(di, ai), 1);
    rows.splice(Math.min(di, ai), 1);
    rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
