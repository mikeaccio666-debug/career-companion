/**
 * 资料编辑器的三方合并（2026-10-04；2026-10-03 前端体检 3.4）。
 *
 * 保存时撞上「别处刚存过」（412：门户、别的标签页、浮层里当场答的「能不能联系现在的雇主」都会），或者先显示的那一份旧了、
 * 后台读到了新的：手上有三份——读到的那一份（base）、他改过的（mine）、此刻服务器上的（theirs）。逐项合：
 *
 * - 他没改的那一项：用服务器上的；
 * - 他改了、服务器上没动（或改成一样的）：用他的；
 * - 同一项两边都改了、改得不一样：先留他的，记一个冲突，请他选（`useTheirs` 换成服务器上的那一份）。
 *
 * 「一项」：普通的一栏是一项；电话（区号 + 号码）、期望薪资（金额 + 币种 + 周期）各算一项；技能、城市、办公模式、族裔这类
 * 集合按条合（他加的、别处加的都留下，他删的就删掉，不算冲突）；语言按语种合；经历与教育按 id 逐栏合，他新加的接在后面，
 * 一边删了、另一边改过的那一段算冲突。纯函数：不发请求、不碰 DOM。
 */

type Draft = Readonly<Record<string, unknown>>;
type Entry = Readonly<Record<string, unknown>> & { readonly id: string | null };

export interface DraftConflict<T> {
  /** 草稿里的哪一项：一栏的键；电话、薪资是 `phone`、`salary`；语言是 `langs`；经历、教育是 `exp`、`edu`。 */
  readonly key: string;
  /** 经历、教育里的哪一栏；整段（一边删了）的冲突没有这一项。 */
  readonly field?: string;
  /** 经历、教育：哪一段（id 与给人看的名字）。 */
  readonly entry?: Readonly<{ id: string; title: string }>;
  /** 语言：哪一种。 */
  readonly lang?: string;
  /** 他的那一份（删掉了是 null）；电话、薪资是那几栏组成的对象。 */
  readonly mine: unknown;
  /** 服务器上的那一份（删掉了是 null）。 */
  readonly theirs: unknown;
  /** 这一项改用服务器上的那一份。 */
  readonly useTheirs: (draft: T) => T;
}

export interface MergeResult<T> {
  readonly merged: T;
  readonly conflicts: readonly DraftConflict<T>[];
}

/** 一起变的几栏。 */
const UNITS: Readonly<Record<string, readonly string[]>> = {
  phone: ['phoneCc', 'phone'],
  salary: ['salary', 'currency', 'period'],
};
/** 按条合的集合。 */
const SETS: ReadonlySet<string> = new Set(['modes', 'cities', 'skills', 'race']);
/** 按 id 逐栏合的条目。 */
const ENTRIES: ReadonlySet<string> = new Set(['exp', 'edu']);

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** 三方取舍：用服务器上的、用他的，还是冲突。 */
function pick(base: unknown, mine: unknown, theirs: unknown): 'THEIRS' | 'MINE' | 'CONFLICT' {
  if (same(mine, base)) return 'THEIRS';
  if (same(theirs, base) || same(theirs, mine)) return 'MINE';
  return 'CONFLICT';
}

