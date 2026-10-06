import type { ViewContext } from '../app/view-context';
import { C } from '../design/palette';
export function hostView(ctx: ViewContext) {
    const S = ctx.state; const isJob = S.scene === 'autofill'; const id = S.fillId || S.deck.selected[0] || 'northstar'; const j = ctx.job(id); const p = S.profile;
    const val: Record<string, string> = { name: p.name, email: p.email, phone: p.phone, city: p.city, links: 'linkedin.example/mia', resume: ctx.resume().label + '.pdf' };
    const rows = S.run.rows; const fields = ['name', 'email', 'phone', 'city', 'links', 'resume'].map(k => { const r = rows.find(x => x.key === k); const st = r ? r.state : 'pending'; const kept = k === 'links'; const shown = st === 'filled' || kept; return { key: k, label: ({ name: 'Full name', email: 'Email', phone: 'Phone', city: 'Location', links: 'LinkedIn / Portfolio', resume: 'Resume / CV' } as Record<string, string>)[k], value: shown ? val[k] : '', hint: shown ? '' : st === 'active' ? '…' : '', border: st === 'active' ? C.steel : st === 'filled' ? '#BFD5C9' : '#D9E0EA', bg: st === 'filled' ? '#F3FAF6' : st === 'active' ? '#F7FAFD' : '#fff' }; });
    const hl = S.hostHighlight;
    return { submitGlow: hl ? '0 0 0 5px rgba(255,157,77,.35), 0 12px 30px -12px rgba(10,17,40,.5)' : 'none', manualBorder: hl ? '#FF9D4D' : '#D9E0EA', manualGlow: hl ? '0 0 0 4px rgba(255,157,77,.18)' : 'none', isJournal: !isJob, isJob, tabTitle: isJob ? j.company + ' — Careers' : 'The Openfield — Journal', url: isJob ? j.boardUrl : 'theopenfield.example/journal', job: j, fields };
  }
