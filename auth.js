import { signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import { auth } from './firebase-config.js';

const provider = new GoogleAuthProvider();
// Drive 읽기 권한 — Google Picker 폴더 탐색용
provider.addScope('https://www.googleapis.com/auth/drive.readonly');
// Drive 파일 생성 권한 — 구글시트 생성용
provider.addScope('https://www.googleapis.com/auth/drive.file');

/** Google OAuth access token (Sheets API용) */
let googleAccessToken = null;
let tokenExpiresAt = 0;

export function getGoogleAccessToken() {
    if (googleAccessToken && Date.now() > tokenExpiresAt) {
        googleAccessToken = null;
    }
    return googleAccessToken;
}

export const signInWithGoogle = async () => {
    try {
        const result = await signInWithPopup(auth, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        googleAccessToken = credential?.accessToken || null;
        tokenExpiresAt = Date.now() + 50 * 60 * 1000;
        console.log(`[AUTH SUCCESS] 로그인 성공: ${result.user.email}`);
        return result.user;
    } catch (error) {
        console.error('[AUTH ERROR]', error.code, error.message);
        throw error;
    }
};

export const logout = async () => {
    try {
        await signOut(auth);
        console.log('[AUTH SUCCESS] 로그아웃 완료');
    } catch (error) {
        console.error('[AUTH ERROR] 로그아웃 실패:', error);
        throw error;
    }
};
