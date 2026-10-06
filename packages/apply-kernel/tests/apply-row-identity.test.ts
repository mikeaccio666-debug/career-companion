import { afterEach, describe, expect, it } from 'vitest';

import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { icimsAdapter } from '../src/sites/icims/applyForm';
import { leverAdapter } from '../src/sites/lever/applyForm';
import { fieldSignature } from '../src/fieldIdentity';

/**
 * 字段身份 = "行标识 + 行内序号"（40-工程计划 P1；增删行的硬前置）。
 *
 * 病根（旧仓库实测，archive/AUTOFILL-施工计划 阶段 2）：身份里的序号是
 * "全表第几个控件"，而 Workable 点一次"加一行"会插入 7 个控件——插入点之后
 * 所有字段的序号全变，identity recheck 全体报 IDENTITY_CHANGED，整轮填充中止。
 *
 * 行结构是厂商知识，所以行作用域由 apply-rules JSON 的 `rowScopes` 声明
 * （铁律 3），kernel 只有解释器。本套 fixture 按 Greenhouse 教育区的实测
 * DOM 搭建（2026-08-08，52 家 board 仅 2 家开）：行是 `div.education--form`、
 * 容器 `div.education--container`、id 带行号（school--0/--1）不跨行重复、
 * 全表无 name、"加一行"按钮是容器最后一个子元素（新行插在它前面）。
 * 实测里 school/degree 是 react-select combobox；本套测试只关心身份不关心
 * 写入路径，用文本框即可。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function educationRow(index: number): string {
  return `
    <div class="education--form">
      <label for="school--${index}">School*</label>
      <input id="school--${index}" type="text" />
      <label for="degree--${index}">Degree*</label>
      <input id="degree--${index}" type="text" />
      <label for="end-year--${index}">End date year*</label>
      <input id="end-year--${index}" type="number" />
    </div>`;
}

function mountGreenhouseWithEducation(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name*</label>
      <input id="first_name" type="text" required />
      <label for="email">Email*</label>
      <input id="email" type="email" required />
      <div class="education--container">
        ${educationRow(0)}
        <button type="button" class="add-another-button">Add another</button>
      </div>
      <label for="phone">Phone*</label>
      <input id="phone" type="tel" required />
    </form>`;
}

function byId(id: string): Element {
  return document.getElementById(id)!;
}

function root() {
  const scanRoot = greenhouseAdapter.resolveRoot(document);
  expect(scanRoot, 'Greenhouse form root not proven').not.toBeNull();
  return scanRoot!;
}

describe('行标识 + 行内序号 · Greenhouse 教育行（rowScopes 已配）', () => {
  it('尾部加一行：既有行与行后字段的身份全部不变', () => {
    mountGreenhouseWithEducation();
    const before = {
      firstName: fieldSignature(byId('first_name'), root()).core,
      school0: fieldSignature(byId('school--0'), root()).core,
      degree0: fieldSignature(byId('degree--0'), root()).core,
      endYear0: fieldSignature(byId('end-year--0'), root()).core,
      phone: fieldSignature(byId('phone'), root()).core,
    };

    // 实测行为：新行插在容器末尾的"加一行"按钮之前。
    document
      .querySelector('.education--container .add-another-button')!
      .insertAdjacentHTML('beforebegin', educationRow(1));

    // 这是本次改造要买到的性质：加一行 = 3 个新控件进入 DOM，
    // 但行前字段、行内既有字段、行后字段的身份一个都不许漂。
    expect(fieldSignature(byId('first_name'), root()).core).toBe(before.firstName);
    expect(fieldSignature(byId('school--0'), root()).core).toBe(before.school0);
    expect(fieldSignature(byId('degree--0'), root()).core).toBe(before.degree0);
    expect(fieldSignature(byId('end-year--0'), root()).core).toBe(before.endYear0);
    expect(
      fieldSignature(byId('phone'), root()).core,
      '行后字段的序号被新行冲掉 —— 这正是"整轮填充中止"的病根',
    ).toBe(before.phone);
  });

  it('两行的同形控件靠行标识区分，行内序号各自从头数', () => {
    mountGreenhouseWithEducation();
    document
      .querySelector('.education--container .add-another-button')!
      .insertAdjacentHTML('beforebegin', educationRow(1));

    const school0 = fieldSignature(byId('school--0'), root());
    const school1 = fieldSignature(byId('school--1'), root());
    // Greenhouse 教育行全部无 name：没有行标识的话，两行的 school 只能靠
    // 全表序号区分——而那个序号正是会漂移的东西。
    expect(school0.core).not.toBe(school1.core);
  });

  it('在已审行之前插入一行：该行身份变化（fail closed 是对的）', () => {
    mountGreenhouseWithEducation();
    const before = fieldSignature(byId('school--0'), root()).core;

    document
      .querySelector('.education--container .education--form')!
      .insertAdjacentHTML('beforebegin', educationRow(9));

    // 已审的"第 1 行"真的变成了"第 2 行"——预览与页面已经对不上，
    // 此时继续写才是事故；身份变化触发 IDENTITY_CHANGED 停下是设计行为。
    expect(fieldSignature(byId('school--0'), root()).core).not.toBe(before);
  });
});

describe('行标识 + 行内序号 · 无 rowScopes 的厂商行为不变', () => {
  it('Lever（未声明行作用域）：插入控件仍会改变后续字段身份', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label>Full name<input name="name" type="text" /></label>
        <label>Email<input name="email" type="email" /></label>
      </form>`;
    const scanRoot = leverAdapter.resolveRoot(document)!;
    const email = document.querySelector<HTMLInputElement>('input[name="email"]')!;
    const before = fieldSignature(email, scanRoot).core;

    document.querySelector('form')!.prepend(document.createElement('input'));

    // 没有行知识就没有豁免：结构位置变了就是变了，保守失败优于错填。
    expect(fieldSignature(email, scanRoot).core).not.toBe(before);
  });
});

/**
 * 第二种行模型：行序编在 id 前缀里（iCIMS）。
 *
 * 2026-08-22 在 careers-udhgroup.icims.com 的 Candidate Profile 页实测：
 * 同一行的控件靠 id 前缀绑在一起（`-1_PersonProfileFields.PhoneNumber` 与
 * `-1_PersonProfileFields.PhoneType`），DOM 上**没有**包住一行的元素——
 * 全部平铺在 `form#profileForm` 里。Workable 那种 {container, row} 的包含模型
 * 在这里一行都定位不了。证据见 50-证据库 §F.6-f。
 */

