// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAssistantController } from '../assistant/app/controller';
import { ProfileEditor } from '../assistant/features/profile/ProfileEditor';
import { createProfileDraft, addProfileRow, PROFILE_SECTIONS, isCollection } from '../assistant/features/profile/editor-model';
import { initialAssistantState } from '../assistant/state/initial';
import { previewData } from '../assistant/testing/fixtures';
import { createPreviewPorts } from '../assistant/testing/preview-ports';
import { fictionalProfileSnapshot } from '../assistant/testing/profile-snapshot';
describe('profile editor translations and form coverage', () => {
  it.each(['en-US', 'zh-CN'] as const)('renders every ordinary group in %s without missing messages', locale => {
    for (const section of PROFILE_SECTIONS) {
      const base = fictionalProfileSnapshot('Example Person')!;
      let draft = createProfileDraft(base, section);
      if (isCollection(section)) draft = addProfileRow(draft, 'example');
      const ui = createAssistantController(previewData, createPreviewPorts().ports, { ...initialAssistantState(previewData, { persona: 'out', locale, entitlements: { ats: { access: 'locked' }, jobs: { access: 'locked' }, letters: { access: 'locked' }, chat: { access: 'locked' }, voice: { access: 'locked' } } }), profileEditor: { draft, phase: 'editing' } });
      const markup = renderToStaticMarkup(<ProfileEditor controller={ui}/>);
      expect(markup).toContain('profile-save'); expect(markup).not.toContain('undefined'); ui.dispose();
    }
  });
});

it('closes the private-intake scene and transport together when role management is disabled', async () => {
  const { privateIntakeFeature } = await import('../assistant/features/intake/feature');
  const { AssistantApp } = await import('../assistant/app/AssistantApp');
  const { createReadOnlyPorts } = await import('../assistant/features/session/read-only-ports');
  const feature=privateIntakeFeature(false,()=>{throw new Error('DISABLED_PORT_CREATED');});
  const ports=createReadOnlyPorts({login:async()=>({ok:true,value:undefined}),logout:async()=>({ok:true,value:undefined}),refresh:async()=>({ok:true,value:undefined})});
  const ui=createAssistantController(previewData,{...ports,...feature.ports},{...initialAssistantState(previewData,{persona:'out',entitlements:{ats:{access:'locked'},jobs:{access:'locked'},letters:{access:'locked'},chat:{access:'locked'},voice:{access:'locked'}}}),scene:'chat',session:'connected',intakeEnabled:feature.intakeEnabled});
  const {createRoot}=await import('react-dom/client'); const {flushSync}=await import('react-dom');
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
  flushSync(()=>root.render(<AssistantApp controller={ui} viewport={{width:1280,height:720}}/>));
  const markup=node.innerHTML;
  expect(markup).not.toContain('argo-intake-heading'); expect(feature.ports).not.toHaveProperty('privateIntake');
  flushSync(()=>root.unmount());node.remove();ui.dispose();
});
