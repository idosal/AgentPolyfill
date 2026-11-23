// Run from any directory: node helper-rs/crates/render/tests/make-fixtures.mjs
// The JS is the oracle. Original tests execute unchanged apart from imports;
// every composeFrame call is recorded, including object identity and call order.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import * as pixels from '../../../../mod/helper/test/pixels.mjs';
import * as sceneHelpers from '../../../../mod/helper/test/scene.mjs';
import { canvasIsPhoto, parseCssColor } from '../../../../mod/helper/render.mjs';

const dir = new URL('./fixtures/', import.meta.url);
mkdirSync(dir, { recursive: true });
function unicode() {
  const ranges=[];
  for(let c=0;c<=0x10ffff;c++) if(/[\p{M}\p{Cf}]/u.test(String.fromCodePoint(c))) {
    const p=ranges.at(-1); if(p&&p[1]+1===c)p[1]=c; else ranges.push([c,c]);
  }
  writeFileSync(new URL('../src/unicode_marks.rs',import.meta.url), `// Generated with Node ${process.version}, Unicode ${process.versions.unicode}: /[\\p{M}\\p{Cf}]/u.\n// Regenerate with tests/make-fixtures.mjs --unicode.\npub(crate) fn is_mark_or_format(cp: u32) -> bool {\n    RANGES.binary_search_by(|&(a, b)| if cp < a { std::cmp::Ordering::Greater } else if cp > b { std::cmp::Ordering::Less } else { std::cmp::Ordering::Equal }).is_ok()\n}\nconst RANGES: &[(u32, u32)] = &[\n${ranges.map(([a,b])=>`    (0x${a.toString(16)}, 0x${b.toString(16)}),`).join('\n')}\n];\n`);
}
if(process.argv.includes('--unicode')) { unicode(); process.exit(0); }

