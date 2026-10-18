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
test('value_conflicts render per-source values with stage labels and the no-auto-pick notice',()=>{
 const {api,nodes}=app();
 const lookup={...emptyLookup,value_conflicts:[
  {attr:'range',kind:'docs',values:[{value:'0~150',unit:'T/H',doc_no:'L-59000-OJ-230-009',doc_rev:'B',pdf_page:4,source:'instrument_provenance',stage:'asbuilt'},{value:'0~450',unit:'T/H',doc_no:null,source:'instruments',stage:'unknown'}]},
  {attr:'set_HH',kind:'logic_scale',values:[{value:'140',unit:null,doc_no:null,pdf_page:77,source:'sheets_logic_range'}]}]};
 api.renderResults({rawInput:'X',lookup,logicSheets:[],drawings:[],manualSearch:[],gen:{variants:[]},callLog:[]});
 const t=nodes.results.textContent;
 assert.match(t,/문서마다 값이 다름/);
 assert.match(t,/자동으로 고르지 않습니다/);
 assert.match(t,/레인지/);assert.match(t,/설정 HH/);
 assert.match(t,/0~150 T\/H\s+L-59000-OJ-230-009 Rev B p\.4/);
 assert.match(t,/준공/);
 assert.match(t,/계기 엑셀\(BOP-INDEX 등\)/);
 assert.match(t,/DCS 로직 시트 p\.77/);
 assert.match(t,/DCS 로직 스케일/);
 const none=app();
 none.api.renderResults({rawInput:'X',lookup:{...emptyLookup,field_instruments:[{raw_tag:'A'}],value_conflicts:[]},logicSheets:[],drawings:[],manualSearch:[],gen:{variants:[]},callLog:[]});
 assert.doesNotMatch(none.nodes.results.textContent,/문서마다 값이 다름/);
});
test('stage badges appear on drawings (doc_meta kept through merge) and related drawings; unknown shows none',()=>{
 const {api,nodes}=app();
 const lookup={...emptyLookup,
  pinned_drawings:[{dwg_no:'A-1',title:'t',file_path:'a.pdf',doc_meta:{stage:'as_installed',scope:null,rev:'1'}},{dwg_no:'B-2',title:'u',file_path:'b.pdf',doc_meta:{stage:'unknown'}}],
  candidate_drawings:[{dwg_no:'A-1',title:'t',doc_meta:{stage:'design'}}],
  related_drawings:{'157':[{kosep_id:'R-1',title:'r',file_path:'r.pdf',doc_meta:{stage:'oh_cal'}}]}};
 const r=api.finalize('X',{variants:[]},lookup,[],[],{results:[]});
 assert.equal(r.drawings.find(d=>d.dwg_no==='A-1').doc_meta.stage,'as_installed');
 api.renderResults(r);
 const pills=Object.values(nodes).flatMap(tree).filter(n=>n.className==='stage-pill').map(n=>n.text);
 assert.deepEqual(pills.sort(),['OH·교정','현재설치본'].sort());
});
test('tag_note renders at the top with preserved line breaks, sources and reviewer',()=>{
 const {api,nodes}=app();
 const lookup={...emptyLookup,field_instruments:[{raw_tag:'A'}],tag_note:{note:'줄1\n줄2',sources:[{kind:'logic_sheet',ref:'25-302'},{kind:'manual',ref:'해설서',page:207}],reviewed_by:'홍길동',reviewed_at:'2026-10-01'}};
 api.renderResults({rawInput:'X',lookup,logicSheets:[],drawings:[],manualSearch:[],gen:{variants:[]},callLog:[]});
 const kids=nodes.results.children;
 assert.match(kids[1].textContent,/설비 설명 \(검토됨\)/);
 const note=tree(nodes.results).find(n=>n.className==='tag-note-text');
 assert.equal(note.text,'줄1\n줄2');
 const t=nodes.results.textContent;
 assert.match(t,/로직 시트 25-302/);assert.match(t,/해설서 해설서 p\.207/);assert.match(t,/검토: 홍길동 2026-10-01/);
 const no=app();
 no.api.renderResults({rawInput:'X',lookup:{...emptyLookup,field_instruments:[{raw_tag:'A'}]},logicSheets:[],drawings:[],manualSearch:[],gen:{variants:[]},callLog:[]});
 assert.doesNotMatch(no.nodes.results.textContent,/설비 설명/);
});

