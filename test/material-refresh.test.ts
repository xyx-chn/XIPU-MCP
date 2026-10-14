import test from 'node:test';
import assert from 'node:assert/strict';
import {MoodleClient} from '../src/moodle/client.js';
import {CORE,type Material,type Source} from '../src/shared.js';

test('successful course refresh removes deleted materials and sources while keeping other courses',async()=>{
  let phase=0;
  const courseUrl=CORE+'/course/view.php?id=42',resourceUrl=CORE+'/mod/resource/view.php?id=7',forumUrl=CORE+'/mod/forum/view.php?id=8';
  const client=new MoodleClient({fetch:async url=>{
    if(url===courseUrl)return new Response(phase===1?'':`<a href="${resourceUrl}">Slides</a><a href="${forumUrl}">Announcements</a>`);
    if(url===resourceUrl)return phase===2?new Response('failed',{status:500}):new Response(null,{status:303,headers:{location:CORE+'/pluginfile.php/99/mod_resource/content/0/slides.pdf'}});
    if(url===forumUrl)return new Response('<h1>Announcements</h1><a href="/mod/forum/discuss.php?d=9">Project update</a>');
    return new Response('pdf',{headers:{'content-type':'application/pdf'}});
  }},async()=>undefined);
  client.courses.set('42',{id:'42',name:'COS305',shortName:'COS305',url:courseUrl});
  const unrelated:Material={id:'other-material',courseId:'43',section:'Week 1',name:'other.pdf',url:CORE+'/pluginfile.php/10/mod_resource/content/0/other.pdf',activityUrl:CORE+'/mod/resource/view.php?id=10',kind:'file'};
  const unrelatedSource:Source={id:'other-source',courseId:'43',name:'Other',url:unrelated.activityUrl,kind:'material',materialId:unrelated.id};
  client.materials.set(unrelated.id,unrelated);client.sources.set(unrelatedSource.id,unrelatedSource);
  const initial=await client.listSources(['42']);assert.equal(initial.length,2);assert.equal(client.materials.size,2);
  phase=2;await assert.rejects(client.listMaterials(['42']),{code:'MOODLE_HTTP'});assert.equal(client.materials.size,2);assert.equal(client.sources.size,3);
  phase=1;assert.deepEqual(await client.listSources(['42']),[]);
  assert.deepEqual([...client.materials.keys()],[unrelated.id]);assert.deepEqual([...client.sources.keys()],[unrelatedSource.id]);
});
