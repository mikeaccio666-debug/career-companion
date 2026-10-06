import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { workdayAdapter } from '../src/sites/workday/applyForm';

const MY_INFORMATION = readFileSync(
  resolve(__dirname, 'fixtures/workday/my-information-step2.html'),
  'utf8',
);
const CREATE_ACCOUNT = readFileSync(
  resolve(__dirname, 'fixtures/workday/create-account-step1.html'),
  'utf8',
);

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(html: string): void {
  document.body.innerHTML = html;
}

describe('Workday adapter · candidate pathname', () => {
  it('accepts only a Workday job application route', () => {
    expect(
      workdayAdapter.isApplyPath(
        '/en-US/External/job/California/Software-Engineer_R-12345/apply',
      ),
    ).toBe(true);
    expect(
      workdayAdapter.isApplyPath(
        '/en-US/External/job/California/Software-Engineer_R-12345/apply/',
      ),
    ).toBe(true);
    // 2026-09-15 live: `/apply` is only the chooser page (Autofill with Resume /
    // Apply Manually / Use My Last Application). The My Information form and the
    // whole wizard live one segment deeper, so refusing it refuses the only page
    // there is anything to fill on.
    expect(
      workdayAdapter.isApplyPath(
        '/en-US/External/job/California/Software-Engineer_R-12345/apply/applyManually',
      ),
    ).toBe(true);
    // 2026-09-23 live: the other two chooser links lead into the same wizard. The owner
    // picked「Use My Last Application」on nvidia.wd5 and the dock said the page was not an
    // application — only applyManually was on the list. Links read off the NVIDIA posting's
    // Apply dialog the same day (the location segment arrives percent-encoded there).
    for (const entry of ['autofillWithResume', 'useMyLastApplication']) {
      expect(
        workdayAdapter.isApplyPath(`/en-US/External/job/California/Software-Engineer_R-12345/apply/${entry}`),
        entry,
      ).toBe(true);
    }
    expect(
      workdayAdapter.isApplyPath(
        '/en-US/NVIDIAExternalCareerSite/job/Germany%2C-Berlin/Senior-Deep-Learning-Compiler-Engineer---PyTorch_JR2001403/apply/useMyLastApplication',
      ),
    ).toBe(true);

    for (const pathname of [
      '/',
      '/en-US/External',
      '/en-US/External/job/California/Software-Engineer_R-12345',
      '/en-US/External/job/California/Software-Engineer_R-12345/apply/admin',
      '/en-US/External/job/California/Software-Engineer_R-12345/apply/autofillWithResume/extra',
      '/en-US/External/job/California/Software-Engineer_R-12345/apply/useMyLastApplicationX',
      '/en-US/External/job/California/Software-Engineer_R-12345/apply/applyManually/extra',
      '/admin/en-US/External/job/California/Software-Engineer_R-12345/apply',
      '/en-US/External/candidateHome/job/California/Software-Engineer_R-12345/apply',
      '/en-US/External/job/California/Software-Engineer_R-12345%2Fapply',
      '/prefix/en-US/External/job/California/Software-Engineer_R-12345/apply/suffix',
      '/login',
    ]) {
      expect(workdayAdapter.isApplyPath(pathname), pathname).toBe(false);
    }
  });
});

describe('Workday adapter · My Information', () => {
  it('uses stable wrapper automation ids to map the four currently supported fields', () => {
    mount(MY_INFORMATION);
    const root = workdayAdapter.resolveRoot(document);
    expect(root, '登录后的 My Information 页没有被锚定').not.toBeNull();
    const fields = [...workdayAdapter.scan(root!)];
    const keyOf = (wrapper: string) =>
      fields.find(
        (field) =>
          field.element.closest('[data-automation-id]')?.getAttribute('data-automation-id') ===
          `formField-${wrapper}`,
      )?.key ?? null;

    expect(keyOf('legalName--firstName')).toBe('firstName');
    expect(keyOf('legalName--lastName')).toBe('lastName');
    expect(keyOf('city')).toBe('city');
    expect(keyOf('phoneNumber')).toBe('phone');
    expect(keyOf('extension'), '分机栏绝不能收到整串电话号码').toBeNull();
  });

  it('builds a fill plan for exactly those four fields and nothing sensitive', () => {
    mount(MY_INFORMATION);
    const root = workdayAdapter.resolveRoot(document)!;
    const fields = [...workdayAdapter.scan(root)];
    const plan = buildApplyPlan(
      { vendor: 'workday', root, fields },
      {
        firstName: 'Ada',
        lastName: 'Lovelace',
        city: 'London',
        phone: '+1 555 0100',
      },
    );

    expect(plan.entries.map((entry) => entry.key).sort()).toEqual([
      'city',
      'firstName',
      'lastName',
      'phone',
    ]);
    expect(workdayAdapter.resolveFinalSubmitControl(root, fields)).toBeNull();
  });

  it('stops at the nearest declared wrapper instead of inheriting an outer mapped field', () => {
    mount(`
      <main data-automation-id="applyFlowMyInfoPage">
        <form>
          <div data-automation-id="formField-phoneNumber">
            <div data-automation-id="formField-extension">
              <label for="extension">Extension</label>
              <input id="extension" type="text" />
            </div>
          </div>
        </form>
      </main>
    `);
    const root = workdayAdapter.resolveRoot(document)!;
    const fields = [...workdayAdapter.scan(root)];
    expect(fields).toHaveLength(1);
    expect(fields[0]?.key).toBeNull();
    expect(buildApplyPlan(
      { vendor: 'workday', root, fields },
      { phone: '+1 555 0100' },
    ).entries).toEqual([]);
  });

  it('does not anchor the account-creation page', () => {
    mount(CREATE_ACCOUNT);
    expect(workdayAdapter.resolveRoot(document)).toBeNull();
  });
});