test('tag_auto renders section with redundancy, sheets, used_by overflow, trip box and basis; lookup with only tag_auto counts',()=>{
 const {api,nodes}=app();
 const ta={entry_sheets:[{ref:'25-302',title:'ANALOG INPUT'}],used_by:[{ref:'1-197',title:'APC'}],used_by_total:9,trip_paths:[['25-302 A','23-424 B','23-407 C'],['x','y']],trip_path_basis:['estimated','confirmed'],trip_level:'indirect',redundancy:['2of3','median'],method:'auto_v1',built_at:'2026-10-01'};
 api.renderResults({rawInput:'X',lookup:{...emptyLookup,tag_auto:ta},logicSheets:[],drawings:[],manualSearch:[],gen:{variants:[]},callLog:[]});
 const t=nodes.results.textContent;
 assert.match(t,/자동 추출 \(검토 전\)/);assert.match(t,/다중화: 3개 중 2개 판정, 중간값 선택/);
 assert.match(t,/쓰이는 시트: 25-302 ANALOG INPUT/);assert.match(t,/신호가 가는 곳 \(9곳\)/);assert.match(t,/외 8곳/);
 assert.match(t,/간접 연결됨 \(2단계\)/);assert.match(t,/25-302 A → 23-424 B → 23-407 C/);
 assert.match(t,/방향 추정/);assert.match(t,/방향 확정/);assert.match(t,/시트 단위 연결입니다/);
 const d=app();
 d.api.renderResults({rawInput:'X',lookup:{...emptyLookup,field_instruments:[{raw_tag:'A'}],tag_auto:{...ta,trip_paths:[],trip_level:null}},logicSheets:[],drawings:[],manualSearch:[],gen:{variants:[]},callLog:[]});
 assert.match(d.nodes.results.textContent,/찾지 못했습니다 \(2단계 이내\)/);
 const direct=app();
 direct.api.renderResults({rawInput:'X',lookup:{...emptyLookup,tag_auto:{...ta,trip_level:'direct'}},logicSheets:[],drawings:[],manualSearch:[],gen:{variants:[]},callLog:[]});
 assert.match(direct.nodes.results.textContent,/직접 연결됨/);
 const no=app();
 no.api.renderResults({rawInput:'X',lookup:{...emptyLookup,field_instruments:[{raw_tag:'A'}]},logicSheets:[],drawings:[],manualSearch:[],gen:{variants:[]},callLog:[]});
 assert.doesNotMatch(no.nodes.results.textContent,/자동 추출/);
});

test('tag_auto.ai_note shows AI draft with confidence and uncertain; hidden when reviewed tag_note exists',()=>{
 const ta={entry_sheets:[],used_by:[],used_by_total:0,trip_paths:[],trip_path_basis:[],trip_level:null,redundancy:[],method:'auto_v1',
  ai_note:{note:'줄1\n줄2',sources:[{kind:'logic_sheet',ref:'23-421'}],confidence:'low',uncertain:'투표 방식 미확인'}};
 const {api,nodes}=app();
 api.renderResults({rawInput:'X',lookup:{...emptyLookup,tag_auto:ta},logicSheets:[],drawings:[],manualSearch:[],gen:{variants:[]},callLog:[]});
 const t=nodes.results.textContent;
 assert.match(t,/AI 설명 \(검토 전\) · 근거 부족/);assert.match(t,/확인 못 한 것: 투표 방식 미확인/);assert.match(t,/로직 시트 23-421/);
 const r=app();
 r.api.renderResults({rawInput:'X',lookup:{...emptyLookup,tag_note:{note:'검토본',sources:[]},tag_auto:ta},logicSheets:[],drawings:[],manualSearch:[],gen:{variants:[]},callLog:[]});
 assert.doesNotMatch(r.nodes.results.textContent,/AI 설명/);
});

test('ai_note.summary shown first, full note folded under 자세히',()=>{
 const ta={entry_sheets:[],used_by:[],used_by_total:0,trip_paths:[],trip_path_basis:[],trip_level:null,redundancy:[],method:'auto_v1',
  ai_note:{summary:'요약1\n⚠ 요약2',note:'긴 설명',sources:[],confidence:'high',uncertain:'없음 아님'}};
 const {api,nodes}=app();
 api.renderResults({rawInput:'X',lookup:{...emptyLookup,tag_auto:ta},logicSheets:[],drawings:[],manualSearch:[],gen:{variants:[]},callLog:[]});
 const sum=tree(nodes.results).find(n=>(n.className||'').includes('ai-note-summary'));
 assert.equal(sum.text,'요약1\n⚠ 요약2');
 const det=tree(nodes.results).find(n=>n.className==='ai-note-more');
 assert.ok(det, 'details 접힘 영역');
 assert.match(det.textContent,/자세히/);assert.match(det.textContent,/긴 설명/);
});
