import { onAuthStateChanged } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { auth, functions, dataAuthReady } from './firebase-config.js';
import { signInWithGoogle, logout } from './auth.js';
import { msIcon } from './ms-icon.js';

document.querySelectorAll('[data-checkin-icon]').forEach((el) => {
    el.innerHTML = msIcon(el.dataset.checkinIcon);
});

const NUM_LENGTH = 6;
// 같은 학생·같은 상태를 단시간에 다시 누르는 것을 막는 클라이언트 가드(서버 멱등이 최종 방어).
const REENTRY_WINDOW_MS = 20_000;
// 완료 화면 노출 후 자동 초기화까지의 시간.
const DONE_RESET_MS = 4_000;
// 키오스크 식별 라벨(설정값). 없으면 빈 문자열로 전송.
const DEVICE_LABEL = import.meta.env.VITE_CHECKIN_DEVICE_LABEL || '';

const checkin = httpsCallable(functions, 'attendanceCheckin');

const screens = {
    login: document.getElementById('screen-login'),
    keypad: document.getElementById('screen-keypad'),
    candidates: document.getElementById('screen-candidates'),
    status: document.getElementById('screen-status'),
    done: document.getElementById('screen-done'),
};

const ui = {
    numDisplay: document.getElementById('num-display'),
    keypadHint: document.getElementById('keypad-hint'),
    candidateList: document.getElementById('candidate-list'),
    pickedName: document.getElementById('picked-name'),
    statusHint: document.getElementById('status-hint'),
    doneTitle: document.getElementById('done-title'),
    doneSub: document.getElementById('done-sub'),
};

const session = {
    digits: '',
    picked: null,       // { studentId, name, label }
    submitting: false,
    recent: new Map(),  // `${studentId}_${status}` → timestamp
    resetTimer: null,
};

function showScreen(name) {
    for (const [key, el] of Object.entries(screens)) {
        el.hidden = key !== name;
    }
}

function setHint(el, text, isError = false) {
    el.textContent = text || '';
    el.classList.toggle('error', !!isError && !!text);
}

// ── 학생번호 입력 ──────────────────────────────────────────────
function renderDigits() {
    ui.numDisplay.innerHTML = '';
    for (let i = 0; i < NUM_LENGTH; i++) {
        const box = document.createElement('div');
        box.className = 'num-dot' + (i < session.digits.length ? ' filled' : '');
        box.textContent = session.digits[i] ?? '';
        ui.numDisplay.appendChild(box);
    }
}

function resetToKeypad() {
    clearTimeout(session.resetTimer);
    session.digits = '';
    session.picked = null;
    session.submitting = false;
    setHint(ui.keypadHint, '');
    setHint(ui.statusHint, '');
    renderDigits();
    showScreen('keypad');
}

function onKey(key) {
    if (session.submitting) return;
    if (key === 'clear') {
        session.digits = '';
    } else if (key === 'back') {
        session.digits = session.digits.slice(0, -1);
    } else if (/^\d$/.test(key) && session.digits.length < NUM_LENGTH) {
        session.digits += key;
    }
    renderDigits();
    if (session.digits.length === NUM_LENGTH) lookupCandidates();
}

async function lookupCandidates() {
    if (session.submitting) return;
    session.submitting = true;
    setHint(ui.keypadHint, '');
    ui.keypadHint.innerHTML = '<span class="spinner"></span>';
    try {
        const { data } = await checkin({ studentNumber: session.digits });
        const candidates = data?.candidates ?? [];
        if (candidates.length === 0) {
            setHint(ui.keypadHint, '해당 번호의 재원 학생을 찾을 수 없어요. 번호를 확인해 주세요.', true);
            session.digits = '';
            renderDigits();
            return;
        }
        renderCandidates(candidates);
        showScreen('candidates');
    } catch (err) {
        setHint(ui.keypadHint, errorMessage(err), true);
    } finally {
        session.submitting = false;
    }
}

