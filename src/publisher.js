import { normalizePostText, openPostDetail, readPostCards, selectDetail } from './post-evidence.js';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { SESSION_FILE } from './files.js';
import { prepareForPublish, findOverLimit, LIMIT } from './split.js';

const THREADS_URL = 'https://www.threads.com';

/**
 * 브라우저를 화면에 띄울지 여부.
 * 기본은 띄우는 쪽(검증된 방식). 맥미니처럼 모니터 없이 돌릴 때만 HEADLESS=1 로 켠다.
 * 헤드리스는 봇으로 감지될 여지가 조금 더 크므로 기본값으로 두지 않는다.
 */
const HEADLESS = /^(1|true|yes)$/i.test(process.env.HEADLESS || '');

/** 열린 다이얼로그의 편집기에 여러 줄 텍스트 입력 후 입력 검증 */
async function typeIntoEditor(page, editor, text) {
  await editor.click();

  // 이전 초안이나 클립보드 잔여물이 남아 있으면 지우고 시작한다.
  // (빈 칸이 정상이므로, 내용이 있을 때만 건드린다)
  const existing = (await editor.innerText().catch(() => '')).trim();
  if (existing) {
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
  }

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press('Enter');
    if (lines[i]) await page.keyboard.insertText(lines[i]);
  }
  await page.waitForTimeout(800);
  // 입력 검증: 첫 줄이 실제로 들어갔는지
  const typed = await editor.innerText().catch(() => '');
  const head = (lines.find((l) => l.trim()) || '').slice(0, 10);
  if (head && !typed.includes(head)) {
    throw new Error('입력한 내용이 편집기에 반영되지 않았습니다.');
  }
}

/**
 * 작성 다이얼로그에서 스레드 체인(1/N)을 만든다.
 * "스레드에 추가"로 칸을 늘려 한 번에 게시해야 순서가 고정된다.
 * (개별 답글로 달면 스레드가 "인기순"으로 정렬해 순서가 뒤섞인다)
 */
async function typeChainCards(page, firstEditor, content, cards, log) {
  await typeIntoEditor(page, firstEditor, content);
  log(`체인 1/${cards.length + 1} 입력 완료 (본문)`);

  for (let i = 0; i < cards.length; i++) {
    const addBtn = page.locator('div[role="dialog"]').locator('text=스레드에 추가').first();
    if (!(await addBtn.count())) {
      throw new Error('"스레드에 추가" 버튼을 찾지 못했습니다.');
    }
    await addBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1800);

    const editors = page.locator('div[role="dialog"] div[contenteditable="true"]');
    const cnt = await editors.count();
    if (cnt < i + 2) {
      throw new Error(`체인 ${i + 2}번째 입력칸이 생성되지 않았습니다.`);
    }
    await typeIntoEditor(page, editors.nth(cnt - 1), cards[i]);
    log(`체인 ${i + 2}/${cards.length + 1} 입력 완료`);
  }
}

/** 글쓰기 다이얼로그 열기 → 편집기 locator 반환 */
async function openComposerDialog(page) {
  const entries = [
    'text=새로운 소식이 있나요?',
    'text=새로운 스레드 시작',
    'text=무슨 생각을',
    '[aria-label="만들기"]',
    'svg[aria-label="새로운 스레드"]',
  ];
  for (const sel of entries) {
    const el = page.locator(sel).first();
    if (!(await el.count())) continue;
    try {
      await el.click({ timeout: 3000 });
    } catch {
      continue;
    }
    const ed = page.locator('div[role="dialog"] div[contenteditable="true"]').first();
    try {
      await ed.waitFor({ state: 'visible', timeout: 4000 });
      return ed;
    } catch { /* 다음 진입점 시도 */ }
  }
  // 단축키 폴백
  await page.keyboard.press('n');
  const ed = page.locator('div[role="dialog"] div[contenteditable="true"]').first();
  await ed.waitFor({ state: 'visible', timeout: 5000 });
  return ed;
}

/**
 * 작성 다이얼로그에서 커뮤니티 주제(토픽) 설정.
 * 입력창에 주제를 타이핑하고 자동완성 목록에서 일치 항목을 클릭한다.
 */