const crcTable=Uint32Array.from({length:256},(_,c)=>{for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function chunk(name,data) {
  const type=Buffer.from(name);const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);type.copy(out,4);data.copy(out,8);
  let crc=0xffffffff;for(const b of Buffer.concat([type,data]))crc=crcTable[(crc^b)&255]^(crc>>>8);
  out.writeUInt32BE((crc^0xffffffff)>>>0,data.length+8);return out;
}
function png(img) {
  const stride=img.width*4;const raw=Buffer.alloc(img.height*(stride+1));
  for(let y=0;y<img.height;y++){const o=y*(stride+1);raw[o]=1;for(let x=0;x<stride;x++)raw[o+1+x]=(img.data[y*stride+x]-(x<4?0:img.data[y*stride+x-4]))&255;}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(img.width);ihdr.writeUInt32BE(img.height,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}
const imageNames=new Set();
function saveImage(img) {
  const hash=createHash('sha256').update(`${img.width}x${img.height}:`).update(img.data).digest('hex').slice(0,24);
  const name=`${hash}.png`;if(!imageNames.has(name)){writeFileSync(new URL(name,dir),png(img));imageNames.add(name);}return name;
}
let serial=0;
async function capture(name,body) {
  const oracle=await import(`../../../../mod/helper/render.mjs?fixture=${serial++}`);
  const frames=[];const memories=new WeakMap();const painters=new WeakMap();let mn=0,pn=0,clock=0;let label=name;
  const id=(map,obj,prefix)=>{if(!obj)return null;if(!map.has(obj))map.set(obj,`${prefix}${prefix==='m'?mn++:pn++}`);return map.get(obj);};
  const render=(img,texts,opts)=>{
    const {memory,painter,...options}=opts;options.now ??= clock;clock=options.now+100;
    const expected=oracle.composeFrame(img,texts,{...options,memory,painter});
    frames.push({label,image:saveImage(img),texts:JSON.parse(JSON.stringify(texts)),options,memory:id(memories,memory,'m'),painter:id(painters,painter,'p'),expected});return expected;
  };
  await body(render,(name,fn)=>{label=name;fn();},oracle);
  writeFileSync(new URL(`${name}.json`,dir),JSON.stringify({name,frames}));
  console.log(`${name}: ${frames.length} frames`);
}
const helpers={...pixels,...sceneHelpers};
for(const file of ['render','sextants','truecolor','palette']) {
  await capture(file,(render,test)=>{
    const source=readFileSync(new URL(`../../../../mod/helper/test/${file}.test.mjs`,import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
    new Function('composeFrame','test','assert',...Object.keys(helpers),source)(render,test,assert,...Object.values(helpers));
  });
}
const {page,fill,grid,stroke}=pixels;
await capture('edges',(render,test)=>{
  test('flags, CSS alpha, Unicode widths, caret and clipping',()=>{
    const img=page(192,96,[22,22,22]);
    const texts=[
      {x:-4,cy:8,t:'ab界🙂e\u0301\u200d\u{e0100}\t\u007f Z',color:'rgba(244.5, 20.5, 80.5, 0.4)',bold:true,dim:true},
      {x:4,cy:24,t:'caret',color:'color(srgb 0.17 0.8 1 / 0.7)',caret:5},
      {x:4,cy:40,t:' inverse ',color:'#fed8',inverse:true,dim:true,bold:true,maxX:140},
      {x:3.9,cy:56,t:'spaces   end',color:'#abc',caret:2},
      {x:0,cy:-0.1,t:'offscreen',color:'red'},
      {x:0,cy:72,t:'end',color:'rgb(999.5, 1.5, 3)',caret:9},
    ];
    for(const truecolor of [false,true])for(const lines of [false,true])render(img,texts,grid(24,6,{truecolor,lines}));
  });
  test('odd cell dimensions, clipped image edges, gradients and halfBlocks',()=>{
    for(const [cw,ch] of [[7,13],[9,17],[16,32]]) {
      const img=page(cw*7-3,ch*3-4,[0,0,0]);
      for(let y=0;y<img.height;y++)for(let x=0;x<img.width;x++){const i=(y*img.width+x)*4;img.data.set([(x*17+y*3)%256,(x*11+y*19)%256,(x*5+y*7)%256,x%256],i);}
      for(const halfBlocks of [true,false])for(const photo of [false,true])render(img,[],{cols:7,rows:3,cellWidth:cw,cellHeight:ch,pageBackground:0x111111,photos:photo?[{x:-5,y:-5,w:200,h:200}]:[],halfBlocks,lines:true});
    }
  });
  test('memory reset on resize, background change and slow drift',()=>{
    const memory={},painter={};
    for(let f=0;f<15;f++)render(fill(page(64,48,[30+f,30+f,30+f]),0,7+(f%4),64,2,[220,220,220]),[],grid(f<10?8:7,f<12?3:2,{memory,painter,pageBackground:f<13?0:0x222222,lines:true}));
  });
  test('canvas classification enters and exits with persisted thresholds',()=>{
    const memory={},painter={};
    for(const height of [16,6,4,2,6,10,6,0]) {
      const img=fill(page(64,32,[30,34,50]),0,32-height,64,height,[60,140,250]);
      render(img,[],grid(8,2,{memory,painter,photos:[{x:-0.5,y:-0.5,w:64.5,h:32.5,canvas2d:true}],lines:true}));
    }
  });
  test('text boxes overlap and erase ink above edges',()=>{
    const img=fill(page(96,48,[32,32,32]),0,16,96,16,[40,180,60]);fill(img,3,3,25,15,[220,220,220]);
    render(img,[{x:-4,cy:15,t:'ABCD',color:'#ddd',top:-2,bottom:22,right:35,bold:true},{x:9,cy:17,t:'efgh',color:'#ddd',top:8,bottom:25,right:45,dim:true},{x:100,cy:47,t:'clipped',color:'#f0f',top:40,bottom:70,right:180}],grid(12,3,{lines:true}));
  });
  test('many independent views share one depleted pair budget',()=>{
    for(let view=0;view<8;view++){
      const memory={},painter={};
      for(let f=0;f<2;f++)render(sceneHelpers.scene(view*8+f),[],grid(90,30,{memory,painter,photos:[{x:0,y:0,w:720,h:480}],sextants:true,now:0}));
    }
  });
  test('truecolor animation carries glyph history and styled runs',()=>{
    const memory={},painter={};
    for(let f=0;f<12;f++)render(sceneHelpers.scene(f),[],grid(90,30,{memory,painter,photos:[{x:0,y:0,w:720,h:480}],truecolor:true,lines:f%2===0,sextants:f%2===1}));
  });
  test('every sextant mask, complements and odd third boundaries',()=>{
    for(const ch of [16,17]) {
      const img=page(64*8,ch,[30,60,90]);const t1=Math.round(ch/3),t2=Math.round(2*ch/3);
      for(let mask=0;mask<64;mask++)for(let y=0;y<ch;y++)for(let x=0;x<8;x++) {
        const bit=(y<t1?0:y<t2?2:4)+(x<4?0:1);
        if(mask&(1<<bit))img.data.set([220,150,50],(y*img.width+mask*8+x)*4);
      }
      for(const sextants of [false,true])render(img,[],{cols:64,rows:1,cellWidth:8,cellHeight:ch,pageBackground:0,photos:[{x:0,y:0,w:512,h:ch}],sextants,lines:true});
    }
  });
  test('deterministic mixed UI patterns',()=>{
    let seed=0x12345678;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
    for(let f=0;f<36;f++){
      const img=page(80,48,[rand()%256,rand()%256,rand()%256]);
      for(let k=0;k<12;k++){const x=rand()%80,y=rand()%48;fill(img,x,y,1+rand()%(80-x),1+rand()%(48-y),[rand()%256,rand()%256,rand()%256]);}
      stroke(img,[[0,rand()%48],[40,rand()%48],[80,rand()%48]],1+rand()%4,[rand()%256,rand()%256,rand()%256]);
      render(img,[],grid(10,3,{lines:true,sextants:f%2===0}));
    }
  });
});

// A deterministic ray-traced 3D scene: shaded spheres over a checker plane.
// 100x30 terminal cells at 2x => 1600x960 pixels, 16x32 per fitted cell.
export function threeDimensionalScene() {
  const width=1600,height=960;const img=page(width,height,[12,17,29]);
  const spheres=[[-1.3,0,4.5,1.05,[52,128,230]],[1.1,0.3,5.6,1.3,[240,106,35]],[0,-0.7,2.8,0.3,[185,225,245]]];
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const dx=(x+0.5-width/2)/height*1.6,dy=-(y+0.5-height/2)/height*1.6,dz=1;
    const len=Math.hypot(dx,dy,dz),d=[dx/len,dy/len,dz/len];let best=Infinity,n=null,color=null;
    for(const [cx,cy,cz,r,rgb] of spheres){const b=-(d[0]*cx+d[1]*cy+d[2]*cz),disc=b*b-(cx*cx+cy*cy+cz*cz-r*r);if(disc<0)continue;const t=-b-Math.sqrt(disc);if(t>0&&t<best){best=t;n=[(d[0]*t-cx)/r,(d[1]*t-cy)/r,(d[2]*t-cz)/r];color=rgb;}}
    const plane=-1.15/d[1];if(plane>0&&plane<best){best=plane;n=[0,1,0];color=(Math.floor(d[0]*plane)+Math.floor(d[2]*plane))%2===0?[70,78,94]:[29,35,49];}
    if(color){const diffuse=Math.max(0,n[0]*-0.35+n[1]*0.75+n[2]*-0.56),shine=Math.pow(Math.max(0,n[0]*-0.2+n[1]*0.4+n[2]*-0.8944),36);const fog=Math.exp(-best*0.025);const i=(y*width+x)*4;for(let c=0;c<3;c++)img.data[i+c]=Math.round(Math.min(255,color[c]*(0.23+0.77*diffuse)+shine*160)*fog+[12,17,29][c]*(1-fog));}
  }return img;
}
await capture('benchmark',(render)=>{
  const img=threeDimensionalScene();
  for(const truecolor of [false,true])for(const sextants of [false,true])render(img,[],{cols:100,rows:30,cellWidth:16,cellHeight:32,pageBackground:0x0c111d,photos:[{x:0,y:0,w:1600,h:960}],truecolor,sextants,lines:true,memory:{},painter:{}});
});

const css=[null,'','red','#abc','#abcd','#12345','#123456','#1234567','#12345678','  #AbC  ','#zzzz','rgb(1.5, 2.5, 3.5)','rgba(12, 22, 34, 0.25)','prefix rgb(256, 999, 65536) suffix','rgb( 1,2,3)','rgb(1,2,3 )','rgb(-1,2,3)','rgb(..,2,3)','color(srgb .5 1.5 0 / .3)','color(srgb 0 0 0)','color(srgb 0 0 0 )','RGB(1,2,3)','rgb(4294967296, 2, 3)'];
const canvas=[];const painter={};for(const h of [16,6,4,2,8]){const img=fill(page(64,32,[30,34,50]),0,32-h,64,h,[60,140,250]);const rect={x:0,y:0,w:64,h:32,canvas2d:true};canvas.push({image:saveImage(img),rect,expected:canvasIsPhoto(img,rect,painter)});}
writeFileSync(new URL('utilities.json',dir),JSON.stringify({css:css.map(input=>({input,expected:parseCssColor(input)})),canvas}));
// Delete only obsolete generated fixture images on regeneration.
for(const name of readdirSync(dir))if(/^[a-f0-9]{24}\.png$/.test(name)&&!imageNames.has(name))unlinkSync(new URL(name,dir));
const size=readdirSync(dir).reduce((n,f)=>n+statSync(new URL(f,dir)).size,0);assert.ok(size<20_000_000,`fixtures are ${size} bytes`);
console.log(`${imageNames.size} PNGs; ${(size/1e6).toFixed(2)} MB total. Node ${process.version}, Unicode ${process.versions.unicode}`);
