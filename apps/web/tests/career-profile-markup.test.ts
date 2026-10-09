import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const webRoot = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(webRoot, '.local'), { recursive: true });
const directory = await mkdtemp(path.join(webRoot, '.local', 'profile-markup-test-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = await build({ stdin: { contents: "export { CareerProfileScene, CareerProfilePanel } from './src/career-profile-view'; export { PlatformAccountClientProvider } from './src/account-client';", resolveDir: webRoot, loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
const filename = path.join(directory, 'entry.mjs');
await writeFile(filename, output.outputFiles[0].text, { mode: 0o600 });
const views = await import(pathToFileURL(filename).href);

const owner='11111111-1111-4111-8111-111111111111';
const state=(patch:object={})=>({data:{ownerId:owner,revision:0,profile:null},busy:false,suspended:false,pending:null,error:'',notice:'',settled:null,...patch});
const props=(patch:object={})=>({state:state(),editor:null,setEditor(){},deleting:null,setDeleting(){},inputError:'',setInputError(){},controller:{refresh(){},begin(){},retry(){},observe(){}},...patch});
const markup=(patch:object={})=>renderToStaticMarkup(createElement(views.CareerProfileScene,props(patch)));
test('empty profile has no invented values and editor starts with unknown graduation and no selected direction',()=>{
 const html=markup({editor:{revision:0,facts:{degreeField:null,graduationMonth:null,graduated:null,targetTracks:[]}}});
 assert.match(html,/确认这些信息并保存/);assert.match(html,/暂不填写/);assert.match(html,/type="month"[^>]*value=""/);assert(!html.includes('checked=""'));assert(!/value="false" selected/.test(html));
});
test('uncertain mutation locks edits, keeps read-only observation and explicit original retry visible',()=>{
 const html=markup({state:state({pending:{action:'save',body:{}},error:'还不能确认是否已保存。'})});assert.match(html,/核对这次操作/);assert.match(html,/用原操作重试/);assert.match(html,/<button type="button" disabled="">填写职业档案/);
});
test('profile page never renders a stale captured account and SSR does not request private data',()=>{
 const client={account:{accountId:owner,generation:1},isCurrent:()=>false,subscribe:()=>()=>{},request(){throw Error('No SSR data reads');}};
 const html=renderToStaticMarkup(createElement(views.PlatformAccountClientProvider,{value:client},createElement(views.CareerProfilePanel)));
 assert.equal(html,'');
});

test('unavailable current snapshot disables stale draft submission, and a changed revision offers an explicit editor reset',()=>{
 const editor={revision:0,facts:{degreeField:null,graduationMonth:null,graduated:null,targetTracks:[]}};
 assert.match(markup({state:state({data:null,error:'重新读取'}),editor}),/<button type="submit" disabled="">确认这些信息并保存/);
 assert.match(markup({state:state({data:{ownerId:owner,revision:2,profile:null}}),editor}),/用最新档案重新填写/);
});
