import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { AUTH_DIR, DATA_DIR } from './files.js';

// 이미 쓴 이미지가 다른 글에 또 나오지 않도록 사용 이력을 남긴다
const USED_IMAGES_FILE = path.join(DATA_DIR, 'used-images.json');

function loadUsedCodes() {
  try {
    const data = JSON.parse(fs.readFileSync(USED_IMAGES_FILE, 'utf-8'));
    return new Set(Array.isArray(data) ? data : []);
  } catch {
    return new Set();
  }
}

function saveUsedCodes(set) {
  try {
    // 너무 커지지 않게 최근 500개만 유지
    const arr = [...set].slice(-500);
    fs.writeFileSync(USED_IMAGES_FILE, JSON.stringify(arr), 'utf-8');
  } catch { /* 무시 */ }
}

export function usedImageCount() {
  return loadUsedCodes().size;
}

export function resetUsedImages() {
  try { fs.unlinkSync(USED_IMAGES_FILE); } catch { /* 없으면 무시 */ }
}

/**
 * 클립아트코리아(유료 멤버십) 연동.
 * 공개 API가 없어 Playwright로 사용자의 로그인 세션을 재사용한다:
 * 검색(/search?keyword=) → 첫 결과(.cksch_unit) → 미리보기 팝업 → "멤버십 다운로드".
 * 다운로드 실패 시 data-preview(미리보기 원본)로 폴백.
 */

export const CLIPART_SESSION_FILE = path.join(AUTH_DIR, 'clipartkorea-session.json');
const BASE = 'https://www.clipartkorea.co.kr';

export function hasClipartSession() {
  return fs.existsSync(CLIPART_SESSION_FILE);
}

export function clipartSessionInfo() {
  if (!hasClipartSession()) return { exists: false };
  const st = fs.statSync(CLIPART_SESSION_FILE);
  return { exists: true, savedAt: st.mtimeMs };
}

/**
 * 브라우저를 띄워 사용자가 직접 로그인 → "로그아웃" 표시 감지로 완료 판정 → 세션 저장.
 * 구글 소셜 로그인이 자동화 브라우저를 차단하므로, 실제 크롬 채널 + 자동화 흔적 제거로 실행한다.
 */
export async function saveClipartLoginSession(log) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  log('브라우저를 실행합니다. 열린 창에서 클립아트코리아에 로그인해 주세요.');
  let browser;
  try {
    // 실제 크롬(설치돼 있으면)으로 실행 — 구글 로그인 차단 회피
    browser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch {
    browser = await chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  }
  const context = await browser.newContext({ locale: 'ko-KR' });
  // navigator.webdriver 흔적 제거
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  log('로그인 대기 중... (최대 5분)');
  const deadline = Date.now() + 5 * 60 * 1000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    if (page.isClosed()) break;
    const ok = await page.evaluate(() => /로그아웃|마이페이지/.test(document.body.innerText || '')).catch(() => false);
    if (ok) { loggedIn = true; break; }
    await page.waitForTimeout(2000);
  }

  if (!loggedIn) {
    await browser.close().catch(() => {});
    throw new Error('로그인이 감지되지 않았습니다. 다시 시도해 주세요.');
  }
  await page.waitForTimeout(2000);
  await context.storageState({ path: CLIPART_SESSION_FILE });
  await browser.close();
  log('클립아트코리아 로그인 세션이 저장되었습니다.');
  return true;
}

/** 검색 결과 첫 페이지에서 아이템 목록(data-code, data-preview) 수집 */
async function collectItems(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('.cksch_unit')]
      .map((el) => ({
        code: el.getAttribute('data-code'),
        preview: el.getAttribute('data-preview'),
        group: el.getAttribute('data-group'),
      }))
      .filter((it) => it.code);
  });
}

/**
 * 여러 검색어의 이미지를 한 브라우저 세션에서 순서대로 다운로드.
 * @param jobs [{ query, filePath, index }]
 * @returns 성공한 filePath 목록
 */
