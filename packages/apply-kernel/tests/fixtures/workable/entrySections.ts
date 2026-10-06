/**
 * Workable 申请表里「经历」「教育」两个区的**结构骨架**与宿主行为的最小模拟。结构按 2026-09-24 在
 * apply.workable.com/skroutz/j/DB1A13AC0A/apply/ 与 usa-vein-clinics/j/64BAE2D35A/apply/ 上只读抽出的
 * DOM 手写：只有标签文字、data-ui、id、name、type、role、ARIA 属性与占位符，**没有任何账号数据**，
 * 所有输入框都是空的；构建哈希类名、图标 SVG 一律去掉。
 *
 * 几处实测形状（夹具必须照着长，否则测到的是别的东西）：
 *
 *  · 区是 `div[data-ui="experience"]` / `div[data-ui="education"]`：头部一个 `<p>`（「Experience (Optional)」）
 *    加一颗 `button[data-ui="add-section"][type=button]`「+ Add」。区里**一开始没有 `<ul>`**，第一次加一段才长出来。
 *  · 点「+ Add」：`ul` 的**最前面**多一个 `li`，里面是 `div[data-ui="editor"]`；这个区的「+ Add」随即
 *    `disabled` + `aria-disabled="true"`（一个区同时只开一个编辑框）；另一个区的「+ Add」不受影响。
 *  · 编辑框里：经历是 Title（`required`，标签前一个 `*`）、Company／Industry／Summary（Optional）、Start／End
 *    date（`placeholder="MM/YYYY"`、`inputmode="tel"`，Optional）、「I currently work here」（`div[role=checkbox]`
 *    包着一个隐藏的原生 checkbox）；教育是 School（`required`）、Field of study／Degree（Optional）、起止日期。
 *    最后一格里两颗按钮：`button[data-ui="save-section"][type=button]`「Update」与
 *    `button[data-ui="cancel-section"][type=button]`「Cancel」。
 *  · 按「Update」（实测：合成的 mousedown/mouseup/click，click 预先取消默认动作，照样收）：100 毫秒以内整个 `li`
 *    **换成一个新的** `li`，里面是 `div[data-ui="group"]` 卡片（`dl > dt Title / dd[data-ui=title]`）和一颗
 *    `button[data-ui="section-actions"]`（选项菜单）；编辑框与 Update 从页面上消失，「+ Add」恢复可用。
 *    表单没有 submit 事件、页面没有发任何请求——这一段只进了网站自己的表单状态（它按岗位存在 localStorage）。
 *  · 再加一段：新编辑框又插在**最前面**，已保存的卡片往后挪。
 *
 * 模拟只做到这些：必填的格空着就不收（编辑框留着、加一句「This is a required field.」），
 * 以及测试点名要的两种坏宿主（不收、在保存里顺手提交整张表）。
 */

export type WorkableSection = 'experience' | 'education';

export interface WorkableEntryHostOptions {
  /** 点「+ Add」之后多久画出编辑框；不给就同步插入（单测里好断言）。线上实测是几百毫秒。 */
  readonly addDelayMs?: number;
  /** 按「Update」宿主一概不收：编辑框留着、标红——模拟网站自己的校验不过。 */
  readonly refuseSave?: boolean;
  /** 宿主的「Update」监听器里顺手提交整张表（出错或不怀好意的宿主）。 */
  readonly submitOnSave?: boolean;
  /** 编辑框里的格换了名字、也不标必填（规则认不出任何一格的宿主变体）：什么都填不进去，也就不该按保存。 */
  readonly unmappedCells?: boolean;
}

export interface MountedWorkableEntries {
  readonly form: HTMLFormElement;
  /** 真的发出去的提交（submit 事件没被取消）。 */
  readonly submitted: () => number;
  /** 每个区已经保存的那几段，按页面上的顺序，读卡片上的标题（经历）或学校（教育）。 */
  readonly savedTitles: (section: WorkableSection) => readonly string[];
  /** 这个区此刻开着几个编辑框。 */
  readonly openEditors: (section: WorkableSection) => number;
}

const header = (section: WorkableSection): string => {
  const title = section === 'experience' ? 'Experience' : 'Education';
  return `<div><p id="${section}_label">${title}&nbsp;<small>(Optional)</small></p>` +
    `<button data-ui="add-section" aria-label="Add ${title}" type="button">+ Add</button></div>`;
};

const textCell = (name: string, label: string, required: boolean, tag: 'input' | 'textarea' = 'input'): string => {
  const mark = required ? '<span><strong>*</strong></span>' : '';
  const optional = required ? '' : '<span> (Optional)</span>';
  const control = tag === 'input'
    ? `<input aria-required="${required}" id="${name}" maxlength="255" name="${name}" aria-labelledby="${name}_label"${required ? ' required' : ''} type="text" dir="auto" value="">`
    : `<textarea aria-required="false" id="${name}" name="${name}" aria-labelledby="${name}_label" type="text" rows="5" dir="auto"></textarea>`;
  return `<div><label><span>${mark}<span><span id="${name}_label"><strong>${label}</strong></span>${optional}</span></span>` +
    `<div data-role="illustrated-input"><div>${control}</div></div></label></div>`;
};

const dateCell = (name: string, label: string): string =>
  `<div><label><span><span><span id="${name}_label"><strong>${label}</strong></span><span> (Optional)</span></span></span>` +
  `<div><div><div data-role="illustrated-input"><div><input type="text" aria-readonly="false" data-lpignore="true" inputmode="tel" name="${name}" placeholder="MM/YYYY" dir="auto" value="">` +
  '<span data-ui="calendar-icon"></span></div></div></div></div></label></div>';

