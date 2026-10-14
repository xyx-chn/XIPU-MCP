import test from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { zipSync,strToU8 } from 'fflate';
import { MailConfig,toolSchemas } from '../src/shared.js';
import { matchesHeaders,extractCode } from '../src/mail/policy.js';
import { parseCourses,parseFiles,parseActivities,parseActivityDeadlines,dateFromMoodle,schoolUrl } from '../src/moodle/parsers.js';
import { safeFilename,materialFilename,rejectLoginFile } from '../src/downloads.js';
import { extractDocument,dateClues,paginateSections } from '../src/documents.js';
import { checkSchoolSession } from '../src/moodle/session-check.js';
import { MoodleClient } from '../src/moodle/client.js';
import { CORE } from '../src/shared.js';

test('sender, recipient, subject and fresh date must all match',async()=>{
  const settings=MailConfig.parse({recipient:'student@example.net'}),now=Date.now();
  const raw=(from='auth@xjtlu.edu.cn',to='student@example.net',subject='Verification code',date=new Date(now).toUTCString())=>`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${date}\r\n\r\n`;
  assert.equal(matchesHeaders(await simpleParser(raw()),settings,now),true);
  for(const bad of [raw('auth@xjtlu.edu.cn.evil.org'),raw('auth@evilxjtlu.edu.cn'),raw(undefined,'someone@example.net'),raw(undefined,undefined,'Personal email'),raw(undefined,undefined,undefined,new Date(now-600_000).toUTCString())])assert.equal(matchesHeaders(await simpleParser(bad),settings,now),false);
  const exact=MailConfig.parse({...settings,senders:['specific@example.org'],senderDomains:[]});
  assert.equal(matchesHeaders(await simpleParser(raw('specific@example.org')),exact,now),true);
});
test('OTP parsing never guesses ambiguous or partial numbers',()=>{
  assert.equal(extractCode('Your code: 123456',6),'123456');
  assert.throws(()=>extractCode('123456 or 654321',6));assert.throws(()=>extractCode('1234567',6));
});
test('public MCP schema does not expose email, credentials or arbitrary paths',()=>{
  assert.equal(Object.keys(toolSchemas).length,9);
  assert.throws(()=>toolSchemas.read_deadline_source.strict().parse({sourceId:'abc',url:'https://evil.example'}));
  assert.throws(()=>toolSchemas.download_materials.strict().parse({materialIds:['x'],directory:'/private'}));
  assert.throws(()=>toolSchemas.auth_status.strict().parse({password:'secret'}));
});
test('course and file discovery reject foreign origins and retain distinct identifiers',()=>{
  const courses=parseCourses('<a href="/course/view.php?id=42">Maths</a><a href="https://evil.example/course/view.php?id=13">Other</a>');assert.equal(courses.length,1);assert.equal(courses[0].id,'42');
  const activities=parseActivities('<li class="section"><h3 class="sectionname">Week 2</h3><a href="/mod/folder/view.php?id=77">Notes</a></li>','42');assert.equal(activities[0].section,'Week 2');
  const files=parseFiles('<a href="/pluginfile.php/11/mod_resource/content/0/week.pdf">PDF</a><a href="https://evil.example/pluginfile.php/stolen.pdf">Bad</a>',activities[0]);assert.equal(files.length,1);
  const duplicate=parseActivities('<li class="course-section"><h3 class="sectionname"><span class="accesshide">Select section</span>Week 3<button>Collapse</button></h3><ul><li data-sectionid="3"><a href="/mod/resource/view.php?id=8">Slides</a></li></ul></li><a href="/mod/resource/view.php?id=8">Sidebar duplicate</a>','42');assert.equal(duplicate[0].section,'Week 3');
  const index=parseActivities('<div class="courseindex-section"><a data-for="section_title">Week 2 Lecture</a><a href="/mod/resource/view.php?id=9">Slides</a></div>','42');assert.equal(index[0].section,'Week 2 Lecture');
  assert.equal(schoolUrl('https://core.xjtlu.edu.cn.evil.example/file'),undefined);
});
test('authenticated canonical redirect is followed, authentication redirects are not',async()=>{
  const calls:string[]=[];
  const result=await checkSchoolSession({fetch:async url=>{calls.push(url);return calls.length===1?new Response(null,{status:303,headers:{location:'/my/index.php'}}):new Response('<div class="usermenu">Student</div>');}});
  assert.equal(result.authenticated,true);assert.equal(calls.length,2);
  const signedOut=await checkSchoolSession({fetch:async()=>new Response(null,{status:303,headers:{location:'/login/index.php'}})});assert.equal(signedOut.authenticated,false);
  const foreign=await checkSchoolSession({fetch:async()=>new Response(null,{status:302,headers:{location:'https://other.example/my/'}})});assert.equal(foreign.authenticated,false);
  const dashboard=await checkSchoolSession({fetch:async()=>new Response('<body id="page-my-index"><h1>Dashboard</h1></body>')});assert.equal(dashboard.authenticated,true);
  const translation=await checkSchoolSession({fetch:async()=>new Response('<body id="page-my-index"><script>const loginTitle="Log in to Learning Mall Core";</script><h1>Dashboard</h1></body>')});assert.equal(translation.authenticated,true);
  const loggedIn=await checkSchoolSession({fetch:async url=>url.includes('/my/')?new Response(null,{status:303,headers:{location:'/login/index.php'}}):new Response('<body id="page-login-index">You are already logged in as Test Student</body>')});assert.equal(loggedIn.authenticated,true);
});
test('current-user effective due date overrides generic badge, cut-off remains separate',()=>{
  const activity={id:'7',courseId:'42',name:'Report',section:'Week 2',type:'assign',url:'https://core.xjtlu.edu.cn/mod/assign/view.php?id=7'};
  const html='<div data-region="activity-dates"><div><strong>Due date:</strong> Tuesday, 14 October 2026, 11:59 PM</div></div><table class="submissionstatustable"><tr><th>Due date</th><td>Friday, 16 October 2026, 11:59 PM</td></tr><tr><th>Cut-off date</th><td>17 October 2026, 11:59 PM</td></tr><tr><th>Submission status</th><td>Submitted for grading</td></tr></table>';
  const d=parseActivityDeadlines(html,activity);assert.equal(d.length,2);assert.equal(d.find(x=>x.kind==='assignment_due')!.at,'2026-10-16T15:59:00.000Z');assert.equal(d[0].submissionStatus,'Submitted for grading');
  assert.equal(dateFromMoodle('2026年10月14日 23:59'),'2026-10-14T15:59:00.000Z');assert.equal(dateFromMoodle('No due date'),undefined);
  const badge=parseActivityDeadlines('<div data-region="activity-dates"><div><strong>Due:</strong> Sunday, 1 November 2026, 11:59 PM</div></div>',activity);assert.equal(badge[0].at,'2026-11-01T15:59:00.000Z');
});
test('calendar uses valid page sizes and preserves effective assignment dates with bounded pagination',async()=>{
  const pages:number[]=[];const due='2026-10-16T15:59:00.000Z';
  const client=new MoodleClient({fetch:async(url,init)=>{
    if(init?.method==='POST') {
      const request=JSON.parse(String(init.body))[0];const args=request.args;
      if(request.methodname==='core_calendar_get_calendar_monthly_view')return Response.json([{data:{weeks:[{days:[{events:[52,53].map(id=>({id,course:{id:42},name:'Ordinary course event '+id,timestart:Date.parse(due)/1000,url:CORE+'/calendar/view.php?view=day&time=1'}))}]}]}}]);
      assert.equal(args.limitnum,50);pages.push(args.aftereventid);
      const events=args.aftereventid===0?Array.from({length:50},(_,i)=>({id:i+1,course:{id:42},name:'Course event',timesort:Date.parse(due)/1000,url:CORE+'/calendar/view.php?event='+i})):[{id:51,course:{id:42},name:'Assignment is due',modulename:'assign',eventtype:'due',timesort:Date.parse(due)/1000,url:CORE+'/mod/assign/view.php?id=7'}];
      return Response.json([{data:{events}}]);
    }
    return new Response(url.includes('/my/')?'<script>M.cfg={"sesskey":"test"}</script>':'');
  }},async()=>undefined);
  client.courses.set('42',{id:'42',name:'Maths',shortName:'Maths',url:CORE+'/course/view.php?id=42'});
  const result=await client.listDeadlines(['42'],'2026-10-01T00:00:00Z','2026-11-01T00:00:00Z');assert.deepEqual(pages,[0,50]);assert.equal(result.deadlines.length,53);assert.equal(result.deadlines.filter(d=>d.kind==='assignment_due').length,1);assert.deepEqual(result.warnings,[]);
});
test('download filenames remain in the selected directory and login pages are refused',()=>{
  assert(!safeFilename('../../bad\\file.pdf').includes('/'));assert(!safeFilename('..').startsWith('.'));
  const material:any={name:'lecture.pdf',id:'abcdef1234567890'};assert.equal(materialFilename(material),'lecture--abcdef1234.pdf');
  assert.throws(()=>rejectLoginFile(new TextEncoder().encode('<html id="page-login-index">'), 'text/html'));
});
test('PPTX and DOCX text extraction preserves evidence locations without reading other ZIP entries',async()=>{
  const ppt=zipSync({'ppt/slides/slide2.xml':strToU8('<p:sld><a:p><a:r><a:t>Submit by 16 October</a:t></a:r></a:p></p:sld>'),'ppt/slides/slide1.xml':strToU8('<p:sld><a:p><a:r><a:t>Introduction</a:t></a:r></a:p></p:sld>'),'media/private.txt':strToU8('not text evidence')});
  const parsed=await extractDocument(ppt,'lecture.pptx');assert.equal(parsed.sections[0].location,'slide 1');assert(parsed.sections[1].text.includes('Submit by 16 October'));assert(!JSON.stringify(parsed).includes('not text evidence'));assert.equal(dateClues(parsed.sections).length,1);
  const doc=zipSync({'word/document.xml':strToU8('<w:document><w:body><w:p><w:r><w:t>Deadline 20 October</w:t></w:r></w:p><w:p><w:r><w:t>Another paragraph</w:t></w:r></w:p></w:body></w:document>')});
  const result=await extractDocument(doc,'brief.docx');assert.equal(result.sections.length,2);assert.equal(result.sections[1].location,'paragraph 2');
  assert.equal(paginateSections([{location:'slide 1',text:'abcdef'}],2,3).sections[0].text,'cde');
});
test('PDF extraction retains page numbers and flags pages without text',async()=>{
  const makePdf=(text:string)=>{
    const stream=`BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
    const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let pdf='%PDF-1.4\n';const offsets=[0];for(const [i,obj]of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
    const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return new Uint8Array(Buffer.from(pdf));
  };
  const result=await extractDocument(makePdf('Submit report by 20 October'),'brief.pdf');assert.equal(result.sections[0].location,'page 1');assert(result.sections[0].text.includes('Submit report'));assert.equal(dateClues(result.sections).length,1);
  const blank=await extractDocument(makePdf(''),'scan.pdf');assert(blank.warning);
  await assert.rejects(extractDocument(new Uint8Array([1,2,3]),'broken.pdf'));
});