async function setTopicInComposer(page, topic, log) {
  const input = page.locator('input[placeholder="커뮤니티 또는 주제"], input[placeholder*="주제"]').first();
  if (!(await input.count())) {
    log('⚠ 주제 입력창을 찾지 못해 주제 없이 게시합니다.');
    return false;
  }
  await input.click();
  await input.type(topic, { delay: 60 });
  await page.waitForTimeout(2000);

  // 자동완성 목록이 뜨면 정확 일치 항목을 실제 마우스로 클릭 (실패해도 입력된 주제는 게시 시 그대로 반영됨)
  try {
    const box = await page.evaluate((t) => {
      const opts = [...document.querySelectorAll('[role="option"]')].filter(
        (o) => !!(o.offsetWidth || o.offsetHeight)
      );
      const target = opts.find((o) => (o.innerText || '').trim() === t) || opts[0];
      if (!target) return null;
      const r = target.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, topic);
    if (box) await page.mouse.click(box.x, box.y);
  } catch { /* 선택 실패해도 입력값으로 진행 */ }
  await page.waitForTimeout(1000);

  const value = await input.inputValue().catch(() => '');
  log(`주제 입력됨: "${value || topic}"`);
  return true;
}

/**
 * 게시 직전, 작성 창에 기대한 장수가 그대로 남아 있는지 확인한다.
 * 마지막 장을 넣자마자 게시를 누르면 스레드가 뒷장을 아직 반영하지 못해 통째로 누락된다.
 */
async function verifyComposerCards(page, expected, log) {
  await page.waitForTimeout(2500); // 마지막 입력이 반영될 시간
  const lens = await page.evaluate(() => {
    const d = [...document.querySelectorAll('div[role="dialog"]')].pop();
    if (!d) return null;
    return [...d.querySelectorAll('div[contenteditable="true"]')].map(
      (e) => (e.innerText || '').trim().length
    );
  });
  if (!lens) throw new Error('게시 직전 작성 창을 찾지 못했습니다.');

  const filled = lens.filter((n) => n > 0).length;
  log(`게시 직전 확인: ${lens.length}칸 중 내용이 든 칸 ${filled}개 (기대 ${expected}장)`);
  if (filled < expected) {
    throw new Error(
      `작성 창에 ${filled}장만 남아 있습니다 (기대 ${expected}장). 게시하지 않고 중단합니다.`
    );
  }
}

/** 한 장에서 검색에 쓸 만한 짧고 고유한 조각을 뽑는다 (첫 번째 실질 줄) */
function fingerprint(card) {
  const line = String(card ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.replace(/[^가-힣A-Za-z0-9]/g, '').length >= 6);
  return line ? line.slice(0, 18) : null;
}

/**
 * 게시된 글 페이지를 열어 각 장이 실제로 올라갔는지 확인한다.
 * 장수를 세는 방식은 페이지의 다른 숫자에 오판하므로 쓰지 않는다.
 * @returns {{missing:number[], checked:number}|null} 확인 실패 시 null
 */
export async function verifyPublishedCards(page, postUrl, cards) {
  if (!cards.length || cards.some(c => !normalizePostText(c))) return null;
  try {
    const root = await openPostDetail(page, postUrl);
    const confirmed = new Map();
    let current = root.url;
    for (let attempt = 0; attempt < Math.min(cards.length + 2, 20); attempt++) {
      const posts = await readPostCards(page);
      const detail = selectDetail(posts, current);
      const scoped = [detail, ...detail.repliesList];
      // A reply page can show the next numbered continuation without index 1.
      for (const p of posts.slice(posts.findIndex(p => p.url === current) + 1)) {
        const prev = scoped[scoped.length - 1];
        if (scoped.some(x => x.url === p.url)) continue;
        if (p.author !== root.author || !prev.chainIndex || p.chainTotal !== prev.chainTotal || p.chainIndex !== prev.chainIndex + 1) break;
        scoped.push(p);
      }
      for (const p of scoped) {
        const i = p.url === root.url ? 0 : p.chainIndex - 1;
        if (i < 0 || i >= cards.length || (i > 0 && p.chainTotal !== cards.length)) continue;
        if (normalizePostText(p.text) === normalizePostText(cards[i])) confirmed.set(i, p.url);
      }
      if (confirmed.size === cards.length) break;
      const last = scoped[scoped.length - 1];
      if (last.url !== current && confirmed.has(last.chainIndex - 1)) {
        current = last.url;
        await openPostDetail(page, current);
      } else {
        await page.waitForTimeout(1500);
      }
    }
    const missing = cards.map((_,i)=>i+1).filter(n=>!confirmed.has(n-1));
    return {missing, checked:cards.length, status:missing.length ? 'unverified' : 'verified',
      cardUrls:cards.map((_,i)=>confirmed.get(i) || null)};
  } catch { return null; }
}

/**
 * 스레드는 체인을 한 번에 보내지 않는다. 장마다 요청을 하나씩 순차로 보낸다.
 * 작성창은 첫 장만 접수되면 바로 닫히므로, 거기서 페이지를 떠나면
 * 아직 안 나간 뒷장 요청이 취소되어 통째로 누락된다. (실측으로 확인된 원인)
 *
 * 게시 버튼을 누르기 전에 이 카운터를 걸어두고, 장수만큼 응답이 올 때까지 기다린다.
 */
export function watchPublishRequests(page) {
  let done = 0;
  const onResponse = (res) => {
    if (/configure_text_only_post|text_only_post|\/media\/configure/.test(res.url()) && res.ok()) done++;
  };
  page.on('response', onResponse);
  return {
    count: () => done,
    dispose: () => page.off('response', onResponse),
    /** expected 개가 다 나갈 때까지 기다린다. 못 채우면 false. */
    async waitFor(expected, log, timeoutMs = 60000) {
      const started = Date.now();
      let last = -1;
      while (Date.now() - started < timeoutMs) {
        if (done !== last) {
          last = done;
          log(`게시 전송 ${done}/${expected}장...`);
        }
        if (done >= expected) {
          await page.waitForTimeout(2500); // 마지막 응답 처리 여유
          return true;
        }
        await page.waitForTimeout(1000);
      }
      return false;
    },
  };
}

/** 다이얼로그 "안"의 게시 버튼을 클릭하고, 다이얼로그가 닫힐 때까지 대기 */
async function submitDialog(page) {
  // 셀렉터 대신 JS로 직접 탐색: 다이얼로그 내부에서 텍스트가 정확히 "게시"인 버튼
  const btnHandle = await page.evaluateHandle(() => {
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')];
    const d = dialogs[dialogs.length - 1];
    if (!d) return null;
    const btns = [...d.querySelectorAll('div[role="button"], button')];
    return btns.find((b) => ['게시', 'Post'].includes((b.innerText || '').trim())) || null;
  });
  const btn = btnHandle.asElement();
  if (!btn) throw new Error('다이얼로그 안에서 게시 버튼을 찾지 못했습니다.');
  await btn.click({ timeout: 5000 });
  // 다이얼로그가 닫히면 제출된 것
  try {
    await page.waitForFunction(() => document.querySelectorAll('div[role="dialog"]').length === 0, { timeout: 15000 });
  } catch {
    throw new Error('게시 후 작성 창이 닫히지 않았습니다. 게시가 완료되지 않았을 수 있습니다.');
  }
  await page.waitForTimeout(3000);
}

/** 내 프로필 경로(/@username) 찾기 */
async function findMyProfileHref(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('svg[aria-label="프로필"], svg[aria-label="Profile"]');
    const a = svg ? svg.closest('a') : null;
    if (a) return a.getAttribute('href');
    const navLinks = document.querySelectorAll('a[href^="/@"]');
    for (const link of navLinks) {
      if (!link.closest('div[data-pressable-container="true"]')) return link.getAttribute('href');
    }
    return null;
  });
}

