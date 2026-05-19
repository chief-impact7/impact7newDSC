import { signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import { auth } from './firebase-config.js';

const provider = new GoogleAuthProvider();
// Drive 읽기 권한 — Google Picker 폴더 탐색용
provider.addScope('https://www.googleapis.com/auth/drive.readonly');
// Drive 파일 생성 권한 — 구글시트 생성용
provider.addScope('https://www.googleapis.com/auth/drive.file');

const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';
const STORAGE_KEY = 'impact7dsc_google_token';
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

/** Google OAuth access token (Drive Picker / Sheets API용) */
let googleAccessToken = null;
let tokenExpiresAt = 0;
let _gisTokenClient = null;

function _saveToStorage(token, expiresAt) {
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token, expiresAt }));
    } catch {}
}

function _clearStorage() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
}

function _restoreFromStorage() {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const { token, expiresAt } = JSON.parse(raw);
        if (token && expiresAt > Date.now() + 60_000) {
            googleAccessToken = token;
            tokenExpiresAt = expiresAt;
        }
    } catch {}
}
// 페이지 로드 시 sessionStorage에서 복원
_restoreFromStorage();

function _setToken(token, lifetimeSeconds) {
    googleAccessToken = token;
    // Google OAuth token은 보통 3600초 만료 — 만료 60초 전 무효화
    tokenExpiresAt = Date.now() + (lifetimeSeconds - 60) * 1000;
    _saveToStorage(token, tokenExpiresAt);
}

export function getGoogleAccessToken() {
    if (googleAccessToken && Date.now() < tokenExpiresAt) return googleAccessToken;
    googleAccessToken = null;
    tokenExpiresAt = 0;
    return null;
}

function _initGisTokenClient() {
    if (_gisTokenClient || !CLIENT_ID) return _gisTokenClient;
    if (typeof google === 'undefined' || !google.accounts?.oauth2) return null;
    _gisTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: () => {}, // 호출 시점에 동적으로 교체
    });
    return _gisTokenClient;
}

/**
 * GIS silent refresh — prompt 없이 토큰 재발급.
 * 사용자가 이미 동의했고 Google 세션이 활성이면 팝업 없이 성공.
 */
function _silentRefresh() {
    const client = _initGisTokenClient();
    if (!client) return Promise.resolve(null);
    return new Promise(resolve => {
        client.callback = (resp) => {
            if (resp?.access_token) {
                _setToken(resp.access_token, resp.expires_in || 3600);
                resolve(resp.access_token);
            } else {
                console.warn('[GIS] silent refresh 응답에 access_token 없음:', resp);
                resolve(null);
            }
        };
        try {
            client.requestAccessToken({ prompt: '' });
        } catch (e) {
            console.warn('[GIS] silent refresh 실패:', e);
            resolve(null);
        }
    });
}

/**
 * 유효한 OAuth access token을 보장한다.
 * 메모리/sessionStorage → GIS silent refresh 순으로 시도.
 * 모두 실패하면 null 반환 (호출자가 안내 메시지 표시).
 */
export async function ensureGoogleAccessToken() {
    const cached = getGoogleAccessToken();
    if (cached) return cached;
    return await _silentRefresh();
}

/**
 * Google 팝업 로그인 — 초기 로그인 및 GIS 실패 시 fallback.
 * @returns {Promise<Object>} Firebase user 객체
 */
export const signInWithGoogle = async () => {
    try {
        const result = await signInWithPopup(auth, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (credential?.accessToken) {
            _setToken(credential.accessToken, 3600);
        }
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
        googleAccessToken = null;
        tokenExpiresAt = 0;
        _clearStorage();
        console.log('[AUTH SUCCESS] 로그아웃 완료');
    } catch (error) {
        console.error('[AUTH ERROR] 로그아웃 실패:', error);
        throw error;
    }
};
