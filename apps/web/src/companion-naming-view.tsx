import { useId } from 'react';
import type { CompanionPublicInkToken, PublicCompanionSealCandidates } from '@companion/platform-contracts';
import './companion-naming-view.css';

/** Presentation of a server rejection, never local name classification. */
export type CompanionNameIssue =
  | { readonly category: 'family_or_partner' | 'team_or_org' | 'abusive' | 'public_figure' | 'length' }
  | { readonly category: 'same_as_user'; readonly userName?: string };

function nameIssueText(issue: CompanionNameIssue): string {
  switch (issue.category) {
    case 'family_or_partner': return '它会一直陪你找工作，但它不是家人，也不是伴侣。换一个名字吧。';
    case 'team_or_org': return '这个名字容易和队员或真实机构混淆，换一个吧。';
    case 'same_as_user': return issue.userName ? `对话里会有两个『${issue.userName}』，换一个吧。` : '这个名字和你的称呼一样，换一个吧。';
    case 'abusive': return '这个名字不太合适，换一个吧。';
    case 'public_figure': return '它不能扮演真实的人。换一个吧。';
    case 'length': return '名字最多 6 个汉字或 16 个字母。';
  }
}

function EmptySeal() {
  return <span className="companion-naming-seal companion-naming-seal-empty" aria-hidden="true" />;
}

/** Controlled O7 view. It forwards the complete original text to its controller;
 * the server owns classification, name rules, persistence and authority.
 */
export function CompanionNameView({ value, pending = false, available = true, unavailableText, issue, error = '', onChange, onSubmit }: {
  readonly value: string;
  readonly pending?: boolean;
  readonly available?: boolean;
  readonly unavailableText?: string;
  readonly issue?: CompanionNameIssue;
  readonly error?: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
}) {
  const id = useId(), blocked = pending || !available, empty = value.length === 0;
  return <section className="companion-naming" aria-labelledby={`${id}-title`} aria-busy={pending}>
    <header className="companion-naming-heading"><EmptySeal /><div>
      <span className="companion-naming-ai">你的主理人 · AI</span>
      <h2 id={`${id}-title`}>给它起个名字</h2>
    </div></header>
    <p className="companion-naming-intro">它还没有名字。你来起一个——以后你和队伍都这么叫它。</p>
    <form noValidate onSubmit={event => { event.preventDefault(); if (!blocked && !empty) onSubmit(value); }}>
      <label htmlFor={`${id}-name`} className="companion-naming-label">主理人的名字</label>
      <input id={`${id}-name`} name="companion-name" type="text" value={value} readOnly={blocked}
        aria-invalid={!!issue} aria-describedby={`${id}-hint${issue || error ? ` ${id}-error` : ''}`}
        autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        placeholder="一个字、一个词、一个英文名都可以"
        onChange={event => { if (!blocked) onChange(event.target.value); }} />
      <p id={`${id}-hint`} className="companion-naming-hint">1–6 个汉字，或 1–16 个拉丁字符；英文名可以有空格和连字符。</p>
      {(issue || error) && <p id={`${id}-error`} className="companion-naming-notice" role="alert">{issue ? nameIssueText(issue) : error}</p>}
      {!available && <p className="companion-naming-notice" role="status">{unavailableText ?? '服务暂时不可用，可以稍后回来继续。'}</p>}
      <button type="submit" className="companion-naming-primary" aria-disabled={blocked || empty}>
        {pending ? '正在确认这个名字…' : '保存名字'}
      </button>
    </form>
  </section>;
}

/** Controlled O8 view. Candidates and ink come from an authenticated server
 * projection. Selecting or confirming here does not claim a saved choice or birth.
 */
export function CompanionSealView({ name, candidates, inkToken, selectedChar, pending = false, available = true, unavailableText,
  error = '', onChange, onConfirm }: {
  readonly name: string;
  readonly candidates: PublicCompanionSealCandidates;
  readonly inkToken: CompanionPublicInkToken;
  readonly selectedChar: string | null;
  readonly pending?: boolean;
  readonly available?: boolean;
  readonly unavailableText?: string;
  readonly error?: string;
  readonly onChange: (char: string) => void;
  readonly onConfirm: (char: string) => void;
}) {
  const id = useId(), blocked = pending || !available;
  const choice = candidates.find(candidate => candidate.char === selectedChar);
  return <section className="companion-naming" aria-labelledby={`${id}-title`} aria-busy={pending}>
    <header className="companion-naming-heading"><EmptySeal /><div>
      <span className="companion-naming-ai">你的主理人 · AI</span>
      <h2 id={`${id}-title`}>它需要一枚印章。选一个字：</h2>
    </div></header>
    <p className="companion-naming-intro">你起的名字：<strong>{name}</strong></p>
    <form noValidate onSubmit={event => { event.preventDefault(); if (!blocked && choice) onConfirm(choice.char); }}>
      <fieldset className="companion-naming-candidates" aria-describedby={`${id}-hint`}>
        <legend className="companion-naming-label">印章字</legend>
        <div className="companion-naming-options">
          {candidates.map(candidate => <label className="companion-naming-option" key={candidate.char}>
            <input type="radio" name={`${id}-seal`} value={candidate.char} checked={choice?.char === candidate.char}
              aria-disabled={blocked} onChange={event => { if (!blocked && event.target.checked) onChange(candidate.char); }} />
            <span className="companion-naming-seal" data-ink={inkToken} aria-hidden="true"><span>{candidate.char}</span></span>
            <span className="companion-naming-option-copy"><strong>{candidate.char}</strong><span>{candidate.reason}</span></span>
          </label>)}
        </div>
      </fieldset>
      <p id={`${id}-hint`} className="companion-naming-hint">选定一个字后，再确认。墨色来自它的性格。</p>
      {error && <p className="companion-naming-notice" role="alert">{error}</p>}
      {!available && <p className="companion-naming-notice" role="status">{unavailableText ?? '服务暂时不可用，可以稍后回来继续。'}</p>}
      <button type="submit" className="companion-naming-primary" aria-disabled={blocked || !choice}>
        {pending ? '正在确认这个字…' : '确认这个字'}
      </button>
    </form>
  </section>;
}