/**
 * 프로필에서 본문 전체가 일치하는 유일한 글의 URL 반환.
 * 고정된 글이 최상단에 있을 수 있으므로 앞쪽 게시물 여러 개를 검사한다.
 */
async function findPostedUrl(page, profileHref, content) {
  await page.goto(`${THREADS_URL}${profileHref}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const posts = await readPostCards(page);
  const matches = posts.filter(p => '/' + p.author === profileHref && normalizePostText(p.text) === normalizePostText(content));
  return matches.length === 1 ? new URL(matches[0].url).pathname : null;
}

/**
 * 게시물 상세 페이지에서 답글 1개 등록.
 * 답글은 다이얼로그가 아니라 페이지에 상시 존재하는 인라인 편집기를 사용하며,
 * Enter = 제출 / Shift+Enter = 줄바꿈 이므로 줄바꿈에 반드시 Shift를 써야 한다.
 */
async function replyOnDetailPage(page, text) {
  const editor = page
    .locator('div[contenteditable="true"][aria-placeholder*="답글"], div[contenteditable="true"][aria-placeholder*="Reply" i]')
    .first();
  try {
    await editor.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    throw new Error('답글 입력창을 찾지 못했습니다.');
  }

  await editor.click();
  await page.waitForTimeout(800);

  // 기존 잔여 텍스트 제거
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      // 줄바꿈: Shift+Enter (그냥 Enter는 즉시 제출되어 글이 잘림)
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
    }
    if (lines[i]) await page.keyboard.insertText(lines[i]);
  }
  await page.waitForTimeout(800);

  // 입력 검증: 마지막 줄까지 들어갔는지 확인 (중간 제출 방지)
  const typed = await editor.innerText().catch(() => '');
  const lastLine = [...lines].reverse().find((l) => l.trim()) || '';
  if (lastLine && !typed.includes(lastLine.slice(0, 8))) {
    throw new Error('답글 본문이 편집기에 온전히 입력되지 않았습니다.');
  }

  // 제출 (Enter)
  await page.keyboard.press('Enter');

  // 제출 확인: 편집기가 비워지면 성공
  try {
    await page.waitForFunction(
      () => {
        const e = document.querySelector(
          'div[contenteditable="true"][aria-placeholder*="답글"], div[contenteditable="true"][aria-placeholder*="Reply" i]'
        );
        return !e || (e.innerText || '').trim() === '';
      },
      { timeout: 15000 }
    );
  } catch {
    throw new Error('답글 제출이 확인되지 않았습니다.');
  }
  await page.waitForTimeout(2500);
}

/**
 * 생성된 게시물(본문 + 연결 댓글)을 Playwright로 스레드에 자동 게시한다.
 * 본문 게시 후 프로필에서 실제 게시 여부를 검증한다.
 */
export async function publishPost({ content, comments = [], topic = '', imagePath = '', log, onProgress = async () => {} }) {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error('저장된 로그인 세션이 없습니다. 먼저 "로그인 세션 저장하기"를 실행해 주세요.');
  }
  if (!content || !content.trim()) {
    throw new Error('게시할 내용이 비어 있습니다.');
  }

  // 1/8 같은 번호 마커 제거. 스레드가 순번을 자체 표시하므로 남기면 번호가 두 번 보인다.
  const before = [content, ...comments].join('').length;
  ({ content, comments } = prepareForPublish(content, comments));
  if (!content) throw new Error('마커를 제거하고 나니 본문이 비었습니다.');
  const removed = before - [content, ...comments].join('').length;
  if (removed > 0) log(`번호 마커 제거 (${removed}자) — 스레드가 순번을 자동으로 표시합니다.`);

  // 브라우저를 띄우기 전에 글자수부터 거른다. 중간에 실패하면 지운 자리가 남는다.
  const over = findOverLimit([content, ...comments]);
  if (over.length) {
    const detail = over.map((o) => `${o.index}번째 ${o.chars}자`).join(', ');
    throw new Error(`스레드 한 장 상한(${LIMIT}자)을 넘었습니다 — ${detail}. 나눠서 다시 시도해 주세요.`);
  }
  log(`검사 완료: ${comments.length + 1}장 (최대 ${Math.max(content.length, ...comments.map((c) => c.length))}자)`);

  log('브라우저 실행 중...');
  log(`브라우저 모드: ${HEADLESS ? '헤드리스(화면 없음)' : '화면 표시'}`);
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    storageState: SESSION_FILE,
    locale: 'ko-KR',
    viewport: { width: 1280, height: 900 },
  });

  try {
    const page = await context.newPage();
    await page.goto(THREADS_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    if (page.url().includes('/login')) {
      throw new Error('세션이 만료되었습니다. 로그인 세션을 다시 저장해 주세요.');
    }

    // ---------- 1) 본문(+체인) 작성 ----------
    log('글쓰기 창을 여는 중...');
    const editor = await openComposerDialog(page);

    // 연결 글이 있으면 개별 답글이 아니라 스레드 체인으로 작성한다.
    // 답글로 달면 스레드가 "인기순"으로 정렬해 순서가 뒤섞이기 때문.
    let chainUsed = false;
    if (comments.length) {
      log(`스레드 체인 ${comments.length + 1}장으로 작성합니다...`);
      try {
        await typeChainCards(page, editor, content, comments, log);
        chainUsed = true;
      } catch (e) {
        log(`⚠ 체인 작성 실패(${e.message.split('\n')[0]}) — 본문만 올리고 연결 글은 답글로 답니다.`);
        // 다이얼로그를 닫고 처음부터 다시 (본문만)
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(1500);
        const discard = page.locator('div[role="dialog"] div[role="button"]:has-text("삭제")').first();
        if (await discard.count()) await discard.click().catch(() => {});
        await page.waitForTimeout(1500);
        const retryEditor = await openComposerDialog(page);
        await typeIntoEditor(page, retryEditor, content);
      }
    } else {
      log('본문 입력 중...');
      await typeIntoEditor(page, editor, content);
    }

    // 이미지 첨부 (작성 다이얼로그의 숨겨진 file input에 직접 주입)
    if (imagePath && fs.existsSync(imagePath)) {
      log(`이미지 첨부 중: ${path.basename(imagePath)}`);
      try {
        const fileInput = page.locator('div[role="dialog"] input[type="file"]').first();
        if (await fileInput.count()) {
          await fileInput.setInputFiles(imagePath);
          // 업로드 미리보기가 나타날 때까지 대기
          await page
            .waitForFunction(
              () => {
                const d = document.querySelector('div[role="dialog"]');
                return !!d && !!d.querySelector('img[src^="blob:"], img[src^="data:"]');
              },
              { timeout: 20000 }
            )
            .catch(() => {});
          await page.waitForTimeout(2000);
          log('이미지 첨부 완료');
        } else {
          log('⚠ 이미지 입력 요소를 찾지 못해 이미지 없이 게시합니다.');
        }
      } catch (e) {
        log(`⚠ 이미지 첨부 실패(${e.message.split('\n')[0]}) — 이미지 없이 게시합니다.`);
      }
    }

    if (topic) {
      log(`커뮤니티 주제 설정 중: "${topic}"...`);
      await setTopicInComposer(page, topic, log);
    }

    // 마지막 장을 넣자마자 누르면 뒷장이 누락된다. 반영을 기다린 뒤 장수를 재확인한다.
    if (chainUsed) await verifyComposerCards(page, comments.length + 1, log);

    // 게시 요청은 장마다 하나씩 순차로 나간다. 다 나가기 전에 페이지를 떠나면 뒷장이 취소된다.
    const watcher = watchPublishRequests(page);

    log('게시 버튼 클릭 (다이얼로그 내부)...');
    await onProgress({ stage: 'submitting' });
    await submitDialog(page);

    const expectedPosts = chainUsed ? comments.length + 1 : 1;
    const allSent = await watcher.waitFor(expectedPosts, log);
    watcher.dispose();
    if (!allSent) {
      log(`⚠ ${expectedPosts}장 중 ${watcher.count()}장만 전송이 확인됐습니다. 결과를 확인합니다...`);
    } else {
      log(`전송 완료: ${expectedPosts}장`);
    }

    // ---------- 2) 실제 게시 여부 검증 ----------
    log('게시 여부를 프로필에서 확인 중...');
    const profileHref = await findMyProfileHref(page);
    if (!profileHref) {
      throw new Error('내 프로필을 찾지 못해 게시 여부를 확인할 수 없습니다. 스레드에서 직접 확인해 주세요.');
    }
    const contentHead = content;
    let postUrl = null;
    for (let attempt = 0; attempt < 3 && !postUrl; attempt++) {
      postUrl = await findPostedUrl(page, profileHref, contentHead);
      if (!postUrl) await page.waitForTimeout(3000);
    }
    if (!postUrl) {
      throw new Error('게시 버튼은 눌렀지만 프로필에서 새 글을 찾지 못했습니다. 게시가 실패했을 수 있으니 스레드에서 확인해 주세요.');
    }
    await onProgress({ stage: 'posted', postUrl: new URL(postUrl, THREADS_URL).href });
    log(`✅ 게시 확인됨: ${postUrl}`);

    // ---------- 3) 연결 글 처리 ----------
    if (chainUsed) {
      // 체인은 게시 한 번으로 전체가 순서대로 올라갔다 — 추가 작업 없음
      // 작성 창에 다 들어갔어도 스레드가 뒷장을 버리는 경우가 있다.
      // 각 장의 전체 내용과 URL을 실제 상세 화면에서 확인한다.
      const all = [content, ...comments];
      const v = await verifyPublishedCards(page, postUrl, all);
      if (!v) {
        throw new Error(`게시 결과 확인 필요: ${THREADS_URL}${postUrl}`);
      } else if (v.missing.length) {
        log(`❌ ${all.length}장 중 ${v.missing.join(', ')}번째 장의 게시를 확인하지 못했습니다.`);
        throw new Error(
          `체인 ${all.length}장 중 ${v.missing.join(', ')}번째의 게시를 확인하지 못했습니다. ` +
          `이미 올라간 글이 있으니 그대로 다시 발행하지 마세요. ` +
          `아래 글에서 실제 결과를 먼저 확인해 주세요: ${THREADS_URL}${postUrl}`
        );
      } else {
        await onProgress({ stage: 'verified', completedComments: comments.map((_,i)=>i+1), cardUrls: v.cardUrls });
        log(`✅ 스레드 체인 ${all.length}장이 모두 게시된 것을 확인했습니다.`);
      }
    } else if (comments.length) {
      log(`연결 댓글 ${comments.length}개 등록을 시작합니다... (체인 실패 폴백)`);

      const failed = [];
      for (let i = 0; i < comments.length; i++) {
        log(`[댓글 ${i + 1}/${comments.length}] 등록 중...`);
        let ok = false;
        for (let attempt = 1; attempt <= 1 && !ok; attempt++) {
          try {
            // 댓글마다 게시물 페이지를 새로 열어 DOM 상태를 초기화
            await page.goto(`${THREADS_URL}${postUrl}`, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(3000);
            await page.evaluate(() => window.scrollTo(0, 0));
            await onProgress({ stage: 'replying', uncertainComment: i + 1 });
            await replyOnDetailPage(page, comments[i]);
            await onProgress({ stage: 'posted', completedComments: Array.from({ length: i + 1 }, (_, n) => n + 1), uncertainComment: null });
            ok = true;
            log(`  ✅ 댓글 ${i + 1} 등록 완료`);
          } catch (e) {
            log(`  ⚠ 댓글 ${i + 1} 시도 ${attempt}/1 실패: ${e.message}`);
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(1500);
          }
        }
        if (!ok) { failed.push(i + 1); break; }
      }
      if (failed.length) {
        throw new Error(`본문은 게시되었지만(${postUrl}) 댓글 ${failed.join(', ')}번 등록에 실패했습니다. 해당 댓글은 수동으로 달아주세요.`);
      }
    }

    if (!chainUsed) {
      const evidence = await verifyPublishedCards(page, postUrl, [content, ...comments]);
      if (!evidence || evidence.missing.length) {
        throw new Error('게시 결과 확인 필요: 본문 또는 개별 답글의 고유 URL·전체 내용을 검증하지 못했습니다. 재발행하지 말고 원문을 확인해 주세요.');
      }
      await onProgress({stage:'verified', cardUrls:evidence.cardUrls});
    }
    log('🎉 게시 완료. 브라우저를 닫습니다.');
    await onProgress({ stage: 'complete' });
    return { postUrl: new URL(postUrl, THREADS_URL).href };
  } finally {
    await browser.close().catch(() => {});
  }
}
