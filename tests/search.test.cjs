const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Element {
  constructor(tag='div') { this.tag=tag; this.children=[]; this.style={}; this.attrs={}; this.events={}; this.value=''; this.classList={_cl:new Set(),add(c){this._cl.add(c);},remove(c){this._cl.delete(c);},toggle(c,v){v===undefined?this._cl.has(c)?this._cl.delete(c):this._cl.add(c):v?this._cl.add(c):this._cl.delete(c);},contains(c){return this._cl.has(c)}}; this.className=''; this._attrs={}; }
  appendChild(n){this.children.push(n);return n;}
  removeChild(n){this.children.splice(this.children.indexOf(n),1);}
  get firstChild(){return this.children[0];}
  setAttribute(k,v){this.attrs[k]=v;this._attrs[k]=v;if(k==='class')this.className=v;}
  getAttribute(k){return this._attrs[k];}
  addEventListener(k,v,cap){
    const prev=this.events[k];
    // Keep as callable function (for existing tests) but chain multiple
    if(!prev){this.events[k]=v;}
    else{const all=Array.isArray(prev)?[...prev,v]:[prev,v];this.events[k]=(...a)=>all.forEach(f=>f(...a));}
  }
  focus(){}
  removeAttribute(k){delete this._attrs[k];}
  get textContent(){return (this.text||'')+this.children.map(c=>c.textContent).join('');}
  set textContent(v){this.text=String(v);this.children=[];}
  scrollIntoView(){}
}
class DocFragment extends Element{constructor(){super('#frag');}}
function allNodes(root){return[root,...(root.children||[]).flatMap(allNodes)];}
function app(fetchFn){
 const nodes={};
 const doc={
   getElementById(id){return nodes[id] ||= new Element();},
   createElement:t=>new Element(t),
   createTextNode(t){const n=new Element('#text');n.textContent=t;return n;},
   createDocumentFragment(){return new DocFragment();},
   documentElement:new Element(),
   querySelectorAll(sel){
     // Return catalog-filter buttons if asked
     const all=Object.values(nodes);
     return {forEach:fn=>{},length:0};
   }
 };
 const context={document:doc,sessionStorage:{getItem:(k)=>k==='tagsearch-catalog-token'?'catalog.9999999999999.mock':'1',setItem(){}},localStorage:{getItem:()=>null,setItem(){}},window:{matchMedia:()=>({matches:false}),addEventListener(){},scrollTo(){}},location:{hash:''},console,setTimeout,clearTimeout,TextEncoder,navigator:{},URLSearchParams:class{constructor(){this._p={};}set(k,v){this._p[k]=v;}toString(){return Object.entries(this._p).map(([k,v])=>k+'='+encodeURIComponent(v)).join('&');}},fetch:fetchFn||(()=>Promise.resolve({ok:false,status:500,json:()=>Promise.resolve({})})),AbortController};
 vm.createContext(context);
 const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
 let source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
 source=source.replace('  initFromHash();', `  globalThis.api = {callTool,finalize,renderResults,renderBaseScan,runBaseTagScan,runSearch,logicPageUrl,doSearch,generateVariants, setTool(fn){callTool=fn;},renderCatalogResults};`);
 vm.runInContext(source,context);
 return {api:context.api,nodes};
}
test('equipment ledger alone renders only the sections that have evidence, optional values and historical stock with provenance',()=>{
 const {api,nodes}=app();
 const lookup={...emptyLookup,equipment_ledger:{records:[{tag:'TEST-PT01',source:{file:'fixture.xlsx',sheet:'Sheet A',row:7},specification:'Test specification',material_no:'TEST-M',service:'Test service',drawing_no:'TEST-D',stock_snapshot:0,purchases:[{year:2020,quantity:0}],manufacturer:'Test maker',model:'Test model',storage:'Test shelf',notes:'Test note',drawings:[{url:'https://example.invalid/test.pdf',title:'Test drawing',source:'Fixture source'}]},{}]}};
 api.renderResults({rawInput:'TEST-PT01',lookup,logicSheets:[],drawings:[],manualSearch:[],gen:api.generateVariants('TEST-PT01'),callLog:[]});
 const ledger=ledgerOf(nodes);
 assert.ok(ledger,'equipment ledger rendered');
 // 근거가 있는 섹션만 그린다(배선 없음 → 연결 정보 섹션 없음, '자료 없음' 한 줄로 대체).
 assert.deepEqual(tree(ledger).filter(n=>n.tag==='section').map(n=>n.attrs.id),['ledger-specs','ledger-drawings','ledger-inventory','ledger-gaps']);
 for(const label of ['대장 사양','대장 도면','재고·정비','검토 공백','자료 없음','미확인','미확보','기준일 미확인','현재 재고가 아닙니다','fixture.xlsx','Sheet A','7행','Test specification','TEST-M','Test service','TEST-D','Test maker','Test model','Test shelf','Test note','2020년 · 0']) assert.ok(ledger.textContent.includes(label),label);
 assert.ok(tree(ledger).some(n=>n.tag==='dd' && n.text==='0'));
 assert.ok(tree(ledger).some(n=>n.attrs.href==='https://example.invalid/test.pdf'));
});

