/** New-product deployment boundary. The reserved .invalid TLD cannot be a live backend.
 * Configure loopback origins explicitly for local development. A future production
 * deployment must replace these two values deliberately and pass artifact gates.
 * Build config and worker import the same constants; neither inherits ArgoLand.
 */
export const PRODUCTION_API_BASE = 'https://api.career-companion.invalid';
export const PRODUCTION_WEB_APP_BASE = 'https://career-companion.invalid';
