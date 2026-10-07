import { expectedSafetyResponseBundleDigests, parseSafetyResponseBundle, type SafetyResponseBundle } from '../../src/safety-response-bundle.ts';

/** Synthetic non-clinical content only. Neither integrity nor fixture activation is professional approval. */
export function fictionalBundle(revision = 7): SafetyResponseBundle {
  const pair = (zh: string, en = zh) => ({ zh, en });
  const locale = (language: 'zh' | 'en') => ({
    L1: { text: language === 'zh' ? '虚构 L1 用户[{{userName}}] 主理人[{{companionName}}]。' : 'Fictional L1 user[{{userName}}] companion[{{companionName}}].' },
    L2: {
      text: language === 'zh' ? '虚构 L2 用户[{{userName}}] 主理人[{{companionName}}]。' : 'Fictional L2 user[{{userName}}] companion[{{companionName}}].',
      safetyQuestion: language === 'zh' ? '虚构测试问题：{{userName}}，此合成测试准备好了吗？' : 'Fictional fixture question: {{userName}}, is this synthetic test ready?',
    },
    resourceCard: {
      title: language === 'zh' ? '虚构资源' : 'Fictional resources',
      footer: language === 'zh' ? '虚构测试不会替你联系任何人。' : 'This fictional fixture does not contact anyone.',
      schoolUnknown: language === 'zh' ? '虚构学校未知指引。' : 'Fictional unknown-school instruction.',
      outsideUsLabel: language === 'zh' ? '虚构境外提示' : 'Fictional outside-country label',
    },
  });
  const content = {
    schemaVersion: 1, revision, retentionDays: 17,
    review: { reference: 'fictional-bundle-integrity-not-professional-approval', approvedAt: '2026-01-01T00:00:00.000Z' },
    locales: { zh: locale('zh'), en: locale('en') },
    resources: {
      outsideUs: pair('虚构境外说明，无具体联系方式。', 'Fictional outside explanation without a contact destination.'),
      contacts: ['lifeline_988', 'emergency_911', 'crisis_text_line'].map((id, index) => ({
        id, verifiedAt: '2026-01-01T00:00:00.000Z', reviewRef: 'fictional-contact-integrity-reference-' + index,
        name: pair('虚构资源 ' + index, 'Fictional resource ' + index),
        description: pair('虚构资源说明。', 'Fictional resource explanation.'),
        actions: [
          { kind: 'call', number: '+1555010010' + index, label: pair('虚构拨号', 'Synthetic call') },
          { kind: 'web', url: 'https://resources.example.com/fictional-' + index, label: pair('虚构链接', 'Synthetic website') },
        ],
      })),
    },
  };
  return parseSafetyResponseBundle({ ...content, ...expectedSafetyResponseBundleDigests(content) });
}
