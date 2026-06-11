// 인원현황 권한 (학원 기밀) — SSoT는 HR_users(impact7HR 임팩트7설정-권한설정).
// all = 전체 집계(재원생 총원 등), classCounts = 반별 인원. 문서가 없거나 읽기 거부면 차단.
import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase-config.js';

export async function fetchPopulationPerms(uid) {
    try {
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
