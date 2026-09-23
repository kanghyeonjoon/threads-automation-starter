// Shared, read-only DOM extraction. Never infer identity from screen order.
export function postIdentity(value) {
  try {
    const u = new URL(value, 'https://www.threads.com');
    if (!['www.threads.com', 'threads.com', 'www.threads.net', 'threads.net'].includes(u.hostname)) return null;
    const m = u.pathname.match(/^\/@([^/]+)\/post\/([A-Za-z0-9_-]+)\/?$/);
    return m ? { author: '@' + m[1].toLowerCase(), id: m[2], url: `https://www.threads.com/@${m[1].toLowerCase()}/post/${m[2]}` } : null;
  } catch { return null; }
}

export const normalizePostText = value => String(value ?? '').normalize('NFC').replace(/[\s\u200b-\u200d\ufeff]+/g, '').replace(/["'“”‘’]/g, '');

// Self-contained for page.evaluate; no dependency on hidden application state.
export function extractPostCards() {
  const selector = '[data-pressable-container="true"]';
  const visible = e => !e.closest('[hidden], [aria-hidden="true"]') && (!e.getClientRects || e.getClientRects().length > 0);
  const read = e => e.innerText ?? e.textContent ?? '';
  const identity = href => {
    try {
      const u = new URL(href, 'https://www.threads.com');
      if (!/^(www\.)?threads\.(com|net)$/.test(u.hostname)) return null;
      const m = u.pathname.match(/^\/@([^/]+)\/post\/([\w-]+)\/?$/);
      return m && {author:'@'+m[1].toLowerCase(), url:`https://www.threads.com/@${m[1].toLowerCase()}/post/${m[2]}`};
    } catch { return null; }
  };
  const result = new Map();
  for (const c of document.querySelectorAll(selector)) {
    if (!visible(c)) continue;
    const owned = e => e.closest(selector) === c;
    const links = [...c.querySelectorAll('a[href]')].filter(owned);
    const anchors = links.filter(a => a.querySelector('time') && identity(a.getAttribute('href')));
    const identities = [...new Set(anchors.map(a => identity(a.getAttribute('href')).url))];
    if (identities.length !== 1) continue; // ambiguous/quoted wrapper
    const p = identity(identities[0]);
    if (!links.some(a => (a.getAttribute('href') || '').replace(/\/$/, '').toLowerCase() === '/' + p.author)) continue;
    const parts = [];
    let chainIndex = null, chainTotal = null;
    for (const e of c.querySelectorAll('span[dir="auto"]')) {
      if (!owned(e) || !visible(e) || e.closest('a,button,[role="button"],[contenteditable="true"]') || e.querySelector('time')) continue;
      if ([...e.querySelectorAll('span[dir="auto"]')].some(owned)) continue;
      let t = read(e).trim();
      const marker = [...e.querySelectorAll('span,div')].find(n => /^\s*\d+\s*\/\s*\d+\s*$/.test(read(n)));
      const chain = marker && t.match(/\s+(\d+)\s*\/\s*(\d+)\s*$/);
      if (chain) { chainIndex = +chain[1]; chainTotal = +chain[2]; t = t.slice(0, chain.index).trim(); }
      if (!t || /^\d+\s*\/\s*\d+$/.test(t) || /님에게 답글 남기기|^Reply to /.test(t)) continue;
      if (/^(번역 보기|더 보기|팔로우|수정됨|인기순|모든 답글)$/.test(t)) continue;
      parts.push(t);
    }
    const metrics = {likes:'', replies:'', reposts:'', shares:'', views:''};
    for (const svg of c.querySelectorAll('svg[aria-label]')) {
      if (!owned(svg)) continue;
      const label = svg.getAttribute('aria-label') || '';
      const key = /좋아요|like/i.test(label) ? 'likes' : /답글|reply|comment/i.test(label) ? 'replies' : /리포스트|repost/i.test(label) ? 'reposts' : /공유|share/i.test(label) ? 'shares' : null;
      const button = svg.closest('button,[role="button"]');
      if (!key || !button || !owned(button)) continue;
      const count = read(button).match(/[\d,.]+\s*(?:만|천|억|K|M|B)?/i);
      if (count) metrics[key] = count[0].trim();
    }
    for (const button of c.querySelectorAll('button,[role="button"]')) {
      if (!owned(button)) continue;
      const match = read(button).trim().match(/^(?:조회수?\s*([\d,.]+\s*(?:만|천|억)?)\s*회|([\d,.]+\s*[KMB]?)\s*views?)$/i);
      if (match) metrics.views = match[1] || match[2];
    }
    if (parts.length) result.set(p.url, {...p, text:parts.join('\n'), chainIndex, chainTotal, ...metrics});
  }
  return [...result.values()];
}

export function selectDetail(posts, url) {
  const target = postIdentity(url);
  const main = target && posts.find(p => postIdentity(p.url)?.url === target.url && p.author.toLowerCase() === target.author);
  if (!main?.text) throw new Error('SOURCE_UNVERIFIED: 요청한 URL과 작성자가 일치하는 본문을 확인하지 못했습니다.');
  // Only numbered self-thread continuation is proven here; arbitrary feed items aren't replies.
  const repliesList = [];
  if (main.chainIndex === 1 && main.chainTotal > 1) {
    for (const p of posts.slice(posts.indexOf(main) + 1)) {
      if (p.author !== main.author || p.chainTotal !== main.chainTotal || p.chainIndex !== repliesList.length + 2) break;
      repliesList.push(p);
      if (repliesList.length >= Math.min(10, main.chainTotal - 1)) break;
    }
  }
  return {...main, repliesList, verification: {status:'verified', sourceUrl:target.url, repliesScope:'numbered-author-chain', checkedAt:new Date().toISOString()}};
}

export async function openPostDetail(page, value) {
  const target = postIdentity(value);
  if (!target) throw new Error('INVALID_POST_URL: 올바른 Threads 게시물 URL이 아닙니다.');
  await page.goto(target.url, {waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1500);
  // Threads can redirect direct visits to a home feed with the target injected.
  if (postIdentity(page.url())?.url !== target.url) {
    const link = page.locator(`a[href="${new URL(target.url).pathname}"]`).filter({has:page.locator('time')}).last();
    if (await link.count()) await link.click();
    await page.waitForTimeout(1500);
  }
  if (postIdentity(page.url())?.url !== target.url) throw new Error('DETAIL_NOT_OPEN: 상세 화면 진입을 확인하지 못했습니다.');
  return target;
}

export async function readPostCards(page) {
  let posts = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    posts = await page.evaluate(extractPostCards);
    if (posts.length) return posts;
    await page.waitForTimeout(1000);
  }
  return posts;
}

export async function readDetailViews(page) {
  return page.evaluate(() => {
    const values = [...document.querySelectorAll('button,[role="button"]')]
      .filter(e => !e.closest('[hidden],[aria-hidden="true"]') && e.getClientRects().length > 0)
      .map(e => (e.innerText || '').trim().match(/^조회수?\s*([\d,.]+\s*(?:만|천|억)?)\s*회$/))
      .filter(Boolean).map(m => m[1]);
    return values.length === 1 ? values[0] : '';
  });
}
