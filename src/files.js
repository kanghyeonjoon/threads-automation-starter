import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.THREADS_DATA_DIR ? path.resolve(process.env.THREADS_DATA_DIR) : path.join(__dirname, '..', 'data');
export const AUTH_DIR = path.join(DATA_DIR, 'auth');
export const SESSION_FILE = path.join(AUTH_DIR, 'threads-session.json');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');

export const FILE_TYPES = {
  crawls: path.join(DATA_DIR, 'crawls'),
  analyses: path.join(DATA_DIR, 'analyses'),
  generated: path.join(DATA_DIR, 'generated'),
  persona: path.join(DATA_DIR, 'persona'),
  ideas: path.join(DATA_DIR, 'ideas'),
};

export function ensureDirs() {
  for (const dir of [DATA_DIR, AUTH_DIR, IMAGES_DIR, ...Object.values(FILE_TYPES)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// 초 단위까지 포함한 타임스탬프 → 같은 작업을 반복해도 파일명이 겹치지 않음
export function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function sanitizeName(s) {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'untitled';
}

export function saveMd(type, baseName, content) {
  const dir = FILE_TYPES[type];
  if (!dir) throw new Error(`알 수 없는 파일 타입: ${type}`);
  const fileName = `${sanitizeName(baseName)}_${timestamp()}.md`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content, 'utf-8');
  return fileName;
}

export function listMd(type) {
  const dir = FILE_TYPES[type];
  if (!dir) throw new Error(`알 수 없는 파일 타입: ${type}`);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    // 맥은 한글 파일명을 NFD 로 돌려준다. 윈도우(NFC)와 섞이면 이름이 안 맞으므로 통일한다.
    .map((f) => f.normalize('NFC'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function readMd(type, name) {
  const dir = FILE_TYPES[type];
  if (!dir) throw new Error(`알 수 없는 파일 타입: ${type}`);
  // 경로 탈출 방지
  const safe = path.basename(name);
  const filePath = path.join(dir, safe);
  if (!fs.existsSync(filePath)) throw new Error(`파일을 찾을 수 없습니다: ${safe}`);
  return fs.readFileSync(filePath, 'utf-8');
}

export function deleteMd(type, name) {
  const dir = FILE_TYPES[type];
  if (!dir) throw new Error(`알 수 없는 파일 타입: ${type}`);
  const safe = path.basename(name);
  const filePath = path.join(dir, safe);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

export function hasSession() {
  return fs.existsSync(SESSION_FILE);
}

export function sessionInfo() {
  if (!hasSession()) return { exists: false };
  const st = fs.statSync(SESSION_FILE);
  return { exists: true, savedAt: st.mtimeMs };
}
