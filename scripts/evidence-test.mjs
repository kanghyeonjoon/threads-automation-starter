import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {extractPostCards, selectDetail, postIdentity, openPostDetail} from '../src/post-evidence.js';
import {verifyPublishedCards, watchPublishRequests} from '../src/publisher.js';
const root = 'https://www.threads.com/@owner/post/ROOT';
const card = (id,text,index=1,total=2,author='owner') => `<div data-pressable-container="true"><a href="/@${author}">${author}</a><a href="/@${author}/post/${id}"><time>1시간</time></a><span dir="auto">${text}<span> ${index}\n/\n${total}</span></span><button><svg aria-label="좋아요"></svg>3</button></div>`;
function parse(html) { globalThis.document=parseHTML(html).document; return extractPostCards(); }
let count=0;
function test(name,fn) { fn(); count++; console.log('PASS',name); }
test('정확한 URL 정규화 및 외부 URL 거부',()=>{
 assert.equal(postIdentity('/@Owner/post/ROOT?x=1').url,root);
 assert.equal(postIdentity('https://evil.test/@owner/post/ROOT'),null);
});
test('추천 글이 앞에 있어도 본문은 URL로 선택',()=>{
 const p=parse(card('NOISE','추천 글',1,1,'other')+card('ROOT','본문',1)+card('CHILD','댓글',2));
 const d=selectDetail(p,root); assert.equal(d.text,'본문'); assert.equal(d.repliesList[0].text,'댓글');
 assert.equal(d.likes,'3'); assert.equal(d.chainTotal,2);
});
test('본문이 없을 때 첫 추천글로 대체하지 않는다',()=>assert.throws(()=>selectDetail(parse(card('NOISE','추천 글')),root),/SOURCE_UNVERIFIED/));
test('연결 순서가 없는 동일 작성자 글도 댓글에서 제외',()=>{
 const p=parse(card('ROOT','본문')+card('OTHER','관련 없는 글',1,5)); assert.equal(selectDetail(p,root).repliesList.length,0);
});
test('숨김 컨테이너와 중첩 카드 혼입 방지',()=>{
 const p=parse(`<div hidden>${card('HIDDEN','숨김')}</div>`+card('ROOT','본문')+`<div data-pressable-container="true">${card('CHILD','댓글',2)}</div>`);
 assert.deepEqual(p.map(p=>p.text),['본문','댓글']);
});
test('링크 포함 문장과 짧은 본문 보존',()=>{
 const p=parse(card('ROOT','안녕 <a href="https://example.com">링크</a> 끝'));
 assert.equal(p[0].text,'안녕 링크 끝');
});
test('본문 끝의 일반 분수는 보존',()=>{
 const p=parse('<div data-pressable-container="true"><a href="/@owner">owner</a><a href="/@owner/post/ROOT"><time>1시간</time></a><span dir="auto">비율은 7/10</span></div>');
 assert.equal(p[0].text,'비율은 7/10');
});
let active=root;
const rows={ [root]:parse(card('ROOT','본문입니다',1,3)+card('C2','두번째입니다',2,3)),
 'https://www.threads.com/@owner/post/C2':parse(card('C2','두번째입니다',2,3)+card('C3','끝',3,3)) };
const page={goto:async url=>{active=url;},url:()=>active,waitForTimeout:async()=>{},evaluate:async()=>rows[active]||[]};
const result=await verifyPublishedCards(page,root,['본문입니다','두번째입니다','끝']);
assert.deepEqual(result.missing,[]); assert.equal(result.cardUrls[2],'https://www.threads.com/@owner/post/C3'); count++;
console.log('PASS 다음 상세 화면까지 따라가 짧은 마지막 장도 검증');
const wrong=await verifyPublishedCards(page,root,['본문입니다','두번째입니다 다른 내용','끝']);
assert.deepEqual(wrong.missing,[2,3]); count++; console.log('PASS 앞문장만 같은 글을 성공으로 판정하지 않는다');
assert.equal(await verifyPublishedCards(page,root,[]),null); count++;
let callback; const watcher=watchPublishRequests({on:(_,cb)=>callback=cb,off:()=>{}});
callback({url:()=>'/media/configure',ok:()=>false}); assert.equal(watcher.count(),0);
callback({url:()=>'/media/configure',ok:()=>true}); assert.equal(watcher.count(),1); count++;
console.log('PASS 실패 응답을 전송 성공으로 세지 않는다');
let clicked=false; active='https://www.threads.com/';
await openPostDetail({goto:async()=>{},url:()=>active,waitForTimeout:async()=>{},locator:()=>({filter:()=>({last:()=>({count:async()=>1,click:async()=>{clicked=true;active=root;}})})})},root);
assert.equal(clicked,true); count++;
console.log('PASS 추천 피드 리다이렉트 후 정확한 고유 링크 진입');
console.log(`${count} evidence tests passed`);
