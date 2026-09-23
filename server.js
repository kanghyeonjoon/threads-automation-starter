import { connectionStatus, checkThreadsConnection, checkAiConnection } from './src/health.js';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, createHash } from 'crypto';
import {
  ensureDirs, saveMd, listMd, readMd, deleteMd, sessionInfo, IMAGES_DIR, timestamp, sanitizeName,
} from './src/files.js';
import {
  saveClipartLoginSession, clipartSessionInfo, downloadClipartImages, resetUsedImages, usedImageCount,
} from './src/clipart.js';
import { saveLoginSession, crawl, toMarkdown } from './src/crawler.js';
import { contentPolicyProbe, analyzeCrawl, generatePost, extractPost, extractComments, extractImageQuery, suggestImageQuery } from './src/ai.js';
import { publishPost } from './src/publisher.js';
import { splitDraft, prepareForPublish, findOverLimit, LIMIT } from './src/split.js';
import { introStatus, forceNext } from './src/intro.js';
import { updateItem, moveItem, publishItem, loadQueue, getQueue, addItem, removeItem, clearFinished, retryItems, setItemImage, startQueue, stopQueue } from './src/queue.js';
import { pickIdeas, markUsed, resetUsed, ideasStatus } from './src/ideas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3579);

ensureDirs();
loadQueue();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 잡(작업) 관리: 오래 걸리는 작업은 잡으로 실행하고 UI가 폴링 ----------
const jobs = new Map();

function startJob(type, fn) {
  const id = randomUUID();
  const job = { id, type, status: 'running', logs: [], result: null, error: null, startedAt: Date.now() };
  jobs.set(id, job);
  const log = (msg) => {
    job.logs.push({ t: Date.now(), msg });
    console.log(`[${type}] ${msg}`);
  };
  (async () => {
    try {
      job.result = await fn(log);
      job.status = 'done';
      log('작업 완료');
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      log(`오류: ${e.message}`);
    }
  })();
  return job;
}

app.get('/api/runtime-status', (req, res) => {
  const q = getQueue();
  res.json({ activeJobs: [...jobs.values()].filter(j => j.status === 'running').map(({id,type,startedAt}) => ({id,type,startedAt})), queueRunning: q.running, publishingItems: q.items.filter(i => i.status === 'publishing').map(i => i.id) });
});

app.get('/api/policy-dry-run', (req, res) => {
  try { res.json(contentPolicyProbe()); } catch { res.status(500).json({ error: '콘텐츠 헌법을 읽을 수 없습니다.' }); }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  res.json(job);
});

// ---------- 로그인 세션 ----------
app.post('/api/connections/ai', (req, res) => {
  const job = startJob('ai-check', async () => checkAiConnection());
  res.json({ jobId: job.id });
});
app.get('/api/connections', (req, res) => res.json(connectionStatus()));
app.post('/api/connections/threads', (req, res) => {
  const job = startJob('connection-check', async () => checkThreadsConnection());
  res.json({ jobId: job.id });
});

app.get('/api/session', (req, res) => res.json(sessionInfo()));

app.post('/api/login', (req, res) => {
  const job = startJob('login', async (log) => {
    await saveLoginSession(log);
    return { ok: true };
  });
  res.json({ jobId: job.id });
});

// ---------- 클립아트코리아 이미지 ----------
app.get('/api/clipart/session', (req, res) => {
  res.json({ ...clipartSessionInfo(), usedCount: usedImageCount() });
});

app.post('/api/clipart/login', (req, res) => {
  const job = startJob('clipart-login', async (log) => {
    await saveClipartLoginSession(log);
    return { ok: true };
  });
  res.json({ jobId: job.id });
});

app.post('/api/clipart/reset-used', (req, res) => {
  resetUsedImages();
  res.json({ ok: true, usedCount: usedImageCount() });
});

