import assert from 'node:assert/strict';
import test from 'node:test';
import {AppearanceStore} from '../src/appearance.ts';
import {APPEARANCE_STORAGE_KEY,createBrowserAppearance} from '../src/appearance-browser.ts';
function fixture(initial:string|null=null) {
  let saved=initial,blockedRead=false,blockedWrite=false,listener:(()=>void)|undefined;
  const applied:string[]=[],writes:string[]=[];
  const store=new AppearanceStore({
    read(){if(blockedRead)throw Error('private browser error');return saved;},
    write(value){if(blockedWrite)throw Error('private browser error');saved=value;writes.push(value);},
    apply(value){applied.push(value);},
    listen(change){assert.equal(listener,undefined);listener=change;return()=>{listener=undefined;};},
  });
  return {store,applied,writes,readBlocked(value:boolean){blockedRead=value;},writeBlocked(value:boolean){blockedWrite=value;},
    external(value:string|null){saved=value;listener?.();},hasListener(){return !!listener;}};
}
test('initial preference accepts only the cosmetic enum and never rewrites stored data while reading',()=>{
  for(const value of [null,'system','light','dark','unknown','<script>fictional</script>','{"account":"fictional"}']) {
    const f=fixture(value);assert.equal(f.store.getSnapshot().preference,value==='light'||value==='dark'?value:'system');
    assert.equal(f.writes.length,0);assert(Object.isFrozen(f.store.getSnapshot()));
  }
});
test('a choice applies immediately, persists and restores in a fresh page without storing account data',()=>{
  const f=fixture();f.store.choose('dark');assert.deepEqual(f.writes,['dark']);assert.equal(f.applied.at(-1),'dark');
  assert.deepEqual(fixture(f.writes[0]).store.getSnapshot(),{preference:'dark',persistence:'saved'});
  f.store.choose('system');assert.equal(f.applied.at(-1),'system');assert.equal(f.writes.at(-1),'system');
  assert.throws(()=>f.store.choose('other' as any));assert.equal(f.writes.length,2);
});
test('blocked storage preserves a usable local choice and reports it as temporary, with explicit retry',()=>{
  const f=fixture('light');f.writeBlocked(true);f.store.choose('dark');
  assert.deepEqual(f.store.getSnapshot(),{preference:'dark',persistence:'session'});assert.equal(f.applied.at(-1),'dark');
  f.readBlocked(true);f.store.start();assert.equal(f.store.getSnapshot().preference,'dark');
  f.writeBlocked(false);f.store.choose('dark');assert.equal(f.store.getSnapshot().persistence,'saved');assert.deepEqual(f.writes,['dark']);
});
test('other tab changes and clear-data restore system; repeated values do not notify or write back',()=>{
  const f=fixture();let notifications=0;const unsubscribe=f.store.subscribe(()=>notifications++);f.store.start();f.store.start();
  f.external('dark');assert.equal(f.store.getSnapshot().preference,'dark');assert.equal(notifications,1);
  f.external('dark');assert.equal(notifications,1);f.external(null);assert.equal(f.store.getSnapshot().preference,'system');
  f.external('malformed');assert.equal(notifications,2);assert.equal(f.writes.length,0);
  unsubscribe();f.external('light');assert.equal(notifications,2);f.store.stop();assert(!f.hasListener());
  f.external('dark');assert.equal(f.store.getSnapshot().preference,'light');f.store.start();assert.equal(f.store.getSnapshot().preference,'dark');f.store.stop();
});
function browserFixture() {
  let saved:string|null=null,blocked=false;
  const events=new EventTarget(),attrs=new Map<string,string>(),writes:unknown[][]=[];
  const localStorage={getItem(key:string){assert.equal(key,APPEARANCE_STORAGE_KEY);if(blocked)throw Error('no storage');return saved;},
    setItem(key:string,value:string){if(blocked)throw Error('no storage');writes.push([key,value]);saved=value;}};
  const metas=[{dataset:{appearance:'light'},content:'#F1F3F7'},{dataset:{appearance:'dark'},content:'#0D131E'}];
  const fakeWindow={localStorage,addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)};
  const fakeDocument={documentElement:{removeAttribute:(key:string)=>attrs.delete(key),setAttribute:(key:string,value:string)=>attrs.set(key,value)},
    querySelectorAll:(query:string)=>{assert.equal(query,'meta[name="theme-color"][data-appearance]');return metas;}};
  const store=createBrowserAppearance(fakeWindow as any,fakeDocument as any);store.start();
  return {store,attrs,metas,writes,block(){blocked=true;},storage(value:string|null,key:string|null=APPEARANCE_STORAGE_KEY,foreign=false){
    saved=value;const e=new Event('storage');Object.assign(e,{key,storageArea:foreign?{}:localStorage,newValue:'outdated-value'});events.dispatchEvent(e);},
    pageShow(value:string|null){saved=value;events.dispatchEvent(new Event('pageshow'));}};
}
test('browser adapter applies explicit modes to root and both chrome colors, then restores media-specific system colors',()=>{
  const b=browserFixture();b.store.choose('dark');assert.equal(b.attrs.get('data-theme'),'dark');assert.deepEqual(b.metas.map(m=>m.content),['#0D131E','#0D131E']);
  b.store.choose('light');assert.equal(b.attrs.get('data-theme'),'light');assert.deepEqual(b.metas.map(m=>m.content),['#F1F3F7','#F1F3F7']);
  b.store.choose('system');assert(!b.attrs.has('data-theme'));assert.deepEqual(b.metas.map(m=>m.content),['#F1F3F7','#0D131E']);
  assert.deepEqual(b.writes,[[APPEARANCE_STORAGE_KEY,'dark'],[APPEARANCE_STORAGE_KEY,'light'],[APPEARANCE_STORAGE_KEY,'system']]);b.store.stop();
});
test('browser synchronization ignores unrelated/session storage, rereads authoritative value and handles clear plus page restoration',()=>{
  const b=browserFixture();b.storage('dark','unrelated');assert(!b.attrs.has('data-theme'));
  b.storage('dark',APPEARANCE_STORAGE_KEY,true);assert(!b.attrs.has('data-theme'));
  b.storage('dark');assert.equal(b.attrs.get('data-theme'),'dark');b.storage(null,null);assert(!b.attrs.has('data-theme'));
  b.pageShow('light');assert.equal(b.attrs.get('data-theme'),'light');b.store.stop();b.pageShow('dark');assert.equal(b.attrs.get('data-theme'),'light');
  assert.equal(b.writes.length,0);
});
test('unavailable browser storage never prevents rendering or applying a theme',()=>{
  const b=browserFixture();b.block();b.store.choose('dark');assert.equal(b.attrs.get('data-theme'),'dark');
  assert.equal(b.store.getSnapshot().persistence,'session');b.pageShow(null);assert.equal(b.attrs.get('data-theme'),'dark');b.store.stop();
});