const strings = (value: unknown): readonly string[] =>
  (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const entries = (value: unknown): readonly Entry[] =>
  (Array.isArray(value) ? value.filter((item): item is Entry => item !== null && typeof item === 'object') : []);

/** 语言标签「日本語 · 基础」的语种那半截。 */
const langLabel = (tag: string): string => (tag.split(/\s*[·•|/]\s*/u)[0] ?? tag).trim();
const langKey = (tag: string): string => langLabel(tag).toLocaleLowerCase('en-US');

/** 给人看的那一段叫什么：经历是「职位 · 公司」，教育是学校。 */
function entryTitle(entry: Entry): string {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  if ('school' in entry) return text(entry.school);
  return [text(entry.title), text(entry.company)].filter((part) => part !== '').join(' · ');
}

export function mergeDrafts<T extends object>(base: T, mine: T, theirs: T): MergeResult<T> {
  const b = base as unknown as Draft;
  const m = mine as unknown as Draft;
  const t = theirs as unknown as Draft;
  const out: Record<string, unknown> = { ...t };
  const conflicts: DraftConflict<T>[] = [];
  const handled = new Set<string>();
  const patch = (draft: T, values: Readonly<Record<string, unknown>>): T => ({ ...draft, ...values });

  for (const [unit, members] of Object.entries(UNITS)) {
    if (!members.every((key) => key in m || key in t)) continue;
    for (const key of members) handled.add(key);
    const of = (draft: Draft): Record<string, unknown> => Object.fromEntries(members.map((key) => [key, draft[key]]));
    const verdict = pick(of(b), of(m), of(t));
    if (verdict === 'THEIRS') continue;
    Object.assign(out, of(m));
    if (verdict === 'CONFLICT') {
      const theirsValues = of(t);
      conflicts.push({ key: unit, mine: of(m), theirs: theirsValues, useTheirs: (draft) => patch(draft, theirsValues) });
    }
  }

  const keys = new Set([...Object.keys(b), ...Object.keys(m), ...Object.keys(t)]);
  for (const key of keys) {
    if (handled.has(key)) continue;
    if (SETS.has(key)) {
      out[key] = mergeSet(strings(b[key]), strings(m[key]), strings(t[key]));
    } else if (key === 'langs') {
      out[key] = mergeLangs(strings(b[key]), strings(m[key]), strings(t[key]), conflicts);
    } else if (ENTRIES.has(key)) {
      out[key] = mergeEntries(key, entries(b[key]), entries(m[key]), entries(t[key]), conflicts);
    } else {
      const verdict = pick(b[key], m[key], t[key]);
      if (verdict === 'THEIRS') continue;
      out[key] = m[key];
      if (verdict === 'CONFLICT') {
        const theirsValue = t[key];
        conflicts.push({ key, mine: m[key], theirs: theirsValue, useTheirs: (draft) => patch(draft, { [key]: theirsValue }) });
      }
    }
  }
  return { merged: out as unknown as T, conflicts };
}

/** 集合按条合：服务器上的次序，去掉他删的，接上他加的。 */
function mergeSet(base: readonly string[], mine: readonly string[], theirs: readonly string[]): string[] {
  const removed = new Set(base.filter((item) => !mine.includes(item)));
  const result = theirs.filter((item) => !removed.has(item));
  for (const item of mine) if (!base.includes(item) && !result.includes(item)) result.push(item);
  return result;
}

function mergeLangs<T>(
  base: readonly string[],
  mine: readonly string[],
  theirs: readonly string[],
  conflicts: DraftConflict<T>[],
): string[] {
  const byName = (tags: readonly string[]): Map<string, string> => {
    const map = new Map<string, string>();
    for (const tag of tags) if (!map.has(langKey(tag))) map.set(langKey(tag), tag);
    return map;
  };
  const B = byName(base);
  const M = byName(mine);
  const T = byName(theirs);
  const result: string[] = [];
  const decide = (name: string): void => {
    const b = B.get(name);
    const m = M.get(name);
    const t = T.get(name);
    const verdict = pick(b, m, t);
    const chosen = verdict === 'THEIRS' ? t : m;
    if (chosen !== undefined) result.push(chosen);
    if (verdict !== 'CONFLICT') return;
    conflicts.push({
      key: 'langs',
      lang: langLabel(m ?? t ?? b ?? name),
      mine: m ?? null,
      theirs: t ?? null,
      useTheirs: (draft) => {
        const list = strings((draft as unknown as Draft).langs);
        const at = list.findIndex((tag) => langKey(tag) === name);
        const next = [...list];
        if (at < 0) {
          if (t !== undefined) next.push(t);
        } else if (t === undefined) next.splice(at, 1);
        else next[at] = t;
        return { ...draft, langs: next };
      },
    });
  };
  for (const name of T.keys()) decide(name);
  for (const name of M.keys()) if (!T.has(name)) decide(name);
  return result;
}

function mergeEntries<T>(
  key: string,
  base: readonly Entry[],
  mine: readonly Entry[],
  theirs: readonly Entry[],
  conflicts: DraftConflict<T>[],
): Entry[] {
  const byId = (list: readonly Entry[]): Map<string, Entry> =>
    new Map(list.filter((entry): entry is Entry & { id: string } => typeof entry.id === 'string').map((entry) => [entry.id, entry]));
  const B = byId(base);
  const M = byId(mine);
  const T = byId(theirs);
  const listOf = (draft: T): readonly Entry[] => entries((draft as unknown as Draft)[key]);
  const result: Entry[] = [];

  for (const t of theirs) {
    const id = t.id;
    const b = id === null ? undefined : B.get(id);
    // 别处新加的（或服务器上没 id 的，不该有）：照收。
    if (id === null || b === undefined) { result.push(t); continue; }
    const m = M.get(id);
    if (m === undefined) {
      // 他删了这一段：别处没动它就照删；别处改过就请他选。
      if (same(t, b)) continue;
      conflicts.push({
        key, entry: { id, title: entryTitle(t) }, mine: null, theirs: t,
        useTheirs: (draft) => {
          const list = [...listOf(draft)];
          list.splice(Math.min(theirs.indexOf(t), list.length), 0, t);
          return { ...draft, [key]: list };
        },
      });
      continue;
    }
    const merged: Record<string, unknown> = { ...t };
    for (const field of new Set([...Object.keys(b), ...Object.keys(m), ...Object.keys(t)])) {
      if (field === 'id') continue;
      const verdict = pick(b[field], m[field], t[field]);
      if (verdict === 'THEIRS') continue;
      merged[field] = m[field];
      if (verdict !== 'CONFLICT') continue;
      const theirsValue = t[field];
      conflicts.push({
        key, field, entry: { id, title: entryTitle(t) }, mine: m[field], theirs: theirsValue,
        useTheirs: (draft) => ({ ...draft, [key]: listOf(draft).map((entry) => (entry.id === id ? { ...entry, [field]: theirsValue } : entry)) }),
      });
    }
    result.push(merged as Entry);
  }

  for (const m of mine) {
    const id = m.id;
    if (id === null || T.has(id)) continue;
    const b = B.get(id);
    // 别处删了这一段：他没动它就照删；他改过就先留着他的，请他选。
    if (b !== undefined && same(m, b)) continue;
    result.push(m);
    if (b === undefined) continue;
    conflicts.push({
      key, entry: { id, title: entryTitle(m) }, mine: m, theirs: null,
      useTheirs: (draft) => ({ ...draft, [key]: listOf(draft).filter((entry) => entry.id !== id) }),
    });
  }
  // 他新加的那几段接在后面。
  for (const m of mine) if (m.id === null) result.push(m);
  return result;
}
