import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const mocks = {
 '@vercel/blob': `export class BlobNotFoundError extends Error {} export async function head(key){const s=globalThis.readerRecoveryTest;if(s.outage)throw new Error('storage unavailable');if(s.missing.includes(key))throw new BlobNotFoundError();return {};}`,
 '@/server/database': `export function getDatabaseSql(){return {query:async()=>{const s=globalThis.readerRecoveryTest;s.resets++;if(s.job?.status==='completed'||s.job?.status==='cancelled'){s.job={status:'pending'};return [{id:'job'}]}return []}}}`,
 '@/server/runtime/artifactStorage': `export function getArtifactStorage(){throw new Error('not used')}`,
 'next/server': `export const NextResponse={json:(data,options)=>Response.json(data,options)};`,
 'workflow/api': `export async function start(){globalThis.readerRecoveryTest.starts++;return {runId:'run'}}`,
 '@/server/auth/access': `export async function requireAppUser(){return {response:null,user:{ownerEmail:'owner'}}}`,
 '@/server/articles/articleNarrationPlan': `export function prepareArticleNarration(){return {sourceTextSha256:'hash',generationFingerprint:'generation',sentenceMapFingerprint:'sentences'}}`,
 '@/server/runtime/articleRepository': `export function getArticleRepository(){return {findById:async()=>globalThis.readerRecoveryTest.article,updateNarration:async(_id,_owner,narration)=>{globalThis.readerRecoveryTest.article.narration=narration}}}`,
 '@/server/runtime/narrationPolicyRepository': `export function getNarrationPolicyRepository(){return {findNarrationJob:async()=>globalThis.readerRecoveryTest.job}}`,
 '@/workflows/narrationPolicy/article': `export function reconcileClaimedNarrationPolicyArticle(){}`,
};
registerHooks({resolve(specifier,context,nextResolve){
 if(mocks[specifier])return {url:'data:text/javascript,'+encodeURIComponent(mocks[specifier]),shortCircuit:true};
 if(specifier.startsWith('@/'))return {url:pathToFileURL(path.resolve('src',specifier.slice(2)+'.ts')).href,shortCircuit:true};
 return nextResolve(specifier,context);
}});
const {GET,POST}=await import('../src/app/api/articles/[id]/narration/request/route.ts');
const context={params:Promise.resolve({id:'article'})};
function setup(){
 process.env.ARTICLE_REPOSITORY_DRIVER='postgres';process.env.ARTIFACT_STORAGE_DRIVER='vercel-blob';
 return globalThis.readerRecoveryTest={article:{id:'article',folderId:'folder',narration:{sourceTextSha256:'hash',artifactKey:'audio',segments:[{artifactKey:'audio'}]}},missing:[],job:{status:'completed'},starts:0,resets:0};
}
test('existing narration is checked and reused without starting paid generation',async()=>{
 const s=setup();const response=await POST(new Request('https://reader.test'),context);
 assert.equal((await response.json()).status,'ready');assert.equal(s.starts,0);assert.equal(s.resets,0);
});
test('polling deleted audio does not regenerate or change job state',async()=>{
 const s=setup();s.missing=['audio'];const response=await GET(new Request('https://reader.test'),context);
 assert.equal((await response.json()).status,'missing');assert.equal(s.starts,0);assert.equal(s.resets,0);
});
test('explicit Play restarts a completed job whose media is missing',async()=>{
 const s=setup();s.missing=['audio'];const response=await POST(new Request('https://reader.test'),context);
 assert.equal(response.status,202);assert.equal((await response.json()).status,'generating');
 assert.equal(s.starts,1);assert.equal(s.article.narration,null);
});
test('Play resumes cancelled cleanup jobs, while active jobs are not duplicated',async()=>{
 const s=setup();s.article.narration=null;s.job={status:'cancelled'};
 assert.equal((await POST(new Request('https://reader.test'),context)).status,202);assert.equal(s.starts,1);
 s.job={status:'running'};
 await POST(new Request('https://reader.test'),context);assert.equal(s.starts,1);
});
test('a storage outage preserves saved narration and never starts regeneration',async()=>{
 const s=setup();s.outage=true;const response=await POST(new Request('https://reader.test'),context);
 assert.equal(response.status,503);assert.equal(s.starts,0);assert.equal(s.resets,0);assert.ok(s.article.narration);
});
