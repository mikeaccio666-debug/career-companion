/**
 * Workday rule adapter.
 *
 * This module is deterministic scaffolding only. Production vendor authority
 * remains the backend's exact `(atsProvider, pathRuleId)` runtime mapping; the
 * static registry intentionally stays `null` until that contract is released.
 */

import rules from '@edaix/apply-rules/workday.json';
import { compileBundledAdapter } from '../../rules/interpreter';

export const workdayAdapter = compileBundledAdapter(rules);
