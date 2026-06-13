// ─── AI 자동 생성 설정 ────────────────────────────────────────────────────────
// 학생 AI 종합 리포트 일괄 생성(스케줄 + 수동)의 설정·실행 모달.
// director 등급 이상(state.canRunAiBatch)만 진입 가능. config 문서: automation_settings/student_report.
// 배포된 functions-shared 백엔드 계약에 맞춘다:
//   - 클라 patch 가능: enabled/interval/run_day/run_hour/skip_within_days/updated_by/updated_at (allowlist)
//   - 서버 갱신(구독만): batch_active/progress_done/progress_total/last_run_* (절대 클라에서 쓰지 않음)
//   - 콜러블 runStudentReportBatchManual(asia-northeast3): 지금 실행.

import { state } from './state.js';
import {
  getAiAutomationSettings,
  saveAiAutomationSettings,
  subscribeAiAutomationSettings,
  runStudentReportBatchManual,
} from './data-layer.js';
import { esc, escAttr, showToast } from './ui-utils.js';
import { formatDateTimeKST } from '@impact7/shared/datetime';

const DEFAULTS = {
  enabled: false,
  interval: 'monthly',   // 'daily' | 'weekly' | 'monthly'
  run_day: 1,            // weekly: 0(일)~6(토) JS getDay 규약 / monthly: 1~31
  run_hour: 3,           // 0~23 (KST)
  skip_within_days: 14,
};

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

let _unsub = null;
let _running = false;

function stopSubscribe() {
  if (_unsub) { _unsub(); _unsub = null; }
}

function cfgValue(cfg, key) {
  const v = cfg?.[key];
  return v === undefined || v === null ? DEFAULTS[key] : v;
}

function fmtCost(usd) {
  if (usd == null) return '—';
  const krw = Math.round(Number(usd) * 1400); // 대략 환산(표시용)
  return `$${Number(usd).toFixed(2)} (약 ${krw.toLocaleString('ko-KR')}원)`;
}

function lastRunHtml(cfg) {
  if (!cfg?.last_run_at) {
    return '<div class="aias-lastrun-empty">아직 일괄 실행 기록이 없습니다.</div>';
  }
  const when = (() => {
    try { return formatDateTimeKST(cfg.last_run_at); } catch { return String(cfg.last_run_at); }
  })();
  const statusMap = { success: '성공', partial: '일부 성공', failed: '실패' };
  const status = esc(statusMap[cfg.last_run_status] || cfg.last_run_status || '완료');
  return `
    <div class="aias-lastrun">
      <div><strong>마지막 실행</strong> ${esc(when)} <span class="aias-muted">(${status})</span></div>
      <div>생성 ${esc(String(cfg.last_run_generated ?? 0))}건 · skip ${esc(String(cfg.last_run_skipped ?? 0))}건</div>
      <div>토큰 ${esc(Number(cfg.last_run_total_tokens ?? 0).toLocaleString('ko-KR'))} · 실비 ${esc(fmtCost(cfg.last_run_cost_usd))}</div>
    </div>`;
}

function dayFieldHtml(cfg) {
  const interval = cfgValue(cfg, 'interval');
  const day = Number(cfgValue(cfg, 'run_day'));
  if (interval === 'daily') {
    return '<div class="aias-muted">매일 실행됩니다.</div>';
  }
  if (interval === 'weekly') {
    const opts = WEEKDAYS.map((label, i) =>
      `<option value="${i}" ${i === day ? 'selected' : ''}>${label}요일</option>`).join('');
    return `<select class="field-input" id="aias-run-day">${opts}</select>`;
  }
  // monthly: 1~31일
  const opts = Array.from({ length: 31 }, (_, i) => i + 1).map(d =>
    `<option value="${d}" ${d === day ? 'selected' : ''}>${d}일</option>`).join('');
  return `<select class="field-input" id="aias-run-day">${opts}</select>`;
}

function progressHtml(cfg) {
  if (!cfg?.batch_active) return '';
  const done = Number(cfg.progress_done ?? 0);
  const total = Number(cfg.progress_total ?? 0);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const label = total > 0 ? `진행 중... ${done}/${total} (${pct}%)` : '진행 중...';
  return `
    <div class="aias-progress" id="aias-progress">
      <div class="aias-progress-label">${esc(label)}</div>
      <div class="aias-progress-track"><div class="aias-progress-bar" style="width:${pct}%;"></div></div>
      <div class="aias-muted" style="margin-top:4px;">진행 중입니다. 자동으로 계속됩니다 — 닫아도 백그라운드에서 이어집니다.</div>
    </div>`;
}

