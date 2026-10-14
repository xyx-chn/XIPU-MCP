import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { AppError, type TextSection } from './shared.js';

const parser = new XMLParser({ ignoreAttributes:false, preserveOrder:true, processEntities:false, trimValues:false });
function xmlText(xml: string, tags: Set<string>): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new AppError('DOCUMENT_UNSUPPORTED','文档包含不支持的 XML 定义。');
  const parts: string[]=[];
  const walk=(nodes: any[])=> {for(const node of nodes)for(const [key,value] of Object.entries(node)) {
    if(tags.has(key)&&Array.isArray(value))for(const child of value as any[]) if(child['#text']!==undefined)parts.push(String(child['#text']));
    else if(key==='#text')parts.push(String(value));
    if(Array.isArray(value))walk(value);
    if(['w:p','a:p'].includes(key))parts.push('\n');
  }};
  walk(parser.parse(xml));return parts.join(' ').replace(/[ \t]+/g,' ').replace(/\n +/g,'\n').trim();
}
export async function extractDocument(bytes: Uint8Array, name: string): Promise<{sections:TextSection[];warning?:string}> {
  if(bytes.length>40*1024*1024)throw new AppError('DOCUMENT_TOO_LARGE','文本解析仅支持 40 MB 以内的文件。');
  const extension=name.split('.').pop()?.toLowerCase();
  if(extension==='pdf') {
    const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
    // Electron utility processes are deliberately not classified as Node by PDF.js.
    // Load its local message handler in this already-isolated process; no browser Worker or CDN is needed.
    Object.assign(globalThis,{pdfjsWorker:await import('pdfjs-dist/legacy/build/pdf.worker.mjs')});
    const task=pdfjs.getDocument({data:bytes.slice(),useSystemFonts:true,disableFontFace:true,verbosity:0});
    try {
      const pdf=await task.promise; if(pdf.numPages>500)throw new AppError('DOCUMENT_TOO_LARGE','PDF 超过 500 页，请选择较小文件。');
      const sections:TextSection[]=[];
      for(let index=1;index<=pdf.numPages;index++) {
        const page=await pdf.getPage(index);const content=await page.getTextContent();
        const text=content.items.map(item=>'str' in item?item.str+('hasEOL' in item&&item.hasEOL?'\n':' '):'').join('').trim();
        sections.push({location:`page ${index}`,text});page.cleanup();
      }
      return {sections,warning:sections.every(s=>!s.text)?'此 PDF 没有可提取文字，可能是扫描件；首版不提供 OCR。':undefined};
    } catch(e) {if(e instanceof AppError)throw e;throw new AppError('DOCUMENT_UNSUPPORTED','PDF 已加密、损坏或无法提取文字。');}
    finally {await task.destroy();}
  }
  if(extension==='pptx'||extension==='docx') {
    let expanded=0;
    const archive=unzipSync(bytes,{filter:file=> {
      const wanted=extension==='pptx'?/^ppt\/slides\/slide\d+\.xml$/.test(file.name):file.name==='word/document.xml';
      if(wanted) {expanded+=file.originalSize;if(expanded>60*1024*1024)throw new AppError('DOCUMENT_TOO_LARGE','文档解压后的文本过大。');}
      return wanted;
    }});
    if(extension==='pptx')return {sections:Object.keys(archive).sort((a,b)=>Number(a.match(/slide(\d+)/)![1])-Number(b.match(/slide(\d+)/)![1])).map(file=>({location:`slide ${file.match(/slide(\d+)/)![1]}`,text:xmlText(strFromU8(archive[file]),new Set(['a:t']))}))};
    if(!archive['word/document.xml'])throw new AppError('DOCUMENT_UNSUPPORTED','DOCX 缺少正文或已加密。');
    const text=xmlText(strFromU8(archive['word/document.xml']),new Set(['w:t']));
    return {sections:text.split(/\n/).filter(Boolean).map((text,index)=>({location:`paragraph ${index+1}`,text}))};
  }
  if(['txt','md','csv'].includes(extension??''))return {sections:[{location:'text',text:new TextDecoder().decode(bytes)}]};
  throw new AppError('DOCUMENT_UNSUPPORTED','支持文本型 PDF、PPTX、DOCX 和纯文本；旧版 Office、扫描件及加密文件请手动查看。');
}
export function dateClues(sections: TextSection[]) {
  const clues:Array<{location:string;excerpt:string}>=[];
  for(const section of sections) {
    const lines=section.text.split(/\n|(?<=[.!?。；;])\s+/);
    for(const line of lines) if(/deadline|due|submit|submission|截止|提交|到期/i.test(line)&&/\d|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|tomorrow|next week|明天|下周/i.test(line))
      clues.push({location:section.location,excerpt:line.slice(0,1500)});
  }return clues.slice(0,200);
}
export function paginateSections(sections: TextSection[],offset:number,limit:number) {
  let cursor=0;const excerpts:TextSection[]=[];
  for(const section of sections) {
    const start=cursor,end=cursor+section.text.length; cursor=end+1;
    if(end<=offset||start>=offset+limit)continue;
    excerpts.push({location:section.location,text:section.text.slice(Math.max(0,offset-start),Math.min(section.text.length,offset+limit-start))});
  }return {sections:excerpts,totalCharacters:cursor,nextOffset:offset+limit<cursor?offset+limit:null};
}
