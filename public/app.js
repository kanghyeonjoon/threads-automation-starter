const $ = (id) => document.getElementById(id);

// ---------- 토스트 알림 (alert/confirm 팝업이 차단되는 환경 대응) ----------
const toastEl = document.createElement('div');
toastEl.id = 'toast';
document.body.appendChild(toastEl);
let toastTimer;
function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = isError ? 'show error' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = ''), 5000);
}

// ---------- 탭 전환 ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'analyze') loadFileOptions('crawls', 'analyzeSource');
    if (tab.dataset.tab === 'generate') loadFileOptions('analyses', 'generateSource');
    if (tab.dataset.tab === 'files') loadFileList();
    if (tab.dataset.tab === 'queue') {
      refreshQueue();
      refreshIdeasStatus();
      loadFileOptions('analyses', 'autoGenSource');
    }
  });
});

// ---------- 공통: 잡 폴링 ----------
async function pollJob(jobId, { logEl, onDone, onError }) {
  let lastLogCount = 0;
  while (true) {
    await new Promise((r) => setTimeout(r, 1500));
    let job;
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      job = await res.json();
    } catch {
      continue;
    }
    if (logEl && job.logs.length > lastLogCount) {
      for (const l of job.logs.slice(lastLogCount)) {
        logEl.textContent += `[${new Date(l.t).toLocaleTimeString('ko-KR')}] ${l.msg}\n`;
      }
      logEl.scrollTop = logEl.scrollHeight;
      lastLogCount = job.logs.length;
    }
    if (job.status === 'done') return onDone && onDone(job.result);
    if (job.status === 'error') return onError ? onError(job.error) : showToast(`오류: ${job.error}`, true);
  }
}

function resetLog(el) {
  el.textContent = '';
  el.classList.remove('hidden');
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '요청 실패');
  return data;
}

// ---------- 로그인 세션 ----------
async function refreshSession() {
  try {
    const res = await fetch('/api/session');
    const info = await res.json();
    const badge = $('sessionStatus');
    if (info.exists) {
      badge.textContent = '세션 저장됨 · 연결 확인 필요';
      badge.className = 'badge ok';
    } else {
      badge.textContent = '✖ 로그인 세션 없음';
      badge.className = 'badge no';
    }
  } catch { /* 무시 */ }
}

$('loginBtn').addEventListener('click', async () => {
  $('loginBtn').disabled = true;
  $('sessionStatus').textContent = '브라우저에서 로그인해 주세요...';
  $('sessionStatus').className = 'badge';
  try {
    const { jobId } = await postJson('/api/login');
    await pollJob(jobId, {
      onDone: () => { showToast('로그인 세션이 저장되었습니다.'); refreshSession(); refreshConnections(); },
      onError: (e) => { showToast(e, true); refreshSession(); },
    });
  } catch (e) {
    showToast(e.message, true);
  } finally {
    $('loginBtn').disabled = false;
  }
});

// ---------- 🖼 클립아트코리아 이미지 ----------
async function refreshClipartSession() {
  try {
    const info = await (await fetch('/api/clipart/session')).json();
    const badge = $('clipartStatus');
    if (info.exists) {
      badge.textContent = `🖼 이미지 세션 OK (사용 ${info.usedCount}장)`;
      badge.className = 'badge ok';
    } else {
      badge.textContent = '🖼 이미지 세션 없음';
      badge.className = 'badge no';
    }
  } catch { /* 무시 */ }
}

$('clipartLoginBtn').addEventListener('click', async () => {
  $('clipartLoginBtn').disabled = true;
  showToast('브라우저가 열립니다. 클립아트코리아에 로그인해 주세요.');
  try {
    const { jobId } = await postJson('/api/clipart/login');
    await pollJob(jobId, {
      onDone: () => { showToast('클립아트코리아 세션이 저장되었습니다.'); refreshClipartSession(); },
      onError: (e) => { showToast(e, true); refreshClipartSession(); },
    });
  } catch (e) {
    showToast(e.message, true);
  } finally {
    $('clipartLoginBtn').disabled = false;
  }
});

async function loadImageOptions(selectAfter) {
  const files = await (await fetch('/api/images')).json();
  const sel = $('imageSelect');
  const current = selectAfter || sel.value;
  sel.innerHTML = '<option value="">(이미지 없음)</option>';
  for (const f of files) {
    const opt = document.createElement('option');
    opt.value = f.name;
    opt.textContent = `${f.name} (${(f.size / 1024).toFixed(0)}KB)`;
    sel.appendChild(opt);
  }
  if (current && files.some((f) => f.name === current)) sel.value = current;
  updateImagePreview();
}

function updateImagePreview() {
  const name = $('imageSelect').value;
  if (name) {
    $('imagePreview').src = `/api/images/${encodeURIComponent(name)}`;
    $('imagePreviewWrap').classList.remove('hidden');
  } else {
    $('imagePreviewWrap').classList.add('hidden');
  }
}

