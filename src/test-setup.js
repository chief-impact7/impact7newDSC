// vitest setup — node 환경에서 누락된 브라우저 전역을 최소 스텁.
// state.js가 모듈 로드 시 localStorage.getItem(line 74)을 호출하므로
// 메모리 기반 localStorage 셔임을 제공한다. (document는 정의하지 않아
// firebase-config의 App Check 초기화는 그대로 스킵된다.)
if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
        clear: () => { store.clear(); },
    };
}
