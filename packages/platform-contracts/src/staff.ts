/** Organization roles are server-managed records, never client authorization. */
export const STAFF_ROLES = ['content_editor', 'content_reviewer', 'mentor', 'ops', 'org_admin', 'safety_reviewer'] as const;
export type StaffRole = typeof STAFF_ROLES[number];

export interface StaffOrganization {
  id: string;
  slug: string;
  displayName: string;
  status: 'active' | 'disabled';
}

/** Internal organization directory metadata; contains no student material or contact details. */
export interface StaffMembership {
  organizationId: string;
  userId: string;
  role: StaffRole;
}
