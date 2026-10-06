import { useEffect, useMemo, useState } from 'react';
import { request } from './api';
import { UsageAccountController, UsageAccountView, visibleAccountUsage, type UsageAccountState } from './usage-account';
import './usage.css';

export default function UsagePanel({ userId }: { userId: string }) {
  const [state, setState] = useState<UsageAccountState>({ accountId: userId, status: 'loading' });
  const controller = useMemo(() => new UsageAccountController(request, setState), []);
  useEffect(() => { void controller.activate(userId); return () => controller.dispose(); }, [controller, userId]);
  return <UsageAccountView state={visibleAccountUsage(state, userId)} onRefresh={() => { void controller.refresh(); }} />;
}