$('imageSelect').addEventListener('change', updateImagePreview);
$('refreshImagesBtn').addEventListener('click', () => loadImageOptions());

$('fetchImageBtn').addEventListener('click', async () => {
  const query = $('imageQuery').value.trim();
  if (!query) return showToast('이미지 검색어를 입력해 주세요.', true);
  $('fetchImageBtn').disabled = true;
  resetLog($('imageLog'));
  try {
    const { jobId } = await postJson('/api/clipart/fetch', { query });
    await pollJob(jobId, {
      logEl: $('imageLog'),
      onDone: (result) => {
        showToast('이미지를 받았습니다.');
        loadImageOptions(result.fileName);
        $('fetchImageBtn').disabled = false;
        refreshClipartSession();
      },
      onError: (e) => { showToast(`이미지 오류: ${e}`, true); $('fetchImageBtn').disabled = false; },
    });
  } catch (e) {
    showToast(e.message, true);
    $('fetchImageBtn').disabled = false;
  }
});

// 본문을 보고 AI가 검색어를 정해 이미지까지 받아온다
$('autoImageBtn').addEventListener('click', async () => {
  const postContent = $('postContent').value.trim();
  if (!postContent) return showToast('먼저 "발행할 게시물"에 본문을 입력해 주세요.', true);
  $('autoImageBtn').disabled = true;
  resetLog($('imageLog'));
  $('imageLog').textContent = 'AI가 본문을 읽고 이미지 검색어를 뽑는 중...\n';
  try {
    const { jobId } = await postJson('/api/clipart/auto', { postContent });
    await pollJob(jobId, {
      logEl: $('imageLog'),
      onDone: (result) => {
        $('imageQuery').value = result.query;
        showToast(`"${result.query}" 이미지를 받았습니다.`);
        loadImageOptions(result.fileName);
        $('autoImageBtn').disabled = false;
        refreshClipartSession();
      },
      onError: (e) => { showToast(`이미지 오류: ${e}`, true); $('autoImageBtn').disabled = false; },
    });
  } catch (e) {
    showToast(e.message, true);
    $('autoImageBtn').disabled = false;
  }
});

$('deleteImageBtn').addEventListener('click', async () => {
  const name = $('imageSelect').value;
  if (!name) return;
  await fetch(`/api/images/${encodeURIComponent(name)}`, { method: 'DELETE' });
  showToast('이미지를 삭제했습니다.');
  loadImageOptions();
});

// ---------- ① 수집 ----------
$('crawlBtn').addEventListener('click', async () => {
  const keyword = $('keyword').value.trim();
  if (!keyword) return showToast('키워드를 입력해 주세요.', true);
  $('crawlBtn').disabled = true;
  $('crawlResult').classList.add('hidden');
  resetLog($('crawlLog'));
  try {
    const { jobId } = await postJson('/api/crawl', {
      keyword,
      minViews: $('minViews').value,
      maxPosts: $('maxPosts').value,
    });
    await pollJob(jobId, {
      logEl: $('crawlLog'),
      onDone: (result) => {
        $('crawlResultFile').textContent = result.fileName;
        $('crawlResultContent').textContent = result.content;
        $('crawlResult').classList.remove('hidden');
        $('crawlBtn').disabled = false;
      },
      onError: (e) => { showToast(`크롤링 오류: ${e}`, true); $('crawlBtn').disabled = false; },
    });
  } catch (e) {
    showToast(e.message, true);
    $('crawlBtn').disabled = false;
  }
});

// ---------- 파일 옵션 로드 ----------
async function loadFileOptions(type, selectId) {
  const res = await fetch(`/api/files?type=${type}`);
  const files = await res.json();
  const sel = $(selectId);
  sel.innerHTML = '';
  if (!files.length) {
    sel.innerHTML = '<option value="">(파일 없음)</option>';
    return;
  }
  for (const f of files) {
    const opt = document.createElement('option');
    opt.value = f.name;
    opt.textContent = f.name;
    sel.appendChild(opt);
  }
}

// ---------- ② 분석 ----------
$('analyzeBtn').addEventListener('click', async () => {
  const fileName = $('analyzeSource').value;
  if (!fileName) return showToast('크롤링 파일을 먼저 만들어 주세요.', true);
  $('analyzeBtn').disabled = true;
  $('analyzeResult').classList.add('hidden');
  resetLog($('analyzeLog'));
  $('analyzeLog').textContent = 'AI 분석 요청 중... (수 분이 걸릴 수 있습니다)\n';
  try {
    const { jobId } = await postJson('/api/analyze', { fileName });
    await pollJob(jobId, {
      logEl: $('analyzeLog'),
      onDone: (result) => {
        $('analyzeResultFile').textContent = result.fileName;
        $('analyzeResultContent').textContent = result.content;
        $('analyzeResult').classList.remove('hidden');
        $('analyzeBtn').disabled = false;
      },
      onError: (e) => { showToast(`분석 오류: ${e}`, true); $('analyzeBtn').disabled = false; },
    });
  } catch (e) {
    showToast(e.message, true);
    $('analyzeBtn').disabled = false;
  }
});

