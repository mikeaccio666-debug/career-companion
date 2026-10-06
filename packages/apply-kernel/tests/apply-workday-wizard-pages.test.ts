import { afterEach, describe, expect, it } from 'vitest';
import { workdayAdapter } from '../src/sites/workday/applyForm';

/**
 * Workday's apply wizard past step 1, measured live on 2026-09-15
 * (nvidia.wd5.myworkdayjobs.com/…/Software-Engineer--OpenShell_JR2020825/apply,
 * owner signed in, a posting they had not started, driven page by page).
 *
 * The flow is five steps — My Information, My Experience, Application
 * Questions, Voluntary Disclosures, Review — and each step hangs its own
 * `applyFlow…Page` container inside `applyFlowPage`. Anchoring only step 1 is
 * what made every later page report `NO_ROOT`.
 *
 * Two shapes on those pages are why this file exists:
 *
 *  · step 2 "Social Network URLs" is an ordinary text input in
 *    `formField-linkedInAccount`, and it is the **only** control on that page
 *    that can carry a canonical profile key. Without the mapping the page
 *    scans to zero canonical fields, which the lab reports as
 *    `NO_CANONICAL_FIELD` — the resume drop zone and Skills never get looked at.
 *
 *  · step 3's employer questions have wrapper ids that are random hex GUIDs and
 *    **no `<label>` at all**: the wording lives in `<fieldset><legend>`, and the
 *    scanned control is the 0×0 value mirror next to the picker button, which
 *    has no id, no name and no aria-label. With only the `label` question scope
 *    both questions scan as the empty string.
 */
afterEach(() => {
  document.body.innerHTML = '';
});

/** Step 2, verbatim apart from styling classes and icon SVGs. */
const MY_EXPERIENCE = `
  <div data-automation-id="applyFlowPage">
    <div data-automation-id="applyFlowMyExpPage">
      <div role="group" aria-labelledby="Work-Experience-section">
        <h4 id="Work-Experience-section">Work Experience</h4>
        <div><div><div><button data-automation-id="add-button">Add</button></div></div></div>
      </div>
      <div role="group" aria-labelledby="Education-section">
        <h4 id="Education-section">Education</h4>
        <div><div><div><button data-automation-id="add-button">Add</button></div></div></div>
      </div>
      <div role="group" aria-labelledby="Resume/CV-section">
        <h4 id="Resume/CV-section">Resume/CV</h4>
        <div data-fkit-id="resumeAttachments--null"><p>
          <div data-automation-id="formField-" data-fkit-id="resumeAttachments--attachments">
            <label id="label5">Upload a file (5MB max)</label>
            <div><div><div data-automation-id="attachments-FileUpload" aria-labelledby="label5"><div>
              <div data-automation-id="file-upload-drop-zone">
                <div>Drop files here</div>
                <div><div>or</div><button type="button" data-automation-id="select-files"
                  id="resumeAttachments--attachments"><span>Select files</span></button></div>
              </div>
              <input data-automation-id="file-upload-input-ref" type="file" multiple="" />
            </div></div></div></div>
          </div>
        </p></div>
      </div>
      <div role="group" aria-labelledby="Social-Network-URLs-section">
        <h4 id="Social-Network-URLs-section">Social Network URLs</h4>
        <div data-fkit-id="socialNetworkAccounts--null">
          <div data-automation-id="formField-linkedInAccount" data-fkit-id="socialNetworkAccounts--linkedInAccount">
            <label for="socialNetworkAccounts--linkedInAccount">Please provide a link to your LinkedIn profile:</label>
            <div><div><input type="text" id="socialNetworkAccounts--linkedInAccount" name="linkedInAccount"
              aria-required="false" value="" /></div><div></div></div>
          </div>
        </div>
      </div>
    </div>
    <div data-automation-id="pageFooter">
      <button data-automation-id="pageFooterBackButton">Back</button>
      <button data-automation-id="pageFooterNextButton">Save and Continue</button>
    </div>
  </div>`;