function icimsRoot() {
  const scanRoot = icimsAdapter.resolveRoot(document);
  expect(scanRoot, 'iCIMS form root not proven').not.toBeNull();
  return scanRoot!;
}

/** 一组电话字段。token 是 iCIMS 的行标识：`-1` 表示尚未保存的新行。 */
function phoneRow(token: string): string {
  return `
    <label for="${token}_PersonProfileFields.PhoneNumber">Phone</label>
    <input id="${token}_PersonProfileFields.PhoneNumber" type="tel" />
    <label for="${token}_PersonProfileFields.PhoneType">Type</label>
    <input id="${token}_PersonProfileFields.PhoneType" type="text" />`;
}

function addressRow(token: string): string {
  return `
    <label for="${token}_PersonProfileFields.AddressCity">City</label>
    <input id="${token}_PersonProfileFields.AddressCity" type="text" />`;
}

function mountIcims(inner: string): void {
  document.body.innerHTML = `
    <form id="profileForm">
      <label for="PersonProfileFields.FirstName">First name</label>
      <input id="PersonProfileFields.FirstName" type="text" autocomplete="given-name" />
      ${inner}
      <label for="PersonProfileFields.Email">Email</label>
      <input id="PersonProfileFields.Email" type="email" autocomplete="email" />
    </form>`;
}