const buttons = '<div><button data-ui="save-section" type="button">Update</button>' +
  '<button data-ui="cancel-section" type="button">Cancel</button></div>';

function editorHtml(section: WorkableSection, unmapped = false): string {
  if (unmapped) {
    return '<div data-ui="editor">' + textCell('job_role', 'Role', false) + textCell('employer', 'Employer', false) + buttons + '</div>';
  }
  if (section === 'education') {
    return '<div data-ui="editor">' +
      textCell('school', 'School', true) +
      textCell('field_of_study', 'Field of study', false) +
      textCell('degree', 'Degree', false) +
      dateCell('start_date', 'Start date') +
      dateCell('end_date', 'End date') +
      buttons + '</div>';
  }
  return '<div data-ui="editor">' +
    textCell('title', 'Title', true) +
    textCell('company', 'Company', false) +
    textCell('industry', 'Industry', false) +
    textCell('summary', 'Summary', false, 'textarea') +
    dateCell('start_date', 'Start date') +
    dateCell('end_date', 'End date') +
    '<label data-checked="false"><div aria-labelledby="checkbox_label_current" role="checkbox" aria-checked="false" ' +
    'aria-disabled="false" aria-required="false" tabindex="0" id="current"><input aria-required="false" tabindex="-1" ' +
    'aria-hidden="true" type="checkbox" name="current" dir="auto"></div><span id="checkbox_label_current">I currently work here</span></label>' +
    buttons + '</div>';
}

/** 卡片：只有一格标题（经历读 Title，教育读 School）和那颗选项菜单按钮。 */
function savedCard(doc: Document, section: WorkableSection, heading: string): HTMLLIElement {
  const li = doc.createElement('li');
  const group = doc.createElement('div');
  group.setAttribute('data-ui', 'group');
  const dl = doc.createElement('dl');
  const dt = doc.createElement('dt');
  dt.textContent = section === 'experience' ? 'Title' : 'School';
  const dd = doc.createElement('dd');
  dd.setAttribute('data-ui', section === 'experience' ? 'title' : 'school');
  const span = doc.createElement('span');
  span.textContent = heading;
  dd.append(span);
  dl.append(dt, dd);
  const actions = doc.createElement('div');
  const menu = doc.createElement('button');
  menu.setAttribute('data-ui', 'section-actions');
  menu.setAttribute('type', 'button');
  menu.setAttribute('aria-haspopup', 'true');
  menu.setAttribute('aria-expanded', 'false');
  menu.setAttribute('aria-label', `Options for ${heading}`);
  actions.append(menu);
  group.append(dl, actions);
  li.append(group);
  return li;
}

export function mountWorkableEntrySections(
  doc: Document,
  sections: readonly WorkableSection[],
  options: WorkableEntryHostOptions = {},
): MountedWorkableEntries {
  doc.body.innerHTML = `
    <form data-ui="application-form">
      <label for="firstname">First name*</label>
      <input id="firstname" name="firstname" data-ui="firstname" type="text" required />
      ${sections.map((section) => `<div data-ui="${section}">${header(section)}</div>`).join('')}
      <button data-ui="apply-button" type="submit">Submit application</button>
    </form>`;
  const form = doc.querySelector<HTMLFormElement>('form[data-ui="application-form"]')!;
  let submitted = 0;
  doc.addEventListener('submit', (event) => { if (!event.defaultPrevented) submitted += 1; });

  for (const section of sections) {
    const area = doc.querySelector<HTMLElement>(`[data-ui="${section}"]`)!;
    const add = area.querySelector<HTMLButtonElement>('button[data-ui="add-section"]')!;
    const setAdd = (enabled: boolean): void => {
      add.disabled = !enabled;
      if (enabled) add.removeAttribute('aria-disabled');
      else add.setAttribute('aria-disabled', 'true');
    };
    const list = (): HTMLUListElement => {
      let ul = area.querySelector('ul');
      if (ul === null) {
        ul = doc.createElement('ul');
        area.append(ul);
      }
      return ul;
    };
    const openEditor = (): void => {
      const li = doc.createElement('li');
      li.innerHTML = editorHtml(section, options.unmappedCells === true);
      list().prepend(li);
    };
    add.addEventListener('click', () => {
      if (add.disabled) return;
      setAdd(false);
      if (options.addDelayMs === undefined) openEditor();
      else setTimeout(openEditor, options.addDelayMs);
    });
    area.addEventListener('click', (event) => {
      const target = event.target as Element | null;
      const button = target?.closest('button[data-ui="save-section"], button[data-ui="cancel-section"]');
      if (button === null || button === undefined) return;
      const li = button.closest('li')!;
      if (button.getAttribute('data-ui') === 'cancel-section') {
        li.remove();
        setAdd(true);
        return;
      }
      if (options.submitOnSave === true) form.requestSubmit();
      const required = [...li.querySelectorAll<HTMLInputElement>('input[required]')];
      if (options.refuseSave === true || required.some((input) => input.value.trim() === '')) {
        if (li.querySelector('[data-ui="error"]') === null) {
          const error = doc.createElement('span');
          error.setAttribute('data-ui', 'error');
          error.textContent = 'This is a required field.';
          li.querySelector('[data-ui="editor"]')!.prepend(error);
        }
        return;
      }
      const heading = required[0]?.value.trim() ?? '';
      li.replaceWith(savedCard(doc, section, heading));
      setAdd(true);
    });
  }

  return {
    form,
    submitted: () => submitted,
    savedTitles: (section) => [...doc.querySelectorAll(`[data-ui="${section}"] ul > li [data-ui="group"] dd span`)]
      .map((node) => node.textContent ?? ''),
    openEditors: (section) => doc.querySelectorAll(`[data-ui="${section}"] ul > li [data-ui="editor"]`).length,
  };
}
