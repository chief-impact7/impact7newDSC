import { signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import { auth } from './firebase-config.js';

const provider = new GoogleAuthProvider();

export const signInWithGoogle = async () => {
    try {
        const result = await signInWithPopup(auth, provider);
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