/** Step 3, verbatim apart from styling classes and the caret SVG. */
const APPLICATION_QUESTIONS = `
  <div data-automation-id="applyFlowPage">
    <div data-automation-id="applyFlowPrimaryQuestionsPage">
      <div data-automation-id="instructionalText"><p><span><i>Responses to these questions will be used to
        assess whether NVIDIA immigration support is required.</i></span></p></div>
      <div role="group" aria-labelledby="primaryQuestionnaire-section">
        <div data-fkit-id="primaryQuestionnaire--null">
          <div data-automation-id="formField-2f2764b3a829100642af25b88deb0000"
               data-fkit-id="primaryQuestionnaire--2f2764b3a829100642af25b88deb0000">
            <fieldset>
              <legend><div id="rich-label11"><div data-automation-id="richText"><p><span>Are you legally
                authorized to work in the country where this position is located?<abbr title="required"
                class="requiredAsterisk">*</abbr></span></p></div></div></legend>
              <div><div><div>
                <button aria-haspopup="listbox" type="button" value="" aria-label=" Select One Required"
                  name="2f2764b3a829100642af25b88deb0000"
                  id="primaryQuestionnaire--2f2764b3a829100642af25b88deb0000">Select One</button>
                <input type="text" value="" />
              </div></div><div></div></div>
            </fieldset>
          </div>
          <div data-automation-id="formField-2f2764b3a829100642af26ec534f0000"
               data-fkit-id="primaryQuestionnaire--2f2764b3a829100642af26ec534f0000">
            <fieldset>
              <legend><div id="rich-label12"><div data-automation-id="richText"><p><span>Will you require
                employer support to obtain or maintain authorization to work in that country? e.g. (work
                permit)<abbr title="required" class="requiredAsterisk">*</abbr></span></p></div></div></legend>
              <div><div><div>
                <button aria-haspopup="listbox" type="button" value="" aria-label=" Select One Required"
                  name="2f2764b3a829100642af26ec534f0000"
                  id="primaryQuestionnaire--2f2764b3a829100642af26ec534f0000">Select One</button>
                <input type="text" value="" />
              </div></div><div></div></div>
            </fieldset>
          </div>
        </div>
      </div>
    </div>
  </div>`;

/** Step 1's radio group: three `<label>`s in the wrapper, wording inside the `<legend>`. */
const PREVIOUS_WORKER = `
  <div data-automation-id="applyFlowMyInfoPage">
    <div data-automation-id="formField-legalName--firstName" data-fkit-id="name--legalName--firstName">
      <label for="name--legalName--firstName"><span>First Name<abbr aria-hidden="true">*</abbr></span></label>
      <div><input id="name--legalName--firstName" type="text" name="firstName" aria-required="true" value="" /></div>
    </div>
    <div data-automation-id="formField-candidateIsPreviousWorker" data-fkit-id="previousWorker--candidateIsPreviousWorker">
      <fieldset>
        <legend><label id="radio-label2"><span>Have you previously worked for NVIDIA as an employee or
          contractor?<abbr aria-hidden="true">*</abbr></span></label></legend>
        <div><div><div name="candidateIsPreviousWorker" aria-labelledby="radio-label2"
          id="previousWorker--candidateIsPreviousWorker" aria-required="true">
          <div><div><input id="vaq74" name="candidateIsPreviousWorker" type="radio" value="true" /></div>
            <label for="vaq74">Yes</label></div>
          <div><div><input id="vaq75" name="candidateIsPreviousWorker" type="radio" value="false" /></div>
            <label for="vaq75">No</label></div>
        </div></div></div>
      </fieldset>
    </div>
  </div>`;

function scan(html: string) {
  document.body.innerHTML = html;
  const root = workdayAdapter.resolveRoot(document);
  expect(root).not.toBeNull();
  return [...workdayAdapter.scan(root!)];
}

