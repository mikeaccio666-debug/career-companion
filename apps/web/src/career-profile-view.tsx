import { useEffect, useMemo, useState } from 'react';
import { CAREER_DEGREE_FIELDS, CAREER_ROLE_FAMILIES, parseCareerProfileFacts, type CareerProfileFacts } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { CareerProfileController, type ProfileState } from './career-profile-controller';
import { bindPrivatePageLifecycle } from './private-page-lifecycle';
const degrees = { cs: '计算机科学', ds_statistics: '数据科学／统计', ece_ee: '电子与计算机工程／电气工程', other_stem: '其他 STEM 专业' };
const roles = { swe: '软件工程', mle: '机器学习工程', ds: '数据科学', da: '数据／产品／业务分析', de: '数据工程', hw: '硬件工程', other: '其他方向' };
interface Editor {
    revision: number;
    facts: CareerProfileFacts;
}
export function CareerProfilePanel() {
    const client = useRequiredPlatformAccountClient(), [observed, setObserved] = useState<{
        client: typeof client;
        state: ProfileState;
    } | null>(null), [editor, setEditor] = useState<Editor | null>(null), [deleting, setDeleting] = useState<number | null>(null), [inputError, setInputError] = useState('');
    const controller = useMemo(() => new CareerProfileController(client, state => setObserved({ client, state })), [client]);
    useEffect(() => { setEditor(null); setDeleting(null); setInputError(''); const bound = bindPrivatePageLifecycle(controller, window, document, () => navigator.onLine); return () => bound.dispose(); }, [controller]);
    const state = observed?.client === client ? observed.state : null;
    useEffect(() => { if (state?.settled || state?.suspended || !client.isCurrent()) {
        setEditor(null);
        setDeleting(null);
        setInputError('');
    } }, [state?.settled, state?.suspended, client, state?.data]);
    if (!client.isCurrent() || state?.suspended)
        return null;
    return <CareerProfileScene state={state} editor={editor} setEditor={setEditor} deleting={deleting} setDeleting={setDeleting} inputError={inputError} setInputError={setInputError} controller={controller}/>;
}
export function CareerProfileScene({ state, editor, setEditor, deleting, setDeleting, inputError, setInputError, controller }: {
    state: ProfileState | null;
    editor: Editor | null;
    setEditor: (v: Editor | null) => void;
    deleting: number | null;
    setDeleting: (v: number | null) => void;
    inputError: string;
    setInputError: (v: string) => void;
    controller: Pick<CareerProfileController, 'refresh' | 'begin' | 'observe' | 'retry'>;
}) {
    const data = state?.data, p = data?.profile, locked = !data || !!state?.busy || !!state?.pending;
    function edit() { if (!data)
        return; setDeleting(null); setEditor({ revision: data.revision, facts: p ? { degreeField: p.degreeField, graduationMonth: p.graduationMonth, graduated: p.graduated, targetTracks: [...p.targetTracks] } : { degreeField: null, graduationMonth: null, graduated: null, targetTracks: [] } }); setInputError(''); }
    function save() { if (!editor || locked)
        return; try {
        const facts = parseCareerProfileFacts(editor.facts);
        controller.begin('save', { operationId: crypto.randomUUID(), expectedRevision: editor.revision, facts, confirmed: true });
        setInputError('');
    }
    catch {
        setInputError('请核对毕业年月和选择；不确定的内容可以留空。');
    } }
    return <section className="identity-panel career-profile-panel" aria-labelledby="career-profile-title"><header><p className="identity-eyebrow">关于你的求职方向</p><h1 id="career-profile-title">职业档案</h1><p>让主理人和队伍从你确认的信息出发。不确定的内容可以先留空。</p></header>
 <div className="identity-actions">{data && <button type="button" disabled={locked} onClick={edit}>{p ? '修改档案' : '填写职业档案'}</button>}<button type="button" disabled={state?.busy} onClick={() => void controller.refresh()}>重新读取</button></div>
 {state?.busy && <p role="status">正在读取或确认…</p>}{(inputError || state?.error) && <p role="alert" className="identity-notice">{inputError || state?.error}</p>}{state?.notice && <p role="status">{state.notice}</p>}
 {state?.pending && !state.busy && <div className="identity-actions"><button type="button" onClick={() => void controller.observe()}>核对这次操作</button><button type="button" onClick={() => void controller.retry()}>用原操作重试</button></div>}
 {data && !p && !editor && <p>还没有保存职业档案。</p>}
 {p && !editor && <><dl><dt>专业方向</dt><dd>{p.degreeField ? degrees[p.degreeField] : '未填写'}</dd><dt>毕业年月</dt><dd>{p.graduationMonth ?? '未填写'}</dd><dt>是否已毕业</dt><dd>{p.graduated === null ? '未填写' : p.graduated ? '已毕业' : '还未毕业'}</dd><dt>想了解的岗位方向</dt><dd>{p.targetTracks.map(t => roles[t]).join('、') || '还没确定'}</dd></dl><p><small>你确认的 · {p.confirmedAt.slice(0, 10)}</small></p><button type="button" disabled={locked} onClick={() => setDeleting(data!.revision)}>删除职业档案</button></>}
 {editor && <form className="identity-editor" onSubmit={e => { e.preventDefault(); save(); }}><label>专业方向<select disabled={locked} value={editor.facts.degreeField ?? ''} onChange={e => setEditor({ ...editor, facts: { ...editor.facts, degreeField: (e.target.value || null) as CareerProfileFacts['degreeField'] } })}><option value="">暂不填写</option>{CAREER_DEGREE_FIELDS.map(v => <option key={v} value={v}>{degrees[v]}</option>)}</select></label>
 <label>预计或实际毕业年月<input type="month" min="1900-01" max="2199-12" value={editor.facts.graduationMonth ?? ''} disabled={locked} onChange={e => setEditor({ ...editor, facts: { ...editor.facts, graduationMonth: e.target.value || null } })}/></label>
 <label>是否已经毕业<select disabled={locked} value={editor.facts.graduated === null ? '' : String(editor.facts.graduated)} onChange={e => setEditor({ ...editor, facts: { ...editor.facts, graduated: e.target.value === '' ? null : e.target.value === 'true' } })}><option value="">暂不填写</option><option value="false">还未毕业</option><option value="true">已毕业</option></select></label>
 <fieldset disabled={locked}><legend>想了解的岗位方向，可以多选</legend>{CAREER_ROLE_FAMILIES.map(v => <label key={v} className="profile-track-choice"><input type="checkbox" checked={editor.facts.targetTracks.includes(v)} onChange={e => setEditor({ ...editor, facts: { ...editor.facts, targetTracks: e.target.checked ? [...editor.facts.targetTracks, v] : editor.facts.targetTracks.filter(t => t !== v) } })}/>{roles[v]}</label>)}</fieldset>
 <p>这里只记录兴趣方向；以后可以再选主攻方向。</p>
 {data && editor.revision !== data.revision && <p role="status">档案已在别处更新。<button type="button" disabled={locked} onClick={edit}>用最新档案重新填写</button></p>}
 <div className="identity-actions"><button type="submit" disabled={locked}>确认这些信息并保存</button><button type="button" disabled={locked} onClick={() => { setEditor(null); setInputError(''); }}>取消</button></div></form>}
 {deleting !== null && <section aria-label="确认删除职业档案"><p>删除这份档案后，队伍不再使用其中的信息。其他求职记录会保留。</p><div className="identity-actions"><button type="button" disabled={locked} onClick={() => controller.begin('delete', { operationId: crypto.randomUUID(), expectedRevision: deleting })}>确认删除档案</button><button type="button" disabled={locked} onClick={() => setDeleting(null)}>保留档案</button></div></section>}
 </section>;
}
