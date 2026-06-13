// 인원현황 권한 (학원 기밀) — SSoT는 HR_users(impact7HR 임팩트7설정-권한설정).
// all = 전체 집계(재원생 총원 등), classCounts = 반별 인원. 문서가 없거나 읽기 거부면 차단.
import { doc, getDoc } from 'firebase/firestore';
import { db, dataAuthReady } from './firebase-config.js';

export async function fetchPopulationPerms(uid) {
    try {
        await dataAuthReady(); // dataApp auth 미러 완료 전 읽으면 unauthenticated로 거부됨
        const snap = await getDoc(doc(db, 'HR_users', uid));
        if (snap.exists()) {
            const d = snap.data();
            const all = d.role === 'owner' || d.role === 'principal'
                || d.permissions?.canViewPopulationStats === true;
            return { all, classCounts: all || d.permissions?.canViewClassCounts === true };
        }
    } catch (e) {
        console.warn('[PERMS] population perms load failed:', e.code || e.message);
    }
    return { all: false, classCounts: false };
}

// AI 일괄 생성(비용 발생) 권한 — HR_users/{uid}.role 이 owner/principal/director 일 때만 true.
// state.currentRole(user_settings의 자유텍스트 role)과는 무관 — HR_users.role을 직접 읽는다.
export async function fetchAiBatchPerm(uid) {
    try {
        await dataAuthReady(); // dataApp auth 미러 완료 전 읽으면 unauthenticated로 거부됨
        const snap = await getDoc(doc(db, 'HR_users', uid));
        if (snap.exists()) {
            return ['owner', 'principal', 'director'].includes(snap.data().role);
        }
    } catch (e) {
        console.warn('[PERMS] ai batch perm load failed:', e.code || e.message);
    }
    return false;
}
