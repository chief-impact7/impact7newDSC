import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDebouncedWriter } from './save-scheduler.js';

// 자동 발동 없는 가짜 타이머. fire/fireAll로 명시적으로 발동시킨다.
function fakeTimers() {
    let seq = 1;
    const timers = new Map();
    return {
        schedule: (fn) => { const id = seq++; timers.set(id, fn); return id; },
        cancel: (id) => { timers.delete(id); },
        fireAll: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
        pending: () => timers.size,
    };
}

test('예약 시점 ctx로 저장 — 발동 전 날짜가 바뀌어도 원래 날짜', () => {
    const ft = fakeTimers();
    const writes = [];
    const w = createDebouncedWriter((ctx) => writes.push(ctx), { schedule: ft.schedule, cancel: ft.cancel });
    w.request('s_2026-06-20', { studentId: 's', targetDate: '2026-06-20', updates: { x: 1 } });
    ft.fireAll();
    assert.deepEqual(writes, [{ studentId: 's', targetDate: '2026-06-20', updates: { x: 1 } }]);
});

test('같은 key 재요청 — 이전 타이머 취소, 마지막 ctx만', () => {
    const ft = fakeTimers();
    const writes = [];
    const w = createDebouncedWriter((ctx) => writes.push(ctx.v), { schedule: ft.schedule, cancel: ft.cancel });
    w.request('k', { v: 1 });
    w.request('k', { v: 2 });
    assert.equal(ft.pending(), 1);
    ft.fireAll();
    assert.deepEqual(writes, [2]);
});

test('다른 날짜 key는 독립 타이머 — 둘 다 저장', () => {
    const ft = fakeTimers();
    const writes = [];
    const w = createDebouncedWriter((ctx) => writes.push(ctx.d), { schedule: ft.schedule, cancel: ft.cancel });
    w.request('s_A', { d: 'A' });
    w.request('s_B', { d: 'B' });
    assert.equal(ft.pending(), 2);
    ft.fireAll();
    assert.deepEqual(writes.sort(), ['A', 'B']);
});

test('flushAll — pending을 즉시 실행하고 비운다', async () => {
    const ft = fakeTimers();
    const writes = [];
    const w = createDebouncedWriter(async (ctx) => { writes.push(ctx.d); }, { schedule: ft.schedule, cancel: ft.cancel });
    w.request('s_A', { d: 'A' });
    w.request('s_B', { d: 'B' });
    await w.flushAll();
    assert.deepEqual(writes.sort(), ['A', 'B']);
    assert.equal(ft.pending(), 0);
    assert.deepEqual(w.pendingKeys(), []);
});

test('flushAll 후 타이머는 발동해도 재저장 없음 (pending에서 제거됨)', async () => {
    const ft = fakeTimers();
    const writes = [];
    const w = createDebouncedWriter((ctx) => writes.push(ctx.d), { schedule: ft.schedule, cancel: ft.cancel });
    w.request('s_A', { d: 'A' });
    await w.flushAll();
    ft.fireAll(); // 이미 cancel됨 — 아무 일도 없어야
    assert.deepEqual(writes, ['A']);
});
