// 자주 쓰는 문구 — 전 직원 공유(Firestore message_templates). 과거엔 localStorage(개인 단말)라
// 다른 사람·다른 브라우저에서 안 보였음 → 공유 DB로 이전(2026-07-04). 같은 제목이면 덮어쓴다.
import { collection, getDocs, doc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from '../../firebase-config.js';

const COLL = 'message_templates';
const LEGACY_KEY = 'dsc-message-templates';
const MIGRATED_KEY = 'dsc-message-templates-migrated';

// 모듈 레벨 캐시(stale-while-revalidate) — 탭 전환·재마운트마다 Firestore 왕복을 기다리지
// 않도록, 마지막으로 받은 목록을 즉시 보여주고 새로고침은 백그라운드에서 구독자에게 통지한다.
let cache = null;
const subscribers = new Set();

function setCache(list) {
  cache = list;
  for (const fn of subscribers) fn(list);
}

// 네트워크를 기다리지 않는 동기 조회 — 캐시가 아직 없으면 빈 배열(첫 로딩 화면과 동일 취급).
export function getCachedTemplates() {
  return cache ?? [];
}

// loadTemplates()가 갱신될 때마다(마운트·refresh·저장·삭제) 호출된다. 구독 해제 함수를 반환.
export function subscribeTemplates(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// 제목이 곧 문서 id — 금지문자('/')는 전각 치환, 예약 id('.', '..', '__x__')는 접두사로 회피.
// 같은 제목=덮어쓰기 규약 유지(표시는 data.title 기준이라 id 변형은 보이지 않음).
function idOf(title) {
  const s = title.replaceAll('/', '／');
  return (/^\.\.?$/.test(s) || /^__.*__$/.test(s)) ? `t_${s}` : s;
}

async function writeTemplate(title, content) {
  await setDoc(doc(db, COLL, idOf(title)), {
    title,
    content,
    updated_by: auth.currentUser?.email ?? null,
    updated_at: serverTimestamp(),
  });
}

export async function loadTemplates() {
  const snap = await getDocs(collection(db, COLL));
  const list = snap.docs.map((d) => {
    const x = d.data();
    return { title: x.title ?? d.id, content: x.content ?? '', updatedAtMs: x.updated_at?.toMillis?.() ?? 0 };
  });
  list.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  setCache(list);
  return list;
}

export async function saveTemplate(title, content) {
  const name = String(title ?? '').trim();
  if (name && String(content ?? '').trim()) await writeTemplate(name, content);
  return loadTemplates();
}

export async function deleteTemplate(title) {
  const name = String(title ?? '').trim();
  if (name) await deleteDoc(doc(db, COLL, idOf(name)));
  return loadTemplates();
}

// 개인 단말(localStorage)에 저장돼 있던 기존 템플릿을 공유 DB로 1회 이관.
// DB에 같은 제목이 있으면 DB 우선(이관 생략). 실패해도 화면 동작엔 영향 없다.
export async function migrateLegacyTemplates() {
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return;
    const raw = localStorage.getItem(LEGACY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr) && arr.length) {
      const existing = new Set((await loadTemplates()).map((t) => t.title));
      for (const t of arr) {
        const name = String(t?.title ?? '').trim();
        if (name && String(t?.content ?? '').trim() && !existing.has(name)) {
          await writeTemplate(name, t.content);
        }
      }
    }
    localStorage.setItem(MIGRATED_KEY, '1');
  } catch {
    // 프라이빗 모드·권한 오류 등 — 이관은 편의 기능이라 조용히 건너뛴다.
  }
}