/** 본문을 보고 이미지 검색어 추천 → 그대로 이미지까지 받아온다 */
app.post('/api/clipart/auto', (req, res) => {
  const { postContent } = req.body || {};
  if (!postContent || !postContent.trim()) {
    return res.status(400).json({ error: '본문이 비어 있습니다. 먼저 발행할 게시물을 입력해 주세요.' });
  }
  const job = startJob('clipart-auto', async (log) => {
    const query = await suggestImageQuery({ postContent: postContent.trim(), log });
    const fileName = `${sanitizeName(query)}_${timestamp()}.jpg`;
    const filePath = path.join(IMAGES_DIR, fileName);
    const done = await downloadClipartImages({ jobs: [{ query, filePath, index: 1 }], log });
    if (!done.length) throw new Error(`"${query}"로 이미지를 받지 못했습니다. 검색어를 직접 입력해 보세요.`);
    return { fileName, query };
  });
  res.json({ jobId: job.id });
});

/** 검색어로 이미지 1장 받아 data/images에 저장 */
app.post('/api/clipart/fetch', (req, res) => {
  const { query } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: '이미지 검색어를 입력해 주세요.' });
  const job = startJob('clipart-fetch', async (log) => {
    const fileName = `${sanitizeName(query.trim())}_${timestamp()}.jpg`;
    const filePath = path.join(IMAGES_DIR, fileName);
    const done = await downloadClipartImages({
      jobs: [{ query: query.trim(), filePath, index: 1 }],
      log,
    });
    if (!done.length) throw new Error('이미지를 받지 못했습니다. 검색어를 바꾸거나 로그인 세션을 다시 저장해 주세요.');
    return { fileName };
  });
  res.json({ jobId: job.id });
});