test('ledger uses safe text, blocks unsafe drawing links and tolerates sparse records',()=>{
 const {api,nodes}=app();
 const hostile='<img src=x onerror=alert(1)>';
 const lookup={...emptyLookup,equipment_ledger:{records:[null,[],{tag:hostile,specification:hostile,source:{file:hostile,row:0},purchases:[null,{}],drawings:[null,{url:'javascript:alert(1)',title:hostile},{url:'data:text/html,test'},{url:'//example.invalid/a.pdf'},{url:'https://user:pass@example.invalid/a.pdf'}]},{}]}};
 api.renderResults({rawInput:'TEST-01',lookup,logicSheets:[],drawings:[],gen:api.generateVariants('TEST-01'),callLog:[]});
 const ledger=ledgerOf(nodes), all=tree(ledger);
 assert.ok(ledger.textContent.includes(hostile));
 assert.ok(ledger.textContent.includes('0행'));
 assert.ok(ledger.textContent.includes('실물 파일 미확보'));
 assert.equal(all.filter(n=>n.tag==='img' || n.tag==='script').length,0);
 assert.equal(all.filter(n=>n.tag==='a' && n.attrs.target==='_blank').length,0);
 assert.ok(ledger.textContent.includes('미확인년 · 미확인'));
});

test('ledger preserves separate record provenance and legacy detail without claiming current stock',()=>{
 const {api,nodes}=app();
 const lookup={...emptyLookup,field_instruments:[{raw_tag:'TEST-01',maker:'Legacy maker',source_doc:'TEST-INDEX',set_point:0}],equipment_ledger:{records:[{source:{file:'fixture-a.xlsx',row:1},model:'Model A'},{source:{file:'fixture-b.xlsx',row:2},model:'Model B'}]}};
 api.renderResults({rawInput:'TEST-01',lookup,logicSheets:[],drawings:[],gen:api.generateVariants('TEST-01'),callLog:[]});
 const ledger=ledgerOf(nodes);
 const records=tree(ledger).filter(n=>n.className==='ledger-record');
 assert.match(records[0].textContent,/Model A.*fixture-a.xlsx/s);
 assert.doesNotMatch(records[0].textContent,/Model B/);
 assert.match(records[1].textContent,/Model B.*fixture-b.xlsx/s);
 // 레거시 계기 정보는 설비대장이 아니라 별도 '현장계기 정보' 섹션에 나온다.
 assert.match(nodes.results.textContent,/Legacy maker/);
 assert.match(nodes.results.textContent,/TEST-INDEX/);
 assert.match(nodes.results.textContent,/현장계기 정보/);
 // 재고 근거가 없으면 재고 섹션을 그리지 않고 '자료 없음'으로만 알린다(재고를 단정하지 않음).
 assert.match(ledger.textContent,/자료 없음 \(조회했으나 찾지 못함\).*재고·정비/s);
 assert.doesNotMatch(ledger.textContent,/현재 재고가 아닙니다/);
});

test('legacy-only results still receive ledger and malformed optional ledger never breaks them',()=>{
 for(const equipment_ledger of [undefined,null,{}, {records:null},{records:'invalid'},{records:[null,[]]}]){
  const {api,nodes}=app();
  api.renderResults({rawInput:'TEST-01',lookup:{...emptyLookup,field_instruments:[{raw_tag:'TEST-01'}],equipment_ledger},logicSheets:[],drawings:[],gen:api.generateVariants('TEST-01'),callLog:[]});
  assert.ok(ledgerOf(nodes),'equipment ledger rendered');
  assert.match(nodes.results.textContent,/설비대장 원문 근거 미확보/);
  assert.match(nodes.results.textContent,/현장계기 정보/);
 }
});