function modalHtml(cfg) {
  const enabled = cfgValue(cfg, 'enabled');
  const interval = cfgValue(cfg, 'interval');
  const hour = Number(cfgValue(cfg, 'run_hour'));
  const skip = cfgValue(cfg, 'skip_within_days');
  const active = !!cfg?.batch_active;
  const hourOpts = Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}" ${h === hour ? 'selected' : ''}>${String(h).padStart(2, '0')}시</option>`).join('');
  return `
    <div class="modal-content aias-modal">
      <div class="modal-header">
        <h3>AI 자동 생성 설정 — 학생 종합 리포트</h3>
        <button class="modal-close" onclick="closeAiAutomationSettings()">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-field aias-toggle-row">
          <label class="field-label" for="aias-enabled">정기 자동 생성 사용</label>
          <input type="checkbox" id="aias-enabled" ${enabled ? 'checked' : ''}>
        </div>
        <div class="form-field">
          <label class="field-label">주기</label>
          <select class="field-input" id="aias-interval" onchange="onAiAutomationIntervalChange()">
            <option value="daily" ${interval === 'daily' ? 'selected' : ''}>매일</option>
            <option value="weekly" ${interval === 'weekly' ? 'selected' : ''}>매주 1회</option>
            <option value="monthly" ${interval === 'monthly' ? 'selected' : ''}>매월 1회</option>
          </select>
        </div>
        <div class="form-field">
          <label class="field-label">실행일</label>
          <div id="aias-run-day-wrap">${dayFieldHtml(cfg)}</div>
        </div>
        <div class="form-field">
          <label class="field-label">실행 시각 (KST)</label>
          <select class="field-input" id="aias-run-hour">${hourOpts}</select>
        </div>
        <div class="form-field">
          <label class="field-label">최근 N일 내 생성분 skip</label>
          <input type="number" class="field-input" id="aias-skip-days" min="0" max="90" value="${escAttr(String(skip))}">
          <div class="aias-muted" style="margin-top:4px;">이미 분석된 학생은 N일 동안 다시 생성하지 않아 비용을 줄입니다.</div>
        </div>

        <hr style="border:none;border-top:1px solid var(--border, #e5e7eb);margin:16px 0;">

        <div id="aias-progress-wrap">${progressHtml(cfg)}</div>
        ${lastRunHtml(cfg)}

        <div class="aias-manual">
          <div class="aias-muted" style="margin-top:8px;">
            전체 재원생 1회 실행 시 실비가 발생합니다. skip 기간 내 학생은 자동으로 건너뜁니다.
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-primary" id="aias-run-btn" onclick="runAiAutomationNow()" ${active ? 'disabled' : ''}>
          ${active ? '실행 중...' : '지금 실행'}
        </button>
        <button class="btn-primary" id="aias-save-btn" onclick="saveAiAutomationSettingsUI()">설정 저장</button>
      </div>
    </div>`;
}

function getOverlay() {
  return document.getElementById('aias-overlay');
}

// 폼 입력값을 보존한 채 서버 갱신 필드(진행률·버튼 상태)만 부분 갱신.
// 전체 re-render는 사용자가 만지던 select 값을 날리므로 구독 콜백에서는 쓰지 않는다.
function applyServerState(cfg) {
  const overlay = getOverlay();
  if (!overlay) return;
  const wrap = document.getElementById('aias-progress-wrap');
  if (wrap) wrap.innerHTML = progressHtml(cfg);
  const lastrun = overlay.querySelector('.aias-lastrun, .aias-lastrun-empty');
  if (lastrun) {
    const tmp = document.createElement('div');
    tmp.innerHTML = lastRunHtml(cfg);
    lastrun.replaceWith(tmp.firstElementChild);
  }
  const active = !!cfg?.batch_active;
  const runBtn = document.getElementById('aias-run-btn');
  // 수동 실행 콜러블 await 중(_running)에는 버튼 텍스트/상태를 건드리지 않는다.
  if (runBtn && !_running) {
    runBtn.disabled = active;
    runBtn.textContent = active ? '실행 중...' : '지금 실행';
  }
}