/** 저장된 이미지 목록 */
app.get('/api/images', (req, res) => {
  try {
    const files = fs
      .readdirSync(IMAGES_DIR)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(IMAGES_DIR, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 이미지 파일 서빙 (미리보기용) */
app.get('/api/images/:name', (req, res) => {
  const safe = path.basename(req.params.name);
  const filePath = path.join(IMAGES_DIR, safe);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

app.delete('/api/images/:name', (req, res) => {
  const safe = path.basename(req.params.name);
  const filePath = path.join(IMAGES_DIR, safe);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 크롤링 ----------
app.post('/api/crawl', (req, res) => {
  const { keyword, minViews = 0, maxPosts = 10 } = req.body || {};
  if (!keyword || !keyword.trim()) return res.status(400).json({ error: '키워드를 입력해 주세요.' });
  const job = startJob('crawl', async (log) => {
    const posts = await crawl({
      keyword: keyword.trim(),
      minViews: Number(minViews) || 0,
      maxPosts: Math.min(Math.max(Number(maxPosts) || 10, 1), 50),
      log,
    });
    const md = toMarkdown({ keyword: keyword.trim(), minViews: Number(minViews) || 0, posts });
    const fileName = saveMd('crawls', `크롤링_${keyword.trim()}`, md);
    log(`저장됨: ${fileName}`);
    return { fileName, postCount: posts.length, content: md };
  });
  res.json({ jobId: job.id });
});

// ---------- AI 분석 ----------
app.post('/api/analyze', (req, res) => {
  const { fileName } = req.body || {};
  if (!fileName) return res.status(400).json({ error: '분석할 크롤링 파일을 선택해 주세요.' });
  const job = startJob('analyze', async (log) => {
    const crawlContent = readMd('crawls', fileName);
    const analysis = await analyzeCrawl({ crawlContent, log });
    const base = fileName.replace(/^크롤링_/, '').replace(/_\d{8}_\d{6}\.md$/, '');
    const outName = saveMd('analyses', `분석_${base}`, analysis);
    log(`저장됨: ${outName}`);
    return { fileName: outName, content: analysis };
  });
  res.json({ jobId: job.id });
});

// ---------- AI 생성 ----------
app.post('/api/generate', (req, res) => {
  const { analysisFile, userMessage } = req.body || {};
  if (!analysisFile) return res.status(400).json({ error: '분석 파일을 선택해 주세요.' });
  if (!userMessage || !userMessage.trim()) return res.status(400).json({ error: '전달하고자 하는 내용을 입력해 주세요.' });
  const job = startJob('generate', async (log) => {
    const analysisContent = readMd('analyses', analysisFile);
    const generated = await generatePost({ analysisContent, userMessage: userMessage.trim(), log });
    const post = extractPost(generated);
    const comments = extractComments(generated);
    const imageQuery = extractImageQuery(generated);
    const base = analysisFile.replace(/^분석_/, '').replace(/_\d{8}_\d{6}\.md$/, '');
    const outName = saveMd('generated', `생성_${base}`, generated);
    log(`저장됨: ${outName} (본문 1개 + 연결 댓글 ${comments.length}개${imageQuery ? ` · 이미지 검색어 "${imageQuery}"` : ''})`);
    return { fileName: outName, content: generated, post, comments, imageQuery };
  });
  res.json({ jobId: job.id });
});

// ---------- 코드 버전 확인 ----------
// 서버를 켜둔 채 소스를 고치면 옛 코드로 계속 돈다. 그걸 감지하기 위한 것.
const CODE_FILES = ['src/publisher.js', 'src/ai.js', 'src/split.js', 'src/intro.js', 'server.js'];
const BOOTED_AT = Date.now();
const BOOT_CODE_HASHES = Object.fromEntries(CODE_FILES.map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(__dirname, f))).digest('hex')]));
app.get('/api/version', (req, res) => {
  const files = CODE_FILES.map((f) => {
    const m = fs.statSync(path.join(__dirname, f)).mtimeMs;
    return { file: f, modifiedAt: m, stale: m > BOOTED_AT };
  });
  res.json({ bootedAt: BOOTED_AT, bootCodeHashes: BOOT_CODE_HASHES, stale: files.some((f) => f.stale), files });
});

// ---------- 자기소개 교대 ----------
app.get('/api/intro', (req, res) => res.json(introStatus()));

app.post('/api/intro', (req, res) => {
  try {
    res.json(forceNext(String(req.body?.next || '').toUpperCase()));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 초안 분할 ----------
// 긴 글 한 덩어리를 스레드 연속 게시용 토막으로 나눈다.
app.post('/api/split', (req, res) => {
  const { draft = '', limit } = req.body || {};
  if (!String(draft).trim()) return res.status(400).json({ error: '분할할 초안이 비어 있습니다.' });
  const max = Number(limit) > 0 ? Number(limit) : LIMIT;
  const chunks = splitDraft(draft, max);
  if (!chunks.length) return res.status(400).json({ error: '나눌 내용이 없습니다.' });
  res.json({
    limit: max,
    count: chunks.length,
    overLimit: findOverLimit(chunks, max),
    content: chunks[0],
    comments: chunks.slice(1),
    chunks: chunks.map((text, i) => ({ index: i + 1, chars: text.length, text })),
  });
});

// ---------- 발행 ----------
app.post('/api/publish', (req, res) => {
  const { content, comments = [], topic = '', image = '' } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: '게시할 내용이 비어 있습니다.' });
  // 번호 마커 제거 후 상한 검사 — 브라우저를 띄우기 전에 걸러낸다
  const prepared = prepareForPublish(content, comments);
  const cleanComments = prepared.comments.slice(0, 10); // 스레드 체인은 여러 장 가능
  if (!prepared.content) return res.status(400).json({ error: '마커를 제거하고 나니 본문이 비었습니다.' });
  const over = findOverLimit([prepared.content, ...cleanComments]);
  if (over.length) {
    const detail = over.map((o) => `${o.index}번째 ${o.chars}자`).join(', ');
    return res.status(400).json({ error: `스레드 한 장 상한(${LIMIT}자) 초과 — ${detail}` });
  }
  if (getQueue().running || getQueue().items.some(i => i.status === 'publishing')) return res.status(409).json({ error: '자동 발행을 중지하고 현재 발행이 끝난 뒤 진행해 주세요.' });
  let item;
  try { item = addItem({ content: prepared.content, comments: cleanComments, topic: String(topic).trim(), image: image ? path.basename(String(image)) : '' }); }
  catch (e) { return res.status(409).json({ error: e.message }); }
  const job = startJob('publish', async (log) => {
    log('발행 결과는 자동 발행 대기열에도 저장됩니다.');
    const result = await publishItem(item.id);
    return { ok: true, postUrl: result.postUrl };
  });
  res.json({ jobId: job.id });
});

// ---------- 글감 자동 생성 ----------
app.get('/api/ideas-status', (req, res) => res.json(ideasStatus()));

app.post('/api/ideas-reset', (req, res) => {
  resetUsed();
  res.json({ ok: true, ...ideasStatus() });
});

/** 미사용 글감 n개를 골라 생성 → 대기열 적재 (auto-generate / full-auto 공용) */
async function generateIdeasToQueue({ analysisContent, count, mode, topic, ideaFile = '', log }) {
  const ideas = pickIdeas(count, mode, ideaFile);
  if (!ideas.length) {
    throw new Error(
      ideaFile
        ? `"${ideaFile}"에 남은 글감이 없습니다. 다른 글감 묶음을 고르거나 사용 기록을 초기화해 주세요.`
        : '사용 가능한 글감이 없습니다. 글감 사용 기록을 초기화하거나 글감을 추가해 주세요.'
    );
  }
  if (ideaFile) log(`글감 묶음: ${ideaFile}`);
  log(`글감 ${ideas.length}개 선택됨: ${ideas.map((i) => `${i.num}번`).join(', ')}`);

  const results = [];
  for (let i = 0; i < ideas.length; i++) {
    const idea = ideas[i];
    log(`── [${i + 1}/${ideas.length}] 글감 ${idea.num}. ${idea.title} — 생성 중...`);
    try {
      const generated = await generatePost({ analysisContent, userMessage: idea.text, log });
      const post = extractPost(generated);
      const comments = extractComments(generated);
      if (!post) throw new Error('생성 결과에서 본문을 추출하지 못했습니다.');

      const outName = saveMd('generated', `생성_글감${idea.num}_${idea.title.slice(0, 12)}`, generated);
      addItem({ content: post, comments, topic: String(topic).trim() });
      markUsed([idea.id]);
      results.push({ idea: `${idea.num}. ${idea.title}`, fileName: outName, ok: true });
      log(`   ✅ 생성 완료 → 대기열 추가됨 (${outName})`);
    } catch (e) {
      results.push({ idea: `${idea.num}. ${idea.title}`, ok: false, error: e.message });
      log(`   ⚠ 실패: ${e.message} (이 글감은 미사용으로 유지되어 다음에 재시도됩니다)`);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  log(`총 ${okCount}/${ideas.length}개 생성 완료. "자동 발행 시작"을 누르면 순서대로 발행됩니다.`);
  return { results, okCount, status: ideasStatus() };
}

app.post('/api/auto-generate', (req, res) => {
  const { analysisFile, count = 3, mode = 'order', topic = '', ideaFile = '' } = req.body || {};
  if (!analysisFile) return res.status(400).json({ error: '분석 파일(프레임)을 선택해 주세요.' });
  const n = Math.min(Math.max(Number(count) || 3, 1), 5);

  const job = startJob('auto-generate', async (log) => {
    const analysisContent = readMd('analyses', analysisFile);
    return generateIdeasToQueue({ analysisContent, count: n, mode, topic, ideaFile, log });
  });
  res.json({ jobId: job.id });
});

// ---------- 풀 자동: 수집 → 분석 → 생성 → 대기열 ----------
app.post('/api/full-auto', (req, res) => {
  const { keyword, minViews = 0, maxPosts = 10, count = 3, mode = 'order', topic = '', ideaFile = '' } = req.body || {};
  if (!keyword || !keyword.trim()) return res.status(400).json({ error: '키워드를 입력해 주세요.' });
  const n = Math.min(Math.max(Number(count) || 3, 1), 5);

  const job = startJob('full-auto', async (log) => {
    // 1) 수집
    log(`[1/3 수집] 키워드 "${keyword.trim()}" 크롤링 시작...`);
    const posts = await crawl({
      keyword: keyword.trim(),
      minViews: Number(minViews) || 0,
      maxPosts: Math.min(Math.max(Number(maxPosts) || 10, 1), 50),
      log,
    });
    const crawlMd = toMarkdown({ keyword: keyword.trim(), minViews: Number(minViews) || 0, posts });
    const crawlName = saveMd('crawls', `크롤링_${keyword.trim()}`, crawlMd);
    log(`[1/3 수집] 완료 — ${posts.length}개 게시물 (${crawlName})`);

    // 2) 분석
    log('[2/3 분석] AI 프레임 분석 시작...');
    const analysis = await analyzeCrawl({ crawlContent: crawlMd, log });
    const analysisName = saveMd('analyses', `분석_${keyword.trim()}`, analysis);
    log(`[2/3 분석] 완료 (${analysisName})`);

    // 3) 생성 → 대기열
    log(`[3/3 생성] 글감 ${n}개로 글 생성 시작...`);
    const gen = await generateIdeasToQueue({ analysisContent: analysis, count: n, mode, topic, ideaFile, log });

    return { crawlFile: crawlName, analysisFile: analysisName, ...gen };
  });
  res.json({ jobId: job.id });
});

// ---------- 자동 발행 대기열 ----------
app.get('/api/queue', (req, res) => res.json(getQueue()));

app.post('/api/queue', (req, res) => {
  const { content, comments = [], topic = '', image = '' } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: '추가할 글 내용이 비어 있습니다.' });
  const prepared = prepareForPublish(content, comments);
  const cleanComments = prepared.comments.slice(0, 10); // 스레드 체인은 여러 장 가능
  if (!prepared.content) return res.status(400).json({ error: '마커를 제거하고 나니 본문이 비었습니다.' });
  const overQ = findOverLimit([prepared.content, ...cleanComments]);
  if (overQ.length) {
    const detail = overQ.map((o) => `${o.index}번째 ${o.chars}자`).join(', ');
    return res.status(400).json({ error: `스레드 한 장 상한(${LIMIT}자) 초과 — ${detail}` });
  }
  let item;
  try { item = addItem({
    content: prepared.content,
    comments: cleanComments,
    topic: String(topic).trim(),
    image: image ? path.basename(String(image)) : '',
  });
  } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json({ ok: true, id: item.id });
});

app.post('/api/queue/:id/edit', (req, res) => {
  try { res.json({ ok: true, item: updateItem(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/queue/:id/move', (req, res) => {
  try { moveItem(req.params.id, req.body?.direction); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/queue/:id', (req, res) => {
  try {
    removeItem(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/queue/clear-finished', (req, res) => {
  clearFinished();
  res.json({ ok: true });
});

app.post('/api/queue/:id/image', (req, res) => {
  try {
    const image = req.body?.image ? path.basename(String(req.body.image)) : '';
    const item = setItemImage(req.params.id, image);
    res.json({ ok: true, image: item.image });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/queue/retry', (req, res) => {
  try {
    const count = retryItems(req.body?.id);
    res.json({ ok: true, count });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/queue/start', (req, res) => {
  try {
    startQueue(req.body?.intervalMin, { alignToClock: req.body?.alignToClock !== false });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/queue/stop', (req, res) => {
  stopQueue();
  res.json({ ok: true });
});

// ---------- 파일 보관함 ----------
app.get('/api/files', (req, res) => {
  const { type } = req.query;
  try {
    res.json(listMd(type));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/file', (req, res) => {
  const { type, name } = req.query;
  try {
    res.json({ name, content: readMd(type, name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/file', (req, res) => {
  const { type, name } = req.query;
  try {
    deleteMd(type, name);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n✅ 스레드 분석기 실행 중: http://localhost:${PORT}\n`);
});
