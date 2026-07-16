import React, { useEffect, useState, useMemo, useRef } from 'react';
import { Icon } from '@impact7/ui';
import { filterStaff, filterStudents } from '../bulk-select.js';
import { studentFullLabel, currentSchool } from '@impact7/shared/student-label';
import { allClassCodes } from '../../shared/firestore-helpers.js';
import GradeFilter from '../../dashboard/components/GradeFilter.jsx';
import { MESSAGE_KIND_NOTICE, MMS_SIZE_NOTICE, messageMeta, normalizePhones, readMmsImage } from '../message-format.js';
import { parsePhonesFromFile, sampleCsv } from '../message-import.js';
import { audienceMaxMessages, buildAudienceRequest, DIRECT_MAX_RECIPIENTS } from '../bulk-send.js';
import { getMessageExtras, saveMessageExtras, composeWithExtras, DEFAULT_CHANNEL_INVITE } from '../sms-extras.js';
import TemplateBar from './TemplateBar.jsx';
import { ICON_NAME } from '../../dashboard/icon-map.js';
import { createBulkMessage, createPromoCampaign, getBulkStaffRecipients, sendDirectMessage } from '../../../data-layer.js';
// 광고 규제 표기(정보통신망법 §50)는 공용 모듈 — 발송 시 자동 보정, 버튼은 미리보기 확인용.
import { OPT_OUT_LINE, ensurePromoCompliance } from '../../../promo-compliance.js';

// randomUUID는 secure context 전용 — LAN http dev(host:true)용 fallback 유지
function newReqId() { return 'bulk-' + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + '-' + performance.now().toString(36)); }

// 대량 발송 blast radius 제한. 서버가 최종 검증하지만 클라 1차 방어로 오발송 규모를 줄인다. F-02
const BULK_CONFIRM_THRESHOLD = 30; // 이 인원 이상이면 발송 전 확인 단계를 요구

const RECIPIENT_LABELS = { student: '학생', parent_1: '학부모1', parent_2: '학부모2' };
const STATUS_LABELS = { enrolled: '재원', non: '비원생' };
const STAFF_STATUS_LABELS = { all: '전체', active: '재직', inactive: '휴직', terminated: '퇴직' };

// 학생의 현재 반코드(첫 수강). enrollmentCode는 enrollment 객체를 받으므로 학생엔 allClassCodes를 쓴다.
function classOf(s) { return allClassCodes(s)[0] || ''; }

const VARS = ['%이름', '%학교', '%학년', '%반'];
// 미리보기용 변수 치환. 실제 발송 시엔 서버가 학생별로 동일 규칙으로 치환한다.
function applyVars(text, target, isStaff) {
  if (isStaff) return String(text).replaceAll('%이름', target?.name || '');
  const s = target;
  if (!s) return text;
  return String(text)
    .replaceAll('%이름', s.name || '')
    .replaceAll('%학교', currentSchool(s) || '')
    .replaceAll('%학년', s.grade != null ? String(s.grade) : '')
    .replaceAll('%반', classOf(s));
}

function targetMeta(target, isStaff) {
  if (isStaff) {
    return [STAFF_STATUS_LABELS[target.status], target.department, target.affiliation, target.phoneAvailable ? '' : '번호 없음']
      .filter(Boolean)
      .join(' · ');
  }
  const classCode = classOf(target);
  return `${studentFullLabel(target)}${classCode ? ` · ${classCode}` : ''}`;
}

