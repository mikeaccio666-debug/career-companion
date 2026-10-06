/**
 * Workday「My Experience」（applyFlowMyExpPage）的**结构骨架**，按 2026-09-24 在
 * adobe.wd5.myworkdayjobs.com（没登录、/apply/applyManually）测试台标签页上只读抽出的
 * DOM 手写：只有标签文字、data-automation-id、data-fkit-id、id、name、type、role 与
 * ARIA 属性，**没有任何账号数据**，所有输入框都是空的。
 *
 * 几处实测形状（夹具必须照着长，否则测到的是别的东西）：
 *
 *  · 区是 `div[role=group][aria-labelledby="<标题>-section"]`，行是
 *    `div[role=group][aria-labelledby="<标题>-<n>-panel"]` 里那个
 *    `div[data-fkit-id="workExperience-<序号>--null"]`（教育是 `education-<序号>--null`）。
 *    序号是页面生成的（29、30……），加一行就再生成一个。
 *  · 「Add」／「Add Another」是区里最后那个 `button[data-automation-id="add-button"]`，
 *    **没有 type 属性**，整页没有 `<form>`。三个区（经历、教育、证书）各一颗，同一个 automation id。
 *  · 日期是 Canvas Kit 的分段日期：`div[data-automation-id="dateInputWrapper"][role=group]`
 *    里每一段一个 `input[role=spinbutton]`（1px 宽、scale(0.01)，看得见的是它的父节点那一段）。
 *    经历是 MM/YYYY 两段，教育是只有 YYYY 一段。
 *  · Degree 是 `button[aria-haspopup=listbox]` 加紧邻的 `input[type=text]` 镜像（与 My Information
 *    的国家下拉同一个部件）。Field of Study 与 Skills 是 `data-uxi-widget-type="selectinput"` 的
 *    搜索式多选（打字不出结果，要回车才搜）。
 *  · 简历栏的 wrapper 是字面上的 `formField-`（后面什么都没有），标签「Upload a file (5MB max)*」
 *    没有 `for`；真正的 `input[type=file]` display:none，看得见的是「Select files」按钮；
 *    区标题「Resume/CV」是往上第 8 层的一个 `<h4>`。
 */

/** 题干：星号是一个 aria-hidden 的 `<abbr>`（2026-09-28 adobe.wd5 实测，看得见、不念给读屏）。 */
const labelText = (label: string, required: boolean): string =>
  `<span>${label}${required ? '<abbr aria-hidden="true">*</abbr>' : ''}</span>`;

const text = (fkit: string, field: string, label: string, name: string, required: boolean): string => `
  <div data-automation-id="formField-${field}" data-fkit-id="${fkit}--${field}">
    <label for="${fkit}--${field}">${labelText(label, required)}</label>
    <div><div><input id="${fkit}--${field}" name="${name}" type="text" aria-required="${required}" /></div><div></div></div>
  </div>`;

const checkbox = (fkit: string, field: string, label: string): string => `
  <div data-automation-id="formField-${field}" data-fkit-id="${fkit}--${field}">
    <label for="${fkit}--${field}">${label}</label>
    <div><div><div><div><input id="${fkit}--${field}" name="${field}" type="checkbox" aria-required="false" /><span></span><div><div></div></div></div></div></div><div></div></div>
  </div>`;

const section = (id: string, part: 'Month' | 'Year', first: boolean): string => `
  <div id="${id}-dateSection${part}" tabindex="${first ? '-1' : '0'}">
    <div data-automation-id="dateSection${part}-display" id="${id}-dateSection${part}-display" aria-hidden="true">${part === 'Month' ? 'MM' : 'YYYY'}</div>
    <input data-automation-id="dateSection${part}-input" id="${id}-dateSection${part}-input" role="spinbutton"${first ? ` aria-describedby="helpText-${id}"` : ' tabindex="-1"'} aria-valuemin="1" aria-valuemax="${part === 'Month' ? '12' : '9999'}" aria-label="${part}" />
  </div>`;

