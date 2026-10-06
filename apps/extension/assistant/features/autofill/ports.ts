import type {
  AssistantAutofillOperation,
  AssistantAutofillSelection,
  AssistantAutofillResult,
} from "@edaix/contracts";
export interface AutofillPorts {
  execute(
    operation: AssistantAutofillOperation,
    selection: AssistantAutofillSelection,
    signal: AbortSignal,
    reviewId?: string,
  ): Promise<AssistantAutofillResult>;
}
