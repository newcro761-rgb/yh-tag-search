const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Element {
  constructor(tag='div') { this.tag=tag; this.children=[]; this.style={}; this.attrs={}; this.events={}; this.value=''; this.classList={add(){},remove(){}}; }
  appendChild(n){this.children.push(n);return n;}
  removeChild(n){this.children.splice(this.children.indexOf(n),1);}
  get firstChild(){return this.children[0];}
  setAttribute(k,v){this.attrs[k]=v;}
  getAttribute(k){return this.attrs[k];}
  addEventListener(k,v){this.events[k]=v;}
  focus(){}
  get textContent(){return (this.text||'')+this.children.map(c=>c.textContent).join('');}
  set textContent(v){this.text=String(v);this.children=[];}
}
function app(){
 const nodes={};const doc={getElementById(id){return nodes[id] ||= new Element();},createElement:t=>new Element(t),createTextNode(t){const n=new Element('#text');n.textContent=t;return n;},documentElement:new Element()};
 const context={document:doc,sessionStorage:{getItem:()=> '1'},localStorage:{getItem:()=>null,setItem(){}},window:{matchMedia:()=>({matches:false})},location:{hash:''},console,setTimeout,clearTimeout,TextEncoder,navigator:{}};
 vm.createContext(context);
 const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
 let source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
 source=source.replace('  initFromHash();', `  globalThis.api = {parseSse,finalize,renderResults,renderBaseScan,runBaseTagScan,runSearch,logicPageUrl,doSearch, setTool(fn){callTool=fn;}};`);
 vm.runInContext(source,context);
 return {api:context.api,nodes};
}
const envelope = data=>JSON.stringify({result:{content:[{type:'text',text:JSON.stringify(data)}]}});
const emptyLookup={usages:[],field_instruments:[]};
function tree(n){return [n,...n.children.flatMap(tree)];}
test('MCP errors and malformed payloads never become empty results',()=>{
 const {api}=app();
 for(const raw of [JSON.stringify({result:{isError:true,content:[{text:'failed'}]}}),envelope({error:'DB unavailable'}),envelope(null),'not JSON']) assert.throws(()=>api.parseSse(raw));
 assert.equal(api.parseSse('data: '+envelope({results:[]})+'\n').results.length,0);
 assert.equal(api.parseSse(envelope({results:[]})).results.length,0);
});
test('all failed / partial failed / genuine empty are distinct',async()=>{
 const {api,nodes}=app();
 assert.throws(()=>api.finalize('X',{variants:[]},null,[{data:null}],[],null));
 const partial=api.finalize('X',{variants:[]},emptyLookup,[{data:null}],[],{results:[]});api.renderResults(partial);
 assert.match(nodes.results.textContent,/일부 조회 실패/);assert.doesNotMatch(nodes.results.textContent,/태그를 찾지 못했습니다/);
 const empty=api.finalize('X',{variants:[]},emptyLookup,[{data:{results:[]}}],[],{results:[]});api.renderResults(empty);
 assert.match(nodes.results.textContent,/태그를 찾지 못했습니다/);
 const warnings=api.finalize('X',{variants:[]},{...emptyLookup,warnings:['현장계기']},[],[],{results:[]});assert.ok(warnings.failures.includes('현장계기'));
 api.setTool(()=>Promise.reject(new Error('offline')));await assert.rejects(api.runSearch('CW-MV03B'));
});
test('prefix search uses one indexed request and preserves later pages',async()=>{
 const {api,nodes}=app();const calls=[];
 api.setTool(async(name,args)=>{calls.push({name,args});return {prefix:'MS-PT',total:101,next_offset:args.offset?null:100,results:args.offset?[{base_tag:'MS-PT999Z'}]:Array.from({length:100},(_,i)=>({base_tag:'MS-PT'+i}))};});
 const r=await api.runBaseTagScan('5MS-PT',{unit:'5',sys:'MS',type:'PT'});assert.equal(calls.length,1);assert.equal(calls[0].name,'search_tags');
 api.renderBaseScan(r);tree(nodes.results).find(n=>n.text==='태그 더 보기').events.click();await new Promise(setImmediate);
 assert.equal(calls[1].args.offset,100);assert.match(nodes.results.textContent,/MS-PT999Z/);assert.match(nodes.results.textContent,/현재 101건/);
});
test('seven drawings are retained and more button reveals seventh',()=>{
 const {api,nodes}=app();api.renderResults({rawInput:'X',lookup:emptyLookup,logicSheets:[],drawings:Array.from({length:7},(_,i)=>({dwg_no:'D'+i,title:'Drawing '+i})),manualSearch:[],gen:{variants:[]},callLog:[]});
 const rows=tree(nodes.results).filter(n=>n.className==='pid-item');assert.equal(rows.length,7);assert.equal(rows[6].hidden,true);
 tree(nodes.results).find(n=>n.text==='나머지 1건 더 보기').events.click();assert.equal(rows[6].hidden,false);
});
test('usage-only sheets receive exact MAIN/FGD PDF page links',()=>{
 const {api}=app();const r=api.finalize('X',{variants:[]},{...emptyLookup,usages:[{logic_book:'FGD',drop_no:1,sheet_no:'2',pdf_page:345,title:'TEST'}]},[],[],{results:[]});
 assert.equal(r.logicSheets[0].pdf_page,345);assert.match(api.logicPageUrl(r.logicSheets[0]),/LOGIC_FGD_20240319.pdf#page=345$/);assert.equal(api.logicPageUrl({logic_book:'OTHER',pdf_page:1}),null);assert.equal(api.logicPageUrl({logic_book:'MAIN',pdf_page:null}),null);
});
test('setpoints, provenance and bundled drawing pages render with source links',()=>{
 const {api,nodes}=app();
 const lookup={...emptyLookup,
  field_instruments:[{raw_tag:'CR-FT01A',source_doc:'BOP-INDEX',maker:'AUTROL',signal_range:'0~450'}],
  instrument_provenance:[{doc_no:'L-59000-OJ-230-009',file_path:'001 계측제어/IL.pdf',pdf_page:4,status:'differs',diff_note:'레인지: 공식 0~150 / 엑셀 0~450'}],
  setpoints:[{raw_tag:'CR-FT-01A/01B',set_point:'H:130, HH: 140',unit:'T/H',cal_range:'0~190',doc_no:'L-50000-UJ-483-001',doc_rev:'E',file_path:'001 계측제어/SP.pdf',pdf_page:3,needs_check:true}],
  related_drawings:{'157 계장루프배선도':[{kosep_id:'L-56000-UJ-157-002',title:'ILWD',file_path:'001 계측제어/ILWD.pdf',pdf_page:11}]}};
 api.renderResults({rawInput:'CR-FT01A',lookup,logicSheets:[],drawings:[],manualSearch:[],gen:{variants:[]},callLog:[]});
 const all=Object.values(nodes).flatMap(tree);
 const text=all.map(n=>n.text||'').join('|');
 assert.match(text,/공식 0~150/);
 assert.match(text,/H:130, HH: 140 T\/H/);
 assert.match(text,/원본 쪽에서 확인/);
 const hrefs=all.map(n=>n.attrs.href).filter(Boolean);
 assert.ok(hrefs.some(h=>h.endsWith('/SP.pdf#page=3')));
 assert.ok(hrefs.some(h=>h.endsWith('/IL.pdf#page=4')));
 assert.ok(hrefs.some(h=>h.endsWith('/ILWD.pdf#page=11')));
});
test('server sheet index replaces per-variant search_logic scans',async()=>{
 const {api}=app();const calls=[];
 api.setTool((name,args)=>{calls.push(name);
  if(name==='lookup_tag') return Promise.resolve({...emptyLookup,body_mentions:[{logic_book:'MAIN',drop_no:21,sheet_no:'2',title:'MS',pdf_page:2354}]});
  return Promise.resolve({results:[]});});
 const r=await api.runSearch('MS-FT01B');
 assert.ok(!calls.includes('search_logic'));
 assert.equal(r.logicSheets.length,1);assert.equal(r.logicSheets[0].pdf_page,2354);
 const {api:old}=app();const oldCalls=[];
 old.setTool((name)=>{oldCalls.push(name);return Promise.resolve(name==='lookup_tag'?{...emptyLookup}:{results:[]});});
 await old.runSearch('MS-FT01B');
 assert.ok(oldCalls.includes('search_logic'));
});
test('supplier pid_dwg_no merges into the KOSEP drawing once with an alias; unresolved numbers stay raw',()=>{
 const {api,nodes}=app();
 const fi=(no,res)=>({raw_tag:'X',pid_dwg_no:no,service_desc:'S',...(res?{pid_dwg_resolved:res}:{})});
 const res={kosep_id:'L-31300-LM-105-001',title:'TURBINE STEAM',file_path:'a/b.pdf',pdf_page:3};
 const lookup={usages:[],field_instruments:[fi('310PB52-576',res),fi('310PB52-576',res),fi('ZZ-1')]};
 const r=api.finalize('X',{variants:[]},lookup,[],[],{results:[]});
 assert.deepEqual([...r.drawings.map(d=>d.dwg_no)],['L-31300-LM-105-001','ZZ-1']);
 assert.deepEqual([...r.drawings[0].aliases],['310PB52-576']);
 api.renderResults(r);
 assert.match(nodes.results.textContent,/\(= 히타치 번호 310PB52-576\)/);
 assert.match(nodes.results.textContent,/도면번호 읽는 법/);
});
