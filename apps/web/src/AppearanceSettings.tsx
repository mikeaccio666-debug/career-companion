import {useSyncExternalStore} from 'react';
import {DEFAULT_APPEARANCE} from './appearance';
import {getAppearanceStore} from './appearance-browser';
import './appearance-settings.css';

export function AppearanceSettings() {
  const store = getAppearanceStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, () => DEFAULT_APPEARANCE);
  return <section className="appearance-settings" aria-labelledby="appearance-heading">
    <h2 id="appearance-heading">外观</h2>
    <p id="appearance-description">只保存在这个浏览器，不影响其他设备。</p>
    <fieldset aria-describedby="appearance-description">
      <legend>选择显示方式</legend>
      {([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([value, label]) =>
        <label key={value}><input type="radio" name="appearance" value={value} checked={state.preference === value}
          onChange={() => store.choose(value)}/><span>{label}</span></label>)}
    </fieldset>
    <p className="appearance-feedback" role="status">{state.persistence === 'session'
      ? '浏览器暂时无法保存，选择只在当前页面生效。' : ''}</p>
  </section>;
}