export default function BulkSendCard({ students = [] }) {
  const [audience, setAudience] = useState('student');
  const [staff, setStaff] = useState([]);
  const [staffLoaded, setStaffLoaded] = useState(false);
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffError, setStaffError] = useState('');
  const [staffStatus, setStaffStatus] = useState('active');
  const [staffAffiliation, setStaffAffiliation] = useState('');
  const [directRecipients, setDirectRecipients] = useState('');
  const [directConsentConfirmed, setDirectConsentConfirmed] = useState(false);
  const [branch, setBranch] = useState('');
  const [grades, setGrades] = useState(new Set());
  const [status, setStatus] = useState('enrolled'); // 기본 재원
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => new Map()); // id -> { target, on }
  const [sources, setSources] = useState([]);
  const [recipientFields, setRecipientFields] = useState(() => new Set(['parent_1'])); // 다중 선택
  const [kind, setKind] = useState('info'); // 'info'(정보성) | 'promo'(홍보성)
  const [content, setContent] = useState('');
  const [when, setWhen] = useState('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [mmsImage, setMmsImage] = useState(null);
  const [footer, setFooter] = useState('');
  const [invite, setInvite] = useState(DEFAULT_CHANNEL_INVITE);
  const [inviteCustom, setInviteCustom] = useState('');
  const [withInvite, setWithInvite] = useState(false);
  const [withFooter, setWithFooter] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [footerDraft, setFooterDraft] = useState('');
  const [inviteDraft, setInviteDraft] = useState('');
  const [setupBusy, setSetupBusy] = useState(false);
  const reqIdRef = useRef(newReqId());
  const fileRef = useRef(null);
  const imageRef = useRef(null);
  const isStaff = audience === 'staff';
  const isDirect = audience === 'direct';
  const resetReqId = () => { reqIdRef.current = newReqId(); setConfirming(false); };

  useEffect(() => {
    let alive = true;
    getMessageExtras().then((extras) => {
      if (!alive) return;
      setFooter(extras.footer);
      setInvite(extras.channelInvite);
      setInviteCustom(extras.channelInviteCustom);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!isStaff || staffLoaded) return;
    let alive = true;
    setStaffLoading(true);
    setStaffError('');
    getBulkStaffRecipients()
      .then((result) => {
        if (!alive) return;
        setStaff(result.recipients || []);
        setStaffLoaded(true);
      })
      .catch((error) => {
        if (alive) setStaffError(error?.message || String(error));
      })
      .finally(() => { if (alive) setStaffLoading(false); });
    return () => { alive = false; };
  }, [isStaff, staffLoaded]);

  const matches = useMemo(() => {
    if (isDirect) return [];
    if (isStaff) return filterStaff(staff, { status: staffStatus, affiliation: staffAffiliation, q });
    return filterStudents(students, { branch, grades, status, q });
  }, [isDirect, isStaff, students, staff, branch, grades, status, staffStatus, staffAffiliation, q]);
  const rows = useMemo(() => [...picked.values()], [picked]);
  const selectedCount = useMemo(() => rows.reduce((n, v) => n + (v.on ? 1 : 0), 0), [rows]);
  const directPhones = useMemo(() => [...new Set(normalizePhones(directRecipients))], [directRecipients]);
  const checkedCount = isDirect ? directPhones.length : selectedCount;
  const recipientMultiplier = isStaff || isDirect ? 1 : recipientFields.size;
  const estimatedMessageCount = checkedCount * recipientMultiplier;
  const staffAffiliations = useMemo(
    () => [...new Set(staff.map((person) => person.affiliation).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko')),
    [staff],
  );

  function commitSearch() {
    if (!matches.length) { setMsg(q.trim() ? `"${q.trim()}" 결과 없음` : '추가할 대상이 없습니다.'); return; }
    setPicked((prev) => {
      const next = new Map(prev);
      for (const target of matches) if (!next.has(target.id)) next.set(target.id, { target, on: true });
      return next;
    });
    const label = q.trim()
      || (isStaff
        ? [staffAffiliation, STAFF_STATUS_LABELS[staffStatus]].filter(Boolean).join(' ')
        : [branch, [...grades].join('·'), STATUS_LABELS[status]].filter(Boolean).join(' '))
      || '전체';
    setSources((prev) => (prev.includes(label) ? prev : [...prev, label]));
    setQ(''); setMsg(''); resetReqId();
  }
  function toggle(id) {
    setPicked((prev) => { const n = new Map(prev); const e = n.get(id); if (e) n.set(id, { ...e, on: !e.on }); return n; });
    resetReqId();
  }
  function setAllOn(on) {
    setPicked((prev) => { const n = new Map(); for (const [k, v] of prev) n.set(k, { ...v, on }); return n; });
    resetReqId();
  }
  function clearAll() { setPicked(new Map()); setSources([]); resetReqId(); }
  function selectAudience(nextAudience) {
    if (nextAudience === audience) return;
    setAudience(nextAudience);
    setQ('');
    clearAll();
    if (nextAudience === 'staff') {
      setKind('info');
      setWithInvite(false);
      setWithFooter(false);
      setSetupOpen(false);
    }
    if (nextAudience !== 'direct') setDirectConsentConfirmed(false);
  }

  async function onRecipientFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const phones = await parsePhonesFromFile(file);
      const existing = new Set(directPhones);
      const added = phones.filter((phone) => !existing.has(phone));
      if (added.length) {
        setDirectRecipients((current) => current.trim() ? `${current.trim()}\n${added.join('\n')}` : added.join('\n'));
        setDirectConsentConfirmed(false);
      }
      setMsg(`${file.name} — ${phones.length}개 인식 · ${added.length}개 추가`);
      resetReqId();
    } catch (error) {
      setMsg(`파일 읽기 실패: ${error?.message || error}`);
    } finally {
      e.target.value = '';
    }
  }

  function downloadRecipientSample() {
    const blob = new Blob(['﻿' + sampleCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = '수신번호_양식.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  }
  function toggleRecipient(f) {
    // 홍보(promo)는 서버가 단일 수신 필드만 처리하므로 단일 선택만 허용(미리보기=실제 보장).
    if (kind === 'promo') { setRecipientFields(new Set([f])); resetReqId(); return; }
    setRecipientFields((prev) => {
      const n = new Set(prev);
      if (n.has(f)) { if (n.size > 1) n.delete(f); } else n.add(f);
      return n;
    });
    resetReqId();
  }
  function selectKind(k) {
    setKind(k);
    // 홍보로 전환 시 받는이를 단일로 축소(서버 promo는 단일 필드만 처리).
    if (k === 'promo') {
      setRecipientFields((prev) => new Set([[...prev][0] || 'parent_1']));
      setDirectConsentConfirmed(false);
    }
    resetReqId();
  }

  async function onMmsImage(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setMmsImage(await readMmsImage(file));
      setMsg(`${file.name} 첨부 완료 · MMS로 발송됩니다.`);
      resetReqId();
    } catch (error) {
      setMmsImage(null);
      setMsg(error?.message || String(error));
    } finally {
      e.target.value = '';
    }
  }

  async function onSaveSetup() {
    if (setupBusy) return;
    setSetupBusy(true);
    try {
      await saveMessageExtras({ footer: footerDraft, channelInvite: inviteDraft });
      const nextInviteCustom = inviteDraft.trim();
      setInviteCustom(nextInviteCustom);
      setInvite(nextInviteCustom || DEFAULT_CHANNEL_INVITE);
      setFooter(footerDraft.trim());
      setSetupOpen(false);
      setMsg('문구를 저장했습니다.');
      resetReqId();
    } catch (error) {
      setMsg('문구 저장 실패: ' + (error?.message || error));
    } finally {
      setSetupBusy(false);
    }
  }

  function onSendClick() {
    if (sending) return;
    const ids = isDirect ? directPhones : rows.filter((v) => v.on).map((v) => v.target.id);
    if (!ids.length) { setMsg(isDirect ? '유효한 수신번호를 입력하세요.' : '대상이 없습니다. 검색으로 추가하세요.'); return; }
    if (!content.trim()) { setMsg('내용을 입력하세요.'); return; }
    if (isDirect && kind === 'promo' && !directConsentConfirmed) { setMsg('광고 수신동의를 확인한 번호인지 체크하세요.'); return; }
    if (when === 'schedule' && !scheduledAt) { setMsg('예약 시각을 입력하세요.'); return; }
    const estimatedCount = ids.length * recipientMultiplier;
    const maxMessages = audienceMaxMessages(audience);
    if (estimatedCount > maxMessages) {
      setMsg(`한 번에 최대 ${maxMessages}건까지 발송할 수 있습니다 (현재 예상 ${estimatedCount}건). 대상을 나눠 보내세요.`);
      return;
    }
    if (ids.length >= BULK_CONFIRM_THRESHOLD && !confirming) { setConfirming(true); setMsg(''); return; }
    doSend(ids);
  }

  async function doSend(ids) {
    setConfirming(false);
    setSending(true); setMsg('');
    try {
      // 홍보는 (광고)·080 표기를 발송 직전 자동 보정 — 깜빡해도 법적 표기가 빠지지 않는다.
      const body = effectiveContent;
      const request = buildAudienceRequest({
        audience,
        ids,
        recipientFields: [...recipientFields],
        directRecipients,
        content: body,
        kind,
        consentConfirmed: directConsentConfirmed,
        requestId: reqIdRef.current,
        scheduledAt: when === 'schedule' ? `${scheduledAt.slice(0, 16).replace('T', ' ')}:00` : '',
        mmsImage: mmsImage ? { name: mmsImage.name, dataBase64: mmsImage.dataBase64 } : null,
      });
      let res;
      if (request.call === 'direct') res = await sendDirectMessage(request.payload);
      else if (request.call === 'promo') res = await createPromoCampaign(request.payload);
      else res = await createBulkMessage(request.payload);
      if (res.duplicate) setMsg('이미 발송된 요청입니다.');
      else {
        const s = isDirect ? { queued: res.queued, skipped_invalid: res.invalid?.length } : (res.stats || {});
        const parts = [];
        if (s.ad_sms != null) {
          parts.push(`문자광고 ${s.ad_sms || 0}`);
          if (s.skipped_no_consent) parts.push(`미동의 제외 ${s.skipped_no_consent}`);
        } else {
          parts.push(`${s.queued ?? ids.length}건`);
          if (s.deduped) parts.push(`중복번호 ${s.deduped} 합침`);
        }
        if (s.skipped_no_phone) parts.push(`번호없음 ${s.skipped_no_phone}`);
        if (s.skipped_invalid) parts.push(`무효번호 ${s.skipped_invalid}`);
        if (s.skipped_revoked) parts.push(`수신거부 ${s.skipped_revoked}`);
        setMsg('발송 접수 — ' + parts.join(' · '));
        clearAll(); setDirectRecipients(''); setDirectConsentConfirmed(false); setContent(''); setMmsImage(null); resetReqId();
      }
    } catch (e) {
      setMsg('발송 실패: ' + (e?.message || e));
    } finally { setSending(false); }
  }

  const baseContent = kind === 'info' && !isStaff
    ? composeWithExtras(content, [withInvite ? invite : '', withFooter ? footer : ''])
    : content;
  const effectiveContent = kind === 'promo' ? ensurePromoCompliance(baseContent) : baseContent;
  const meta = messageMeta(effectiveContent);
  const messageType = mmsImage ? 'MMS' : meta.type;
  const firstTarget = rows.find((v) => v.on)?.target;
  let recipientText = [...recipientFields].map((field) => RECIPIENT_LABELS[field]).join('·');
  if (isStaff) recipientText = '교직원 본인';
  if (isDirect) recipientText = '입력 번호';
  const attachedLines = kind === 'info' && !isStaff
    ? [withInvite ? invite : '', withFooter ? footer : ''].filter((line) => line && !content.includes(line))
    : [];
  let vars = VARS;
  if (isStaff) vars = ['%이름'];
  if (isDirect) vars = [];

  return (
    <section className="mc-section">
      <details className="mc-card">
        <summary className="mc-section-title"><Icon name={ICON_NAME.bulk_message} size={20} aria-hidden="true" /> 검색으로 단체/개인 문자 발송 <span className="mc-tag" style={{ background: '#0a6e49' }}>목록·검색·누적</span><Icon name="chevronDown" size={18} className="mc-disclosure-icon" aria-hidden="true" /></summary>
        <div className="bulk-split">
          <div className="bulk-left">
            <p className="bulk-col-title">받는 사람</p>
            <div className="mc-seg" role="group" aria-label="수신 대상 종류" style={{ marginBottom: 8 }}>
              <button type="button" className={audience === 'student' ? 'on' : ''} aria-pressed={audience === 'student'} onClick={() => selectAudience('student')}>학생</button>
              <button type="button" className={audience === 'staff' ? 'on' : ''} aria-pressed={audience === 'staff'} onClick={() => selectAudience('staff')}>교직원</button>
              <button type="button" className={audience === 'direct' ? 'on' : ''} aria-pressed={audience === 'direct'} onClick={() => selectAudience('direct')}>번호 입력</button>
            </div>
            {isDirect ? <>
              <div className="mc-content-head">
                <p className="mc-field-label">수신번호 (줄바꿈/쉼표로 여러 명) · {checkedCount}명</p>
                <div className="mc-vars">
                  <button type="button" className="mc-var-btn mc-icon-btn" onClick={() => fileRef.current?.click()}><Icon name={ICON_NAME.upload} size={14} aria-hidden="true" /> Excel·CSV 업로드</button>
                  <button type="button" className="mc-var-btn" onClick={downloadRecipientSample}>양식 다운로드</button>
                </div>
              </div>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" aria-label="번호 파일 업로드" style={{ display: 'none' }} onChange={onRecipientFile} />
              <textarea aria-label="수신번호 목록" className="mc-textarea" value={directRecipients}
                onChange={(e) => { setDirectRecipients(e.target.value); setDirectConsentConfirmed(false); resetReqId(); }}
                placeholder={'010-1234-5678\n010-9876-5432'} />
              <div className="bulk-cart"><span>발신대상 {checkedCount}명 · 최대 {DIRECT_MAX_RECIPIENTS}명</span></div>
              <p className="mc-field-label" style={{ marginTop: 6 }}>학생·교직원 DB에 없는 번호도 발송할 수 있습니다.</p>
            </> : <>
              {!isStaff ? <div className="bulk-filters">
                <select aria-label="소속" value={branch} onChange={(e) => setBranch(e.target.value)}>
                  <option value="">소속 전체</option><option value="2단지">2단지</option><option value="10단지">10단지</option>
                </select>
                <select aria-label="수신 상태" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="enrolled">재원</option><option value="all">재원+비원생</option><option value="non">비원생</option>
                </select>
                <GradeFilter value={grades} onChange={setGrades} />
              </div> : <div className="bulk-filters">
                <select aria-label="교직원 상태" value={staffStatus} onChange={(e) => setStaffStatus(e.target.value)}>
                  <option value="active">재직</option><option value="inactive">휴직</option><option value="terminated">퇴직</option><option value="all">전체</option>
                </select>
                <select aria-label="교직원 소속" value={staffAffiliation} onChange={(e) => setStaffAffiliation(e.target.value)}>
                  <option value="">소속 전체</option>
                  {staffAffiliations.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>}
              <div className="mc-search">
                <input aria-label="대상 검색" value={q} onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) { e.preventDefault(); commitSearch(); }
                  }}
                  placeholder={isStaff ? '이름·부서·소속 검색 후 엔터' : '이름·학교·반 검색 후 엔터 (예: 노현담, 영도초6, PA101)'} />
                <button onClick={commitSearch} disabled={isStaff && staffLoading}>{staffLoading ? '불러오는 중…' : q.trim() ? `결과 ${matches.length}명 담기` : '검색 결과 담기'}</button>
              </div>
              {isStaff && staffError && <p className="mc-field-label" role="alert">교직원 명단 조회 실패: {staffError}</p>}
              <div className="bulk-cart">
                <span>누적 대상 {checkedCount}명{sources.length ? ` (${sources.join(' + ')})` : ''}</span>
                <span className="bulk-cart-actions">
                  <button onClick={() => setAllOn(true)} disabled={!picked.size}>전체선택</button>
                  <button onClick={clearAll} disabled={!picked.size}>비우기</button>
                </span>
              </div>
              <ul className="bulk-list">
                {rows.map(({ target, on }) => (
                  <li key={target.id} className={on ? '' : 'off'}>
                    <label className="bulk-row">
                      <input type="checkbox" checked={on} onChange={() => toggle(target.id)} />
                      <span className="bulk-name">{target.name}</span>
                      <span className="bulk-meta">{targetMeta(target, isStaff)}</span>
                    </label>
                  </li>
                ))}
                {picked.size === 0 && <li className="bulk-empty">검색해서 대상을 추가하세요.</li>}
              </ul>
            </>}
          </div>

          <div className="bulk-mid">
            <p className="bulk-col-title">메시지</p>
            <div className="mc-routing-grid">
              <span className="mc-field-label">받는이 {isStaff || isDirect ? '(고정)' : kind === 'promo' ? '(단일)' : '(다중 선택)'}</span>
              <span className="mc-field-label mc-kind-label">종류</span>
              <div className="mc-seg">
                {isDirect ? <button type="button" className="on" aria-pressed="true" disabled>입력 번호</button> : isStaff ? <button type="button" className="on" aria-pressed="true" disabled>본인 휴대폰</button> : ['student', 'parent_1', 'parent_2'].map((f) => (
                  <button key={f} type="button" className={recipientFields.has(f) ? 'on' : ''} aria-pressed={recipientFields.has(f)} onClick={() => toggleRecipient(f)}>
                    {RECIPIENT_LABELS[f]}
                  </button>
                ))}
              </div>
              <div className="mc-seg">
                <button type="button" className={kind === 'info' ? 'on' : ''} aria-pressed={kind === 'info'} onClick={() => selectKind('info')}>정보성</button>
                <button type="button" disabled={isStaff} className={kind === 'promo' ? 'on' : ''} aria-pressed={kind === 'promo'} onClick={() => selectKind('promo')}>홍보성</button>
              </div>
            </div>
            <div className="mc-content-head mc-message-tools">
              <p className="mc-field-label">내용</p>
              <div className="mc-vars">
                {vars.map((v) => (
                  <button key={v} type="button" className="mc-var-btn" onClick={() => { setContent((c) => c + v); resetReqId(); }}>{v}</button>
                ))}
                {kind === 'promo' && (
                  <button type="button" className="mc-var-btn" title="발송 시 자동으로 붙지만, 미리보기로 확인하려면 클릭" onClick={() => { setContent((c) => ensurePromoCompliance(c)); resetReqId(); }}>+ (광고)·080</button>
                )}
              </div>
            </div>
            <input ref={imageRef} type="file" accept="image/jpeg,.jpg,.jpeg" aria-label="MMS 사진 첨부" style={{ display: 'none' }} onChange={onMmsImage} />
            <textarea aria-label="메시지 내용" className="mc-textarea bulk-content" value={content} onChange={(e) => { setContent(e.target.value); resetReqId(); }}
              placeholder={kind === 'promo' ? `(광고) [임팩트세븐학원]\n\n...\n\n${OPT_OUT_LINE}` : '안내 내용을 입력하세요.'} />
            <TemplateBar content={content} onPick={(c) => { setContent(c); resetReqId(); }} />
            <div className="mc-meta">
              <span>{meta.chars}자 · {meta.bytes}byte</span>
              <span className={'mc-pill' + (messageType !== 'SMS' ? ' lms' : '')}>{messageType}</span>
              <span>· {checkedCount}명 × {recipientMultiplier} · 예상 {estimatedMessageCount}건</span>
              <label className="mc-mms-toggle"><input type="checkbox" checked={!!mmsImage} onChange={(e) => { if (e.target.checked) imageRef.current?.click(); else { setMmsImage(null); resetReqId(); } }} /> MMS</label>
            </div>
            {kind === 'info' && !isStaff && <div className="mc-promo-checks"><label title={invite}><input type="checkbox" checked={withInvite} onChange={(e) => { setWithInvite(e.target.checked); resetReqId(); }} /> 채널 가입 안내</label><label title={footer || '문구 설정에서 꼬리말을 등록하세요'}><input type="checkbox" checked={withFooter} disabled={!footer} onChange={(e) => { setWithFooter(e.target.checked); resetReqId(); }} /> 학원 꼬리말</label><button type="button" className="mc-var-btn" onClick={() => { setFooterDraft(footer); setInviteDraft(inviteCustom); setSetupOpen(!setupOpen); }}>문구 설정</button></div>}
            {isStaff && <div className="mc-note">교직원 문자는 관리자 이상만 발송할 수 있으며 업무성 정보 문자만 지원합니다.</div>}
            {kind === 'promo' && <div className="mc-promo-checks"><label><input type="checkbox" checked readOnly /> 광고 문구</label><label><input type="checkbox" checked readOnly /> 수신거부</label>{isDirect ? <label><input type="checkbox" checked={directConsentConfirmed} onChange={(e) => { setDirectConsentConfirmed(e.target.checked); resetReqId(); }} /> 광고 수신동의 번호 확인</label> : <label><input type="checkbox" checked readOnly /> 수신동의 번호 자동 확인</label>}</div>}
            {attachedLines.length > 0 && <div className="mc-attached-lines">{attachedLines.join('\n\n')}</div>}
            {mmsImage && <div className="mc-mms-file"><img src={mmsImage.previewUrl} alt="MMS 첨부 미리보기" /><span>{mmsImage.name}<br />{mmsImage.width}×{mmsImage.height}px · {Math.ceil(mmsImage.size / 1024)}KB</span><button type="button" className="mc-var-btn" onClick={() => { setMmsImage(null); resetReqId(); }}>제거</button></div>}
            {kind === 'info' && !isStaff && setupOpen && <div className="mc-message-setup"><label className="mc-field-label">채널 가입 안내 문구 (비우면 기본 문구)</label><textarea aria-label="채널 가입 안내 문구" className="mc-textarea" rows={2} value={inviteDraft} onChange={(e) => setInviteDraft(e.target.value)} placeholder={DEFAULT_CHANNEL_INVITE} maxLength={280} /><label className="mc-field-label">학원 꼬리말</label><input aria-label="학원 꼬리말" className="mc-tpl-title" value={footerDraft} onChange={(e) => setFooterDraft(e.target.value)} placeholder="예: -임팩트세븐학원 02-2649-0509" maxLength={200} /><div className="mc-vars"><button type="button" className="mc-var-btn" disabled={setupBusy} onClick={onSaveSetup}>{setupBusy ? '저장 중…' : '저장'}</button><button type="button" className="mc-var-btn" onClick={() => setSetupOpen(false)}>취소</button></div></div>}
          </div>

          <div className="bulk-right">
            <p className="bulk-col-title">미리보기 &amp; 발송</p>
            <div className="mc-phone">
              <p className="mc-phone-sender">임팩트세븐학원 → {isDirect ? `${checkedCount}명` : firstTarget ? `${firstTarget.name} ${recipientText}` : recipientText}</p>
              <div className={'mc-bubble' + (effectiveContent ? '' : ' empty')}>
                {mmsImage && <img className="mc-preview-image" src={mmsImage.previewUrl} alt="MMS 첨부 미리보기" />}
                {effectiveContent ? applyVars(effectiveContent, firstTarget, isStaff) : '내용을 입력하면 여기에 표시됩니다.'}
              </div>
            </div>
            <p className="mc-preview-foot">{isDirect ? '입력 번호 기준' : firstTarget ? `${firstTarget.name} 기준` : '대상 미선택'} · 실제는 각 대상에게 발송</p>
            <div className="bulk-summary">대상 {checkedCount}명 · 예상 {estimatedMessageCount}건 · 받는이 {recipientText} · {messageType} · {kind === 'promo' ? '홍보성' : '정보성'}</div>
            <div className="bulk-send-row">
              <div className="mc-seg">
                <button type="button" className={when === 'now' ? 'on' : ''} aria-pressed={when === 'now'} onClick={() => setWhen('now')}>즉시</button>
                <button type="button" className={when === 'schedule' ? 'on' : ''} aria-pressed={when === 'schedule'} onClick={() => setWhen('schedule')}>예약</button>
              </div>
              {when === 'schedule' && <input aria-label="예약 발송 시각" type="datetime-local" value={scheduledAt} onChange={(e) => { setScheduledAt(e.target.value); resetReqId(); }} />}
            </div>
            {confirming && (
              <div className="mc-note" role="alertdialog" aria-label="발송 확인" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                <span>
                  {checkedCount}명 · 예상 {estimatedMessageCount}건 · 받는이 {recipientText} · {kind === 'promo' ? '홍보성' : '정보성'}
                  {when === 'schedule' && scheduledAt ? ` · 예약 ${scheduledAt.replace('T', ' ')}` : ' · 즉시 발송'}
                  — 맞으면 아래 버튼을 다시 눌러 발송하세요.
                </span>
                <button type="button" className="mc-var-btn" onClick={() => setConfirming(false)}>취소</button>
              </div>
            )}
            <button className="mc-send bulk-send-btn" disabled={sending} onClick={onSendClick}>
              {sending ? '발송 중…' : confirming ? `확인 후 ${checkedCount}명에게 발송` : `${checkedCount}명에게 발송`}
            </button>
            {msg && <p className="mc-field-label" role="status" aria-live="polite" style={{ marginTop: 8 }}>{msg}</p>}
            {mmsImage && <p className="mc-mms-requirement">{MMS_SIZE_NOTICE}</p>}
            <div className="mc-note" style={{ marginTop: 10 }}>{MESSAGE_KIND_NOTICE[kind]}</div>
          </div>
        </div>
      </details>
    </section>
  );
}