/** 分段日期：`parts` 是页面上的段，经历 `['Month','Year']`，教育 `['Year']`。 */
const date = (fkit: string, field: string, legend: string, required: boolean, parts: readonly ('Month' | 'Year')[]): string => {
  const id = `${fkit}--${field}`;
  return `
  <div data-automation-id="formField-${field}" data-fkit-id="${id}">
    <fieldset><legend>${legend}${required ? '*' : ''}</legend>
      <div><div>
        <div id="helpText-${id}" aria-hidden="true"></div>
        <div data-automation-id="dateInputWrapper" id="${id}" role="group" aria-labelledby="hiddenDateValueId-${id}">
          <div tabindex="-1">${parts.map((part, index) => `${index > 0 ? '<div>/</div>' : ''}${section(id, part, index === 0)}`).join('')}</div>
          ${parts.length > 1 ? '<div data-automation-id="dateIcon" role="button" tabindex="0" aria-label="Calendar"><span></span></div>' : ''}
        </div>
      </div><div></div></div>
    </fieldset>
  </div>`;
};

const prompt = (fkit: string, field: string, label: string): string => `
  <div data-automation-id="formField-${field}" data-fkit-id="${fkit}--${field}">
    <label for="${fkit}--${field}">${label}</label>
    <div><div><div><div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect" tabindex="-1">
      <div data-automation-id="multiselectInputContainer"><div>
        <input id="${fkit}--${field}" data-uxi-widget-type="selectinput" aria-required="false" placeholder="Search" tabindex="0" />
        <div data-automation-id="promptSelectionLabel"></div>
      </div><span data-automation-id="promptIcon" data-uxi-widget-type="selectinputicon" aria-hidden="true"></span></div>
    </div></div></div><div></div></div>
  </div>`;

const listbox = (fkit: string, field: string, label: string, required: boolean): string => `
  <div data-automation-id="formField-${field}" data-fkit-id="${fkit}--${field}">
    <label for="${fkit}--${field}">${labelText(label, required)}</label>
    <div><div><div><button id="${fkit}--${field}" name="${field}" type="button" aria-haspopup="listbox">Select One</button><input type="text" /><span></span></div></div><div></div></div>
  </div>`;

/** 一行工作经历。`seq` 是页面生成的序号，`ordinal` 是第几段（从 1 起）。 */
export function workExperienceRow(seq: number, ordinal: number): string {
  const fkit = `workExperience-${seq}`;
  return `
  <div role="group" aria-labelledby="Work-Experience-${ordinal}-panel">
    <div><h5 id="Work-Experience-${ordinal}-panel">Work Experience ${ordinal}</h5>${ordinal > 1 ? '<button>Delete</button>' : ''}</div>
    <div data-fkit-id="${fkit}--null">
      ${text(fkit, 'jobTitle', 'Job Title', 'jobTitle', true)}
      ${text(fkit, 'companyName', 'Company', 'companyName', true)}
      ${text(fkit, 'location', 'Location', 'location', false)}
      ${checkbox(fkit, 'currentlyWorkHere', 'I currently work here')}
      <div>
        ${date(fkit, 'startDate', 'From', true, ['Month', 'Year'])}
        ${date(fkit, 'endDate', 'To', true, ['Month', 'Year'])}
      </div>
      <div data-automation-id="formField-roleDescription" data-fkit-id="${fkit}--roleDescription">
        <label for="${fkit}--roleDescription">Role Description</label>
        <div><div><textarea id="${fkit}--roleDescription" aria-required="false"></textarea></div><div></div></div>
      </div>
    </div>
  </div>`;
}

/** 一行教育。 */
export function educationRow(seq: number, ordinal: number): string {
  const fkit = `education-${seq}`;
  return `
  <div role="group" aria-labelledby="Education-${ordinal}-panel">
    <div><h5 id="Education-${ordinal}-panel">Education ${ordinal}</h5>${ordinal > 1 ? '<button>Delete</button>' : ''}</div>
    <div data-fkit-id="${fkit}--null">
      ${text(fkit, 'schoolName', 'School or University', 'schoolName', true)}
      ${listbox(fkit, 'degree', 'Degree', true)}
      <div><div>${prompt(fkit, 'fieldOfStudy', 'Field of Study')}</div><button type="button" aria-label="The field will alphabetically return the first 100 results and can also return search results"></button></div>
      ${text(fkit, 'gradeAverage', 'Overall Result (GPA)', 'gradeAverage', false)}
      <div>
        ${date(fkit, 'firstYearAttended', 'From', false, ['Year'])}
        ${date(fkit, 'lastYearAttended', 'To (Actual or Expected)', false, ['Year'])}
      </div>
    </div>
  </div>`;
}

