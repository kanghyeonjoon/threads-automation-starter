import { extractPostCards, openPostDetail, readPostCards, readDetailViews, selectDetail } from './post-evidence.js';
import { chromium } from 'playwright';
import fs from 'fs';
import { SESSION_FILE, AUTH_DIR } from './files.js';

const THREADS_URL = 'https://www.threads.com';

/**
 * 로그인 세션 저장:
 * 브라우저를 띄워 사용자가 직접 로그인하게 하고,
 * 로그인 완료(sessionid 쿠키 감지)되면 storageState를 로컬에 저장한다.
 */
export async function saveLoginSession(log) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  log('브라우저를 실행합니다. 열린 창에서 스레드에 로그인해 주세요.');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ locale: 'ko-KR' });
  const page = await context.newPage();
  await page.goto(`${THREADS_URL}/login`, { waitUntil: 'domcontentloaded' });

  log('로그인 대기 중... (최대 5분)');
  const deadline = Date.now() + 5 * 60 * 1000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    if (page.isClosed()) break;
    const cookies = await context.cookies();
    if (cookies.some((c) => c.name === 'sessionid' && c.value)) {
      loggedIn = true;
      break;
    }
    await page.waitForTimeout(2000);
  }

  if (!loggedIn) {
    await browser.close().catch(() => {});
    throw new Error('로그인이 감지되지 않았습니다. 다시 시도해 주세요.');
  }

  // 로그인 직후 쿠키가 안정화되도록 잠시 대기
  await page.waitForTimeout(3000);
  await context.storageState({ path: SESSION_FILE });
  await browser.close();
  log('로그인 세션이 저장되었습니다.');
  return true;
}

async function launchWithSession() {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error('저장된 로그인 세션이 없습니다. 먼저 "로그인 세션 저장하기"를 실행해 주세요.');
  }
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: SESSION_FILE,
    locale: 'ko-KR',
    viewport: { width: 1280, height: 900 },
  });
  return { browser, context };
}

