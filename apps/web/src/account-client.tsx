import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { BoundPlatformClient } from './api.ts';

const AccountClient = createContext<BoundPlatformClient | null>(null);
/** The owner supplies the rendered account's immutable capture; old UI cannot adopt a new global user. */
export function PlatformAccountClientProvider({ value, children }: { value: BoundPlatformClient | null; children: ReactNode }) {
  return <AccountClient.Provider value={value}>{children}</AccountClient.Provider>;
}
const noSubscription = () => () => {};
const inactive = () => false;
export function usePlatformAccountClient(): BoundPlatformClient | null {
  const client = useContext(AccountClient);
  useSyncExternalStore(client?.subscribe ?? noSubscription, client?.isCurrent ?? inactive, inactive);
  return client;
}
export function useRequiredPlatformAccountClient(): BoundPlatformClient {
  const client = usePlatformAccountClient();
  if (!client) throw new Error('私有工作台缺少账号请求上下文。');
  return client;
}
