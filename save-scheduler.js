// 날짜별 debounce 저장 스케줄러 (순수 — Firebase/DOM 무의존, node:test 가능).
//
// 예약 시점의 컨텍스트(targetDate·payload 등)를 캡처하므로, 발동 전에 화면 날짜가
// 바뀌어도 원래 날짜 문서로 저장된다. 같은 key의 재요청은 이전 타이머를 취소하고
// 마지막 컨텍스트만 남긴다. 날짜를 key에 포함하면 서로 다른 날짜의 예약이 독립 보존된다.
// 날짜 전환 시 flushAll()로 예약을 원래 날짜에 즉시 확정한다. F-01.
export function createDebouncedWriter(writeFn, { schedule, cancel: cancelTimer, delay = 2000 } = {}) {
    const setT = schedule || ((fn, ms) => setTimeout(fn, ms));
    const clrT = cancelTimer || clearTimeout;
    const pending = new Map(); // key -> { ctx, timer }

    function request(key, ctx) {
        const cur = pending.get(key);
        if (cur) clrT(cur.timer);
        const timer = setT(() => {
            pending.delete(key);
            writeFn(ctx);
        }, delay);
        pending.set(key, { ctx, timer });
    }

    // 예약을 발동 없이 취소한다. 즉시 저장(immediate) 경로에서 같은 key의 debounce 예약을 정리할 때 쓴다.
    function cancel(key) {
        const cur = pending.get(key);
        if (cur) { clrT(cur.timer); pending.delete(key); }
    }

    async function flushAll() {
        const entries = [...pending.values()];
        pending.clear();
        for (const { ctx, timer } of entries) {
            clrT(timer);
            await writeFn(ctx);
        }
    }

    return {
        request,
        cancel,
        flushAll,
        pendingKeys: () => [...pending.keys()],
    };
}
