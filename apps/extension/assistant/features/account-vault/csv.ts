/** Password-manager CSV. Do not rewrite credentials to accommodate spreadsheet formulas. */
export interface PasswordExportRow {
  readonly origin: string;
  readonly email: string | null;
  readonly password: string;
}

const csvCell = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/** RFC 4180 quoting preserves quotes, newlines and formula-like passwords exactly. */
export function passwordManagerCsv(rows: readonly PasswordExportRow[], legacy: Readonly<{ password: string; email: string | null }> | null = null): string {
  const records = rows.map((row) => [new URL(row.origin).hostname, row.origin, row.email ?? '', row.password]);
  // No invented URL: this legacy credential must be saved/imported manually.
  if (legacy !== null) records.push(['旧共用密码（未关联网站）', '', legacy.email ?? '', legacy.password]);
  return [['name', 'url', 'username', 'password'], ...records]
    .map((record) => record.map(csvCell).join(','))
    .join('\r\n') + '\r\n';
}
