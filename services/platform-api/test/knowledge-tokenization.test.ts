import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeHanBigrams, knowledgeHanSearch, knowledgeHanRuns, KNOWLEDGE_HAN_RANGES } from '../src/knowledge-tokenization.ts';
test('adjacent Unicode Han characters preserve repetitions and never join across punctuation, spaces, Latin words or emoji',()=>{
  assert.deepEqual(knowledgeHanBigrams('系统设计 SQL 𠀀𠀁𠀂；云🌱端；系统设计'),['系统','统设','设计','𠀀𠀁','𠀁𠀂','系统','统设','设计']);
  assert.deepEqual(knowledgeHanBigrams('系 统 A计\n算'),[]);
  assert.deepEqual(knowledgeHanRuns('日本カナ 职业'),['日本','职业']);
  assert(KNOWLEDGE_HAN_RANGES.every(([a,b])=>a<=b));
});
test('Han query operators are generated only from two Han characters and mixed/single-character requirements are retained',()=>{
  const q=knowledgeHanSearch("SQL 系统设计 系统 云 %missing_ ' OR 1=1 --");
  assert.equal(q.tsquery,"'系统' | '统设' | '设计'");
  assert.deepEqual(q.requiredLiteral,['SQL','%missing_',"'",'OR','1=1','--','云']);
  assert.deepEqual(knowledgeHanSearch('SQL window_function'),{tsquery:'',latin:'SQL window_function',requiredLiteral:['SQL','window_function']});
});
