/** Frozen Han script ranges from the pinned Node 24.21.0 / Unicode 17 runtime.
 * Migration 066 uses exactly these ranges to backfill existing sources.
 * Keeping the set explicit avoids index/query drift after a runtime upgrade. */
export const KNOWLEDGE_HAN_RANGES: readonly (readonly [number, number])[] = Object.freeze([[11904,11929],[11931,12019],[12032,12245],[12293,12293],[12295,12295],[12321,12329],[12344,12347],[13312,19903],[19968,40959],[63744,64109],[64112,64217],[94178,94179],[94192,94198],[131072,173791],[173824,178205],[178208,183981],[183984,191456],[191472,192093],[194560,195101],[196608,201546],[201552,210041]].map(([a,b]) => Object.freeze([a,b] as const)));
const han = new RegExp('[' + KNOWLEDGE_HAN_RANGES.map(([a,b]) => String.fromCodePoint(a) + (a === b ? '' : '-' + String.fromCodePoint(b))).join('') + ']+', 'gu');
export function knowledgeHanRuns(value: string): string[] { return value.match(han) ?? []; }
/** Overlapping adjacent characters. Boundaries, Latin words, emoji and spaces
 * never get joined. Source repetition is preserved for lexical ranking. */
export function knowledgeHanBigrams(value: string): string[] {
  const terms:string[]=[];
  for(const run of knowledgeHanRuns(value)) {
    const characters=Array.from(run);
    for(let i=0;i+1<characters.length;i++) terms.push(characters[i]+characters[i+1]);
  }
  return terms;
}
export function knowledgeHanSearch(query:string) {
  const terms=[...new Set(knowledgeHanBigrams(query))], runs=knowledgeHanRuns(query);
  const latin=query.replace(han,' ').trim();
  const requiredLiteral=[...latin.split(/\s+/u).filter(Boolean),...runs.filter(run=>Array.from(run).length===1)];
  // Every term contains only two Han characters: no tsquery syntax or user operator.
  return {tsquery:terms.map(term=>"'"+term+"'").join(' | '),latin,requiredLiteral};
}
