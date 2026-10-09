import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseDailyPreferences, parseCompanionDailySettings, parseCompanionDailySettingsCommand, DAILY_PREFERENCE_DEFAULTS } from '../src/companion-daily-settings.ts';
const prefs = { ...DAILY_PREFERENCE_DEFAULTS, timeZone: 'America/New_York' };
const base = { ownerId: randomUUID(), companionId: randomUUID(), preferences: null, revision: 0, updatedAt: null, lastOperationId: null };
test('an unchosen timezone is represented by null preferences; defaults are not saved consent', () => {
 assert.deepEqual(parseCompanionDailySettings(base), base); assert(Object.isFrozen(DAILY_PREFERENCE_DEFAULTS));
 assert.throws(() => parseCompanionDailySettings({ ...base, preferences: prefs }));
 for (const timeZone of ['America/New_York','America/Los_Angeles','Asia/Shanghai','UTC']) assert.equal(parseDailyPreferences({ ...prefs, timeZone }).timeZone, timeZone);
 assert.equal(parseDailyPreferences({ ...prefs, dailyMinutes: 0 }).dailyMinutes, 0);
});
test('timezones, clock times, distinct quiet endpoints, minutes and delivery choices are strict', () => {
 for (const patch of [{timeZone:''},{timeZone:'Mars/City'},{timeZone:'+08:00'},{morningTime:'9:00'},{morningTime:'24:00'},{quietEnd:'22:30'},{dailyMinutes:-1},{dailyMinutes:1.5},{dailyMinutes:1441},{dailyMinutes:'90'},{webAlert:'push'},{confirmed:true}]) assert.throws(() => parseDailyPreferences({ ...prefs, ...patch }));
});
test('saved choices require a complete receipt and freeze nested preferences', () => {
 const command = { companionId: base.companionId, operationId: randomUUID(), expectedRevision: 0, preferences: prefs };
 const parsed = parseCompanionDailySettingsCommand(command); assert(Object.isFrozen(parsed.preferences));
 const saved = { ...base, preferences: prefs, revision: 1, updatedAt:'2026-10-09T00:00:00.000Z', lastOperationId:command.operationId };
 assert.deepEqual(parseCompanionDailySettings(saved), saved);
 for (const patch of [{lastOperationId:null},{preferences:null},{updatedAt:'2026-10-09'},{revision:-0},{ownerId:'invalid'}]) assert.throws(() => parseCompanionDailySettings({ ...saved, ...patch }));
 assert.throws(() => parseCompanionDailySettingsCommand({ ...command, expectedRevision:2147483647 }));
});