// "1.5만", "1,234", "3.2천", "12.5K", "1M" 등의 표기를 숫자로 변환
export function parseCount(raw) {
  if (raw == null) return 0;
  let s = String(raw).trim().replace(/,/g, '');
  const m = s.match(/([\d.]+)\s*(만|천|억|K|M|B)?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return 0;
  const u = m[2] || '';
  const units = { '만': 1e4, '천': 1e3, '억': 1e8, K: 1e3, M: 1e6, B: 1e9 };
  const mul = units[u] || units[u.toUpperCase()] || 1;
  return Math.round(n * mul);
}

/**
 * 페이지 내 게시물 컨테이너들을 파싱한다 (브라우저 컨텍스트에서 실행).
 * DOM 구조가 난독화되어 있으므로 aria-label / href / 텍스트 패턴 기반의 휴리스틱을 사용한다.
 */
const PARSE_FN = extractPostCards;

/**
 * 키워드 검색 → 스크롤하며 게시물 수집 → 상세 페이지에서 댓글 스레드(최대 10개) 수집
 */
export async function crawl({ keyword, minViews = 0, maxPosts = 10, log }) {
  const { browser, context } = await launchWithSession();
  const collected = [];
  try {
    const page = await context.newPage();
    const searchUrl = `${THREADS_URL}/search?q=${encodeURIComponent(keyword)}&serp_type=default`;
    log(`검색 페이지로 이동: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    // 로그인 풀림 감지
    if (page.url().includes('/login')) {
      throw new Error('세션이 만료되었습니다. 로그인 세션을 다시 저장해 주세요.');
    }

    // 스크롤하며 후보 게시물 수집
    const candidates = new Map(); // url -> 요약 정보
    const maxScrolls = 30;
    for (let i = 0; i < maxScrolls; i++) {
      const posts = await page.evaluate(PARSE_FN);
      for (const p of posts) {
        if (p.url && !candidates.has(p.url)) candidates.set(p.url, p);
      }
      log(`스크롤 ${i + 1}/${maxScrolls} — 후보 ${candidates.size}개 발견`);
      // 필터 통과 예상치가 충분하면 중단
      const passing = [...candidates.values()].filter((p) => passesFilter(p, minViews));
      if (passing.length >= maxPosts) break;
      await page.mouse.wheel(0, 2500);
      await page.waitForTimeout(1800);
    }

    // 필터 적용 → 참여도 높은 순 정렬 → 상세 수집
    // (진짜 반응이 좋았던 글이 앞쪽에 오도록 정렬해야 분석 품질이 올라감)
    const targets = [...candidates.values()]
      .filter((p) => passesFilter(p, minViews))
      .sort((a, b) => engagementScore(b) - engagementScore(a))
      .slice(0, maxPosts);
    log(`필터(최소 조회수 ${minViews}) 통과 게시물 ${targets.length}개 — 참여도순 정렬 후 상세 수집 시작`);

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      log(`[${i + 1}/${targets.length}] ${t.url}`);
      try {
        const detail = await crawlDetail(context, t.url);
        collected.push({ ...t, ...detail });
      } catch (e) {
        log(`  ⚠ 상세 수집 실패: ${e.message}`);
        log('  검증되지 않은 후보를 결과에서 제외했습니다.');
      }
      await page.waitForTimeout(1200);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (!collected.length) {
    throw new Error('조건을 만족하는 게시물을 찾지 못했습니다. 최소 조회수를 낮추거나 다른 키워드로 시도해 보세요.');
  }
  return collected;
}

/** 참여도 점수: 조회수가 있으면 그 값, 없으면 좋아요·답글·리포스트 가중 합산 */
function engagementScore(p) {
  const views = parseCount(p.views);
  if (views > 0) return views;
  return parseCount(p.likes) * 50 + parseCount(p.replies) * 20 + parseCount(p.reposts) * 30;
}

function passesFilter(p, minViews) {
  if (!p.text || p.text.length < 10) return false;
  if (!minViews) return true;
  const views = parseCount(p.views);
  // 조회수가 화면에 노출되지 않는 게시물은 좋아요 수로 대체 판정 (조회수 ≈ 좋아요의 수십 배로 추정하지 않고 보수적으로 좋아요 기준 1/50 적용)
  if (views > 0) return views >= minViews;
  const likes = parseCount(p.likes);
  return likes >= Math.max(1, Math.floor(minViews / 50));
}

export async function crawlDetail(context, url) {
  const page = await context.newPage();
  try {
    await openPostDetail(page, url);
    const posts = await readPostCards(page);
    const detail = selectDetail(posts, url);
    detail.views = await readDetailViews(page) || detail.views;
    return detail;
  } finally {
    await page.close().catch(() => {});
  }
}

/** 수집 결과를 마크다운으로 변환 */
export function toMarkdown({ keyword, minViews, posts }) {
  const lines = [];
  lines.push(`# 스레드 크롤링 결과: "${keyword}"`);
  lines.push('');
  lines.push(`- 수집 일시: ${new Date().toLocaleString('ko-KR')}`);
  lines.push(`- 최소 조회수 필터: ${minViews}`);
  lines.push(`- 수집 게시물 수: ${posts.length}`);
  lines.push('');
  posts.forEach((p, i) => {
    lines.push(`---`);
    lines.push('');
    lines.push(`## 게시물 ${i + 1}`);
    lines.push('');
    lines.push(`- 작성자: ${p.author || '(알 수 없음)'}`);
    lines.push(`- URL: ${p.url || ''}`);
    lines.push(`- 조회수: ${p.views || '(미노출)'} | 좋아요: ${p.likes || '0'} | 답글: ${p.replies || '0'} | 리포스트: ${p.reposts || '0'} | 공유: ${p.shares || '0'}`);
    lines.push('');
    lines.push(`### 본문`);
    lines.push('');
    lines.push(p.text || '(본문 없음)');
    lines.push('');
    if (p.repliesList && p.repliesList.length) {
      lines.push(`### 연결된 댓글 스레드 (${p.repliesList.length}개)`);
      lines.push('');
      p.repliesList.forEach((r, j) => {
        lines.push(`${j + 1}. **${r.author || '익명'}**${r.likes ? ` (좋아요 ${r.likes})` : ''}: ${r.text.replace(/\n/g, ' ')}`);
      });
      lines.push('');
    }
  });
  return lines.join('\n');
}
