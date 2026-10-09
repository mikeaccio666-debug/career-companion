import { DAILY_PREFERENCE_DEFAULTS, type DailyPreferences } from '@companion/platform-contracts';
import { useState } from 'react';
export function DailySettingsForm({ preferences, disabled, onSave }: { preferences: Readonly<DailyPreferences> | null; disabled: boolean; onSave: (value: DailyPreferences) => void }) {
  const [draft, setDraft] = useState(() => ({ ...(preferences ?? { ...DAILY_PREFERENCE_DEFAULTS, timeZone: '' }) }));
  const [minutes, setMinutes] = useState(String(draft.dailyMinutes));
  return <form className="daily-settings-form" onSubmit={event => { event.preventDefault(); onSave({ ...draft, dailyMinutes: Number(minutes) }); }}>
    <fieldset disabled={disabled}><legend>按你的当地时间安排</legend>
      <label>时区<input name="timeZone" list="daily-time-zones" autoComplete="off" required maxLength={100} value={draft.timeZone} placeholder="例如 America/New_York" onChange={e => setDraft({ ...draft, timeZone: e.target.value })}/><small>请明确选择时区，夏令时会随所选地区调整。</small></label>
      <datalist id="daily-time-zones">{['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','Pacific/Honolulu','Asia/Shanghai','UTC'].map(zone => <option key={zone} value={zone}/>)}</datalist>
      <div className="daily-settings-grid">
        <label>晨报时间<input type="time" required name="morningTime" value={draft.morningTime} onChange={e => setDraft({ ...draft, morningTime: e.target.value })}/></label>
        <label>每天可投入的分钟数<input type="number" required name="dailyMinutes" min={0} max={1440} step={1} value={minutes} onChange={e => setMinutes(e.target.value)}/><small>可以填 0，给自己留一天休息。</small></label>
        <label>免打扰开始<input type="time" required name="quietStart" value={draft.quietStart} onChange={e => setDraft({ ...draft, quietStart: e.target.value })}/></label>
        <label>免打扰结束<input type="time" required name="quietEnd" value={draft.quietEnd} onChange={e => setDraft({ ...draft, quietEnd: e.target.value })}/></label>
      </div>
      <label>晨报做好后的提醒<select name="webAlert" value={draft.webAlert} onChange={e => setDraft({ ...draft, webAlert: e.target.value as 'none' | 'email' })}><option value="none">不发提醒，我自己来看</option><option value="email">发邮件提醒</option></select><small>邮件只提醒你回来查看，不包含求职内容。</small></label>
    </fieldset>
    {!preferences && <p className="settings-default">时区还未选择。其余是建议值，保存后才会记录。</p>}
    <button type="submit" disabled={disabled}>保存时间偏好</button>
  </form>;
}