// ---------- ③ 생성 · 발행 ----------
$('generateBtn').addEventListener('click', async () => {
  const analysisFile = $('generateSource').value;
  const userMessage = $('userMessage').value.trim();
  if (!analysisFile) return showToast('분석 파일을 먼저 만들어 주세요.', true);
  if (!userMessage) return showToast('전달하고자 하는 내용을 입력해 주세요.', true);
  $('generateBtn').disabled = true;
  $('generateRaw').classList.add('hidden');
  resetLog($('generateLog'));
  $('generateLog').textContent = 'AI 글 생성 요청 중...\n';
  try {
    const { jobId } = await postJson('/api/generate', { analysisFile, userMessage });
    await pollJob(jobId, {
      logEl: $('generateLog'),
      onDone: (result) => {
        $('generateResultFile').textContent = result.fileName;
        $('generateResultContent').textContent = result.content;
        $('generateRaw').classList.remove('hidden');
        $('postContent').value = result.post || '';
        renderComments(result.comments || []);
        if (result.imageQuery) {
          $('imageQuery').value = result.imageQuery;
          showToast(`이미지 검색어 제안: "${result.imageQuery}" — 가져오기를 누르면 받아옵니다.`);
        }
        $('generateBtn').disabled = false;
        if (!result.post) showToast('게시물 본문을 자동 추출하지 못했습니다. 텍스트박스에 직접 붙여넣어 주세요.', true);
      },
      onError: (e) => { showToast(`생성 오류: ${e}`, true); $('generateBtn').disabled = false; },
    });
  } catch (e) {
    showToast(e.message, true);
    $('generateBtn').disabled = false;
  }
});

// 연결 댓글 편집 UI 렌더링 (비어 있어도 1칸은 보여줘 직접 입력 가능하게)
function renderComments(comments) {
  const container = $('commentsContainer');
  container.innerHTML = '';
  const list = comments.length ? comments : [''];
  list.forEach((text, i) => addCommentBox(text, i));
}

const THREADS_LIMIT = 500;

/** 글자수 표시를 갱신한다. 상한을 넘으면 빨갛게. */
function paintCount(el, textarea) {
  const n = textarea.value.length;
  el.textContent = `${n} / ${THREADS_LIMIT}자`;
  el.classList.toggle('over', n > THREADS_LIMIT);
}

function addCommentBox(text = '', index) {
  const container = $('commentsContainer');
  const i = index ?? container.children.length;

  const wrap = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'comment-head';
  const label = document.createElement('span');
  label.textContent = `연결 글 ${i + 1}`;
  const count = document.createElement('span');
  count.className = 'charcount';
  head.append(label, count);

  const ta = document.createElement('textarea');
  ta.rows = 4;
  ta.className = 'comment-box';
  ta.placeholder = `연결 댓글 ${i + 1} (비우면 건너뜀)`;
  ta.value = text;
  ta.addEventListener('input', () => paintCount(count, ta));

  wrap.append(head, ta);
  container.appendChild(wrap);
  paintCount(count, ta);
}

// ---------- 자기소개 교대 ----------
async function refreshIntro() {
  try {
    const r = await fetch('/api/intro').then((x) => x.json());
    $('introNext').textContent = `${r.nextLabel} — "${r.nextLine}"`;
    document.querySelectorAll('[data-intro]').forEach((b) => {
      b.classList.toggle('on', b.dataset.intro === r.next);
    });
  } catch { /* 표시만 못 할 뿐 생성에는 지장 없음 */ }
}

document.querySelectorAll('[data-intro]').forEach((b) => {
  b.addEventListener('click', async () => {
    try {
      const r = await postJson('/api/intro', { next: b.dataset.intro });
      await refreshIntro();
      showToast(`다음 글은 "${r.nextLine}" 로 시작합니다.`);
    } catch (e) {
      showToast(`변경 실패: ${e.message}`, true);
    }
  });
});

refreshIntro();

