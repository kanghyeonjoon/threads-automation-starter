import fs from 'fs';
import path from 'path';
import { FILE_TYPES } from './files.js';

const IDEAS_DIR = FILE_TYPES.ideas;
const USED_FILE = path.join(IDEAS_DIR, 'used.json');

/** ideas 폴더의 모든 md에서 "### N. 제목" + "> 인용문" 형식의 글감을 파싱 */
export function loadIdeas() {
  const ideas = [];
  if (!fs.existsSync(IDEAS_DIR)) return ideas;
  // 맥(NFD)과 윈도우(NFC)가 같은 이름을 다르게 돌려주므로 통일한다
  const files = fs
    .readdirSync(IDEAS_DIR)
    .map((f) => f.normalize('NFC'))
    .filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(IDEAS_DIR, file), 'utf-8');
    const regex = /###\s*(\d+)\.\s*([^\n]+)\n((?:>[^\n]*\n?)+)/g;
    let m;
    while ((m = regex.exec(content)) !== null) {
      const text = m[3]
        .split('\n')
        .map((l) => l.replace(/^>\s?/, '').trim())
        .filter(Boolean)
        .join('\n');
      if (text.length < 10) continue;
      ideas.push({
        id: `${file}#${m[1]}`,
        num: Number(m[1]),
        title: m[2].trim(),
        text,
        file,
      });
    }
  }
  return ideas;
}

function loadUsed() {
  try {
    const arr = JSON.parse(fs.readFileSync(USED_FILE, 'utf-8'));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

export function markUsed(ids) {
  const used = loadUsed();
  for (const id of ids) used.add(id);
  fs.writeFileSync(USED_FILE, JSON.stringify([...used], null, 2), 'utf-8');
}

export function resetUsed() {
  try {
    fs.unlinkSync(USED_FILE);
  } catch { /* 없으면 무시 */ }
}

export function ideasStatus() {
  const ideas = loadIdeas();
  const used = loadUsed();
  // 파일별 현황도 함께 — UI에서 글감 묶음을 골라 쓸 수 있게
  const byFile = {};
  for (const i of ideas) {
    const f = (byFile[i.file] ??= { file: i.file, total: 0, used: 0, remaining: 0 });
    f.total += 1;
    if (used.has(i.id)) f.used += 1;
    else f.remaining += 1;
  }
  return {
    total: ideas.length,
    used: ideas.filter((i) => used.has(i.id)).length,
    remaining: ideas.filter((i) => !used.has(i.id)).length,
    files: Object.values(byFile),
  };
}

/**
 * 미사용 글감에서 count개 선택.
 * @param mode 'order' 순서대로 | 'random' 무작위
 * @param sourceFile 특정 글감 파일로 한정 (비우면 전체)
 */
export function pickIdeas(count, mode = 'order', sourceFile = '') {
  const ideas = loadIdeas();
  const used = loadUsed();
  let unused = ideas.filter((i) => !used.has(i.id));
  if (sourceFile) unused = unused.filter((i) => i.file === sourceFile);
  if (!unused.length) return [];
  if (mode === 'random') {
    const shuffled = [...unused].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }
  // 순서대로: 파일 안에서는 번호순으로 뽑는다
  return [...unused].sort((a, b) => a.num - b.num).slice(0, count);
}