const addButton = (rows: number): string =>
  `<div><div><div><button data-automation-id="add-button">${rows === 0 ? 'Add' : 'Add Another'}</button></div></div></div>`;

export interface MyExperienceShape {
  /** 页面上已有几行经历（Adobe 预渲染 1 行；别的租户可能是 0）。 */
  readonly experiences: number;
  readonly educations: number;
}

/** 整页。序号从 29（经历）/ 30（教育）起，与实测那一页同一形状。 */
export function myExperiencePage(shape: MyExperienceShape = { experiences: 1, educations: 1 }): string {
  const experienceRows = Array.from({ length: shape.experiences }, (_, index) => workExperienceRow(29 + index * 2, index + 1)).join('');
  const educationRows = Array.from({ length: shape.educations }, (_, index) => educationRow(30 + index * 2, index + 1)).join('');
  return `
  <div data-automation-id="applyFlowMyExpPage">
    <div role="group" aria-labelledby="Work-Experience-section">
      <h4 id="Work-Experience-section">Work Experience</h4>
      ${experienceRows}
      ${addButton(shape.experiences)}
    </div>
    <div data-automation-id="smartDivider"></div>
    <div role="group" aria-labelledby="Education-section">
      <h4 id="Education-section">Education</h4>
      ${educationRows}
      ${addButton(shape.educations)}
    </div>
    <div data-automation-id="smartDivider"></div>
    <div role="group" aria-labelledby="Certifications-section">
      <h4 id="Certifications-section">Certifications</h4>
      ${addButton(0)}
    </div>
    <div data-automation-id="smartDivider"></div>
    <div role="group" aria-labelledby="Skills-section">
      <h4 id="Skills-section">Skills</h4>
      <div data-fkit-id="skills--null">${prompt('skills', 'skills', 'Type to Add Skills')}</div>
    </div>
    <div data-automation-id="smartDivider"></div>
    <div role="group" aria-labelledby="Resume/CV-section">
      <h4 id="Resume/CV-section">Resume/CV</h4>
      <div data-fkit-id="resumeAttachments--null"><wd-p>
        <div data-automation-id="formField-" data-fkit-id="resumeAttachments--attachments">
          <label id="label96">Upload a file (5MB max)*</label>
          <div><div><div data-automation-id="attachments-FileUpload" aria-labelledby="label96"><div>
            <div data-automation-id="file-upload-drop-zone">
              <div><span></span></div>
              <div>Drop files here</div>
              <div><div>or</div><button data-automation-id="select-files" id="resumeAttachments--attachments" type="button">Select files</button></div>
            </div>
            <input data-automation-id="file-upload-input-ref" type="file" multiple style="display:none" />
          </div><div></div></div></div>
          <div><p data-automation-id="inputAlert" id="error1-resumeAttachments--attachments"><span></span></p></div></div>
        </div>
      </wd-p></div>
    </div>
    <div data-automation-id="smartDivider"></div>
    <div role="group" aria-labelledby="Social-Network-URLs-section">
      <h4 id="Social-Network-URLs-section">Social Network URLs</h4>
      <div data-fkit-id="socialNetworkAccounts--null">${text('socialNetworkAccounts', 'linkedInAccount', 'Share your LinkedIn Profile site', 'linkedInAccount', false)}</div>
    </div>
  </div>`;
}

/**
 * 挂到文档上。Workday 的简历栏是 React 建的 `<p>` 里套 `<div>`——HTML 解析器会把这种 `<p>` 提前关掉，
 * 于是先用占位标签写、挂上之后换成真的 `<p>`，层数才与实测一致（「Resume/CV」在第 8 层）。
 */
export function mountMyExperience(doc: Document, shape?: MyExperienceShape): void {
  doc.body.innerHTML = myExperiencePage(shape);
  for (const placeholder of [...doc.querySelectorAll('wd-p')]) {
    const paragraph = doc.createElement('p');
    paragraph.append(...placeholder.childNodes);
    placeholder.replaceWith(paragraph);
  }
}
