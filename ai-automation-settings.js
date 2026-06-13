// ─── AI 자동 생성 설정 ────────────────────────────────────────────────────────
// 학생 AI 종합상태 일괄 생성(스케줄 + 수동)의 설정 모달.
// director 등급 이상(state.canRunAiBatch)만 진입 가능. config 문서: automation_settings/student_report_ai.
// Cloud Function(onScheduleStudentReportAi / runStudentReportBatchNow)이 별도 레포(impact7DB)에서
// 배포돼야 실제 실행이 동작한다. 미배포 상태에서도 모달은 열리고 설정 저장은 가능하다.

import { state } from './state.js';
import {
  getAiAutomationSettings,
  saveAiAutomationSettings,
  runStudentReportBatchNow,
} from './data-layer.js';
import { esc, escAttr, showToast } from './ui-utils.js';
import { formatDateTimeKST } from '@impact7/shared/datetime';

const DEFAULTS = {
  enabled: false,
  interval: 'monthly',   // 'monthly' | 'weekly'
  run_day: 1,            // monthly: 1~28(일), weekly: 0(일)~6(토)
  run_hour: 3,           // 0~23 (KST)
  skip_within_days: 14,
};

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

let _pollTimer = null;
let _running = false;

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
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
  const status = cfg.last_run_status ? esc(String(cfg.last_run_status)) : '완료';
  return `
    <div class="aias-lastrun">
      <div><strong>마지막 실행</strong> ${esc(when)} <span class="aias-muted">(${status})</span></div>
      <div>생성 ${esc(String(cfg.last_run_generated ?? 0))}건 · skip ${esc(String(cfg.last_run_skipped ?? 0))}건</div>
      <div>토큰 ${esc(Number(cfg.last_run_total_tokens ?? 0).toLocaleString('ko-KR'))} · 실비 ${esc(fmtCost(cfg.last_run_cost_usd))}</div>
    </div>`;
}

function dayFieldHtml(cfg) {
  const interval = cfgValue(cfg, 'interval');
  const day = cfgValue(cfg, 'run_day');
  if (interval === 'weekly') {
    const opts = WEEKDAYS.map((label, i) =>
      `<option value="${i}" ${i === Number(day) ? 'selected' : ''}>${label}요일</option>`).join('');
    return `<select class="field-input" id="aias-run-day">${opts}</select>`;
  }
  // monthly: 1~28일
  const opts = Array.from({ length: 28 }, (_, i) => i + 1).map(d =>
    `<option value="${d}" ${d === Number(day) ? 'selected' : ''}>${d}일</option>`).join('');
  return `<select class="field-input" id="aias-run-day">${opts}</select>`;
}

function modalHtml(cfg) {
  const enabled = cfgValue(cfg, 'enabled');
  const interval = cfgValue(cfg, 'interval');
  const hour = cfgValue(cfg, 'run_hour');
  const skip = cfgValue(cfg, 'skip_within_days');
  const hourOpts = Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}" ${h === Number(hour) ? 'selected' : ''}>${String(h).padStart(2, '0')}시</option>`).join('');
  return `
    <div class="modal-content aias-modal">
      <div class="modal-header">
        <h3>AI 자동 생성 설정 — 학생 종합상태</h3>
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
            <option value="monthly" ${interval === 'monthly' ? 'selected' : ''}>매월 1회</option>
            <option value="weekly" ${interval === 'weekly' ? 'selected' : ''}>매주 1회</option>
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

        ${lastRunHtml(cfg)}

        <div class="aias-manual">
          <div class="aias-muted" style="margin-bottom:8px;">
            전체 재원생(약 350명) 1회 실행 시 실비가 발생합니다. 먼저 샘플로 토큰·비용을 실측하세요.
          </div>
          <div class="form-field aias-sample-row">
            <label class="field-label" for="aias-sample-limit">샘플 인원(0 = 전체)</label>
            <input type="number" class="field-input" id="aias-sample-limit" min="0" max="500" value="3" style="max-width:120px;">
          </div>
          <div id="aias-progress" class="aias-progress" style="display:none;"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-primary" id="aias-run-btn" onclick="runAiAutomationNow()">지금 일괄 생성</button>
        <button class="btn-primary" id="aias-save-btn" onclick="saveAiAutomationSettingsUI()">설정 저장</button>
      </div>
    </div>`;
}

