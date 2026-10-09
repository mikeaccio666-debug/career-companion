import { lazyFeature } from '../LazyFeature';
import { useRequiredPlatformAccountClient } from '../account-client';
import { orgSourceReferenceFromPath } from '../org-source-api';
import type { User } from '../types';
import type { StudentRoute } from './student-route';
import '../career-design-tokens.css';
import './student-route.css';

const JourneyPage = lazyFeature(async () => ({ default: (await import('../journey-view')).JourneyPage }), '旅程');
const StudentMePage = lazyFeature(async () => ({ default: (await import('../student-me-view')).StudentMePage }), '我');
const CompanionPaidSettingsPage = lazyFeature(async () => ({ default: (await import('../companion-paid-settings-view')).CompanionPaidSettingsPage }), '主理人设置');
const MentorIntentPage = lazyFeature(async () => ({ default: (await import('../mentor-intent-view')).MentorIntentPage }), '蔓藤导师');
const OrgSourcePage = lazyFeature(async () => ({ default: (await import('../org-source-view')).OrgSourcePage }), '资料来源');
const CareerInterviewPage = lazyFeature(async () => ({ default: (await import('../career-interview-view')).CareerInterviewPage }), '面试安排');
const CareerIdentityPage = lazyFeature(async () => ({ default: (await import('../career-identity-view')).CareerIdentityPage }), '身份资料');
const CareerApplicationPage = lazyFeature(async () => ({ default: (await import('../career-application-view')).CareerApplicationPage }), '投递看板');
const ResumeReviewPage = lazyFeature(async () => ({ default: (await import('../resume-review-view')).ResumeReviewPage }), '简历确认');
const CareerStoryPage = lazyFeature(async () => ({ default: (await import('../career-story-view')).CareerStoryPage }), '项目与故事');
const ManualJobPage = lazyFeature(async () => ({ default: (await import('../manual-job-view')).ManualJobPage }), '收藏岗位');
const CareerTargetPage = lazyFeature(async () => ({ default: (await import('../career-target-view')).CareerTargetPage }), '目标方向');
const SharedMemoryPage = lazyFeature(async () => ({ default: (await import('../shared-memory-view')).SharedMemoryPage }), '共享记忆');

export function MissingStudentRecord({ route }: { route: Extract<StudentRoute, { kind: 'missing' }> }) {
  return <main className="career-surface student-route-missing" aria-labelledby="student-route-title">
    <header><span>求职小组</span><small>都是 AI</small></header>
    <section><h1 id="student-route-title">这条内容不存在或已经处理</h1>
      <p>可以回到列表，查看当前账号的记录。</p><a href={route.returnHref}>{route.returnLabel}</a></section>
  </main>;
}

/** Mounted only after App's account, legal and first-letter gates. A changed
 * account cannot keep rendering the preceding account's page or lazy loader. */
export function StudentRoutes({ route, user, onLogout }: {
  route: StudentRoute; user: User; onLogout: () => void;
}) {
  const client = useRequiredPlatformAccountClient();
  if (!client.isCurrent() || client.account.accountId !== user.id) return null;
  if (route.kind === 'missing') return <MissingStudentRecord route={route} />;
  if (route.kind === 'source') return <OrgSourcePage reference={orgSourceReferenceFromPath(route.pathname)} onLogout={onLogout} />;
  switch (route.page) {
    case 'journey': return <JourneyPage onLogout={onLogout} />;
    case 'pending': return <ResumeReviewPage initialItemId={route.id} onLogout={onLogout} />;
    case 'stories': return <CareerStoryPage initialStoryId={route.id} onLogout={onLogout} />;
    case 'interviews': return <CareerInterviewPage initialInterviewId={route.id} onLogout={onLogout} />;
    case 'applications': return <CareerApplicationPage initialApplicationId={route.id} onLogout={onLogout} />;
    case 'jobs': return <ManualJobPage onLogout={onLogout} />;
    case 'targets': return <CareerTargetPage onLogout={onLogout} />;
    case 'mentors': return <MentorIntentPage onLogout={onLogout} />;
    case 'profile': return <CareerIdentityPage onLogout={onLogout} />;
    case 'companion': return <CompanionPaidSettingsPage onLogout={onLogout} />;
    case 'memory': return <SharedMemoryPage onLogout={onLogout} />;
    case 'me': return <StudentMePage user={user} onLogout={onLogout} />;
  }
}
