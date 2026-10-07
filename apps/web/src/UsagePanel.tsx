import { useEffect, useMemo, useState } from 'react';
import { useRequiredPlatformAccountClient } from './account-client';
import { UsageAccountController, UsageAccountView, visibleAccountUsage, type UsageAccountState } from './usage-account';
import './usage.css';

export default function UsagePanel({ userId, aggregate = false }: { userId: string; aggregate?: boolean }) {
  const accountClient = useRequiredPlatformAccountClient();
  const [state, setState] = useState<UsageAccountState>({ accountId: userId, status: 'loading' });
  const controller = useMemo(() => new UsageAccountController(accountClient.request, setState, { aggregate }), [accountClient, aggregate]);
  useEffect(() => { void controller.activate(userId); return () => controller.dispose(); }, [controller, userId]);
  return <UsageAccountView details={!aggregate} state={visibleAccountUsage(state, userId)} onRefresh={() => { void controller.refresh(); }} />;
}