test('embedded raster drawings render safe preview, keyboard zoom and candidate provenance',()=>{
 const {api,nodes}=app();
 // Deliberately tiny inert fixture; never a work drawing.
 const image='data:image/png;base64,iVBORw0KGgo=';
 const lookup={...emptyLookup,equipment_ledger:{records:[{drawings:[{url:image,title:'Fixture image',source:{file:'fixture.xlsx',sheet:'Drawing',row:1},match_status:'sheet_name_candidate'},{url:'data:image/svg+xml;base64,PHN2Zz4='},{url:'data:text/html;base64,PHNjcmlwdD4='}]}]}};
 api.renderResults({rawInput:'TEST-01',lookup,logicSheets:[],drawings:[],gen:api.generateVariants('TEST-01'),callLog:[]});
 const ledger=ledgerOf(nodes), all=tree(ledger);
 assert.equal(all.filter(n=>n.tag==='img').length,2);
 assert.ok(all.filter(n=>n.tag==='img').every(n=>n.attrs.src===image));
 assert.equal(all.filter(n=>n.tag==='details').length,1);
 assert.ok(all.some(n=>n.tag==='summary' && n.textContent.includes('도면 확대')));
 assert.ok(all.some(n=>n.attrs.role==='region' && n.attrs.tabindex==='0'));
 assert.ok(all.every(n=>n.tag!=='a' || !String(n.attrs.href).startsWith('data:')));
 assert.match(ledger.textContent,/도면 후보 · 시트명 기반 연결, 태그 일치 미검토/);
 assert.match(ledger.textContent,/fixture.xlsx/);
});

