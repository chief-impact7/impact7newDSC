import { initializeApp } from 'firebase/app';
import { getAuth, initializeAuth, inMemoryPersistence, onIdTokenChanged, connectAuthEmulator } from 'firebase/auth';
import {
    getFirestore, connectFirestoreEmulator,
    initializeFirestore, persistentLocalCache, persistentMultipleTabManager
} from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';

const firebaseConfig = {
    apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

if (import.meta.env.DEV) {
    const missing = Object.entries(firebaseConfig)
        .filter(([, v]) => !v)
        .map(([k]) => k);
    if (missing.length > 0) {
        console.error('[Firebase] .env에서 누락된 값:', missing);
    } else {
        console.log('[Firebase] 설정 로딩 완료', {
            projectId: firebaseConfig.projectId,
            authDomain: firebaseConfig.authDomain,
        });
    }
}

// 두 앱 체제:
// - [DEFAULT] app: auth 전담 — 같은 origin의 모든 impact7 앱이 동일 auth 저장 키를
//   공유해 한 번 로그인으로 전체 사용 (원앱 SSO).
// - 'dsc' app: Firestore persistence 분리 — [DEFAULT] IndexedDB 공유 시 다른 앱 탭과
//   primary lease 충돌로 write가 hang됨.
const app = initializeApp(firebaseConfig);
const dataApp = initializeApp(firebaseConfig, 'dsc');
export { app };

export const auth = getAuth(app);

// dataApp의 Firestore가 인증 토큰을 받도록 [DEFAULT] auth를 미러링.
// 세션 저장은 [DEFAULT]가 담당하므로 여기는 in-memory.
const dataAuth = initializeAuth(dataApp, { persistence: inMemoryPersistence });
let _mirrorReady = Promise.resolve();
let _firstMirrorResolve;
const _firstMirror = new Promise((r) => { _firstMirrorResolve = r; });
onIdTokenChanged(auth, (user) => {
    _mirrorReady = dataAuth.updateCurrentUser(user)
        .catch(err => console.warn('[auth-mirror] dataApp 동기화 실패:', err))
        .finally(() => _firstMirrorResolve());
});
// Firestore 첫 쿼리 전에 미러링 완료를 보장 — onAuthStateChanged 콜백 첫 줄에서 await.
// 첫 미러 완료를 명시적으로 기다리므로 리스너 등록 순서에 의존하지 않는다.
export const dataAuthReady = () => _firstMirror.then(() => _mirrorReady);

let db;
if (import.meta.env.VITE_USE_EMULATOR === 'true') {
    db = getFirestore(dataApp);
} else {
    try {
        db = initializeFirestore(dataApp, {
            localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
        });
    } catch {
        db = getFirestore(dataApp);
    }
}
export { db };
// 공유 LLM 게이트웨이(llmGenerate)가 배포된 리전. dataAuth 토큰 사용.
export const functions = getFunctions(dataApp, 'asia-northeast3');

// Emulator 모드: VITE_USE_EMULATOR=true일 때 Firestore + Auth를 로컬 emulator에 연결.
// 별도 터미널에서 `firebase emulators:start --only firestore,auth` 먼저 실행해야 함.
// production DB는 안 건드림 (완전 격리).
if (import.meta.env.DEV && import.meta.env.VITE_USE_EMULATOR === 'true') {
    connectFirestoreEmulator(db, 'localhost', 8080);
    connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
    connectAuthEmulator(dataAuth, 'http://localhost:9099', { disableWarnings: true });
    connectFunctionsEmulator(functions, 'localhost', 5001);
    console.warn('%c🔧 EMULATOR MODE — Firestore/Auth localhost:8080/9099 사용', 'background:#dbeafe;color:#1e3a8a;font-size:13px;font-weight:700;padding:4px 8px;border-radius:4px;');
}