// ---------- 초안 분할 ----------
$('splitBtn').addEventListener('click', async () => {
  const draft = $('draftInput').value.trim();
  const info = $('splitInfo');
  if (!draft) return showToast('자를 초안을 붙여넣어 주세요.', true);

  $('splitBtn').disabled = true;
  info.textContent = '자르는 중...';
  info.classList.remove('warn');
  try {
    const r = await postJson('/api/split', { draft });
    $('postContent').value = r.content;
    renderComments(r.comments);
    paintCount($('contentCount'), $('postContent'));

    if (r.overLimit.length) {
      info.textContent = `${r.count}장으로 잘랐지만 ${r.overLimit.length}장이 상한 초과 — 직접 줄여 주세요.`;
      info.classList.add('warn');
    } else {
      const max = Math.max(...r.chunks.map((c) => c.chars));
      info.textContent = `${r.count}장으로 나눴습니다 (가장 긴 장 ${max}자). 번호 마커는 제거했습니다.`;
    }
    showToast(`${r.count}장으로 나눴습니다.`);
  } catch (e) {
    info.textContent = '';
    showToast(`분할 실패: ${e.message}`, true);
  } finally {
    $('splitBtn').disabled = false;
  }
});

$('postContent').addEventListener('input', () => paintCount($('contentCount'), $('postContent')));

$('addCommentBtn').addEventListener('click', () => {
  if ($('commentsContainer').children.length >= 10) {
    return showToast('연결 글은 최대 10장까지 등록됩니다.', true);
  }
  addCommentBox();
});

function collectComments() {
  return [...document.querySelectorAll('#commentsContainer textarea.comment-box')]
    .map((t) => t.value.trim())
    .filter(Boolean);
}

// 팝업(confirm)이 차단되는 환경이 있어, 버튼을 두 번 눌러 확인하는 방식 사용
let publishArmed = false;
let publishArmTimer;

function resetPublishBtn() {
  publishArmed = false;
  clearTimeout(publishArmTimer);
  $('publishBtn').textContent = '스레드에 게시하기';
}

$('publishBtn').addEventListener('click', async () => {
  const content = $('postContent').value.trim();
  if (!content) return showToast('게시할 내용이 비어 있습니다.', true);

  const comments = collectComments();
  const topic = $('topicInput').value.trim();
  const image = $('imageSelect').value;
  localStorage.setItem('threads_topic', topic);

  if (!publishArmed) {
    publishArmed = true;
    $('publishBtn').textContent = '⚠ 정말 게시할까요? 한 번 더 클릭 (8초 내)';
    showToast(`게시 확인: 본문 1개${comments.length ? ` + 연결 댓글 ${comments.length}개` : ''}${image ? ' + 이미지' : ''}${topic ? ` (주제: ${topic})` : ''}가 게시됩니다. 버튼을 한 번 더 누르세요.`);
    publishArmTimer = setTimeout(resetPublishBtn, 8000);
    return;
  }

  resetPublishBtn();
  $('publishBtn').disabled = true;
  resetLog($('publishLog'));
  try {
    const { jobId } = await postJson('/api/publish', { content, comments, topic, image });
    await pollJob(jobId, {
      logEl: $('publishLog'),
      onDone: () => {
        showToast('✅ 게시 완료!');
        $('publishBtn').disabled = false;
      },
      onError: (e) => { showToast(`게시 오류: ${e}`, true); $('publishBtn').disabled = false; },
    });
  } catch (e) {
    showToast(e.message, true);
    $('publishBtn').disabled = false;
  }
});

// ---------- 🤖 글감 자동 생성 ----------
async function refreshIdeasStatus() {
  try {
    const s = await (await fetch('/api/ideas-status')).json();
    $('ideasStatus').textContent = `(글감 현황: 전체 ${s.total}개 · 미사용 ${s.remaining}개)`;

    // 글감 묶음 드롭다운 — 파일별 잔여 개수 표시
    const sel = $('autoGenIdeaFile');
    const current = sel.value;
    sel.innerHTML = `<option value="">전체 (미사용 ${s.remaining})</option>`;
    for (const f of s.files || []) {
      const opt = document.createElement('option');
      opt.value = f.file;
      opt.textContent = `${f.file.replace(/\.md$/, '')} — 미사용 ${f.remaining}/${f.total}`;
      if (f.remaining === 0) opt.disabled = true;
      sel.appendChild(opt);
    }
    if (current) sel.value = current;
  } catch { /* 무시 */ }
}

