import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getAI, getGenerativeModel, VertexAIBackend } from 'firebase/ai';

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

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

// Emulator 모드: VITE_USE_EMULATOR=true일 때 Firestore + Auth를 로컬 emulator에 연결.
// 별도 터미널에서 `firebase emulators:start --only firestore,auth` 먼저 실행해야 함.
// production DB는 안 건드림 (완전 격리).
if (import.meta.env.DEV && import.meta.env.VITE_USE_EMULATOR === 'true') {
    connectFirestoreEmulator(db, 'localhost', 8080);
    connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
    console.warn('%c🔧 EMULATOR MODE — Firestore/Auth localhost:8080/9099 사용', 'background:#dbeafe;color:#1e3a8a;font-size:13px;font-weight:700;padding:4px 8px;border-radius:4px;');
}

const ai = getAI(app, { backend: new VertexAIBackend('global') });
export const geminiModel = getGenerativeModel(ai, { model: 'gemini-3-flash-preview' });
