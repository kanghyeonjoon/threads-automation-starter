/**
 * 긴 초안을 스레드 연속 게시용 토막으로 나눈다.
 *
 * - 초안에 `1/8`, `2/8` 같은 번호 마커가 있으면 그 경계를 존중하고 마커는 제거한다.
 *   (스레드가 포스트 순번을 자체 표시하므로 본문에 남기면 번호가 두 번 보인다)
 * - 마커가 없으면 빈 줄로 나뉜 문단을 LIMIT자 이하로 묶는다.
 * - 토막 안의 줄바꿈은 그대로 보존한다. 짧은 줄이 계단처럼 쌓이는 게 이 형식의 맛이다.
 */

/** 스레드 포스트 하나의 글자 상한 */
export const LIMIT = 500;

/** 줄 하나가 통째로 "3/8" 형태인 경우만 마커로 본다. **굵게**·공백은 허용. */
const MARKER_RE = /^\s*(?:\*\*|__)?\s*\d{1,3}\s*\/\s*\d{1,3}\s*(?:\*\*|__)?\s*[.)]?\s*$/;

const isMarker = (line) => MARKER_RE.test(line);

/** 토막 안에 남은 번호 마커 줄을 제거한다. */
export function stripMarkers(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((ln) => !isMarker(ln))
    .join('\n')
    .trim();
}

/** `n/N` 마커가 2개 이상이면 그 경계로 자른다. 없으면 null. */
function splitByMarkers(text) {
  const lines = text.split('\n');
  const idx = [];
  lines.forEach((ln, i) => {
    if (isMarker(ln)) idx.push(i);
  });
  if (idx.length < 2) return null;

  const chunks = [];
  // 첫 마커 앞에 본문이 있으면 그것도 첫 토막이다.
  const head = lines.slice(0, idx[0]).join('\n').trim();
  if (head) chunks.push(head);

  const bounds = [...idx, lines.length];
  for (let i = 0; i < bounds.length - 1; i++) {
    const body = lines.slice(bounds[i] + 1, bounds[i + 1]).join('\n').trim();
    if (body) chunks.push(body);
  }
  return chunks.length ? chunks : null;
}

/** 문장 끝(. ! ? …) 뒤에서 자른다. 그래도 안 되면 글자수로. */
function splitSentences(line, limit) {
  const parts = line.split(/(?<=[.!?…])\s+/);
  const out = [];
  let buf = '';
  for (let s of parts) {
    const cand = buf ? `${buf} ${s}`.trim() : s;
    if (cand.length <= limit) {
      buf = cand;
    } else {
      if (buf) out.push(buf);
      while (s.length > limit) {
        out.push(s.slice(0, limit));
        s = s.slice(limit);
      }
      buf = s;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** 한 문단이 limit를 넘으면 줄 단위로, 그래도 넘으면 문장 단위로 쪼갠다. */
function splitLongParagraph(para, limit) {
  const out = [];
  let buf = '';
  for (const u of para.split('\n')) {
    const pieces = u.length <= limit ? [u] : splitSentences(u, limit);
    for (const piece of pieces) {
      const cand = buf ? `${buf}\n${piece}` : piece;
      if (cand.length <= limit) {
        buf = cand;
      } else {
        if (buf) out.push(buf);
        buf = piece;
      }
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** 빈 줄로 나뉜 문단을 limit자 이하로 묶는다. */
function splitByParagraphs(text, limit) {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    const cand = buf ? `${buf}\n\n${p}` : p;
    if (cand.length <= limit) {
      buf = cand;
    } else {
      if (buf) chunks.push(buf);
      if (p.length <= limit) {
        buf = p;
      } else {
        buf = '';
        chunks.push(...splitLongParagraph(p, limit));
      }
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/**
 * 초안을 토막 배열로 나눈다.
 * @returns {string[]} 첫 번째가 본문, 나머지가 연결 글
 */
export function splitDraft(text, limit = LIMIT) {
  const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!src) return [];

  let chunks = splitByMarkers(src) ?? splitByParagraphs(src, limit);
  chunks = chunks.map(stripMarkers).filter(Boolean);

  // 마커 경계를 존중했더라도 상한을 넘는 토막은 한 번 더 쪼갠다.
  const final = [];
  for (const c of chunks) {
    if (c.length <= limit) final.push(c);
    else final.push(...splitLongParagraph(c, limit));
  }
  return final;
}

/**
 * 발행 직전 검사. 브라우저를 띄우기 전에 걸러내기 위한 것.
 * @returns {{index:number, chars:number}[]} 상한을 넘은 토막들 (1부터 시작)
 */
export function findOverLimit(chunks, limit = LIMIT) {
  return chunks
    .map((c, i) => ({ index: i + 1, chars: String(c ?? '').length }))
    .filter((x) => x.chars > limit);
}

/** 본문+연결글 전체를 발행용으로 정리한다. 마커 제거 + 빈 항목 제거. */
export function prepareForPublish(content, comments = []) {
  const body = stripMarkers(content);
  const cards = (Array.isArray(comments) ? comments : [])
    .map(stripMarkers)
    .filter(Boolean);
  return { content: body, comments: cards };
}
