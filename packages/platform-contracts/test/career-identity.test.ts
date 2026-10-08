import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CAREER_IDENTITY_FIELDS, careerIdentityCalendarDate, parseCareerIdentityCommand, parseCareerIdentityRecord } from '../src/career-identity.ts';
const command = (field = 'program_end_date', value: unknown = '2028-02-29', label: unknown = null) => ({ operationId: randomUUID(), expectedRevision: 0, field, value, label });
test('calendar dates preserve the reported day without timezone or legal arithmetic', () => {
    for (const v of ['0001-01-01', '1900-02-28', '2000-02-29', '2028-02-29', '9999-12-31'])
        assert.equal(careerIdentityCalendarDate(v), v);
    for (const v of ['0000-01-01', '1900-02-29', '2026-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-12-00', '2026-1-01', '2026-01-01T00:00:00Z', '2026-01-01 ', null, {}, 1])
        assert.throws(() => careerIdentityCalendarDate(v));
});
test('owner values retain explicit false, zero, unknown and arbitrary self-reported status without interpretation', () => {
    const examples: Record<string, unknown> = { program_end_date: '2028-02-29', stem_designated: false, opt_status: 'Fictional owner wording', opt_start_date: '2026-01-01', opt_end_date: '2025-01-01', stem_opt_start_date: '2024-01-01', stem_opt_end_date: '2023-01-01', unemployment_days_reported: { days: 0 }, employment_reported: false, h1b_registration: { year: 2026, outcome: 'unknown' }, custom_status_date: '2027-01-01' };
    for (const field of CAREER_IDENTITY_FIELDS) {
        const v = parseCareerIdentityCommand('create', command(field, examples[field], field === 'custom_status_date' ? 'Fictional personal date' : null));
        assert.deepEqual(v.value, examples[field]);
        assert(Object.isFrozen(v));
    }
    for (const v of [-0, -1, 1.5, NaN, Infinity, '5'])
        assert.throws(() => parseCareerIdentityCommand('create', command('unemployment_days_reported', { days: v })));
    assert.equal((parseCareerIdentityCommand('create', command('unemployment_days_reported', { days: 1000 })).value as {
        days: number;
    }).days, 1000);
    for (const outcome of ['selected', 'not_selected', 'unknown'])
        assert.doesNotThrow(() => parseCareerIdentityCommand('create', command('h1b_registration', { year: 2026, outcome })));
});
test('owner commands cannot supply privileges, inferred dates, sensitivity, confirmation or reminder behavior', () => {
    for (const extra of [{ ownerId: randomUUID() }, { source: 'derived' }, { sensitivity: 'normal' }, { confirmedAt: '2026-01-01T00:00:00.000Z' }, { remindBeforeDays: 10 }, { eligible: true }, { unemployment_start_date: '2026-01-01' }, { remainingDays: 90 }])
        assert.throws(() => parseCareerIdentityCommand('create', { ...command(), ...extra }));
    for (const field of ['unemployment_reminder_days', 'eligibility', 'derived_end_date'])
        assert.throws(() => parseCareerIdentityCommand('create', command(field, 10)));
    assert.throws(() => parseCareerIdentityCommand('create', command('unemployment_days_reported', { days: 1, reportedAt: '2026-01-01T00:00:00.000Z' })));
    assert.throws(() => parseCareerIdentityCommand('create', command('h1b_registration', { year: 2026, outcome: 'approved' })));
    assert.throws(() => parseCareerIdentityCommand('create', command('stem_designated', 'false')));
    assert.throws(() => parseCareerIdentityCommand('create', command('custom_status_date', '2026-01-01', null)));
    const getter = command();
    Object.defineProperty(getter, 'value', { enumerable: true, get() { throw Error('must not evaluate owner accessor'); } });
    assert.throws(() => parseCareerIdentityCommand('create', getter));
});
test('encrypted-record codec requires fixed sensitivity and actual reporting/confirmation timestamps', () => {
    const at = '2026-10-08T12:00:00.000Z', record = { id: randomUUID(), ownerId: randomUUID(), field: 'program_end_date', value: '2027-01-01', label: null, source: 'user_entered', sensitivity: 'sensitive', confirmedAt: at, remindBeforeDays: null, revision: 1, createdAt: at, updatedAt: at, lastOperationId: randomUUID() };
    assert.equal(parseCareerIdentityRecord(record).value, record.value);
    for (const patch of [{ sensitivity: 'normal' }, { sensitivity: 'restricted' }, { source: 'user_uploaded' }, { remindBeforeDays: 0 }, { confirmedAt: '2026-10-07T12:00:00.000Z' }])
        assert.throws(() => parseCareerIdentityRecord({ ...record, ...patch }));
    const days = { ...record, field: 'unemployment_days_reported', value: { days: 0, reportedAt: at }, sensitivity: 'restricted' };
    assert.equal((parseCareerIdentityRecord(days).value as {
        days: number;
    }).days, 0);
    assert.throws(() => parseCareerIdentityRecord({ ...days, value: { days: 0, reportedAt: '2026-10-07T12:00:00.000Z' } }));
});
