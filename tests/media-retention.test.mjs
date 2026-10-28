import assert from 'node:assert/strict';
import test from 'node:test';
import { planMediaCleanup, releaseImageReferences } from '../src/server/artifacts/mediaRetention.ts';
import { missingNarrationKeys } from '../src/server/articles/narrationRecovery.ts';
const now=Date.parse('2026-10-27T12:00:00Z');
const blob=(pathname='articles/a/images/1.jpg',days=40)=>({pathname,url:'https://test.public.blob.vercel-storage.com/'+pathname,size:100,uploadedAt:new Date(now-days*86400000)});
const article=(b,original='https://source.example/image.jpg')=>({id:'a',owner_email:'owner',blocks:[{type:'image',artifactKey:b.pathname,src:b.url,originalSrc:original}],narration:null,content_html:`<img src="${b.url}">`,thumbnail_url:b.url,updated_at:'2026-09-01'});

test('retention deletes only old unused app images and keeps recent or unknown files',()=>{
 const candidates=[blob(),blob('articles/a/images/new.jpg',2),blob('uploads/only-copy.png'),blob('articles/a/audio/review/test.wav')];
 assert.deepEqual(planMediaCleanup(candidates,[],[],[],now).map(b=>b.pathname),[candidates[0].pathname]);
});
test('expired image references switch to originals in blocks, HTML and thumbnails',()=>{
 const b=blob(),a=article(b);
 assert.equal(planMediaCleanup([b],[a],[],[],now)[0].reason,'expired-image');
 const next=releaseImageReferences(a,new Set([b.pathname]),new Map([[b.pathname,b.url]]));
 assert.equal(next.blocks[0].src,'https://source.example/image.jpg');
 assert.equal(next.blocks[0].artifactKey,undefined);
 assert.equal(next.thumbnail_url,next.blocks[0].src);
 assert.ok(!next.content_html.includes(b.pathname));
 assert.equal(a.blocks[0].artifactKey,b.pathname);
});
test('retention preserves sole copies, shared unrecoverable images, narration and external references',()=>{
 const b=blob(),a=article(b);
 const unavailable=article(b,'');
 assert.equal(planMediaCleanup([b],[a,unavailable],[],[],now).length,0);
 assert.equal(planMediaCleanup([b],[article(b,b.url)],[],[],now).length,0);
 assert.equal(planMediaCleanup([b],[{...a,narration:{artifactKey:b.pathname}}],[],[],now).length,0);
 assert.equal(planMediaCleanup([b],[],[],[{source:b.url}],now).length,0);
});
test('cancelled audio ages out while active work and currently playable narration survive',()=>{
 const b=blob('articles/a/audio/v2/segment.mp3');
 const segment={job_id:'j',segment_index:0,artifact_key:b.pathname,job_status:'cancelled',job_updated_at:'2026-09-01',updated_at:'2026-09-01'};
 assert.equal(planMediaCleanup([b],[],[segment],[],now)[0].reason,'cancelled-audio');
 for(const status of ['pending','running','completed','failed'])
  assert.equal(planMediaCleanup([b],[],[{...segment,job_status:status}],[],now).length,0);
 assert.equal(planMediaCleanup([b],[{...article(blob()),narration:{artifactKey:b.pathname}}],[segment],[],now).length,0);
 assert.equal(planMediaCleanup([b],[],[{...segment,job_updated_at:new Date(now).toISOString()}],[],now).length,0);
});
test('missing narration checks every segment without treating a provider outage as deletion',async()=>{
 const a={narration:{artifactKey:'a',segments:[{artifactKey:'a'},{artifactKey:'b'}]}};
 assert.deepEqual(await missingNarrationKeys(a,async key=>key==='a'),['b']);
 await assert.rejects(missingNarrationKeys(a,async()=>{throw new Error('storage suspended')}),/suspended/);
});