describe('行标识 + 行内序号 · iCIMS 的 id 前缀行模型', () => {
  it('同前缀的控件属于同一行，行内序号各自从头数', () => {
    mountIcims(phoneRow('1') + phoneRow('2'));
    const number1 = fieldSignature(byId('1_PersonProfileFields.PhoneNumber'), icimsRoot());
    const number2 = fieldSignature(byId('2_PersonProfileFields.PhoneNumber'), icimsRoot());
    // 没有行模型时这两个只能靠全表序号区分——而那个序号正是加一行就会漂的东西。
    expect(number1.core).not.toBe(number2.core);
  });

  it('尾部加一行：既有行与行后字段的身份全部不变', () => {
    mountIcims(phoneRow('1'));
    const before = {
      firstName: fieldSignature(byId('PersonProfileFields.FirstName'), icimsRoot()).core,
      phone1: fieldSignature(byId('1_PersonProfileFields.PhoneNumber'), icimsRoot()).core,
      type1: fieldSignature(byId('1_PersonProfileFields.PhoneType'), icimsRoot()).core,
      email: fieldSignature(byId('PersonProfileFields.Email'), icimsRoot()).core,
    };

    // 实测行为：点"加一行"后新控件以 `-1_` 前缀插在既有行之后。
    byId('1_PersonProfileFields.PhoneType').insertAdjacentHTML('afterend', phoneRow('-1'));

    expect(fieldSignature(byId('PersonProfileFields.FirstName'), icimsRoot()).core).toBe(
      before.firstName,
    );
    expect(fieldSignature(byId('1_PersonProfileFields.PhoneNumber'), icimsRoot()).core).toBe(
      before.phone1,
    );
    expect(fieldSignature(byId('1_PersonProfileFields.PhoneType'), icimsRoot()).core).toBe(
      before.type1,
    );
    expect(
      fieldSignature(byId('PersonProfileFields.Email'), icimsRoot()).core,
      '行后字段的序号被新行冲掉 —— 这正是"整轮填充中止"的病根',
    ).toBe(before.email);
  });

  it('行的先后按 DOM 出现顺序，不按行标识的字面值排', () => {
    // `-1` 是"新行"而不是"第 -1 行"。若按标识排序，页面上排第二的新行会被
    // 当成第一行——第 2 段经历会填进第 1 组控件，而这在扫描期完全静默。
    mountIcims(phoneRow('7') + phoneRow('-1'));
    const first = fieldSignature(byId('7_PersonProfileFields.PhoneNumber'), icimsRoot()).core;

    document.body.innerHTML = '';
    mountIcims(phoneRow('9') + phoneRow('-1'));
    // 换个行标识但 DOM 顺序不变：第一行还是第一行。
    expect(fieldSignature(byId('9_PersonProfileFields.PhoneNumber'), icimsRoot()).core).toBe(first);
  });

  it('电话与地址是两个集合：同号行不会被并成一行', () => {
    // 两个集合各自的"新行"都叫 `-1`。只用一条 `^(-?\d+)_PersonProfileFields\.`
    // 的规则会把电话号码和城市判成同一行的两个控件。
    mountIcims(phoneRow('-1') + addressRow('-1'));
    const phone = fieldSignature(byId('-1_PersonProfileFields.PhoneNumber'), icimsRoot());
    const city = fieldSignature(byId('-1_PersonProfileFields.AddressCity'), icimsRoot());
    expect(phone.core).not.toBe(city.core);

    // 而且各自是所在行的第一个控件——城市的行内序号不该被电话那两栏推后。
    document.body.innerHTML = '';
    mountIcims(addressRow('-1'));
    expect(fieldSignature(byId('-1_PersonProfileFields.AddressCity'), icimsRoot()).core).toBe(
      city.core,
    );
  });

  it('不带行前缀的字段留在根域，不被任何行认领', () => {
    mountIcims(phoneRow('1'));
    const withRows = fieldSignature(byId('PersonProfileFields.FirstName'), icimsRoot()).core;

    document.body.innerHTML = '';
    mountIcims('');
    // 姓名从来不属于任何一行：页面上有几行电话都不该动它的身份。
    expect(fieldSignature(byId('PersonProfileFields.FirstName'), icimsRoot()).core).toBe(withRows);
  });
});
