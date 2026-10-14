import { mkdir,writeFile,rm,readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
const size=1024,rgba=Buffer.alloc((size*4+1)*size);
const lineDistance=(x,y,ax,ay,bx,by)=>{const t=Math.max(0,Math.min(1,((x-ax)*(bx-ax)+(y-ay)*(by-ay))/((bx-ax)**2+(by-ay)**2)));return Math.hypot(x-ax-t*(bx-ax),y-ay-t*(by-ay));};
for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const dx=Math.max(Math.abs(x-512)-237,0),dy=Math.max(Math.abs(y-512)-237,0),inside=Math.hypot(dx,dy)<=205;
  const mark=Math.min(lineDistance(x,y,345,295,680,730),lineDistance(x,y,680,295,345,730))<53;
  const color=mark?[200,232,169]:[22,61,53];const offset=y*(size*4+1)+1+x*4;rgba[offset]=color[0];rgba[offset+1]=color[1];rgba[offset+2]=color[2];rgba[offset+3]=inside?255:0;
}
function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^(0xedb88320&-(c&1));}return(c^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([length,name,data,checksum]);}
const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
await mkdir('assets',{recursive:true});await writeFile('assets/icon.png',Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rgba)),chunk('IEND',Buffer.alloc(0))]));
const iconset='assets/icon.iconset';await mkdir(iconset,{recursive:true});
for(const n of [16,32,128,256,512])for(const scale of [1,2])execFileSync('/usr/bin/sips',['-z',String(n*scale),String(n*scale),'assets/icon.png','--out',`${iconset}/icon_${n}x${n}${scale===2?'@2x':''}.png`],{stdio:'ignore'});
const entries=[];
for(const [type,name]of [['ic07','icon_128x128.png'],['ic08','icon_256x256.png'],['ic09','icon_512x512.png'],['ic10','icon_512x512@2x.png']]){const bytes=await readFile(`${iconset}/${name}`);const head=Buffer.alloc(8);head.write(type,0);head.writeUInt32BE(bytes.length+8,4);entries.push(head,bytes);}
const container=Buffer.alloc(8);container.write('icns',0);container.writeUInt32BE(8+entries.reduce((sum,b)=>sum+b.length,0),4);await writeFile('assets/icon.icns',Buffer.concat([container,...entries]));await rm(iconset,{recursive:true,force:true});