$('autoGenBtn').addEventListener('click', async () => {
  const keyword = $('autoKeyword').value.trim();
  const analysisFile = $('autoGenSource').value;
  const topic = $('autoTopic').value.trim();
  localStorage.setItem('threads_topic', topic);

  if (!keyword && !analysisFile) {
    return showToast('키워드를 입력하거나, 기존 분석 파일을 선택해 주세요.', true);
  }

  $('autoGenBtn').disabled = true;
  resetLog($('autoGenLog'));
  $('autoGenLog').textContent = keyword
    ? `풀 자동 시작: 수집 → 분석 → 생성 (10분 이상 걸릴 수 있습니다)\n`
    : 'AI 자동 생성 시작... (개수에 따라 수 분이 걸립니다)\n';

  const url = keyword ? '/api/full-auto' : '/api/auto-generate';
  const body = keyword
    ? {
        keyword,
        minViews: $('autoMinViews').value,
        maxPosts: $('autoMaxPosts').value,
        count: $('autoGenCount').value,
        mode: $('autoGenMode').value,
        ideaFile: $('autoGenIdeaFile').value,
        topic,
      }
    : {
        analysisFile,
        count: $('autoGenCount').value,
        mode: $('autoGenMode').value,
        ideaFile: $('autoGenIdeaFile').value,
        topic,
      };

  try {
    const { jobId } = await postJson(url, body);
    await pollJob(jobId, {
      logEl: $('autoGenLog'),
      onDone: (result) => {
        showToast(`✅ ${result.okCount}개 글이 생성되어 대기열에 추가되었습니다.`);
        $('autoGenBtn').disabled = false;
        refreshIdeasStatus();
        refreshQueue();
        loadFileOptions('analyses', 'autoGenSource');
        loadFileOptions('crawls', 'analyzeSource');
        loadFileOptions('analyses', 'generateSource');
      },
      onError: (e) => { showToast(`자동 생성 오류: ${e}`, true); $('autoGenBtn').disabled = false; },
    });
  } catch (e) {
    showToast(e.message, true);
    $('autoGenBtn').disabled = false;
  }
});

$('ideasResetBtn').addEventListener('click', async () => {
  const r = await postJson('/api/ideas-reset');
  showToast(`글감 사용 기록이 초기화되었습니다 (미사용 ${r.remaining}개).`);
  refreshIdeasStatus();
});

// ---------- ⏱ 자동 발행 대기열 ----------
$('addQueueBtn').addEventListener('click', async () => {
  const content = $('postContent').value.trim();
  if (!content) return showToast('대기열에 추가할 본문이 비어 있습니다.', true);
  const comments = collectComments();
  const topic = $('topicInput').value.trim();
  const image = $('imageSelect').value;
  localStorage.setItem('threads_topic', topic);
  try {
    await postJson('/api/queue', { content, comments, topic, image });
    showToast(`대기열에 추가되었습니다${comments.length ? ` (연결 댓글 ${comments.length}개` : ''}${image ? ' + 이미지' : ''}${comments.length ? ')' : ''}. ⏱ 자동 발행 탭에서 확인하세요.`);
  } catch (e) {
    showToast(e.message, true);
  }
});

const STATUS_LABEL = {
  pending: '⏳ 대기 중',
  publishing: '🚀 발행 중...',
  done: '✅ 발행 완료',
  failed: '❌ 게시 전 실패',
  review: '⚠ 확인 필요 · 재발행 잠금',
};

let queueTimer = null;
const expandedItems = new Set(); // 펼쳐진 대기열 항목 id
let availableImages = [];        // 대기열에서 고를 수 있는 이미지 목록

/** 클립보드 복사 (clipboard API 실패 시 폴백) */
async function copyText(text, btn, originalLabel = '복사') {
  let ok = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch {
      ok = false;
    }
  }
  if (btn) {
    btn.textContent = ok ? '✓ 복사됨' : '복사 실패';
    setTimeout(() => { btn.textContent = originalLabel; }, 1500);
  }
  if (!ok) showToast('복사에 실패했습니다. 텍스트를 드래그해서 복사해 주세요.', true);
}

