/**
 * Frontend account actions pending three-person review against the backend
 * AuthModule contract. Registration reuses stable RegisterAuthRequest/Response.
 */

export type PasswordResetRequest = {
  readonly email: string;
};

export type ResetPasswordRequest = {
  readonly token: string;
  readonly password: string;
};

export type AccountActionResult = {
  readonly ok: true;
};
