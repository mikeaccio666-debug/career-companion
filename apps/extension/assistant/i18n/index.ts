import en from './en-US.json';
import zh from './zh-CN.json';
import { ASSISTANT_UI_LOCALES, isAssistantUiLocale } from '@edaix/contracts';

/** Kept equal to Portal's UI locales by assistant-locale.test.ts. Content language is separate. */
export const ASSISTANT_LOCALES = ASSISTANT_UI_LOCALES;
export type AssistantLocale = typeof ASSISTANT_LOCALES[number];
export type MessageKey = keyof typeof en;
export type Translator = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
export const messages = { 'en-US': en, 'zh-CN': zh };
export function isAssistantLocale(value: unknown): value is AssistantLocale {
  return isAssistantUiLocale(value);
}
export const resolveAssistantLocale = (value: unknown): AssistantLocale => isAssistantLocale(value) ? value : 'en-US';
export function createTranslator(locale: AssistantLocale): Translator {
  // Single pass: user-provided replacements are neither translated nor interpreted as placeholders.
  return (key, values = {}) => messages[locale][key].replace(/\{(v\d+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder);
}
