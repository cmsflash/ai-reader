import { loadLocalEnv } from './lib/env.mjs';
loadLocalEnv();
const { del } = await import('@vercel/blob');
const { getDatabaseSql } = await import('../src/server/database.ts');
const { readMediaInventory } = await import('../src/server/artifacts/runMediaCleanup.ts');
const { planMediaCleanup, releaseImageReferences, recoverableImageSource } = await import('../src/server/artifacts/mediaRetention.ts');
const apply = process.argv.includes('--apply');
const retireBlackMyth = process.argv.includes('--retire-black-myth');
const { blobs, articles, segments, other } = await readMediaInventory();
const automatic = planMediaCleanup(blobs,articles,segments,other);
const blackMyth = retireBlackMyth ? blobs.filter(b=>b.pathname.startsWith('imports/black-myth-journals/')) : [];
const selected = [...automatic.filter(b=>b.reason !== 'expired-image'),...blackMyth];
const keys=new Set(selected.map(b=>b.pathname)), urls=new Map(selected.map(b=>[b.pathname,b.url]));
const sql=getDatabaseSql();
const journalArticles=articles.filter(a=>a.id.startsWith('black-myth-journal-'));
for(const a of articles) for(const b of a.blocks) {
  if(keys.has(b.artifactKey) && b.type==='image' && !recoverableImageSource(b.originalSrc))
    throw new Error('No recoverable original for '+b.artifactKey);
}
const summary={apply,files:selected.length,bytes:selected.reduce((n,b)=>n+b.size,0),blackMythArticles:journalArticles.length};
console.log(JSON.stringify(summary));
if(!apply) process.exit();
// Persist original image sources before removing cached copies; compare-and-swap keeps concurrent edits safe.
for(const a of articles){
  const next=releaseImageReferences(a,keys,urls);
  if(JSON.stringify(next.blocks)!==JSON.stringify(a.blocks)){
    const changed=await sql.query(`UPDATE articles SET blocks=$3::jsonb,content_html=$4,thumbnail_url=$5,updated_at=now()
      WHERE id=$1 AND owner_email=$2 AND blocks=$6::jsonb RETURNING id`,
    [a.id,a.owner_email,JSON.stringify(next.blocks),next.content_html,next.thumbnail_url,JSON.stringify(a.blocks)]);
    if(changed.length!==1)throw new Error('Article changed; rerun cleanup: '+a.id);
  }
}
if(retireBlackMyth){
  await sql.query(`UPDATE articles SET archived_at=COALESCE(archived_at,now()),organization_updated_at=now(),updated_at=now()
    WHERE id LIKE 'black-myth-journal-%'`);
  // The shared Archive folder is retained. Remove only dedicated Black Myth folders.
  await sql.query(`DELETE FROM reading_folders f WHERE is_archive=false
    AND (lower(name) IN ('black myth','black myth wukong','bmw','黑神话悟空','黑神话：悟空') OR slug LIKE 'black-myth%')
    AND NOT EXISTS(SELECT 1 FROM articles a WHERE a.folder_id=f.id AND a.id NOT LIKE 'black-myth-journal-%')`);
}
let deleted=0,bytes=0;
for(let offset=0;offset<selected.length;offset+=50){
  const batch=selected.slice(offset,offset+50);
  // Reread the live library before every batch. Only cancelled jobs may lose recovery audio.
  const paths=batch.map(b=>b.pathname);
  const refs=await sql.query(`SELECT b.key FROM unnest($1::text[]) b(key) WHERE EXISTS(
    SELECT 1 FROM articles WHERE strpos(blocks::text,b.key)>0 OR strpos(COALESCE(narration::text,''),b.key)>0
    OR strpos(content_html,b.key)>0 OR strpos(COALESCE(thumbnail_url,''),b.key)>0)
    OR EXISTS(SELECT 1 FROM article_narration_job_segments s JOIN article_narration_jobs j ON j.id=s.job_id
    WHERE s.artifact_key=b.key AND j.status<>'cancelled')`,[paths]);
  if(refs.length)throw new Error('Live reference found; refusing deletion: '+refs[0].key);
  await del(batch.map(b=>b.url));
  await sql.transaction([
    sql.query(`UPDATE article_narration_jobs j SET error_message='Saved audio was removed by media cleanup. Press Play to regenerate.',updated_at=now()
      WHERE status='cancelled' AND EXISTS(SELECT 1 FROM article_narration_job_segments s WHERE s.job_id=j.id AND s.artifact_key=ANY($1::text[]))`,[paths]),
    sql.query(`UPDATE article_narration_job_segments s SET artifact_key=NULL,byte_length=NULL,updated_at=now()
      FROM article_narration_jobs j WHERE s.job_id=j.id AND s.artifact_key=ANY($1::text[]) AND j.status='cancelled'`,[paths]),
  ]);
  deleted+=batch.length;bytes+=batch.reduce((n,b)=>n+b.size,0);
  console.log(JSON.stringify({deleted,bytes}));
}
console.log(JSON.stringify({done:true,deleted,bytes}));
