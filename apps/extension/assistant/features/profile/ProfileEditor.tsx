import { useEffect, useRef } from 'react';
import { PROFILE_V2_LINK_KINDS, PROFILE_V2_COLLECTION_LIMITS } from '@edaix/contracts';
import type { AssistantController } from '../../app/controller';
import type { MessageKey } from '../../i18n';
import { createProfileDraft, isCollection, sectionFields, sectionLabels, type EditorField, type EditorRow, type EditorValue, type ProfileDraft } from './editor-model';
import './editor.css';

const statusKeys: Record<string, MessageKey> = {
  NO_CHANGES: '还没有修改。', VALIDATION_FAILED: '请检查必填项、日期顺序、电话和网址格式。', CONFIRM_REQUIRED: '请逐项确认每个地区的工作许可答案。', REFERENCE_IN_USE: '这条资料仍被项目或成果引用。请先修改关联资料，再删除。', REBASE_BLOCKED: '资料已删除或相关记录已移除，无法恢复到最新版本。请保留需要的文字，再放弃草稿重新编辑。', REVISION_CONFLICT: '资料已有更新。请读取最新内容，对照后再继续编辑。', SAVE_UNCERTAIN: '尚不能确认是否保存成功。修改仍在，请读取最新内容后再决定。', READBACK_CHANGED: '保存后的资料又有变化，请读取最新内容并核对。', LOGIN_REQUIRED: '请重新连接账号，草稿会在同一账号恢复。', OWNER_CHANGED: '账号已变化，请重新连接。', LOCKED: '暂未获准保存资料。', UNAVAILABLE: '暂时无法读取最新资料，请重试。', CANCELLED: '操作已取消，修改仍保留。', DISABLED: '资料编辑暂不可用。', SENDER_REJECTED: '连接无法验证，请重新连接。', RESPONSE_MALFORMED: '服务返回的资料无法验证，请重新读取。', TIMEOUT: '请求超时，请重新读取资料。', INVALID_REQUEST: '请检查资料后重试。', TOO_LARGE: '资料内容过长，请缩短后重试。',
};
export function ProfileEditor({ controller }: { controller: AssistantController }) {
  const editor = controller.ctx.state.profileEditor!, draft = editor.draft, t = controller.ctx.t;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [draft.section]);
  const label = (key: string) => t(key as MessageKey);
  const option = (value: string) => label(optionLabels[value] ?? value);
  const busy = editor.phase === 'saving' || !!editor.reading, editable = editor.phase === 'editing';
  const edit = (row: string, key: string, value: EditorValue) => controller.profile.edit(row, key, value);
  function options(spec: EditorField, row: EditorRow, source = draft): { value: string; text: string }[] {
    if (spec.key === 'skillIds') return source.base.profile.skills.map(v => ({ value: v.id, text: v.name }));
    if (spec.key === 'context.itemId') {
      const type = row.values['context.type']; const p = source.base.profile;
      const values = type === 'EXPERIENCE' ? p.experiences.map(v => ({ value: v.id, text: `${v.company} · ${v.title}` })) : type === 'EDUCATION' ? p.educations.map(v => ({ value: v.id, text: v.school })) : type === 'PROJECT' ? p.projects.map(v => ({ value: v.id, text: v.title })) : [];
      return values;
    }
    return (spec.options ?? []).map(value => ({ value, text: option(value) }));
  }
  function input(spec: EditorField, row: EditorRow) {
    const id = `profile-${row.key}-${spec.key}`, value = row.values[spec.key] ?? '';
    const disabled = !editable || (spec.key === 'endDate' && row.values.isCurrent === 'true') || (spec.key === 'expectedGraduationDate' && row.values.isCurrent !== 'true') || (spec.key === 'context.itemId' && row.values['context.type'] === 'STANDALONE');
    return <label className={`argo-profile-field ${spec.kind === 'long' || spec.kind === 'multi' ? 'argo-profile-full' : ''}`} key={spec.key} htmlFor={id}>
      <span>{label(spec.label)}{spec.required && ' *'}</span>
      {spec.kind === 'multi' ? <fieldset id={id} disabled={disabled} aria-label={label(spec.label)}>{options(spec, row).map(v => <label className="argo-profile-choice" key={v.value}><input type="checkbox" checked={Array.isArray(value) && value.includes(v.value)} onChange={e => edit(row.key, spec.key, e.target.checked ? [...(Array.isArray(value) ? value : []), v.value].sort() : (Array.isArray(value) ? value : []).filter(x => x !== v.value))}/>{v.text}</label>)}{!options(spec, row).length && <small>{t('请先保存相关资料，再选择关联。')}</small>}</fieldset>
      : spec.kind === 'select' ? <select id={id} value={String(value)} disabled={disabled} onChange={e => edit(row.key, spec.key, e.target.value)}><option value="">{t('未选择')}</option>{options(spec, row).map(v => <option key={v.value} value={v.value}>{v.text}</option>)}</select>
      : spec.kind === 'long' ? <textarea id={id} rows={5} value={String(value)} disabled={disabled} onChange={e => edit(row.key, spec.key, e.target.value)}/>
      : <input id={id} type={spec.kind === 'date' ? 'date' : spec.kind === 'number' ? 'number' : 'text'} min={spec.kind === 'number' ? 0 : undefined} max={spec.kind === 'number' ? 365 : undefined} value={String(value)} disabled={disabled} placeholder={spec.kind === 'part' ? 'YYYY / YYYY-MM' : spec.key === 'regionCode' || spec.key === 'address.countryCode' ? 'US / CA / CN' : spec.key === 'contact.phone.countryCode' ? '+1' : spec.key === 'contact.phone.e164' ? '+14155550123' : undefined} onChange={e => edit(row.key, spec.key, e.target.value)}/>}</label>;
  }
  const comparison = (source: ProfileDraft) => source.rows.map((row, index) => <div key={row.key} className="argo-profile-comparison-row"><b>{index + 1}</b>{sectionFields[source.section].map(spec => {
    const raw = row.values[spec.key]; const values = Array.isArray(raw) ? raw : [raw];
    const shown = values.filter(Boolean).map(v => options(spec, row, source).find(x => x.value === v)?.text ?? v).join(' · ');
    return <p key={spec.key}><span>{label(spec.label)}</span><span>{shown || t('未提供')}</span></p>;
  })}</div>);
  return <section data-scene="profile" className="argo-profile-editor">
    <div data-scroll="1" className="argo-profile-scroll">
      <div className="argo-profile-heading"><small>YOUR PROFILE</small><h2 ref={heading} tabIndex={-1}>{t('修改资料')} · {label(sectionLabels[draft.section])}</h2><p>{t('只保存这一组的修改。手动编辑不消耗 AI 额度。')}</p></div>
      {editor.code && <div role="alert" className="argo-profile-status">{t(statusKeys[editor.code] ?? '暂时无法完成此操作，请重试。')}</div>}
      {draft.section === 'educations' && <p className="argo-profile-hint">{t('在读时请填写预计毕业年月；已毕业请选择否并填写结束年月。只知道年份也可以。')}</p>}
      {draft.section === 'workAuthorizations' && <p className="argo-profile-hint">{t('请按地区本人作答；不会推断工作许可或签证答案。已撤销或到期的答案需要重新核对。保存确认的答案不会自动填写到所有网站。')}</p>}
      {draft.rows.map((row, index) => <section key={row.key} className="argo-profile-card">
        {isCollection(draft.section) && <div className="argo-profile-row-heading"><b>{label(sectionLabels[draft.section])} {index + 1}</b><button type="button" data-act="profile-remove" data-arg={row.key} disabled={!editable}>{t('删除此条')}</button></div>}
        <div className="argo-profile-fields">{sectionFields[draft.section].map(spec => input(spec, row))}</div>
        {draft.section === 'workAuthorizations' && draft.base.profile.workAuthorizations.find(v => v.regionCode === row.key)?.revokedAt && <p className="argo-profile-hint">{t('已撤销')}</p>}
        {draft.section === 'workAuthorizations' && draft.base.profile.workAuthorizations.find(v => v.regionCode === row.key)?.expiresAt && <p className="argo-profile-hint">{t('有效期至：{v0}', { v0: draft.base.profile.workAuthorizations.find(v => v.regionCode === row.key)!.expiresAt! })}</p>}
        {draft.section === 'workAuthorizations' && <label className="argo-profile-choice argo-profile-confirm"><input type="checkbox" checked={row.confirmed === true} disabled={!editable} onChange={e => edit(row.key, '$confirmed', String(e.target.checked))}/>{t('本人确认本地区以上答案')}</label>}
      </section>)}
      {isCollection(draft.section) && <button className="argo-profile-add" data-act="profile-add" disabled={!editable || draft.rows.length >= PROFILE_V2_COLLECTION_LIMITS[draft.section]}>{t('添加一条')}</button>}
      {draft.section === 'links' && <section className="argo-profile-card"><b>{t('常用链接')}</b><p className="argo-profile-hint">{t('新资料保存后可设为常用或关联到其他资料。')}</p>{PROFILE_V2_LINK_KINDS.map(kind => <label className="argo-profile-field" key={kind}><span>{option(kind)}</span><select value={String(draft.extras[kind] ?? '')} disabled={!editable} onChange={e => edit('extras', kind, e.target.value)}><option value="">{t('未选择')}</option>{draft.rows.filter(row => row.id && row.values.kind === kind).map(row => <option key={row.key} value={row.id}>{row.values.label || row.values.url}</option>)}</select></label>)}</section>}
      {draft.section === 'experiences' && <section className="argo-profile-card"><label className="argo-profile-field"><span>{t('暂无工作经历')}</span><select value={String(draft.extras.noExperience)} disabled={!editable} onChange={e => edit('extras', 'noExperience', e.target.value)}><option value="">{t('未选择')}</option><option value="true">{t('是')}</option><option value="false">{t('否')}</option></select></label><label className="argo-profile-field"><span>{t('主要当前经历')}</span><select value={String(draft.extras.primaryCurrentExperienceId)} disabled={!editable} onChange={e => edit('extras', 'primaryCurrentExperienceId', e.target.value)}><option value="">{t('未选择')}</option>{draft.rows.filter(row => row.id && row.values.isCurrent === 'true').map(row => <option key={row.key} value={row.id}>{row.values.company} · {row.values.title}</option>)}</select></label><p className="argo-profile-hint">{t('新资料保存后可设为常用或关联到其他资料。')}</p></section>}
      {editor.phase === 'review' && <section className="argo-profile-card"><button data-act="profile-read-latest" disabled={busy}>{editor.reading ? t('正在读取…') : t('读取最新资料')}</button>{editor.latest && <><p>{t('请对照两份内容。继续编辑会保留你的修改以及服务器上未被你修改的字段，之后仍需点击保存。')}</p><div className="argo-profile-compare"><details open><summary>{t('我的修改')}</summary>{comparison(draft)}</details><details open><summary>{t('最新保存内容')}</summary>{comparison(createProfileDraft(editor.latest, draft.section))}</details></div><button data-act="profile-rebase" disabled={busy}>{t('保留修改，基于最新资料继续编辑')}</button></>}</section>}
    </div>
    <footer className="argo-profile-footer"><button data-act="profile-discard" disabled={busy}>{editor.latest ? t('使用最新资料并返回') : t('放弃修改并返回')}</button><button className="argo-profile-primary" data-act="profile-save" disabled={!editable}>{editor.phase === 'saving' ? t('正在保存并核对…') : t('保存这组资料')}</button></footer>
  </section>;
}
const optionLabels: Record<string, MessageKey> = { true: '是', false: '否', YES: '是', NO: '否', UNSPECIFIED: '未提供', MOBILE: '手机', HOME: '家庭', WORK: '工作', OTHER: '其他', LINKEDIN: 'LinkedIn', GITHUB: 'GitHub', PORTFOLIO: '作品集', WEBSITE: '个人网站', TWITTER: 'Twitter / X', FULL_TIME: '全职', PART_TIME: '兼职', INTERNSHIP: '实习', CONTRACT: '合同工作', FREELANCE: '自由职业', VOLUNTEER: '志愿工作', HIGH_SCHOOL: '高中', ASSOCIATE: '副学士', BACHELOR: '学士', MASTER: '硕士', MBA: '工商管理硕士', JD: '法学博士', MD: '医学博士', PHD: '博士', TECHNICAL: '技术技能', TOOL: '工具', SOFT: '软技能', NATIVE_OR_BILINGUAL: '母语', PROFESSIONAL: '专业工作水平', CONVERSATIONAL: '日常交流', BASIC: '基础', IMPACT: '业务成果', LEADERSHIP: '领导力', AWARD: '奖项', CERTIFICATION: '证书', PUBLICATION: '出版物', EXPERIENCE: '工作经历', PROJECT: '项目', EDUCATION: '教育', STANDALONE: '独立成果' };