test('workbook fields, unresolved groups and raw columns remain source-specific and safe',()=>{
 const {api,nodes}=app();
 const record={tag:'ZZ-PT01(A,B)',raw_tag:'ZZ-PT-01(A,B)',is_grouped:true,tag_resolution:'unresolved_group',source:{file:'fixture.xlsx',sheet:'Stock',row:8,sha256:'fixture-hash'},setpoints:0,accessories:'Fixture accessory',location:'Fixture location',panel_no:'Fixture panel',drawing_reference_prefix:'99999-J-',stock_snapshot:0,stock_as_of:'2020-01-01',storage:'Fixture shelf',storage_kind:'workshop_storage',source_columns:{A:0,B:null,C:'<script>bad()</script>'},source_column_labels:{A:'Quantity',B:'Missing',C:'Notes'}};
 api.renderResults({rawInput:'ZZ-PT01(A,B)',lookup:{...emptyLookup,equipment_ledger:{records:[record]}},logicSheets:[],drawings:[],gen:api.generateVariants('ZZ-PT01(A,B)'),callLog:[]});
 const ledger=ledgerOf(nodes), text=ledger.textContent;
 for(const value of ['원문 태그','설정값 (목록 원문)','Fixture accessory','Fixture location','Fixture panel','완전한 도면번호 아님','개별 태그로 확장하지 않았','2020-01-01','작업실 보관, JB 아님','원본 열 전체 보기','fixture-hash','A · Quantity','B · Missing','<script>bad()</script>']) assert.ok(text.includes(value),value);
 assert.ok(tree(ledger).some(n=>n.tag==='dd' && n.text==='0'));
 assert.ok(tree(ledger).every(n=>n.tag!=='script'));
 assert.equal(api.generateVariants('ZZ-PT-01-A').forLookup,'ZZ-PT-01-A');
});
const emptyLookup={usages:[],field_instruments:[]};
// 결과 맨 위에는 답 카드(answer-card)가 있으므로 설비대장은 className으로 찾는다.
function ledgerOf(nodes){return tree(nodes.results).find(n=>n.className==='equipment-ledger');}
function tree(n){return [n,...n.children.flatMap(tree)];}
// callTool: POST /catalog/tool with Bearer token, plain JSON. (Replaces the removed MCP/SSE parseSse tests.)
const res=(status,body)=>Promise.resolve({ok:status>=200&&status<300,status,text:()=>Promise.resolve(typeof body==='string'?body:JSON.stringify(body))});
test('callTool errors and malformed payloads never become empty results',async()=>{
 for(const [status,body] of [[200,'not JSON'],[200,'null'],[200,{error:'DB unavailable'}],[400,{error:'bad request'}],[500,'oops']]){
  const {api}=app(()=>res(status,body));
  await assert.rejects(api.callTool('lookup_tag',{tag:'X'}),'status '+status+' '+JSON.stringify(body));
 }
 const {api}=app(()=>res(200,{results:[]}));
 assert.equal((await api.callTool('search_tags',{prefix:'MS-PT'})).results.length,0);
});
test('callTool sends POST to /catalog/tool with Bearer token and JSON body; 401 is an auth error',async()=>{
 const calls=[];
 const {api}=app((url,opt)=>{calls.push({url,opt});return res(200,{ok:1});});
 await api.callTool('lookup_tag',{tag:'CW-MV03B'});
 assert.match(calls[0].url,/\/catalog\/tool$/);
 assert.equal(calls[0].opt.method,'POST');
 assert.equal(calls[0].opt.headers.Authorization,'Bearer catalog.9999999999999.mock');
 assert.deepEqual(JSON.parse(calls[0].opt.body),{name:'lookup_tag',arguments:{tag:'CW-MV03B'}});
 const a2=app(()=>res(401,{error:'expired'}));
 await assert.rejects(a2.api.callTool('lookup_tag',{tag:'X'}),e=>e.kind==='auth');
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
 const {api,nodes}=app();api.renderResults({rawInput:'X',lookup:emptyLookup,logicSheets:[],drawings:Array.from({length:7},(_,i)=>({dwg_no:'D'+i,title:'Drawing '+i})),manualSearch:[],gen:api.generateVariants('X'),callLog:[]});
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
 api.renderResults({rawInput:'CR-FT01A',lookup,logicSheets:[],drawings:[],manualSearch:[],gen:api.generateVariants('CR-FT01A'),callLog:[]});
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
 api.renderResults({rawInput:'X',lookup,logicSheets:[],drawings:[],manualSearch:[],gen:api.generateVariants('X'),callLog:[]});
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
 none.api.renderResults({rawInput:'X',lookup:{...emptyLookup,field_instruments:[{raw_tag:'A'}],value_conflicts:[]},logicSheets:[],drawings:[],manualSearch:[],gen:api.generateVariants('X'),callLog:[]});
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
 // 답 카드의 P&ID 상위 2건과 P&ID 목록에 같은 배지가 각각 나온다(A-1 두 번).
 assert.deepEqual(pills.sort(),['OH·교정','현재설치본','현재설치본'].sort());
});
test('tag_note renders at the top with preserved line breaks, sources and reviewer',()=>{
 const {api,nodes}=app();
 const lookup={...emptyLookup,field_instruments:[{raw_tag:'A'}],tag_note:{note:'줄1\n줄2',sources:[{kind:'logic_sheet',ref:'25-302'},{kind:'manual',ref:'해설서',page:207}],reviewed_by:'홍길동',reviewed_at:'2026-10-01'}};
 api.renderResults({rawInput:'X',lookup,logicSheets:[],drawings:[],manualSearch:[],gen:api.generateVariants('X'),callLog:[]});
 const kids=nodes.results.children;
 assert.match(kids[1].textContent,/설비 설명 \(검토됨\)/);
 const note=tree(nodes.results).find(n=>n.className==='tag-note-text');
 assert.equal(note.text,'줄1\n줄2');
 const t=nodes.results.textContent;
 assert.match(t,/로직 시트 25-302/);assert.match(t,/해설서 해설서 p\.207/);assert.match(t,/검토: 홍길동 2026-10-01/);
 const no=app();
 no.api.renderResults({rawInput:'X',lookup:{...emptyLookup,field_instruments:[{raw_tag:'A'}]},logicSheets:[],drawings:[],manualSearch:[],gen:api.generateVariants('X'),callLog:[]});
 assert.doesNotMatch(no.nodes.results.textContent,/설비 설명/);
});

