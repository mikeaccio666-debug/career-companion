import { describe, expect, it } from 'vitest';
import { parseAssistantRoleRequest, parseAssistantRoleResponse, parseAssistantRoleView } from '../src/assistantRoles.ts';
import { parseAssistantReadRequest } from '../src/assistantRead.ts';
import { parseAssistantProfileRequest } from '../src/assistantProfile.ts';
const id = '11111111-1111-4111-8111-111111111111';
const preferences = { preferredLocation: 'Toronto', workMode: null, salary: null, availableFrom: null };
describe('isolated Role wire', () => {
  it('keeps Role commands off old read/profile ports and rejects owner or endpoint injection', () => {
    const value = { kind: 'assistant/roles-v1', id, operation: 'PATCH_ROLE_PREFS', conversationId: id, patch: { expectedRevision: '2', preferences } };
    expect(parseAssistantRoleRequest(value)).toEqual(value);
    expect(parseAssistantReadRequest({ ...value, kind: 'assistant/read-v1' })).toBeNull();
    expect(parseAssistantProfileRequest({ ...value, kind: 'assistant/profile-v1' })).toBeNull();
    expect(parseAssistantRoleRequest({ ...value, ownerId: id })).toBeNull();
    expect(parseAssistantRoleRequest({ ...value, url: 'https://foreign.test' })).toBeNull();
  });
  it('projects only role metadata from full server conversation details', () => {
    const role = { id, revision: '3', targetRole: 'Designer', status: 'ACTIVE', jobPreferences: { preferredLocation: null } };
    expect(parseAssistantRoleView({ ...role, lastMessagePreview: { text: 'PRIVATE' }, personas: ['private'] })).toEqual(role);
    expect(parseAssistantRoleResponse({ kind: 'assistant/roles-result-v1', id, operation: 'LIST_ROLES', ok: true, value: { items: [role, role], nextCursor: null } })).toBeNull();
  });
  it('accepts closed create with immutable role label and rejects extra authority', () => {
    const request = { clientRequestId: id, kind: 'ROLE', targetRole: 'Designer', title: 'Designer', jobPreferences: { preferredLocation: null } };
    const command = { kind: 'assistant/roles-v1', id, operation: 'CREATE_ROLE', request };
    expect(parseAssistantRoleRequest(command)).toEqual(command);
    expect(parseAssistantRoleRequest({ ...command, request: { ...request, title: 'Renamed' } })).toBeNull();
    expect(parseAssistantRoleRequest({ ...command, request: { ...request, userId: id } })).toBeNull();
    expect(parseAssistantRoleRequest({ ...command, request: { ...request, targetRole: '\ud800', title: '\ud800' } })).toBeNull();
  });
});
