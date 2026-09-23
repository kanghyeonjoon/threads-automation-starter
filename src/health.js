import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { SESSION_FILE } from './files.js';
import { CLIPART_SESSION_FILE } from './clipart.js';
import { chromium } from 'playwright';

export function inspectSession(file, now = Date.now()) {
  if (!fs.existsSync(file)) return { state: 'missing', label: '로그인 필요' };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.cookies) || !data.cookies.length) return { state: 'invalid', label: '세션 내용 없음 — 다시 로그인' };
    const cookies = data.cookies.filter(c => c.expires === -1 || c.expires === 0 || c.expires * 1000 > now);
    if (!cookies.length) return { state: 'expired', label: '저장된 쿠키 만료 — 다시 로그인' };
    return { state: 'unverified', label: '세션 저장됨 · 실제 연결 미확인' };
  } catch { return { state: 'invalid', label: '세션 파일 오류 — 다시 로그인' }; }
}

let threadsCheck;
let aiCheck;
export function connectionStatus() {
  const threads = inspectSession(SESSION_FILE);
  let sdk = false;
  try { createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'); sdk = true; } catch {}
  return { threads: { ...threads, lastCheck: threads.state === 'unverified' && threadsCheck?.sessionMtime === fs.statSync(SESSION_FILE).mtimeMs ? threadsCheck : undefined }, clipart: inspectSession(CLIPART_SESSION_FILE),
    ai: aiCheck || { state: sdk ? 'unverified' : 'missing', label: sdk ? 'Claude 설치됨 · 인증/응답 미확인' : 'Claude SDK 설치 필요' },
    browser: { state: fs.existsSync(chromium.executablePath()) ? 'ready' : 'missing', label: fs.existsSync(chromium.executablePath()) ? '브라우저 준비됨' : '브라우저 설치 필요' } };
}

export async function checkThreadsConnection() {
  const saved = inspectSession(SESSION_FILE);
  if (saved.state !== 'unverified') return saved;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: SESSION_FILE });
    const page = await context.newPage();
    await page.goto('https://www.threads.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Positive evidence is required; absence of a login redirect is insufficient.
    const profile = page.locator('a[href="/@me"], a[aria-label="Profile"], a[aria-label="프로필"]');
    await profile.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    threadsCheck = { state: await profile.count() && await profile.first().isVisible() ? 'ready' : 'unverified', checkedAt: Date.now() };
    threadsCheck.sessionMtime = fs.statSync(SESSION_FILE).mtimeMs;
    threadsCheck.label = threadsCheck.state === 'ready' ? '스레드 로그인 연결 확인됨' : '로그인 연결 확인 불가 — 로그인 화면에서 확인해 주세요';
  } catch { threadsCheck = { state: 'unverified', label: '연결 확인 실패 — 네트워크 또는 로그인 상태 확인', checkedAt: Date.now() }; }
  finally { await browser?.close(); }
  return threadsCheck;
}

export async function checkAiConnection() {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 30000);
  try {
    let success = false;
    for await (const msg of query({ prompt: 'Reply with exactly OK.', options: { tools: [], allowedTools: [], mcpServers: {}, settingSources: [], maxTurns: 1, maxBudgetUsd: 0.05, abortController } })) {
      if (msg.type === 'result' && msg.subtype === 'success' && msg.result?.trim() === 'OK') success = true;
    }
    aiCheck = { state: success ? 'ready' : 'unverified', label: success ? 'Claude 응답 확인됨' : 'Claude 응답 확인 실패 — 인증/사용량 확인', checkedAt: Date.now() };
  } catch { aiCheck = { state: 'unverified', label: 'Claude 연결 실패 — 인증/사용량/네트워크 확인', checkedAt: Date.now() }; }
  finally { clearTimeout(timer); }
  return aiCheck;
}
