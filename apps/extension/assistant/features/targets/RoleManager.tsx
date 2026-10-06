import { ROLE_SALARY_CURRENCIES, ROLE_SALARY_PERIODS, ROLE_WORK_MODES } from '@edaix/contracts';
import type { AssistantController } from '../../app/controller';
import type { MessageKey } from '../../i18n';
import { roleDraft, type RoleDraft } from './controller';
import '../profile/editor.css';

const labels: Record<keyof RoleDraft, MessageKey> = { location: '工作地点', workMode: '工作方式', min: '最低薪资', max: '最高薪资', currency: '币种', period: '薪资周期', availableFrom: '可开始日期' };
const options: Record<string, MessageKey> = { REMOTE: '远程', HYBRID: '混合办公', ONSITE: '现场办公', YEAR: '每年', MONTH: '每月', HOUR: '每小时' };
export function RoleManager({ controller }: { controller: AssistantController }) {
  const { state, t } = controller.ctx, manager = state.roleManager;
  const editor = manager?.editor, creating = manager?.create;
  const busy = !!manager?.loading || editor?.phase === 'saving' || !!editor?.reading || creating?.phase === 'saving';
  const editable = editor?.phase === 'editing' || creating?.phase === 'editing';
  const code = editor?.code ?? creating?.code ?? manager?.code;
  const valueLabel = (value: string) => options[value] ? t(options[value]!) : value;
  const status = code === 'VALIDATION_FAILED' ? t('请检查地点、金额范围、币种、周期和日期。')
    : code === 'REVISION_CONFLICT' || code === 'READBACK_CHANGED' ? t('岗位偏好已有更新，请读取最新内容后比较。')
    : code === 'SAVE_UNCERTAIN' ? t('尚不能确认保存结果。先读取最新内容，再决定下一步。')
    : code === 'NOT_FOUND' ? t('这个目标岗位已不可用，请刷新列表。')
    : t('暂时无法读取或保存岗位，请稍后刷新。');
  function field(key: keyof RoleDraft, choices?: readonly string[]) {
    return <label className="argo-profile-field" key={key}><span>{t(labels[key])}</span>{choices ?
      <select value={editor!.draft[key]} disabled={!editable || busy} onChange={e => controller.roles.edit(key, e.target.value)}><option value="">{t('未选择')}</option>{choices.map(v => <option key={v} value={v}>{valueLabel(v)}</option>)}</select>
      : <input type={key === 'availableFrom' ? 'date' : 'text'} inputMode={key === 'min' || key === 'max' ? 'decimal' : undefined} maxLength={key === 'location' ? 256 : 20} value={editor!.draft[key]} disabled={!editable || busy} onChange={e => controller.roles.edit(key, e.target.value)}/>}</label>;
  }
  const comparison = (draft: RoleDraft) => <dl className="argo-profile-comparison-row">{(Object.keys(labels) as (keyof RoleDraft)[]).map(key => <div key={key}><dt>{t(labels[key])}</dt><dd style={{ marginLeft: 0, overflowWrap: 'anywhere' }}>{draft[key] ? valueLabel(draft[key]) : t('未提供')}</dd></div>)}</dl>;
  return <section data-sheet="1" role="dialog" aria-modal="true" aria-label={t('目标岗位与偏好')} className="argo-profile-editor" style={{ position: 'absolute', inset: '56px 0 0', zIndex: 25, background: 'var(--argo-grey)', borderRadius: '24px 24px 0 0' }}>
    <div className="argo-profile-scroll" data-scroll="1">
      <div className="argo-profile-row-heading"><div className="argo-profile-heading"><small>YOUR TARGETS</small><h2>{t('目标岗位与偏好')}</h2></div><button data-act="sheet-close" aria-label={t('关闭')}>×</button></div>
      <p className="argo-profile-hint">{t('每个岗位分别保存偏好；切换不会改动个人资料。')}</p>
      {code && <p role="alert" className="argo-profile-status">{status}</p>}
      {creating ? <section className="argo-profile-card"><h3>{t('添加目标岗位')}</h3><p className="argo-profile-hint">{t('先创建岗位与地点，再填写工作方式、薪资和可开始日期。')}</p>
        <label className="argo-profile-field"><span>{t('岗位名称')}</span><input value={creating.name} maxLength={120} disabled={!editable || busy} onChange={e => controller.roles.edit('name', e.target.value)}/></label>
        <label className="argo-profile-field"><span>{t('工作地点')}</span><input value={creating.location} maxLength={256} disabled={!editable || busy} onChange={e => controller.roles.edit('location', e.target.value)}/></label>
        {creating.phase === 'review' && <button data-act="role-refresh" disabled={busy}>{t('刷新岗位列表以核对')}</button>}
      </section> : editor ? <section className="argo-profile-card"><h3>{manager?.items.find(r => r.id === editor.base.conversationId)?.targetRole}</h3>
        <div className="argo-profile-fields">{field('location')}{field('workMode', ROLE_WORK_MODES)}{field('min')}{field('max')}{field('currency', ROLE_SALARY_CURRENCIES)}{field('period', ROLE_SALARY_PERIODS)}{field('availableFrom')}</div>
        <button disabled={!editable || busy} onClick={() => { for (const key of ['min', 'max', 'currency', 'period']) controller.roles.edit(key, ''); }}>{t('清除薪资偏好')}</button>
        <p className="argo-profile-hint">{t('留空表示尚未提供。手动编辑不消耗 AI 额度。')}</p>
        {editor.phase === 'review' && <section><button data-act="role-read-latest" disabled={busy}>{editor.reading ? t('正在读取…') : t('读取最新资料')}</button>
          {editor.latest && <><div className="argo-profile-compare"><details open><summary>{t('我的修改')}</summary>{comparison(editor.draft)}</details><details open><summary>{t('最新保存内容')}</summary>{comparison(roleDraft(editor.latest.preferences))}</details></div><button data-act="role-rebase" disabled={busy}>{t('保留修改，基于最新资料继续编辑')}</button></>}
        </section>}
      </section> : <>
        <div className="argo-profile-row-heading"><button data-act="role-refresh" disabled={busy}>{t('刷新')}</button><button data-act="role-create-new" disabled={busy || !manager?.loaded}>{t('添加目标岗位')}</button></div>
        {manager?.loading && <p role="status">{t('正在读取…')}</p>}
        {manager?.loaded && !manager.items.length && <p>{t('还没有目标岗位。添加一个方向，开始整理偏好。')}</p>}
        {manager?.items.map(role => <article className="argo-profile-card" key={role.id}><h3 style={{ overflowWrap: 'anywhere' }}>{role.targetRole}</h3><p>{role.jobPreferences.preferredLocation || t('尚未填写地点')}</p>
          {role.status === 'ARCHIVED' ? <p>{t('该岗位已归档，请先在 Portal 恢复。')}</p> : <div className="argo-profile-row-heading"><button data-act="role-use" data-arg={role.id} disabled={busy}>{state.currentTargetId === role.id ? t('当前目标') : t('选择此岗位')}</button><button data-act="role-edit" data-arg={role.id} disabled={busy}>{t('编辑偏好')}</button></div>}</article>)}
        {manager?.nextCursor && <button data-act="role-more" disabled={busy}>{t('加载更多岗位')}</button>}
      </>}
    </div>
    {(creating || editor) && <footer className="argo-profile-footer"><button data-act="role-cancel" disabled={busy}>{editor?.latest ? t('使用最新资料并返回') : t('返回岗位列表')}</button><button className="argo-profile-primary" data-act={creating ? 'role-create' : 'role-save'} disabled={!editable || busy}>{busy ? t('正在保存并核对…') : creating ? t('创建目标岗位') : t('保存岗位偏好')}</button></footer>}
  </section>;
}