export async function downloadClipartImages({ jobs, allowPreviewFallback = false, log }) {
  if (!hasClipartSession()) throw new Error('클립아트코리아 로그인 세션이 없습니다.');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: CLIPART_SESSION_FILE,
    locale: 'ko-KR',
    viewport: { width: 1280, height: 900 },
  });
  const done = [];
  const usedCodes = loadUsedCodes();   // 지난 글들에서 이미 쓴 이미지
  const usedNow = new Set();           // 이번 글 안에서 쓴 이미지
  try {
    const page = await context.newPage();

    // 로그인 상태 먼저 확인 — 로그인이 풀리면 워터마크 미리보기만 받게 되므로 즉시 중단
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const loggedIn = await page
      .evaluate(() => /로그아웃|마이페이지/.test(document.body.innerText || ''))
      .catch(() => false);
    if (!loggedIn) {
      throw new Error(
        '클립아트코리아 로그인이 만료되었습니다. 헤더의 "🖼 클립아트 로그인" 버튼으로 다시 로그인해 주세요. ' +
          '(로그인 없이 받으면 워터마크가 박힌 미리보기 이미지만 저장됩니다)'
      );
    }
    log('클립아트코리아 로그인 확인됨 (멤버십 다운로드 가능)');

    for (const job of jobs) {
      try {
        log(`[이미지 ${job.index}] 클립아트코리아 검색: "${job.query}"`);
        await page.goto(`${BASE}/search?keyword=${encodeURIComponent(job.query)}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(4000);
        const items = await collectItems(page);
        if (!items.length) {
          log(`[이미지 ${job.index}] ⚠ 검색 결과 없음`);
          continue;
        }
        // 지난 글·이번 글에서 쓰지 않은 이미지 중에서 고른다
        // (검색 결과 순서가 고정이라 그냥 앞에서 고르면 매번 같은 사진이 나옴)
        const fresh = items.filter((it) => !usedCodes.has(it.code) && !usedNow.has(it.code));
        const pool = fresh.length ? fresh : items.filter((it) => !usedNow.has(it.code));
        if (!fresh.length && pool.length) log(`[이미지 ${job.index}] (새 이미지가 없어 기존 이미지에서 선택)`);
        // 상위 결과 중 무작위로 골라 같은 키워드라도 매번 다른 사진이 나오게 한다
        const item = pool[Math.floor(Math.random() * Math.min(pool.length, 12))] || items[0];
        usedNow.add(item.code);

        let saved = false;
        // 1차: 미리보기 팝업 열어 "멤버십 다운로드" (정식 라이선스 다운로드)
        try {
          const unit = page.locator(`.cksch_unit[data-code="${item.code}"]`).first();
          await unit.scrollIntoViewIfNeeded();
          await unit.click({ force: true, timeout: 5000 });
          await page.waitForTimeout(2500);
          const downBtn = page.locator('button.mega-btn__down, button:has-text("멤버십 다운로드")').first();
          if (await downBtn.count()) {
            const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
            await downBtn.click();
            // 크기/옵션 선택 레이어가 뜨는 경우 첫 다운로드 항목 클릭
            await page.waitForTimeout(1200);
            const optBtn = page.locator('button:has-text("다운로드"), a:has-text("다운로드")').first();
            if (await optBtn.count().catch(() => 0)) await optBtn.click({ timeout: 2000 }).catch(() => {});
            const download = await downloadPromise;
            const suggested = download.suggestedFilename() || '';
            if (/\.(jpe?g|png)$/i.test(suggested)) {
              await download.saveAs(job.filePath);
              saved = true;
              log(`[이미지 ${job.index}] ✅ 멤버십 다운로드 완료 (${suggested})`);
            } else {
              // zip 등은 임시 저장 후 폐기하고 미리보기 폴백
              await download.cancel().catch(() => {});
              log(`[이미지 ${job.index}] 다운로드 형식(${suggested})이 이미지가 아니라 미리보기로 대체`);
            }
          }
          await page.keyboard.press('Escape').catch(() => {});
        } catch (e) {
          log(`[이미지 ${job.index}] 멤버십 다운로드 실패(${e.message.split('\n')[0]}) — 미리보기로 대체`);
          await page.keyboard.press('Escape').catch(() => {});
        }

        // 2차: data-preview 폴백 — ⚠ 워터마크가 박힌 미리보기이므로 기본적으로 사용하지 않는다
        if (!saved && item.preview && allowPreviewFallback) {
          const res = await context.request.get(item.preview);
          if (res.ok()) {
            const buf = await res.body();
            if (buf.length > 5000) {
              fs.writeFileSync(job.filePath, buf);
              saved = true;
              log(`[이미지 ${job.index}] ⚠ 워터마크가 있는 미리보기 이미지로 저장됨 (발행용으로는 부적합)`);
            }
          }
        }
        if (saved) {
          done.push(job.filePath);
          usedCodes.add(item.code); // 다음 글에서 같은 사진이 다시 나오지 않도록 기록
        } else {
          log(`[이미지 ${job.index}] ⚠ 정품(멤버십) 다운로드에 실패했습니다. 워터마크 이미지는 저장하지 않습니다.`);
        }
        await page.waitForTimeout(1000);
      } catch (e) {
        log(`[이미지 ${job.index}] ⚠ 오류: ${e.message.split('\n')[0]}`);
      }
    }
  } finally {
    saveUsedCodes(usedCodes);
    await browser.close().catch(() => {});
  }
  return done;
}