window.openAiAutomationSettings = async function () {
  if (!state.canRunAiBatch) {
    showToast('AI 자동 생성 설정 권한이 없습니다 (director 등급 이상).');
    return;
  }
  if (getOverlay()) return;
  const overlay = document.createElement('div');
  overlay.id = 'aias-overlay';
  overlay.className = 'modal-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) window.closeAiAutomationSettings(); };
  overlay.innerHTML = '<div class="modal-content"><div class="modal-body">불러오는 중...</div></div>';
  document.body.appendChild(overlay);

  const cfg = await getAiAutomationSettings().catch((err) => {
    console.warn('[ai-automation] 설정 로드 실패:', err?.code || err?.message);
    return null;
  });
  if (!getOverlay()) return; // 그 사이 닫힘
  overlay.innerHTML = modalHtml(cfg);

  // 진행상태/마지막 실행 결과 실시간 구독 → batch_active·progress·last_run만 부분 반영.
  _unsub = subscribeAiAutomationSettings((data) => applyServerState(data));
};

window.closeAiAutomationSettings = function () {
  stopSubscribe();
  _running = false;
  getOverlay()?.remove();
};

// 주기 변경 시 실행일 입력(매일=없음 / 주=요일 / 월=일자)을 다시 렌더.
window.onAiAutomationIntervalChange = function () {
  const wrap = document.getElementById('aias-run-day-wrap');
  if (!wrap) return;
  const interval = document.getElementById('aias-interval')?.value || 'monthly';
  wrap.innerHTML = dayFieldHtml({ interval, run_day: DEFAULTS.run_day });
};

function readForm() {
  const interval = document.getElementById('aias-interval')?.value || 'monthly';
  const skip = parseInt(document.getElementById('aias-skip-days')?.value, 10);
  const dayEl = document.getElementById('aias-run-day'); // daily면 없음
  return {
    enabled: !!document.getElementById('aias-enabled')?.checked,
    interval,
    run_day: dayEl ? (parseInt(dayEl.value, 10) || 0) : DEFAULTS.run_day,
    run_hour: parseInt(document.getElementById('aias-run-hour')?.value, 10) || 0,
    skip_within_days: Number.isFinite(skip) ? skip : DEFAULTS.skip_within_days,
  };
}

window.saveAiAutomationSettingsUI = async function () {
  const btn = document.getElementById('aias-save-btn');
  if (btn) btn.disabled = true;
  try {
    await saveAiAutomationSettings(readForm());
    showToast('AI 자동 생성 설정을 저장했습니다.');
  } catch (err) {
    showToast('설정 저장 실패: ' + (err?.message || err));
    console.error('[ai-automation] 저장 실패:', err);
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.runAiAutomationNow = async function () {
  if (_running) return;
  if (!window.confirm('전체 재원생에 대해 AI 종합 리포트를 생성합니다. 실비가 발생합니다. 진행할까요?')) return;

  const runBtn = document.getElementById('aias-run-btn');
  const saveBtn = document.getElementById('aias-save-btn');
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = '시작 중...'; }
  if (saveBtn) saveBtn.disabled = true;

  _running = true;
  try {
    const res = await runStudentReportBatchManual();
    if (res?.ok === false && res?.reason === 'locked') {
      showToast('이미 실행 중입니다.');
    } else if (res?.status === 'in_progress') {
      const done = res?.done ?? 0;
      const total = res?.total ?? 0;
      showToast(`실행 시작 — ${done}/${total} 처리. 진행 중이며 자동으로 계속됩니다.`);
    } else {
      // status:'complete'
      const generated = res?.generated ?? 0;
      const skipped = res?.skipped ?? 0;
      showToast(`일괄 생성 완료 — 생성 ${generated}건 / skip ${skipped}건`);
    }
  } catch (err) {
    const code = err?.code || '';
    if (code === 'functions/permission-denied') {
      showToast('실행 권한이 없습니다 (director 등급 이상).');
    } else if (code === 'functions/unauthenticated') {
      showToast('로그인이 필요합니다.');
    } else if (code === 'functions/not-found') {
      showToast('일괄 생성 함수를 찾을 수 없습니다. (배포 상태 확인 필요)');
    } else if (code === 'functions/deadline-exceeded') {
      showToast('실행이 길어 대기를 종료했습니다 — 진행률·마지막 실행 정보를 확인하세요.');
    } else {
      showToast('일괄 생성 실패: ' + (err?.message || err));
    }
    console.error('[ai-automation] 일괄 생성 실패:', err);
  } finally {
    _running = false;
    // 버튼 상태는 구독 콜백(applyServerState)이 batch_active로 반영. 즉시 한 번 보정.
    const cfg = await getAiAutomationSettings().catch(() => null);
    applyServerState(cfg);
  }
};