describe('Workday wizard · step 2 My Experience', () => {
  it('anchors applyFlowMyExpPage instead of falling through to NO_ROOT', () => {
    document.body.innerHTML = MY_EXPERIENCE;
    const root = workdayAdapter.resolveRoot(document);
    // Step 1's anchor is nowhere on this page, so a non-null root can only be
    // the new one — and it is the page container, not the whole apply flow:
    // the footer's Save and Continue sits outside it and stays out of reach.
    expect(root).not.toBeNull();
    expect(root!.querySelectorAll('[data-automation-id="file-upload-input-ref"]')).toHaveLength(1);
    expect(root!.querySelectorAll('[data-automation-id="pageFooterNextButton"]')).toHaveLength(0);
  });

  it('gives the page a canonical field: the LinkedIn URL input', () => {
    const fields = scan(MY_EXPERIENCE);
    const linkedin = fields.find((field) => field.key === 'linkedinUrl');
    expect(linkedin).toBeDefined();
    expect((linkedin!.element as HTMLInputElement).id).toBe('socialNetworkAccounts--linkedInAccount');
    expect(linkedin!.label).toContain('LinkedIn');
    // Without at least one canonical field the lab reports NO_CANONICAL_FIELD
    // and never looks at the resume drop zone.
    expect(fields.filter((field) => field.key !== null)).toHaveLength(1);
  });

  it('still reaches the resume file input behind the hidden-input/visible-button shape', () => {
    const fields = scan(MY_EXPERIENCE);
    const file = fields.find((field) => (field.element as Element).localName === 'input'
      && (field.element as HTMLInputElement).type === 'file');
    expect(file).toBeDefined();
    expect((file!.element as Element).getAttribute('data-automation-id')).toBe('file-upload-input-ref');
  });
});

describe('Workday wizard · step 3 Application Questions', () => {
  it('anchors applyFlowPrimaryQuestionsPage', () => {
    document.body.innerHTML = APPLICATION_QUESTIONS;
    const root = workdayAdapter.resolveRoot(document);
    expect(root).not.toBeNull();
    expect(root!.querySelectorAll('[data-fkit-id^="primaryQuestionnaire--"]').length).toBeGreaterThan(0);
  });

  it('reads each GUID question’s wording out of its <legend>', () => {
    const labels = scan(APPLICATION_QUESTIONS).map((field) => field.label);
    expect(labels.some((label) => label.includes('legally authorized to work in the country'))).toBe(true);
    expect(labels.some((label) => label.includes('require employer support to obtain or maintain'))).toBe(true);
    // The old behaviour: the mirror input is labelled by nothing at all.
    expect(labels.every((label) => label.trim() !== '')).toBe(true);
  });
});

/**
 * Step 4, live 2026-09-15. This tenant's EEO block is three pickers plus the
 * required consent checkbox; it does not match the 2026-08-21 rochester capture
 * (hispanicOrLatino + an ethnicityMulti checkbox group), which is why the
 * anchor is per-page and the fields are not.
 */
const VOLUNTARY_DISCLOSURES = `
  <div data-automation-id="applyFlowPage">
    <div data-automation-id="applyFlowVoluntaryDisclosuresPage">
      <div data-automation-id="formField-ethnicity" data-fkit-id="personalInfoUS--ethnicity">
        <label for="personalInfoUS--ethnicity"><span>What is your ethnicity?<abbr aria-hidden="true">*</abbr></span></label>
        <div><div><div><button aria-haspopup="listbox" type="button" value="" name="ethnicity"
          id="personalInfoUS--ethnicity">Select One</button><input type="text" value="" /></div></div></div>
      </div>
      <div data-automation-id="formField-gender" data-fkit-id="personalInfoUS--gender">
        <label for="personalInfoUS--gender"><span>What is your gender?<abbr aria-hidden="true">*</abbr></span></label>
        <div><div><div><button aria-haspopup="listbox" type="button" value="" name="gender"
          id="personalInfoUS--gender">Select One</button><input type="text" value="" /></div></div></div>
      </div>
      <div data-automation-id="formField-veteranStatus" data-fkit-id="personalInfoUS--veteranStatus">
        <label for="personalInfoUS--veteranStatus"><span>Do you identify as one of the following protected
          veterans (Disabled Veteran, Recently Separated Veteran, Active Duty Wartime or Campaign Badge
          Veteran, Armed Forces Service Medal Veteran)?<abbr aria-hidden="true">*</abbr></span></label>
        <div><div><div><button aria-haspopup="listbox" type="button" value="" name="veteranStatus"
          id="personalInfoUS--veteranStatus">Select One</button><input type="text" value="" /></div></div></div>
      </div>
      <h4>Terms and Conditions</h4>
      <div data-automation-id="formField-acceptTermsAndAgreements" data-fkit-id="termsAndConditions--acceptTermsAndAgreements">
        <div><input id="termsAndConditions--acceptTermsAndAgreements" name="acceptTermsAndAgreements"
          type="checkbox" aria-required="true" /></div>
        <label for="termsAndConditions--acceptTermsAndAgreements">By selecting the checkbox, you agree to our
          Terms and Conditions and Applicant Privacy Policy.</label>
      </div>
    </div>
  </div>`;