function getOverlay() {
  return document.getElementById('aias-overlay');
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
};

window.closeAiAutomationSettings = function () {
  stopPolling();
  _running = false;
  getOverlay()?.remove();
};

// 주기 변경 시 실행일 입력(월=일자 / 주=요일)을 다시 렌더.
window.onAiAutomationIntervalChange = function () {
  const wrap = document.getElementById('aias-run-day-wrap');
  if (!wrap) return;
  const interval = document.getElementById('aias-interval')?.value || 'monthly';
  wrap.innerHTML = dayFieldHtml({ interval, run_day: DEFAULTS.run_day });
};

function readForm() {
  const interval = document.getElementById('aias-interval')?.value || 'monthly';
  const skip = parseInt(document.getElementById('aias-skip-days')?.value, 10);
  return {
    enabled: !!document.getElementById('aias-enabled')?.checked,
    interval,
    run_day: parseInt(document.getElementById('aias-run-day')?.value, 10) || 0,
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

function renderProgress(cfg) {
  const el = document.getElementById('aias-progress');
  if (!el) return;
  if (cfg?.running) {
    const done = cfg.progress_done ?? 0;
    const total = cfg.progress_total ?? 0;
    el.style.display = '';
    el.textContent = total > 0 ? `진행 중... ${done}/${total}` : '진행 중...';
  }
}

function startPolling() {
  stopPolling();
  _pollTimer = setInterval(async () => {
    const cfg = await getAiAutomationSettings().catch(() => null);
    renderProgress(cfg);
    if (cfg && cfg.running === false) {
      // 실행 종료 감지. 폴링은 중단하되, 수동 실행 중(_running)이면 모달 갱신은 callable await의
      // finally가 처리하도록 양보한다(실행 중 버튼이 조기에 다시 활성화되는 것 방지).
      stopPolling();
      if (!_running) refreshAfterRun(cfg);
    }
  }, 3000);
}

// cfg가 주어지면 재조회 없이 그대로 렌더(폴링이 방금 읽은 값 재사용).
async function refreshAfterRun(cfg) {
  if (!getOverlay()) return;
  const data = cfg !== undefined ? cfg : await getAiAutomationSettings().catch(() => null);
  const overlay = getOverlay();
  if (overlay) overlay.innerHTML = modalHtml(data);
}

window.runAiAutomationNow = async function () {
  if (_running) return;
  const limitRaw = parseInt(document.getElementById('aias-sample-limit')?.value, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 0;
  const confirmMsg = limit > 0
    ? `샘플 ${limit}명에 대해 AI 종합상태를 생성합니다. 실비가 발생합니다. 진행할까요?`
    : '전체 재원생에 대해 AI 종합상태를 생성합니다. 실비가 발생합니다. 진행할까요?';
  if (!window.confirm(confirmMsg)) return;

  const runBtn = document.getElementById('aias-run-btn');
  const saveBtn = document.getElementById('aias-save-btn');
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = '실행 중...'; }
  if (saveBtn) saveBtn.disabled = true;
  const progressEl = document.getElementById('aias-progress');
  if (progressEl) { progressEl.style.display = ''; progressEl.textContent = '시작 중...'; }

  _running = true;
  startPolling();
  try {
    const res = await runStudentReportBatchNow(limit > 0 ? { limit } : {});
    const generated = res?.generated ?? 0;
    const skipped = res?.skipped ?? 0;
    showToast(`일괄 생성 완료 — 생성 ${generated}건 / skip ${skipped}건`);
  } catch (err) {
    const code = err?.code || '';
    if (code === 'functions/not-found' || code === 'functions/internal') {
      showToast('일괄 생성 함수가 아직 배포되지 않았습니다. (impact7DB 배포 필요)');
    } else if (code === 'functions/permission-denied') {
      showToast('실행 권한이 없습니다 (director 등급 이상).');
    } else if (code === 'functions/deadline-exceeded') {
      showToast('실행이 길어 클라이언트 대기를 종료했습니다 — 잠시 후 마지막 실행 정보를 확인하세요.');
    } else {
      showToast('일괄 생성 실패: ' + (err?.message || err));
    }
    console.error('[ai-automation] 일괄 생성 실패:', err);
  } finally {
    _running = false;
    stopPolling();
    await refreshAfterRun();
  }
};
