import { describe, it, expect } from 'vitest';
import { isSecretSettings, stripSecrets } from './secrets.js';
describe('enrollment secret classification', () => { it('requires encrypted storage and strips public copies', () => { const input = { labEnrollment: { signingSecret: 'test-only-secret' }, labPayments: { stripeKey: 'test-key' } }; expect(isSecretSettings(input)).toBe(true); expect(stripSecrets(input).labEnrollment).toEqual({}); expect(input.labEnrollment.signingSecret).toBe('test-only-secret'); }); });