function renderCandidates(candidates) {
    ui.candidateList.innerHTML = '';
    for (const c of candidates) {
        const btn = document.createElement('button');
        btn.className = 'candidate';
        const name = document.createElement('span');
        name.className = 'c-name';
        name.textContent = c.name || '';
        const label = document.createElement('span');
        label.className = 'c-label';
        label.textContent = c.label || '';
        btn.append(name, label);
        btn.addEventListener('click', () => pickCandidate(c));
        ui.candidateList.appendChild(btn);
    }
}

function pickCandidate(candidate) {
    session.picked = candidate;
    ui.pickedName.textContent = `${candidate.name} 학생`;
    setHint(ui.statusHint, '');
    showScreen('status');
}

// ── 출결 상태 확정 ─────────────────────────────────────────────
async function submitStatus(status) {
    if (session.submitting || !session.picked) return;
    const { studentId, name } = session.picked;
    const guardKey = `${studentId}_${status}`;
    const last = session.recent.get(guardKey);
    if (last && Date.now() - last < REENTRY_WINDOW_MS) {
        showDone(name, status, true);
        return;
    }

    session.submitting = true;
    setStatusButtonsDisabled(true);
    ui.statusHint.innerHTML = '<span class="spinner"></span>';
    try {
        // studentName은 보내지 않는다 — 후보 이름은 마스킹되어 평문이 없고,
        // 서버가 studentId↔studentNumber 결합으로 검증 후 자체 read한 이름을 저장한다.
        const { data } = await checkin({
            studentNumber: session.digits,
            studentId,
            status,
            deviceLabel: DEVICE_LABEL,
        });
        session.recent.set(guardKey, Date.now());
        showDone(name, status, data?.result === 'duplicate');
    } catch (err) {
        setHint(ui.statusHint, errorMessage(err), true);
    } finally {
        session.submitting = false;
        setStatusButtonsDisabled(false);
    }
}

function setStatusButtonsDisabled(disabled) {
    document.querySelectorAll('.status-btn').forEach(b => { b.disabled = disabled; });
}

function showDone(name, status, alreadyDone) {
    ui.doneTitle.textContent = alreadyDone ? '이미 처리됐어요' : `${status} 처리됐어요`;
    ui.doneSub.textContent = `${name} 학생 · 학부모님께 안내가 전달됩니다.`;
    showScreen('done');
    session.resetTimer = setTimeout(resetToKeypad, DONE_RESET_MS);
}

function errorMessage(err) {
    const code = err?.code || '';
    if (code.includes('unauthenticated')) return '로그인이 필요해요. 직원에게 문의하세요.';
    if (code.includes('failed-precondition')) return '학생 정보가 일치하지 않아요. 번호를 다시 확인해 주세요.';
    if (code.includes('invalid-argument')) return '입력값을 확인해 주세요.';
    return '잠시 후 다시 시도해 주세요.';
}

// ── 이벤트 바인딩 ──────────────────────────────────────────────
document.querySelectorAll('.key').forEach(k => {
    k.addEventListener('click', () => onKey(k.dataset.key));
});
document.querySelectorAll('.status-btn').forEach(b => {
    b.addEventListener('click', () => submitStatus(b.dataset.status));
});
document.getElementById('candidates-back').addEventListener('click', resetToKeypad);
document.getElementById('status-back').addEventListener('click', resetToKeypad);
document.getElementById('login-btn').addEventListener('click', async () => {
    try {
        await signInWithGoogle();
    } catch (err) {
        console.error('[checkin] 로그인 실패:', err);
    }
});

// ── 인증 게이트(키오스크 직원 세션) ────────────────────────────
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        showScreen('login');
        return;
    }
    await dataAuthReady();
    const email = user.email || '';
    const allowed = user.emailVerified && email.endsWith('@impact7.kr');
    if (!allowed) {
        await logout();
        showScreen('login');
        return;
    }
    resetToKeypad();
});
