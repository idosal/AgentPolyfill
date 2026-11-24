// Browser-independent checks for the scripts embedded into the Rust binary.
// Node is a development test tool only; the binary has no Node dependency.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const here = new URL('../js/', import.meta.url);
const node = fs.readFileSync(new URL('../../mod/helper/helper.mjs', import.meta.url), 'utf8');
for (const name of ['CANVAS_TEXT_HOOK','CHANGE_HOOK','STORE_HOOK','NO_WEBRTC','INSTANT_TRANSITIONS','CLIPBOARD_HOOK']) {
  const literal = node.match(new RegExp('const ' + name + ' = (`[\\s\\S]*?`);'))?.[1];
  assert.ok(literal, name);
  const expected = vm.runInNewContext(literal);
  const actual = fs.readFileSync(new URL(name.toLowerCase() + '.js', here), 'utf8').trimEnd();
  assert.equal(actual, expected, `${name} is copied verbatim`);
  new vm.Script(actual);
}
new vm.Script(fs.readFileSync(new URL('extract_text.js', here),'utf8'));
const calls = [];
const context = vm.createContext({window:{__cliHost: payload=>calls.push(JSON.parse(payload))}});
vm.runInContext(fs.readFileSync(new URL('binding.js', here),'utf8'), context);
const result = context.window.__cliHost('tools/call',{name:'test'});
assert.equal(calls[0].id, 1);
assert.equal(calls[0].kind,'tools/call');
assert.equal(typeof result.then,'function');
context.window.__cliHost.__answer(1,true,{answer:42});
assert.equal((await result).answer,42);
const rejected = context.window.__cliHost('resources/read',{});
context.window.__cliHost.__answer(2,false,'the view closed');
await assert.rejects(rejected,/the view closed/);

const storageContext = vm.createContext({btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary')});
storageContext.Store = vm.runInContext(fs.readFileSync(new URL('storage.js',here),'utf8'),storageContext);
assert.equal(typeof storageContext.Store,'function');
const serialized = expr=>JSON.parse(JSON.stringify(vm.runInContext(`new Store('chromium')._trySerialize(${expr})`,storageContext)));
assert.deepEqual(serialized('({count:3,nested:[true,"x"]})'),{trivial:{count:3,nested:[true,'x']}});
assert.deepEqual(serialized('new Date("2020-01-01T00:00:00Z")'),{encoded:{d:'2020-01-01T00:00:00.000Z'}});
assert.deepEqual(serialized('new Uint8Array([0,1,255])'),{encoded:{ta:{b:'AAH/',k:'ui8'}}});
assert.deepEqual(serialized('12n'),{encoded:{bi:'12'}});
const map = serialized('new Map([["n",3]])');
assert.equal(map.encoded.m[0].k,'n');
assert.equal(map.encoded.m[0].v,3);
console.log('PASS six verbatim hooks, extract-text syntax, binding promises/errors, and IndexedDB value serialization');