test('tag_auto renders section with redundancy, sheets, used_by overflow, trip box and basis; lookup with only tag_auto counts',()=>{
 const {api,nodes}=app();
 const ta={entry_sheets:[{ref:'25-302',title:'ANALOG INPUT'}],used_by:[{ref:'1-197',title:'APC'}],used_by_total:9,trip_paths:[['25-302 A','23-424 B','23-407 C'],['x','y']],trip_path_basis:['estimated','confirmed'],trip_level:'indirect',redundancy:['2of3','median'],method:'auto_v1',built_at:'2026-10-01'};
 api.renderResults({rawInput:'X',lookup:{...emptyLookup,tag_auto:ta},logicSheets:[],drawings:[],manualSearch:[],gen:api.generateVariants('X'),callLog:[]});
 const t=nodes.results.textContent;
 assert.match(t,/자동 추출 \(검토 전\)/);assert.match(t,/다중화: 3개 중 2개 판정, 중간값 선택/);
 assert.match(t,/쓰이는 시트: 25-302 ANALOG INPUT/);assert.match(t,/신호가 가는 곳 \(9곳\)/);assert.match(t,/외 8곳/);
 assert.match(t,/간접 연결됨 \(2단계\)/);assert.match(t,/25-302 A → 23-424 B → 23-407 C/);
 assert.match(t,/방향 추정/);assert.match(t,/방향 확정/);assert.match(t,/시트 단위 연결입니다/);
 const d=app();
 d.api.renderResults({rawInput:'X',lookup:{...emptyLookup,field_instruments:[{raw_tag:'A'}],tag_auto:{...ta,trip_paths:[],trip_level:null}},logicSheets:[],drawings:[],manualSearch:[],gen:api.generateVariants('X'),callLog:[]});
 assert.match(d.nodes.results.textContent,/찾지 못했습니다 \(2단계 이내\)/);
 const direct=app();
 direct.api.renderResults({rawInput:'X',lookup:{...emptyLookup,tag_auto:{...ta,trip_level:'direct'}},logicSheets:[],drawings:[],manualSearch:[],gen:api.generateVariants('X'),callLog:[]});
 assert.match(direct.nodes.results.textContent,/직접 연결됨/);
 const no=app();
 no.api.renderResults({rawInput:'X',lookup:{...emptyLookup,field_instruments:[{raw_tag:'A'}]},logicSheets:[],drawings:[],manualSearch:[],gen:api.generateVariants('X'),callLog:[]});
 assert.doesNotMatch(no.nodes.results.textContent,/자동 추출/);
});

test('tag_auto.ai_note shows AI draft with confidence and uncertain; hidden when reviewed tag_note exists',()=>{
 const ta={entry_sheets:[],used_by:[],used_by_total:0,trip_paths:[],trip_path_basis:[],trip_level:null,redundancy:[],method:'auto_v1',
  ai_note:{note:'줄1\n줄2',sources:[{kind:'logic_sheet',ref:'23-421'}],confidence:'low',uncertain:'투표 방식 미확인'}};
 const {api,nodes}=app();
 api.renderResults({rawInput:'X',lookup:{...emptyLookup,tag_auto:ta},logicSheets:[],drawings:[],manualSearch:[],gen:api.generateVariants('X'),callLog:[]});
 const t=nodes.results.textContent;
 assert.match(t,/AI 설명 \(검토 전\) · 근거 부족/);assert.match(t,/확인 못 한 것: 투표 방식 미확인/);assert.match(t,/로직 시트 23-421/);
 const r=app();
 r.api.renderResults({rawInput:'X',lookup:{...emptyLookup,tag_note:{note:'검토본',sources:[]},tag_auto:ta},logicSheets:[],drawings:[],manualSearch:[],gen:api.generateVariants('X'),callLog:[]});
 assert.doesNotMatch(r.nodes.results.textContent,/AI 설명/);
});

test('ai_note.summary shown first, full note folded under 자세히',()=>{
 const ta={entry_sheets:[],used_by:[],used_by_total:0,trip_paths:[],trip_path_basis:[],trip_level:null,redundancy:[],method:'auto_v1',
  ai_note:{summary:'요약1\n⚠ 요약2',note:'긴 설명',sources:[],confidence:'high',uncertain:'없음 아님'}};
 const {api,nodes}=app();
 api.renderResults({rawInput:'X',lookup:{...emptyLookup,tag_auto:ta},logicSheets:[],drawings:[],manualSearch:[],gen:api.generateVariants('X'),callLog:[]});
 const sum=tree(nodes.results).find(n=>(n.className||'').includes('ai-note-summary'));
 assert.equal(sum.text,'요약1\n⚠ 요약2');
 const det=tree(nodes.results).find(n=>n.className==='ai-note-more');
 assert.ok(det, 'details 접힘 영역');
 assert.match(det.textContent,/자세히/);assert.match(det.textContent,/긴 설명/);
});

