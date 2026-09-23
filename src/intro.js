/**
 * 첫 카드 자기소개 문구를 A ↔ B로 자동 교대시킨다.
 *
 * 페르소나 파일(§8)에도 "직전 사용" 줄이 있지만 사람이 손으로 고쳐야 해서,
 * 앱으로 뽑을 때는 늘 같은 문구가 나왔다. 여기서 상태를 직접 들고 돌린다.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './files.js';

const STATE_FILE = path.join(DATA_DIR, 'intro-state.json');

export const INTROS = {
  A: {
    key: 'A',
    label: '유튜브 PD',
    line: '현직 유튜브 PD인데,',
    variant: '현직 유튜브 PD인데,',
  },
  B: {
    key: 'B',
    label: '전문직 마케팅 PD',
    line: '현직 전문직 마케팅 PD인데,',
    variant: '현직 전문직 마케팅 PD인데,',
  },
};

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return j && (j.lastUsed === 'A' || j.lastUsed === 'B') ? j : null;
  } catch {
    return null;
  }
}

function write(lastUsed) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ lastUsed, updatedAt: Date.now() }, null, 2),
      'utf-8'
    );
  } catch { /* 상태 저장 실패해도 생성은 계속한다 */ }
}

/** 이번에 써야 할 자기소개. 직전이 A였으면 B. */
export function nextIntro() {
  const s = read();
  const key = s?.lastUsed === 'A' ? 'B' : 'A';
  return INTROS[key];
}

/** 생성이 끝난 뒤 호출해서 교대 상태를 넘긴다. */
export function commitIntro(key) {
  if (key === 'A' || key === 'B') write(key);
}

/** 현재 상태 조회 (UI 표시용) */
export function introStatus() {
  const s = read();
  const next = nextIntro();
  return {
    lastUsed: s?.lastUsed ?? null,
    lastLabel: s ? INTROS[s.lastUsed].label : null,
    next: next.key,
    nextLabel: next.label,
    nextLine: next.line,
  };
}

/** 원하는 쪽으로 직접 맞춘다 (다음 글이 key 로 나오게 한다) */
export function forceNext(key) {
  if (key !== 'A' && key !== 'B') throw new Error('A 또는 B만 지정할 수 있습니다.');
  write(key === 'A' ? 'B' : 'A'); // 직전을 반대로 두면 다음이 key 가 된다
  return introStatus();
}

/** 생성된 본문이 지정한 자기소개로 시작하는지 확인한다. */
export function startsWithIntro(text, intro) {
  const head = String(text ?? '').trim().split('\n').slice(0, 2).join(' ');
  const keywords = intro.key === 'A'
    ? ['현직 유튜브 PD', '전문직 채널만 만지는 PD']
    : ['현직 전문직 마케팅 PD', '전문직 마케팅하는 PD'];
  return keywords.some((k) => head.includes(k));
}
