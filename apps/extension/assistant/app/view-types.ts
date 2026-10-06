import type { ChangeEventHandler } from 'react';
import type { AssistantView } from './view-model';

export interface AssistantEvents {
  onStreamDone(id: string): void;
  reduced: boolean;
  active: boolean;
  onInput: ChangeEventHandler<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
  onChange: ChangeEventHandler<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
}
export interface SceneProps { view: AssistantView; events: AssistantEvents }
