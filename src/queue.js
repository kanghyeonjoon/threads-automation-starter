import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR, IMAGES_DIR } from './files.js';
import { prepareForPublish, findOverLimit } from './split.js';
import { publishPost } from './publisher.js';

const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');

const state = {
  items: [],        // { id, content, comments, topic, status: pending|publishing|done|failed, error, addedAt, publishedAt }
  running: false,
  intervalMin: 60,
  alignToClock: true,  // 정시(:00)에 맞춰 발행. 60분 간격이면 1시·2시·3시…
  nextAt: null,
  logs: [],
};
let timer = null;

function log(msg) {
  state.logs.push({ t: Date.now(), msg });
  if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300);
  console.log(`[자동발행] ${msg}`);
}

const BACKUP_FILE = `${QUEUE_FILE}.bak`;

/**
 * 원자적 저장: 임시 파일에 쓴 뒤 교체.
 * 쓰기 도중 중단되어도 기존 파일이나 백업이 남아 대기열이 유실되지 않는다.
 */
function save() {
  const payload = JSON.stringify(
    { items: state.items, intervalMin: state.intervalMin, alignToClock: state.alignToClock },
    null,
    2
  );
  const tmp = `${QUEUE_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, payload, 'utf-8');
    if (fs.existsSync(QUEUE_FILE)) fs.copyFileSync(QUEUE_FILE, BACKUP_FILE);
    fs.renameSync(tmp, QUEUE_FILE);
  } catch (e) {
    throw new Error('대기열 저장 실패: ' + e.message);
  }
}

export function loadQueue() {
  for (const file of [QUEUE_FILE, BACKUP_FILE]) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      state.items = Array.isArray(data.items) ? data.items : [];
      if (data.intervalMin) state.intervalMin = data.intervalMin;
      if (typeof data.alignToClock === 'boolean') state.alignToClock = data.alignToClock;
      // 불확실한 이전 발행은 재시도하지 않고 검토 대상으로 격리
      for (const it of state.items) {
        if (it.status === 'pending' && !it.progress) it.progress = { stage: 'prepared', completedComments: [] };
        if (it.status === 'publishing' || (it.status === 'failed' && !it.progress)) {
          it.status = 'review';
          it.error = '이전 발행 결과를 확인해야 합니다. 중복 방지를 위해 재시도를 차단했습니다. ' + (it.error || '');
        }
      }
      const pending = state.items.filter((i) => i.status === 'pending').length;
      if (state.items.length) {
        console.log(`[자동발행] 대기열 복원됨 — 전체 ${state.items.length}개 (대기 ${pending}개)${file === BACKUP_FILE ? ' [백업에서 복구]' : ''}`);
      }
      return;
    } catch { /* 다음 후보(백업) 시도 */ }
  }
}

export function getQueue() {
  return {
    items: state.items,
    running: state.running,
    intervalMin: state.intervalMin,
    alignToClock: state.alignToClock,
    nextAt: state.nextAt,
    logs: state.logs.slice(-60),
  };
}

export function addItem({ content, comments = [], topic = '', image = '' }) {
  if (state.items.some(i => ['pending', 'publishing', 'review', 'done'].includes(i.status) && i.content === content && JSON.stringify(i.comments || []) === JSON.stringify(comments))) throw new Error('같은 본문과 댓글이 이미 대기열 또는 발행 기록에 있습니다. 기존 항목을 확인해 주세요.');
  const item = {
    id: randomUUID(),
    content,
    comments,
    topic,
    image,
    progress: { stage: 'prepared', completedComments: [] },
    status: 'pending',
    error: null,
    addedAt: Date.now(),
    publishedAt: null,
  };
  state.items.push(item);
  save();
  log(`대기열에 추가됨 (${state.items.filter((i) => i.status === 'pending').length}개 대기 중)`);
  return item;
}

export function removeItem(id) {
  const idx = state.items.findIndex((i) => i.id === id);
  if (idx === -1) throw new Error('항목을 찾을 수 없습니다.');
  if (state.items[idx].status === 'publishing') throw new Error('지금 발행 중인 항목은 삭제할 수 없습니다.');
  state.items.splice(idx, 1);
  save();
}

export function clearFinished() {
  state.items = state.items.filter((i) => i.status !== 'done');
  save();
}

/** 대기 중인 항목의 첨부 이미지를 변경한다 (빈 문자열이면 이미지 제거) */
export function setItemImage(id, image) {
  const item = state.items.find((i) => i.id === id);
  if (!item) throw new Error('항목을 찾을 수 없습니다.');
  if (state.running || !['pending', 'failed'].includes(item.status)) throw new Error('자동 발행을 중지한 뒤 미발행 항목만 수정할 수 있습니다.');
  item.image = image || '';
  save();
  log(`이미지 ${image ? `설정: ${image}` : '해제'} (${item.content.split('\n')[0].slice(0, 20)}...)`);
  return item;
}

/** 실패한 항목을 다시 대기 상태로 되돌린다 (id 생략 시 모든 실패 항목) */
export function retryItems(id) {
  if (state.running) throw new Error('자동 발행을 중지한 뒤 재시도해 주세요.');
  const targets = id
    ? state.items.filter((i) => i.id === id && i.status === 'failed' && i.progress?.stage === 'prepared')
    : state.items.filter((i) => i.status === 'failed' && i.progress?.stage === 'prepared');
  if (!targets.length) throw new Error('다시 시도할 실패 항목이 없습니다.');
  for (const it of targets) {
    it.status = 'pending';
    it.error = null;
  }
  save();
  log(`실패 항목 ${targets.length}개를 대기 상태로 되돌렸습니다.`);
  return targets.length;
}

/**
 * 자정 기준으로 intervalMin 의 배수가 되는 다음 시각을 구한다.
 * 60분이면 매 정시(1:00, 2:00…), 30분이면 :00 과 :30, 15분이면 :00 :15 :30 :45.
 * @returns {number} 그 시각의 타임스탬프
 */
export function nextAlignedTime(intervalMin, from = Date.now()) {
  const step = Math.max(1, Number(intervalMin) || 60) * 60 * 1000;
  const d = new Date(from);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const passed = from - midnight;
  const next = midnight + (Math.floor(passed / step) + 1) * step;
  return next;
}

function scheduleNext(delayMs) {
  clearTimeout(timer);
  state.nextAt = Date.now() + delayMs;
  timer = setTimeout(tick, delayMs);
}

export function startQueue(intervalMin, opts = {}) {
  if (state.items.some(i => i.status === 'publishing')) throw new Error('현재 발행이 끝난 뒤 시작해 주세요.');
  if (!Number.isInteger(Number(intervalMin)) || Number(intervalMin) < 1 || Number(intervalMin) > 1440) throw new Error('발행 간격은 1~1440분의 정수여야 합니다.');
  if (state.running) throw new Error('이미 자동 발행이 실행 중입니다.');
  const pending = state.items.filter((i) => i.status === 'pending');
  if (!pending.length) throw new Error('대기열에 발행할 글이 없습니다. 먼저 글을 추가해 주세요.');
  state.intervalMin = Math.max(1, Number(intervalMin) || 60);
  if (typeof opts.alignToClock === 'boolean') state.alignToClock = opts.alignToClock;
  state.running = true;
  save();

  if (state.alignToClock) {
    // 정시 발행: 첫 글도 다음 정시까지 기다린다
    const at = nextAlignedTime(state.intervalMin);
    const when = new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    const mins = Math.round((at - Date.now()) / 60000);
    log(`자동 발행 시작 — ${pending.length}개 글, 정시 발행(${state.intervalMin}분 간격). 첫 글은 ${when} (약 ${mins}분 후)`);
    scheduleNext(Math.max(1000, at - Date.now()));
    return getQueue();
  }

  log(`자동 발행 시작 — ${pending.length}개 글, ${state.intervalMin}분 간격 (첫 글은 즉시 발행)`);
  scheduleNext(3000); // 첫 글은 3초 후 바로 발행
}

export function stopQueue() {
  clearTimeout(timer);
  timer = null;
  state.running = false;
  state.nextAt = null;
  log('자동 발행이 중지되었습니다.');
}

async function tick() {
  if (!state.running) return;
  const item = state.items.find((i) => i.status === 'pending');
  if (!item) {
    log('대기열의 모든 글이 처리되어 자동 발행을 종료합니다.');
    state.running = false;
    state.nextAt = null;
    return;
  }

  state.nextAt = null;
  try { await publishItem(item.id); } catch (e) { log(e.message); }

  const remaining = state.items.some((i) => i.status === 'pending');
  if (remaining && state.running) {
    if (state.alignToClock) {
      const at = nextAlignedTime(state.intervalMin);
      const when = new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      log(`다음 발행은 ${when} 입니다 (정시 발행).`);
      scheduleNext(Math.max(1000, at - Date.now()));
    } else {
      log(`다음 발행은 ${state.intervalMin}분 후입니다.`);
      scheduleNext(state.intervalMin * 60 * 1000);
    }
  } else {
    state.running = false;
    state.nextAt = null;
    log('대기열의 모든 글이 처리되었습니다. 자동 발행 종료.');
  }
}

export function updateItem(id, changes) {
  if (state.running) throw new Error('자동 발행을 중지한 뒤 편집해 주세요.');
  const item = state.items.find(i => i.id === id);
  if (!item || !['pending', 'failed'].includes(item.status) || item.progress?.stage !== 'prepared') throw new Error('미발행 항목만 편집할 수 있습니다.');
  if (typeof changes.content !== 'string' || !Array.isArray(changes.comments) || changes.comments.some(c => typeof c !== 'string') || changes.comments.length > 10) throw new Error('본문과 최대 10개의 댓글을 입력해 주세요.');
  const prepared = prepareForPublish(changes.content, changes.comments);
  if (!prepared.content || findOverLimit([prepared.content, ...prepared.comments]).length) throw new Error('본문을 입력하고 각 장을 500자 이하로 작성해 주세요.');
  if (state.items.some(i => i.id !== id && ['pending', 'publishing', 'review', 'done'].includes(i.status) && i.content === prepared.content && JSON.stringify(i.comments || []) === JSON.stringify(prepared.comments))) throw new Error('같은 글이 이미 대기열 또는 발행 기록에 있습니다.');
  Object.assign(item, prepared, { topic: String(changes.topic || '').trim() });
  save();
  return item;
}

export function moveItem(id, direction) {
  if (state.running || state.items.some(i => i.status === 'publishing')) throw new Error('발행을 중지한 뒤 순서를 바꿔 주세요.');
  if (![1, -1].includes(direction)) throw new Error('잘못된 이동 방향입니다.');
  const pending = state.items.filter(i => i.status === 'pending');
  const at = pending.findIndex(i => i.id === id);
  if (at < 0 || !pending[at + direction]) throw new Error('더 이동할 수 없습니다.');
  const a = state.items.indexOf(pending[at]), b = state.items.indexOf(pending[at + direction]);
  [state.items[a], state.items[b]] = [state.items[b], state.items[a]];
  save();
}

export async function publishItem(id, publisher = publishPost) {
  if (state.items.some(i => i.status === 'publishing')) throw new Error('다른 글을 발행 중입니다.');
  const item = state.items.find(i => i.id === id);
  if (!item || item.status !== 'pending') throw new Error('대기 중인 글만 발행할 수 있습니다.');
  item.status = 'publishing';
  save();
  try {
    const result = await publisher({ content: item.content, comments: item.comments, topic: item.topic,
      imagePath: item.image ? path.join(IMAGES_DIR, item.image) : '', log,
      onProgress: async patch => { item.progress = { ...item.progress, ...patch }; save(); },
    });
    item.status = 'done';
    item.postUrl = result?.postUrl || item.progress?.postUrl;
    item.publishedAt = Date.now();
    item.error = null;
  } catch (e) {
    item.status = item.progress?.stage === 'prepared' ? 'failed' : 'review';
    item.error = e.message;
    save();
    throw e;
  }
  save();
  return item;
}
