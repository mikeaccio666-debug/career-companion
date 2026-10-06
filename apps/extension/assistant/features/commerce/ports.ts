import type { AssistantCommerceCommand, AssistantCommerceResult } from '@edaix/contracts';
export interface CommercePorts { execute(command:AssistantCommerceCommand,signal:AbortSignal):Promise<AssistantCommerceResult> }