test('wiring and doc_refs fill connection fields, add a related-docs section, and links stay on the file server',()=>{
 const {api,nodes}=app();
 const lookup={...emptyLookup,wiring:{records:[{raw_tag:'5TB-PT-02A-A',description:'MAIN OIL PRESS',drop:'36/86',card:'111',channel:'1',signal:'AIHART',mr_cabinet:'TBN-MR-1',system_cabinet:'TBN-SYS-1',slot:'3',source:{file:'DROP36.xlsb',file_path:'001 계측제어/IWD/DROP36.xlsb',sheet:'Raw Data',row:9}},null]},
  doc_refs:{refs:[{category:'보호·트립 로직',file:'Trip.pdf',file_path:'001 계측제어/Trip.pdf',page:3,excerpt:'TB-PT-02A LOW 0.5MPa'},{category:'화면',file:'TBN01.jpg',file_path:'javascript:alert(1)',page:1},null]}};
 api.renderResults({rawInput:'TB-PT02A',lookup,logicSheets:[],drawings:[],manualSearch:[],gen:api.generateVariants('TB-PT02A'),callLog:[]});
 const text=nodes.results.textContent;
 assert.match(text,/Drop 36\/86 · Card 111 · CH 1 · AIHART/);
 assert.match(text,/MR\/IR TBN-MR-1 · SYS TBN-SYS-1 · Slot 3/);
 assert.match(text,/IWD DROP Raw Data 원문 1행/);
 assert.match(text,/관련 문서/);
 assert.match(text,/보호·트립 로직 · 1건/);
 assert.match(text,/OCR 발췌 \(원문 대조 필요\): TB-PT-02A LOW 0.5MPa/);
 assert.match(text,/배선·단자·채널: IWD 원문 추출값\(검토 전\)/);
 assert.doesNotMatch(text,/배선·단자·DCS 채널 근거: 미확보/);
 const links=[];(function walk(n){if(n.tag==='a'&&n.attrs.href)links.push(n.attrs.href);(n.children||[]).forEach(walk);})(nodes.results);
 assert.ok(links.some(h=>/Trip\.pdf#page=3$/.test(h)));
 assert.ok(links.every(h=>!/javascript:/i.test(h)));
});

test('drawings with mixed disciplines UJ/LM group into separate discipline headers with 추정 label',()=>{
  const {api,nodes}=app();
  const drawings=[
    {dwg_no:'L-31300-UJ-105-001',title:'BOP P&ID',tier:'t1',file_path:null,doc_meta:null},
    {dwg_no:'L-31300-LM-105-001',title:'TG Mech',tier:'t1',file_path:null,doc_meta:null},
    {dwg_no:'L-31300-UJ-105-002',title:'BOP P&ID 2',tier:'t1',file_path:null,doc_meta:null},
  ];
  api.renderResults({rawInput:'X',lookup:{...emptyLookup,field_instruments:[{raw_tag:'X'}]},logicSheets:[],drawings,manualSearch:[],gen:api.generateVariants('X'),callLog:[]});
  const t=nodes.results.textContent;
  // Both discipline headers appear
  assert.match(t,/계측제어 \(UJ\)/);
  assert.match(t,/기계 \(LM\)/);
  // 추정 caveat present
  assert.match(t,/추정/);
  // Drawing numbers present
  assert.match(t,/L-31300-UJ-105-001/);
  assert.match(t,/L-31300-LM-105-001/);
  // UJ group appears before LM group (UJ first in DWG_DISC_ORDER)
  const ujPos=t.indexOf('계측제어 (UJ)');
  const lmPos=t.indexOf('기계 (LM)');
  assert.ok(ujPos<lmPos,'UJ disc header precedes LM disc header');
});

test('drawings with single discipline show no group headers',()=>{
  const {api,nodes}=app();
  const drawings=[
    {dwg_no:'L-31300-UJ-105-001',title:'BOP P&ID',tier:'t1',file_path:null,doc_meta:null},
    {dwg_no:'L-31300-UJ-105-002',title:'BOP P&ID 2',tier:'t1',file_path:null,doc_meta:null},
  ];
  api.renderResults({rawInput:'X',lookup:{...emptyLookup,field_instruments:[{raw_tag:'X'}]},logicSheets:[],drawings,manualSearch:[],gen:api.generateVariants('X'),callLog:[]});
  const t=nodes.results.textContent;
  // Drawing numbers present but no discipline group header
  assert.match(t,/L-31300-UJ-105-001/);
  assert.doesNotMatch(t,/계측제어 \(UJ\)/);
});

test('logic section appears before instrument section (current order: 로직 사용처 → P&ID → 현장계기)',()=>{
  const {api,nodes}=app();
  const lookup={...emptyLookup,field_instruments:[{raw_tag:'TB-TE01A',service_desc:'BEARING TEMP',maker:'WEED',model_no:'TG-100',signal_range:'0-500',eng_unit:'deg C',source_doc:'BOP-INDEX'}]};
  const logicSheets=[{drop_no:'23',sheet_no:'302',title:'LUBE OIL TRIP',categories:['trip'],sources:{usage:true},pdf_page:5,logic_book:'MAIN',is_first:true}];
  api.renderResults({rawInput:'TB-TE01A',lookup,logicSheets,drawings:[],manualSearch:[],gen:api.generateVariants('TB-TE01A'),callLog:[]});
  // Both sections present in DOM
  const allNodes=[];(function walk(n){allNodes.push(n);(n.children||[]).forEach(walk);})(nodes.results);
  const instNodes=allNodes.filter(n=>n.className==='section-title' && (n.text||'').includes('현장계기 정보'));
  const logicNodes=allNodes.filter(n=>n.className==='section-title' && (n.text||'').includes('로직 사용처'));
  assert.ok(instNodes.length>0,'현장계기 정보 section-title present');
  assert.ok(logicNodes.length>0,'로직 사용처 section-title present');
  // Find DOM insertion order via results.children
  const childTexts=nodes.results.children.map(c=>c.textContent);
  const instIdx=childTexts.findIndex(t=>t.includes('현장계기 정보'));
  const logicIdx=childTexts.findIndex(t=>t.includes('로직 사용처') && !t.includes('현장계기'));
  assert.ok(logicIdx>=0 && logicIdx<instIdx,'로직 사용처 section precedes 현장계기 정보 section in results');
});

test('P&ID drawing section appears before equipment ledger (설비대장) in results',()=>{
  const {api,nodes}=app();
  const equipment_ledger={records:[{tag:'X',source:{file:'f.xlsx',sheet:'S',row:1},specification:'spec',material_no:'M1',service:'svc',drawing_no:'D1',stock_snapshot:1,purchases:[],manufacturer:'mfr',model:'mod',storage:'shelf',notes:'',drawings:[]}]};
  const drawings=[
    {dwg_no:'L-31300-UJ-105-001',title:'BOP P&ID',tier:'t1',file_path:null,doc_meta:null},
    {dwg_no:'L-31300-LM-105-001',title:'TG Mech',tier:'t1',file_path:null,doc_meta:null},
  ];
  api.renderResults({rawInput:'X',lookup:{...emptyLookup,field_instruments:[{raw_tag:'X'}],equipment_ledger},logicSheets:[],drawings,manualSearch:[],gen:api.generateVariants('X'),callLog:[]});
  const childTexts=nodes.results.children.map(c=>c.textContent);
  const pidIdx=childTexts.findIndex(t=>t.includes('P&ID 도면'));
  const ledgerIdx=childTexts.findIndex(t=>t.includes('설비대장'));
  assert.ok(pidIdx>=0,'P&ID 도면 section present');
  assert.ok(ledgerIdx>=0,'설비대장 section present');
  assert.ok(pidIdx<ledgerIdx,'P&ID drawing section precedes 설비대장 (equipment ledger) in results');
});

// ── 최근 추가된 동작 ─────────────────────────────────────────────────────────
function answerLines(nodes){return tree(nodes.results).filter(n=>/^answer-line/.test(n.className));}
function tripLine(nodes){return answerLines(nodes).find(n=>n.textContent.startsWith('트립·인터록'));}
test('unified trip status: 4 combinations of title keywords (tripSheets) and tag_auto.trip_paths',()=>{
 const titleSheets=[{drop_no:'23',sheet_no:'302',title:'LUBE OIL TRIP',categories:['trip'],sources:{usage:true},pdf_page:5,logic_book:'MAIN',is_first:true}];
 const ta={entry_sheets:[],used_by:[],used_by_total:0,trip_paths:[['25-302 A','23-424 B']],trip_path_basis:['confirmed'],trip_level:'direct',redundancy:[],method:'auto_v1',built_at:'2026-10-01'};
 const run=(sheets,tagAuto)=>{
  const {api,nodes}=app();
  api.renderResults({rawInput:'TB-TE01A',lookup:{...emptyLookup,field_instruments:[{raw_tag:'TB-TE01A'}],...(tagAuto?{tag_auto:tagAuto}:{})},logicSheets:sheets,drawings:[],manualSearch:[],gen:api.generateVariants('TB-TE01A'),callLog:[]});
  return tripLine(nodes);
 };
 const none=run([],null);
 assert.ok(none.className.includes('is-none'));
 assert.match(none.textContent,/조회한 자료에서 로직 사용처를 찾지 못함/);
 const title=run(titleSheets,null);
 assert.ok(title.className.includes('is-trip'));
 assert.match(title.textContent,/관련 시트 1건 있음.*\(제목 키워드 기준\)/s);
 const auto=run([],ta);
 assert.ok(auto.className.includes('is-trip'));
 assert.match(auto.textContent,/트립·인터록 시트와 직접 연결됨.*\(시트 연결 기준, 제목 키워드 시트는 없음\)/s);
 const both=run(titleSheets,ta);
 assert.ok(both.className.includes('is-trip'));
 assert.match(both.textContent,/관련 시트 1건 있음.*\(제목 키워드 \+ 시트 연결 기준\)/s);
});

test('keyword mode: non-tag input without tag-specific data shows search hits, no equipment ledger',()=>{
 const {api,nodes}=app();
 const gen=api.generateVariants('Governor Free');
 assert.equal(gen.parsed,null);
 const sheets=[{drop_no:'1',sheet_no:'10',title:'GOVERNOR FREE CONTROL',categories:[],sources:{search:true},pdf_page:3,logic_book:'MAIN',is_first:true}];
 api.renderResults({rawInput:'Governor Free',lookup:{...emptyLookup},logicSheets:sheets,drawings:[],manualSearch:[],gen,callLog:[]});
 const t=nodes.results.textContent;
 assert.match(t,/로직 시트 검색결과 \(1건\)/);
 assert.doesNotMatch(t,/로직 사용처 \(1건\)/);
 assert.ok(!ledgerOf(nodes),'no equipment ledger in keyword mode');
 // 같은 시트라도 태그 형식 입력이면 태그 모드(설비대장 + 로직 사용처)
 const tagMode=app();
 tagMode.api.renderResults({rawInput:'TB-TE01A',lookup:{...emptyLookup,field_instruments:[{raw_tag:'TB-TE01A'}]},logicSheets:sheets,drawings:[],manualSearch:[],gen:tagMode.api.generateVariants('TB-TE01A'),callLog:[]});
 assert.ok(ledgerOf(tagMode.nodes));
 assert.match(tagMode.nodes.results.textContent,/로직 사용처 \(1건\)/);
});

test('hyphen-less input: hopsll41a -> primary HO-PSLL41A, alternative split HOP-SLL41A',()=>{
 const {api}=app();
 const g=api.generateVariants('hopsll41a');
 assert.equal(g.forLookup,'HO-PSLL41A');
 assert.equal(JSON.stringify([...g.altLookups]),JSON.stringify(['HOP-SLL41A']));
 assert.ok(g.variants.includes('HO-PSLL41A')&&g.variants.includes('HOP-SLL41A'));
 assert.ok(g.variants.indexOf('HO-PSLL41A')<g.variants.indexOf('HOP-SLL41A'),'2-letter system tried first');
 // 사용자가 하이픈을 넣으면 그대로 따른다 (대안 분할 없음)
 const h=api.generateVariants('HOP-SLL41A');
 assert.equal(h.forLookup,'HOP-SLL41A');
 assert.equal(h.altLookups.length,0);
});

test('"조회한 태그 표기" line appears only when the input has no hyphen',()=>{
 const render=(input,matched)=>{
  const {api,nodes}=app();
  const gen=api.generateVariants(input);
  gen.matchedLookup=matched;
  api.renderResults({rawInput:input,lookup:{...emptyLookup,field_instruments:[{raw_tag:matched}]},logicSheets:[],drawings:[],manualSearch:[],gen,callLog:[]});
  return nodes.results.textContent;
 };
 assert.match(render('hopsll41a','HO-PSLL41A'),/조회한 태그 표기: HO-PSLL41A/);
 assert.doesNotMatch(render('HOP-SLL41A','HO-PSLL41A'),/조회한 태그 표기/);
 assert.doesNotMatch(render('HO-PSLL41A','HO-PSLL41A'),/조회한 태그 표기/);
});
