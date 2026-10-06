import {createAutofillFixture} from '../testing/autofill-fixture';
import {createCommerceFixture,COMMERCE_FIXTURE_ROLE,COMMERCE_FIXTURE_RESUME} from '../testing/commerce-fixture';
import { createIntakeFixture } from '../testing/intake-fixture';
import { createRoleFixture } from '../testing/role-fixture';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantApp } from '../app/AssistantApp';
import { createAssistantController } from '../app/controller';
import { createReadOnlyPorts } from '../features/session/read-only-ports';
import { initialAssistantState } from '../state/initial';
import { previewData } from '../testing/fixtures';
import { createProfileFixture } from '../testing/profile-fixture';
import { fictionalProfileSnapshot } from '../testing/profile-snapshot';
import '../design/tokens.css';
const fixture = createProfileFixture(), roleFixture = createRoleFixture();
const intakeFixture = createIntakeFixture(fixture);
const roleMode = new URLSearchParams(location.search).get('mode') === 'roles';
const commerceMode=new URLSearchParams(location.search).get('mode')==='jobs',commerceFixture=createCommerceFixture();
const connected = async () => ({ ok: true as const, value: undefined });
const ui = createAssistantController(previewData, { ...createReadOnlyPorts({ login: connected, logout: connected, refresh: connected }), ...(commerceMode?{commerce:commerceFixture.ports,autofill:createAutofillFixture()}:{}),profile: fixture.ports, privateIntake: intakeFixture.ports, ...(roleMode ? { roles: roleFixture.ports } : {}) }, {
  ...initialAssistantState(previewData, { persona: 'out', entitlements: { ats: { access: 'locked' }, jobs: { access: 'locked' }, letters: { access: 'locked' }, chat: { access: 'locked' }, voice: { access: 'locked' } } }),
  session: 'connected', scene: commerceMode?'home':'profile',
  ...(commerceMode?{currentTargetId:COMMERCE_FIXTURE_ROLE,targets:[{id:COMMERCE_FIXTURE_ROLE,role:'Product Designer',locations:'Toronto',workMode:'Hybrid',salary:'',start:'',source:'Portal',savedAt:''}],hasResume:true,resumeId:COMMERCE_FIXTURE_RESUME,
    resumeOptions:[{id:COMMERCE_FIXTURE_RESUME,track:'Product Design',version:'v1',label:'Product design · v1',kind:'existing' as const,current:true,note:''}]}:{}), profileV2: fictionalProfileSnapshot('Example Person')!, profileEditingEnabled: true, intakeEnabled: true, roleManagementEnabled: roleMode, ...(roleMode ? { sheet: { kind: 'targets' as const } } : {}),
  reads: { personal: 'ready', profileV2: 'ready', resumes: 'ready', processingCount: 0, failedCount: 0, hasMoreVersions: false },
});
if (roleMode) void ui.roles.refresh();
if(commerceMode)void ui.commerce.usage();
function Preview() {
  const [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight - 80 });
  useEffect(() => { const resize = () => setViewport({ width: innerWidth, height: innerHeight - 80 }); addEventListener('resize', resize); return () => removeEventListener('resize', resize); }, []);
  return <><header style={{ height: 80, padding: '10px 16px', fontSize: 12 }}><b>ArgoLand.AI S3–S7 · Fictional {commerceMode?'jobs and ATS':roleMode ? 'role preferences' : 'profile editor'}</b><p style={{ margin: '4px 0' }}>Local memory only. No real account or backend.</p><label>Save scenario <select aria-label="Save scenario" onChange={e => (roleMode ? roleFixture : fixture).scenario(e.target.value as Parameters<typeof fixture.scenario>[0])}><option value="normal">Saved</option><option value="conflict">Concurrent update</option><option value="uncertain">Saved, response lost</option><option value="slow">Slow save</option></select></label></header><main style={{ position: 'relative', height: 'calc(100% - 80px)', background: '#eef2f6' }}><AssistantApp controller={ui} viewport={viewport}/></main></>;
}
const root = document.getElementById('root'); if (!root) throw new Error('ASSISTANT_PROFILE_PREVIEW_ROOT_MISSING');
createRoot(root).render(<Preview/>);
if (import.meta.hot) import.meta.hot.dispose(() => ui.dispose());
