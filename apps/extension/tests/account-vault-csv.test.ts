import { describe, expect, it } from 'vitest';
import { passwordManagerCsv } from '../assistant/features/account-vault/csv';

/** Independent reader for quoted RFC 4180 fields, including embedded CR/LF. */
function readCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\r' && csv[index + 1] === '\n' && !quoted) {
      row.push(cell); rows.push(row); row = []; cell = ''; index += 1;
    } else cell += char;
  }
  expect(quoted).toBe(false);
  expect(row).toEqual([]);
  expect(cell).toBe('');
  return rows;
}

describe('lossless password-manager CSV', () => {
  it.each(['=password', '+password', '-password', '@password', 'a,b"c\r\nd\ne', '\tpassword', '中文密码'])
  ('roundtrips the actual password %s', (password) => {
    const parsed = readCsv(passwordManagerCsv([{ origin: 'https://careers.example.test', email: 'student@example.test', password }]));
    expect(parsed).toEqual([
      ['name', 'url', 'username', 'password'],
      ['careers.example.test', 'https://careers.example.test', 'student@example.test', password],
    ]);
  });

  it('keeps per-site usernames distinct and represents a missing email honestly', () => {
    expect(readCsv(passwordManagerCsv([
      { origin: 'https://first.example.test', email: 'first@example.test', password: 'first' },
      { origin: 'https://second.example.test', email: null, password: 'second' },
    ]))).toEqual([
      ['name', 'url', 'username', 'password'],
      ['first.example.test', 'https://first.example.test', 'first@example.test', 'first'],
      ['second.example.test', 'https://second.example.test', '', 'second'],
    ]);
  });

  it('does not invent an export row when the vault has no site credentials', () => {
    expect(readCsv(passwordManagerCsv([]))).toEqual([['name', 'url', 'username', 'password']]);
  });

  it('preserves an unbound legacy password without inventing a site URL', () => {
    expect(readCsv(passwordManagerCsv([], { password: '=legacy,"value"', email: 'old@example.test' }))).toEqual([
      ['name', 'url', 'username', 'password'],
      ['旧共用密码（未关联网站）', '', 'old@example.test', '=legacy,"value"'],
    ]);
  });
});