describe('Workday wizard · step 4 Voluntary Disclosures', () => {
  it('anchors applyFlowVoluntaryDisclosuresPage and reads all four controls', () => {
    const fields = scan(VOLUNTARY_DISCLOSURES);
    const labels = fields.map((field) => field.label);
    expect(labels.some((label) => label.includes('What is your ethnicity'))).toBe(true);
    expect(labels.some((label) => label.includes('What is your gender'))).toBe(true);
    expect(labels.some((label) => label.includes('protected'))).toBe(true);
    expect(labels.some((label) => label.includes('Terms and Conditions'))).toBe(true);
  });

  it('carries no canonical profile key, so only the relaxed lab gate reaches it', () => {
    expect(scan(VOLUNTARY_DISCLOSURES).filter((field) => field.key !== null)).toHaveLength(0);
  });
});

/**
 * Step 1's two `data-uxi-widget-type="selectinput"` prompts, which look
 * identical and behave differently. Measured 2026-09-15: "How Did You Hear
 * About Us?" opens onto six categories and hides its answers one level down,
 * while Country Phone Code opens straight onto ~200 countries, 13 rendered at a
 * time. A tiered walk descends by clicking a row — on the flat one that click
 * *is* the answer, which is how a host-prefilled "United States of America
 * (+1)" became "Anguilla (+1)" and got the whole page rejected.
 */
const TWO_PROMPTS = `
  <div data-automation-id="applyFlowMyInfoPage">
    <div data-automation-id="formField-legalName--firstName">
      <label for="name--legalName--firstName">First Name</label>
      <input id="name--legalName--firstName" type="text" name="firstName" aria-required="true" value="" />
    </div>
    <div data-automation-id="formField-source" data-fkit-id="source--source">
      <label for="source--source">How Did You Hear About Us?</label>
      <div data-automation-id="multiSelectContainer"><div data-automation-id="multiselectInputContainer">
        <input id="source--source" data-uxi-widget-type="selectinput" aria-required="true" value="" />
      </div></div>
    </div>
    <div data-automation-id="formField-countryPhoneCode" data-fkit-id="phoneNumber--countryPhoneCode">
      <label for="phoneNumber--countryPhoneCode">Country Phone Code</label>
      <div data-automation-id="multiSelectContainer"><div data-automation-id="multiselectInputContainer">
        <input id="phoneNumber--countryPhoneCode" data-uxi-widget-type="selectinput" aria-required="true" value="" />
      </div></div>
    </div>
  </div>`;

describe('Workday · only the measured prompt is declared tiered', () => {
  it('binds the hierarchical walk to "How Did You Hear About Us?"', () => {
    const found = scan(TWO_PROMPTS).find((field) => (field.element as Element).id === 'source--source');
    expect(found?.kind).toBe('combobox');
    // 运行时断言不给类型收窄，所以显式取 combobox 分支再读 listbox。
    const source = found?.kind === 'combobox' ? found : null;
    expect(source?.listbox?.hierarchicalPrompt).toBeDefined();
  });

  it('leaves the flat Country Phone Code prompt off it', () => {
    const flat = scan(TWO_PROMPTS).find((field) => (field.element as Element).id === 'phoneNumber--countryPhoneCode');
    const code = flat?.kind === 'combobox' ? flat : null;
    expect(code?.listbox?.hierarchicalPrompt).toBeUndefined();
  });
});

describe('Workday wizard · the legend scope does not disturb step 1', () => {
  it('keeps the previous-worker radio group’s wording and grouping', () => {
    const fields = scan(PREVIOUS_WORKER);
    const radio = fields.find((field) => (field.element as HTMLInputElement).type === 'radio');
    expect(radio).toBeDefined();
    expect(radio!.label).toContain('previously worked for NVIDIA');
    // One question, not two: both radios share a name and a wrapper.
    expect(fields.filter((field) => (field.element as HTMLInputElement).type === 'radio')).toHaveLength(1);
  });

  it('leaves a wrapper that has exactly one <label> on the label scope', () => {
    const fields = scan(PREVIOUS_WORKER);
    const first = fields.find((field) => field.key === 'firstName');
    expect(first!.label).toContain('First Name');
  });
});
