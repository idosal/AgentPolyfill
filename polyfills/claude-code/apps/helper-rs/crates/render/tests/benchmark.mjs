// Excludes scene generation, PNG decode and I/O. Same work as the Rust example.
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {decodePng} from '../../../../mod/helper/png.mjs';
const root=new URL('./fixtures/',import.meta.url);
const fixture=JSON.parse(readFileSync(new URL('benchmark.json',root)));
const image=decodePng(readFileSync(new URL(fixture.frames[0].image,root)));
let serial=0;
for(const step of fixture.frames){
  const {composeFrame}=await import(`../../../../mod/helper/render.mjs?benchmark=${serial++}`);
  const options={...step.options,memory:{},painter:{},now:0};
  let sink;const coldStart=performance.now();sink=composeFrame(image,[],options);const cold_ms=performance.now()-coldStart;
  for(let i=1;i<=20;i++){options.now=i*100;sink=composeFrame(image,[],options);}
  const times=[];const start=performance.now();
  for(let i=21;i<=220;i++){options.now=i*100;const start=performance.now();sink=composeFrame(image,[],options);times.push(performance.now()-start);}
  const mean_ms=(performance.now()-start)/200;times.sort((a,b)=>a-b);
  if(!sink.cells)throw Error('missing frame');
  console.log(JSON.stringify({runtime:`Node ${process.version}`,truecolor:options.truecolor,sextants:options.sextants,lines:options.lines,cols:100,rows:30,scale:2,frames:200,cold_ms,mean_ms,median_ms:times[100],p95_ms:times[190]}));
}