let editingQueue = false;
let queueSettingsLoaded = false;
async function refreshQueue() {
  if (editingQueue) return;
  let q;
  try {
    const res = await fetch('/api/queue');
    q = await res.json();
  } catch {
    return;
  }
  // 펼친 항목이 있을 때만 이미지 목록을 갱신 (드롭다운 채우기용)
  if (expandedItems.size) {
    try {
      availableImages = await (await fetch('/api/images')).json();
    } catch { /* 유지 */ }
  }

  // 상태 표시
  const pending = q.items.filter((i) => i.status === 'pending').length;
  let status = q.running
    ? `🟢 자동 발행 실행 중 — ${q.alignToClock ? '정시 발행' : q.intervalMin + '분 간격'}, 대기 ${pending}개` +
      (q.nextAt ? ` · 다음 ${new Date(q.nextAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : '')
    : `⚪ 중지됨 — 대기 ${pending}개`;
  if (q.running && q.nextAt) {
    const remainMs = q.nextAt - Date.now();
    if (remainMs > 0) {
      const m = Math.floor(remainMs / 60000);
      const s = Math.floor((remainMs % 60000) / 1000);
      status += ` · 다음 발행까지 ${m}분 ${s}초`;
    }
  }
  $('queueStatus').textContent = status;
  $('queueStartBtn').classList.toggle('hidden', q.running);
  $('queueStopBtn').classList.toggle('hidden', !q.running);
  if (!queueSettingsLoaded || q.running) {
    $('queueInterval').value = q.intervalMin;
    $('alignToClock').checked = q.alignToClock;
    queueSettingsLoaded = true;
  }
  updateSchedulePreview(q);

  // 목록
  const ul = $('queueList');
  ul.innerHTML = '';
  if (!q.items.length) {
    ul.innerHTML = '<li class="empty">대기열이 비어 있습니다. ③ 탭에서 글을 생성해 추가하세요.</li>';
  }
  for (const item of q.items) {
    const li = document.createElement('li');
    const expanded = expandedItems.has(item.id);
    const head = item.content.split('\n')[0].slice(0, 40);
    const extra = [];
    if (item.comments?.length) extra.push(`댓글 ${item.comments.length}`);
    if (item.image) extra.push('🖼 이미지');
    if (item.topic) extra.push(`주제: ${item.topic}`);
    if (item.error) extra.push(item.error.slice(0, 60));

    const header = document.createElement('div');
    header.textContent = `${expanded ? '▾' : '▸'} ${STATUS_LABEL[item.status] || item.status} · ${head} ${extra.join(' · ')}`;
    li.appendChild(header);

    // 펼침 영역: 본문 + 연결 댓글을 블록별로 표시하고 각각 복사 버튼 제공
    if (expanded) {
      const detail = document.createElement('div');
      detail.className = 'queue-detail';
      detail.addEventListener('click', (e) => e.stopPropagation());
      if (item.error) { const error = document.createElement('p'); error.textContent = item.error; detail.append(error); }
      const url = item.postUrl || item.progress?.postUrl;
      if (url && /^https:\/\/(www\.)?threads\.(com|net)\//.test(url)) { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '게시된 글 확인'; detail.append(a); }
      if (item.progress?.completedComments?.length) { const p = document.createElement('p'); p.textContent = '등록 확인된 댓글: ' + item.progress.completedComments.join(', '); detail.append(p); }
      if (!q.running && ['pending', 'failed'].includes(item.status)) addQueueEditor(detail, item);

      const blocks = [{ label: '본문', text: item.content }];
      (item.comments || []).forEach((c, i) => blocks.push({ label: `연결 댓글 ${i + 1}`, text: c }));

      for (const b of blocks) {
        const block = document.createElement('div');
        block.className = 'detail-block';

        const head = document.createElement('div');
        head.className = 'detail-head';
        const title = document.createElement('span');
        title.textContent = `【${b.label}】 ${b.text.length}자`;
        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn secondary small';
        copyBtn.textContent = '복사';
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          copyText(b.text, copyBtn);
        });
        head.append(title, copyBtn);

        const body = document.createElement('div');
        body.className = 'detail-body';
        body.textContent = b.text;

        block.append(head, body);
        detail.appendChild(block);
      }

      // 첨부 이미지 지정 (대기 중인 항목만)
      if (item.status === 'pending' || item.status === 'failed') {
        const imgRow = document.createElement('div');
        imgRow.className = 'detail-image-row';

        const label = document.createElement('span');
        label.textContent = '🖼 첨부 이미지';

        const sel = document.createElement('select');
        sel.innerHTML = '<option value="">(없음)</option>';
        for (const f of availableImages) {
          const opt = document.createElement('option');
          opt.value = f.name;
          opt.textContent = f.name;
          if (f.name === item.image) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.addEventListener('click', (e) => e.stopPropagation());
        sel.addEventListener('change', async (e) => {
          e.stopPropagation();
          try {
            await postJson(`/api/queue/${item.id}/image`, { image: sel.value });
            showToast(sel.value ? `이미지 설정: ${sel.value}` : '이미지를 해제했습니다.');
            refreshQueue();
          } catch (err) {
            showToast(err.message, true);
          }
        });

        imgRow.append(label, sel);
        if (item.image) {
          const thumb = document.createElement('img');
          thumb.className = 'detail-thumb';
          thumb.src = `/api/images/${encodeURIComponent(item.image)}`;
          imgRow.appendChild(thumb);
        }
        detail.appendChild(imgRow);
      }

      // 전체 복사 (본문 + 댓글 한 번에)
      const allBtn = document.createElement('button');
      allBtn.className = 'btn secondary small';
      allBtn.textContent = '📋 전체 복사 (본문 + 댓글)';
      allBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const all = blocks.map((b) => `【${b.label}】\n${b.text}`).join('\n\n');
        copyText(all, allBtn, '📋 전체 복사 (본문 + 댓글)');
      });
      detail.appendChild(allBtn);

      li.appendChild(detail);
    }

    li.addEventListener('click', () => {
      if (expandedItems.has(item.id)) expandedItems.delete(item.id);
      else expandedItems.add(item.id);
      refreshQueue();
    });

    if (item.status !== 'publishing') {
      const del = document.createElement('button');
      del.className = 'btn secondary small';
      del.textContent = '삭제';
      del.style.marginTop = '6px';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch(`/api/queue/${item.id}`, { method: 'DELETE' });
        expandedItems.delete(item.id);
        refreshQueue();
      });
      li.appendChild(del);
    }
    ul.appendChild(li);
  }

  // 로그
  const logEl = $('queueLog');
  logEl.textContent = (q.logs || [])
    .map((l) => `[${new Date(l.t).toLocaleTimeString('ko-KR')}] ${l.msg}`)
    .join('\n');
  logEl.scrollTop = logEl.scrollHeight;

  // 자동 새로고침 (탭이 열려 있는 동안)
  // 글을 펼쳐 읽는 중에는 화면이 자꾸 다시 그려지지 않도록 주기를 늦춘다
  clearTimeout(queueTimer);
  if ($('tab-queue').classList.contains('active')) {
    const interval = expandedItems.size && !q.running ? 15000 : 3000;
    queueTimer = setTimeout(refreshQueue, interval);
  }
}

$('queueStartBtn').addEventListener('click', async () => {
  try {
    await postJson('/api/queue/start', {
      intervalMin: $('queueInterval').value,
      alignToClock: $('alignToClock').checked,
    });
    showToast('자동 발행이 시작되었습니다. 첫 글은 곧 발행됩니다.');
    refreshQueue();
  } catch (e) {
    showToast(e.message, true);
  }
});

$('queueStopBtn').addEventListener('click', async () => {
  await postJson('/api/queue/stop');
  showToast('자동 발행이 중지되었습니다.');
  refreshQueue();
});

$('queueRetryBtn').addEventListener('click', async () => {
  try {
    const r = await postJson('/api/queue/retry', {});
    showToast(`실패 항목 ${r.count}개를 대기 상태로 되돌렸습니다. "자동 발행 시작"을 누르세요.`);
    refreshQueue();
  } catch (e) {
    showToast(e.message, true);
  }
});

$('queueClearBtn').addEventListener('click', async () => {
  await postJson('/api/queue/clear-finished');
  refreshQueue();
});

// ---------- 📁 파일 보관함 ----------
let selectedFile = null;

async function loadFileList() {
  const type = $('fileType').value;
  const res = await fetch(`/api/files?type=${type}`);
  const files = await res.json();
  const ul = $('fileList');
  ul.innerHTML = '';
  selectedFile = null;
  $('fileViewName').textContent = '';
  $('fileViewContent').textContent = '파일을 선택하세요.';
  $('deleteFileBtn').classList.add('hidden');
  if (!files.length) {
    ul.innerHTML = '<li class="empty">파일이 없습니다.</li>';
    return;
  }
  for (const f of files) {
    const li = document.createElement('li');
    li.innerHTML = `${f.name}<span class="meta">${new Date(f.mtime).toLocaleString('ko-KR')} · ${(f.size / 1024).toFixed(1)}KB</span>`;
    li.addEventListener('click', async () => {
      ul.querySelectorAll('li').forEach((x) => x.classList.remove('selected'));
      li.classList.add('selected');
      const r = await fetch(`/api/file?type=${type}&name=${encodeURIComponent(f.name)}`);
      const data = await r.json();
      selectedFile = { type, name: f.name };
      $('fileViewName').textContent = f.name;
      $('fileViewContent').textContent = data.content || data.error;
      $('deleteFileBtn').classList.remove('hidden');
    });
    ul.appendChild(li);
  }
}

$('fileType').addEventListener('change', loadFileList);
$('refreshFilesBtn').addEventListener('click', loadFileList);

let deleteArmed = false;
let deleteArmTimer;

$('deleteFileBtn').addEventListener('click', async () => {
  if (!selectedFile) return;
  if (!deleteArmed) {
    deleteArmed = true;
    $('deleteFileBtn').textContent = '한 번 더 클릭하면 삭제';
    deleteArmTimer = setTimeout(() => {
      deleteArmed = false;
      $('deleteFileBtn').textContent = '삭제';
    }, 5000);
    return;
  }
  deleteArmed = false;
  clearTimeout(deleteArmTimer);
  $('deleteFileBtn').textContent = '삭제';
  await fetch(`/api/file?type=${selectedFile.type}&name=${encodeURIComponent(selectedFile.name)}`, { method: 'DELETE' });
  showToast('파일이 삭제되었습니다.');
  loadFileList();
});

// ---------- 초기화 ----------
const savedTopic = localStorage.getItem('threads_topic') ?? '유튜브';
$('topicInput').value = savedTopic;
$('autoTopic').value = savedTopic;
refreshSession();
refreshClipartSession();
loadImageOptions();
renderComments([]); // 직접 붙여넣을 수 있도록 빈 댓글 칸 1개 표시
loadFileOptions('crawls', 'analyzeSource');
loadFileOptions('analyses', 'generateSource');

function updateSchedulePreview(q) {
  const el = $('schedulePreview');
  if (!el) return;
  if (q?.running) { el.textContent = q.nextAt ? `다음 발행: ${new Date(q.nextAt).toLocaleString('ko-KR')}` : '현재 발행 처리 중'; return; }
  const minutes = Number($('queueInterval').value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) { el.textContent = '간격은 1~1440분으로 입력해 주세요.'; return; }
  const now = Date.now(), midnight = new Date().setHours(0, 0, 0, 0), step = minutes * 60000;
  const at = $('alignToClock').checked ? midnight + (Math.floor((now - midnight) / step) + 1) * step : now + 3000;
  el.textContent = `지금 시작하면 첫 발행: ${new Date(at).toLocaleString('ko-KR')} (${$('alignToClock').checked ? '정시 기준' : '시작 약 3초 후'}) · 서버 재시작 시 직접 다시 시작`;
}
$('queueInterval').addEventListener('input', () => updateSchedulePreview());
$('alignToClock').addEventListener('change', () => updateSchedulePreview());

function addQueueEditor(detail, item) {
  const edit = document.createElement('button'); edit.className = 'btn secondary small'; edit.textContent = '본문·댓글 편집';
  edit.onclick = () => {
    editingQueue = true; clearTimeout(queueTimer); edit.disabled = true;
    $('queueStartBtn').disabled = true;
    const form = document.createElement('div'); form.className = 'queue-editor';
    const fields = [item.content, ...(item.comments || [])].map((value, i) => {
      const label = document.createElement('label'); label.textContent = i ? `댓글 ${i}` : '본문';
      const input = document.createElement('textarea'); input.value = value; input.rows = 4; label.append(input); form.append(label); return input;
    });
    const add = document.createElement('button'); add.textContent = '댓글 추가'; add.className = 'btn secondary small';
    add.onclick = () => { if (fields.length >= 11) return showToast('댓글은 최대 10개입니다.', true); const label = document.createElement('label'); label.textContent = `댓글 ${fields.length}`; const input = document.createElement('textarea'); input.rows = 3; label.append(input); form.insertBefore(label, add); fields.push(input); };
    form.append(add);
    const topicLabel = document.createElement('label'); topicLabel.textContent = '커뮤니티 주제'; const topic = document.createElement('input'); topic.value = item.topic || ''; topicLabel.append(topic); form.append(topicLabel);
    const finish = () => { editingQueue = false; $('queueStartBtn').disabled = false; refreshQueue(); };
    const save = document.createElement('button'); save.className = 'btn primary small'; save.textContent = '저장';
    save.onclick = async () => { try { await postJson(`/api/queue/${item.id}/edit`, { content: fields[0].value, comments: fields.slice(1).map(f => f.value).filter(v => v.trim()), topic: topic.value }); finish(); } catch (e) { showToast(e.message, true); } };
    const cancel = document.createElement('button'); cancel.className = 'btn secondary small'; cancel.textContent = '취소'; cancel.onclick = finish;
    form.append(save, cancel); detail.append(form);
  };
  detail.append(edit);
  if (item.status === 'pending') for (const [direction, name] of [[-1, '위로'], [1, '아래로']]) {
    const button = document.createElement('button'); button.className = 'btn secondary small'; button.textContent = name;
    button.onclick = async () => { try { await postJson(`/api/queue/${item.id}/move`, { direction }); refreshQueue(); } catch (e) { showToast(e.message, true); } }; detail.append(button);
  }
}

async function refreshConnections() {
  try { const data = await (await fetch('/api/connections')).json();
    $('connectionSummary').textContent = `스레드: ${data.threads.lastCheck?.label || data.threads.label} · AI: ${data.ai.label} · 이미지: ${data.clipart.label} · ${data.browser.label}`;
  } catch { $('connectionSummary').textContent = '서버 연결을 확인해 주세요.'; }
}
$('checkConnectionBtn').onclick = async () => {
  const button = $('checkConnectionBtn'); button.disabled = true; button.textContent = '확인 중…';
  try { const { jobId } = await postJson('/api/connections/threads'); await pollJob(jobId, { onDone: r => showToast(r.label), onError: e => showToast(e, true) }); await refreshConnections(); }
  catch (e) { showToast(e.message, true); }
  finally { button.disabled = false; button.textContent = '스레드 연결 확인'; }
};
refreshConnections();

$('checkAiBtn').onclick = async () => {
  const button = $('checkAiBtn'); button.disabled = true;
  try { const { jobId } = await postJson('/api/connections/ai'); await pollJob(jobId, { onDone: r => showToast(r.label), onError: e => showToast(e, true) }); await refreshConnections(); }
  catch (e) { showToast(e.message, true); }
  finally { button.disabled = false; }
};
