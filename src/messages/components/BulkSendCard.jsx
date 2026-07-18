import React, { useEffect, useState, useMemo, useRef } from 'react';
import { Icon, IconButton } from '@impact7/ui';
import { filterStaff, filterStudents, staffMatchesQuery, studentMatchesQuery } from '../bulk-select.js';
import { studentFullLabel, currentSchool } from '@impact7/shared/student-label';
import { formatPhone } from '@impact7/shared/phone';
import { allClassCodes } from '../../shared/firestore-helpers.js';
import GradeFilter from '../../dashboard/components/GradeFilter.jsx';
import { MESSAGE_KIND_NOTICE, MMS_SIZE_NOTICE, messageMeta, normalizePhones, onlyDigits, readMmsImage } from '../message-format.js';
import { parsePhonesFromFile, sampleCsv } from '../message-import.js';
import {
  ALIMTALK_NAME_VARIABLE,
  BULK_MAX_MESSAGES,
  alimtalkInputVariables,
  applyAlimtalkPreview,
  buildAlimtalkAudienceRequests,
  buildAudienceRequests,
  completedTargetKeys,
  DIRECT_MAX_RECIPIENTS,
  estimateAudienceMessages,
  groupSelectedTargets,
  invalidVariablesForGroups,
} from '../bulk-send.js';
import { getMessageExtras, saveMessageExtras, composeWithExtras, DEFAULT_CHANNEL_INVITE } from '../sms-extras.js';
import TemplateBar from './TemplateBar.jsx';
import { ICON_NAME } from '../../dashboard/icon-map.js';
import { createBulkMessage, createPromoCampaign, getBulkStaffRecipients, getSolapiAlimtalkTemplates, sendDirectMessage } from '../../../data-layer.js';
// 광고 규제 표기(정보통신망법 §50)는 공용 모듈 — 발송 시 자동 보정, 버튼은 미리보기 확인용.
import { OPT_OUT_LINE, ensurePromoCompliance } from '../../../promo-compliance.js';

// randomUUID는 secure context 전용 — LAN http dev(host:true)용 fallback 유지
function newReqId() { return 'bulk-' + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + '-' + performance.now().toString(36)); }

// 대량 발송 blast radius 제한. 서버가 최종 검증하지만 클라 1차 방어로 오발송 규모를 줄인다. F-02
const BULK_CONFIRM_THRESHOLD = 30; // 이 인원 이상이면 발송 전 확인 단계를 요구

const RECIPIENT_LABELS = { student: '학생', parent_1: '학부모1', parent_2: '학부모2' };
const STATUS_LABELS = { enrolled: '재원', non: '비원생' };
const STAFF_STATUS_LABELS = { all: '전체', active: '재직', inactive: '휴직', terminated: '퇴직' };
const AUDIENCE_LABELS = { student: '학생', staff: '교직원', direct: '번호' };
const AUDIENCE_DISPLAY_ORDER = { direct: 0, staff: 1, student: 2 }; // 누적 목록 표시 순서

// 학생의 현재 반코드(첫 수강). enrollmentCode는 enrollment 객체를 받으므로 학생엔 allClassCodes를 쓴다.
function classOf(s) { return allClassCodes(s)[0] || ''; }

const VARS = ['%이름', '%학교', '%학년', '%반'];
// 미리보기용 변수 치환. 실제 발송 시엔 서버가 학생별로 동일 규칙으로 치환한다.
function applyVars(text, entry) {
  if (!entry || entry.audience === 'direct') return text;
  if (entry.audience === 'staff') return String(text).replaceAll('%이름', entry.target.name || '');
  const s = entry.target;
  if (!s) return text;
  return String(text)
    .replaceAll('%이름', s.name || '')
    .replaceAll('%학교', currentSchool(s) || '')
    .replaceAll('%학년', s.grade != null ? String(s.grade) : '')
    .replaceAll('%반', classOf(s));
}

function targetMeta(entry) {
  const { audience, target } = entry;
  if (audience === 'direct') return '직접 입력 번호';
  if (audience === 'staff') {
    return [STAFF_STATUS_LABELS[target.status], target.department, target.affiliation, target.phoneAvailable ? '' : '번호 없음']
      .filter(Boolean)
      .join(' · ');
  }
  const classCode = classOf(target);
  return `${studentFullLabel(target)}${classCode ? ` · ${classCode}` : ''}`;
}

function targetName(entry) {
  return entry.audience === 'direct' ? formatPhone(entry.target.id) : entry.target.name;
}

function responseSummary(audience, response, fallbackCount) {
  if (response.duplicate) return `${AUDIENCE_LABELS[audience]} 중복 요청`;
  const stats = audience === 'direct'
    ? { queued: response.queued, skipped_invalid: response.invalid?.length }
    : (response.stats || {});
  const parts = [`${AUDIENCE_LABELS[audience]} ${stats.queued ?? fallbackCount}건`];
  if (stats.ad_sms != null) parts[0] = `${AUDIENCE_LABELS[audience]} 문자광고 ${stats.ad_sms || 0}건`;
  if (stats.deduped) parts.push(`중복번호 ${stats.deduped} 합침`);
  if (stats.skipped_no_consent) parts.push(`미동의 ${stats.skipped_no_consent}`);
  if (stats.skipped_no_phone) parts.push(`번호없음 ${stats.skipped_no_phone}`);
  if (stats.skipped_invalid) parts.push(`무효번호 ${stats.skipped_invalid}`);
  if (stats.skipped_revoked) parts.push(`수신거부 ${stats.skipped_revoked}`);
  return parts.join(' · ');
}

export default function BulkSendCard({ students = [] }) {
  const [channel, setChannel] = useState('sms');
  const [audience, setAudience] = useState('student');
  const [staff, setStaff] = useState([]);
  const [staffLoaded, setStaffLoaded] = useState(false);
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffError, setStaffError] = useState('');
  const [staffStatus, setStaffStatus] = useState('active');
  const [staffAffiliation, setStaffAffiliation] = useState('');
  const [staffDepartment, setStaffDepartment] = useState('');
  const [directRecipients, setDirectRecipients] = useState('');
  const [directConsentConfirmed, setDirectConsentConfirmed] = useState(false);
  const [branch, setBranch] = useState('');
  const [grades, setGrades] = useState(new Set());
  const [status, setStatus] = useState('enrolled'); // 기본 재원
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => new Map()); // audience:id -> { audience, target, on }
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
  const [alimtalkTemplates, setAlimtalkTemplates] = useState([]);
  const [alimtalkLoading, setAlimtalkLoading] = useState(false);
  const [alimtalkError, setAlimtalkError] = useState('');
  const [alimtalkTemplateId, setAlimtalkTemplateId] = useState('');
  const [alimtalkValues, setAlimtalkValues] = useState({});
  const reqIdRef = useRef(newReqId());
  const fileRef = useRef(null);
  const imageRef = useRef(null);
  const isStaff = audience === 'staff';
  const isDirect = audience === 'direct';
  const isAlimtalk = channel === 'alimtalk';
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

  useEffect(() => {
    if (!isAlimtalk || alimtalkTemplates.length) return;
    loadAlimtalkTemplates();
  }, [isAlimtalk, alimtalkTemplates.length]);

  const matches = useMemo(() => {
    if (isDirect) return [];
    if (isStaff) return filterStaff(staff, { status: staffStatus, affiliation: staffAffiliation, department: staffDepartment, q });
    return filterStudents(students, { branch, grades, status, q });
  }, [isDirect, isStaff, students, staff, branch, grades, status, staffStatus, staffAffiliation, staffDepartment, q]);
  const rows = useMemo(() => [...picked.values()], [picked]);
  // 검색어는 새로 담을 대상뿐 아니라 이미 담긴 누적 목록도 함께 좁힌다(목록 안에서 학생 찾기).
  const displayRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = !needle ? rows : rows.filter((entry) => {
      if (entry.audience === 'student') return studentMatchesQuery(entry.target, needle);
      if (entry.audience === 'staff') return staffMatchesQuery(entry.target, needle);
      const digits = onlyDigits(needle);
      return Boolean(digits) && entry.target.id.includes(digits);
    });
    return [...filtered].sort((a, b) => AUDIENCE_DISPLAY_ORDER[a.audience] - AUDIENCE_DISPLAY_ORDER[b.audience]);
  }, [rows, q]);
  const selectedGroups = useMemo(() => groupSelectedTargets(rows), [rows]);
  const selectedAlimtalkTemplate = useMemo(
    () => alimtalkTemplates.find((template) => template.templateId === alimtalkTemplateId) || null,
    [alimtalkTemplates, alimtalkTemplateId],
  );
  const alimtalkVariables = useMemo(() => alimtalkInputVariables(selectedAlimtalkTemplate), [selectedAlimtalkTemplate]);
  const selectedCount = selectedGroups.student.length + selectedGroups.staff.length + selectedGroups.direct.length;
  const directPhones = useMemo(() => [...new Set(normalizePhones(directRecipients))], [directRecipients]);
  const estimatedMessageCount = estimateAudienceMessages(selectedGroups, [...recipientFields]);
  const hasStaffTargets = selectedGroups.staff.length > 0;
  const hasDirectTargets = selectedGroups.direct.length > 0;
  // 직접 번호는 이름 자동 주입이 안 되므로 #{학생명}도 입력 변수로 요구한다.
  const alimtalkNameInputNeeded = hasDirectTargets
    && (selectedAlimtalkTemplate?.variables || []).includes(ALIMTALK_NAME_VARIABLE);
  const alimtalkManualVariables = alimtalkNameInputNeeded
    ? [ALIMTALK_NAME_VARIABLE, ...alimtalkVariables]
    : alimtalkVariables;
  const staffAffiliations = useMemo(
    () => [...new Set(staff.map((person) => person.affiliation).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko')),
    [staff],
  );
  const staffDepartments = useMemo(
    () => [...new Set(staff.map((person) => person.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko')),
    [staff],
  );

  async function loadAlimtalkTemplates() {
    setAlimtalkLoading(true);
    setAlimtalkError('');
    try {
      const result = await getSolapiAlimtalkTemplates();
      setAlimtalkTemplates(result.templates || []);
    } catch (error) {
      setAlimtalkError(error?.message || String(error));
    } finally {
      setAlimtalkLoading(false);
    }
  }

  // 담긴 대상·받는이 선택은 채널 전환에도 유지한다. 알림톡은 정보성만이라 종류만 고정.
  function selectChannel(nextChannel) {
    if (nextChannel === channel) return;
    setChannel(nextChannel);
    setConfirming(false);
    setMsg('');
    if (nextChannel === 'alimtalk') setKind('info');
    resetReqId();
  }

  function selectAlimtalkTemplate(templateId) {
    setAlimtalkTemplateId(templateId);
    setAlimtalkValues({});
    resetReqId();
  }

  function commitSearch() {
    if (isStaff && kind === 'promo') { setMsg('교직원은 정보성 문자에서만 추가할 수 있습니다.'); return; }
    if (!matches.length) { setMsg(q.trim() ? `"${q.trim()}" 결과 없음` : '추가할 대상이 없습니다.'); return; }
    const fresh = matches.filter((target) => !picked.has(`${audience}:${target.id}`));
    if (!fresh.length) { setQ(''); setMsg('검색 결과가 모두 이미 담겨 있습니다.'); return; }
    setPicked((prev) => {
      const next = new Map(prev);
      for (const target of fresh) next.set(`${audience}:${target.id}`, { audience, target, on: true });
      return next;
    });
    const dup = matches.length - fresh.length;
    setQ(''); setMsg(`${fresh.length}명 추가${dup ? ` · ${dup}명 이미 담김` : ''}`); resetReqId();
  }
  function toggle(key) {
    const entry = picked.get(key);
    setPicked((prev) => { const n = new Map(prev); const e = n.get(key); if (e) n.set(key, { ...e, on: !e.on }); return n; });
    if (entry?.audience === 'direct') setDirectConsentConfirmed(false);
    resetReqId();
  }
  function setAllOn(on) {
    setPicked((prev) => { const n = new Map(); for (const [k, v] of prev) n.set(k, { ...v, on }); return n; });
    setDirectConsentConfirmed(false);
    resetReqId();
  }
  function clearAll() { setPicked(new Map()); setDirectConsentConfirmed(false); resetReqId(); }
  function selectAudience(nextAudience) {
    if (nextAudience === audience) return;
    setAudience(nextAudience);
    setQ('');
  }

  function addDirectTargets(phones) {
    const added = [...new Set(phones)].filter((phone) => !picked.has(`direct:${phone}`));
    if (!added.length) return 0;
    setPicked((prev) => {
      const next = new Map(prev);
      for (const phone of added) next.set(`direct:${phone}`, { audience: 'direct', target: { id: phone }, on: true });
      return next;
    });
    setDirectConsentConfirmed(false);
    resetReqId();
    return added.length;
  }

  function commitDirectRecipients() {
    if (!directPhones.length) { setMsg('유효한 수신번호를 입력하세요.'); return; }
    const added = addDirectTargets(directPhones);
    setDirectRecipients('');
    setMsg(`${directPhones.length}개 인식 · ${added}개 추가`);
  }

  async function onRecipientFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const phones = await parsePhonesFromFile(file);
      const added = addDirectTargets(phones);
      setMsg(`${file.name} — ${phones.length}개 인식 · ${added}개 추가`);
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
    if (k === 'promo' && hasStaffTargets) { setMsg('교직원은 정보성 문자만 지원합니다.'); return; }
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
      const image = await readMmsImage(file);
      setMmsImage(image);
      setMsg(image.converted
        ? `${file.name} → JPG 변환·압축 (${Math.ceil(image.size / 1024)}KB) · MMS로 발송됩니다.`
        : `${file.name} 첨부 완료 · MMS로 발송됩니다.`);
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
    if (isAlimtalk) {
      if (!selectedAlimtalkTemplate) { setMsg('솔라피 승인 템플릿을 선택하세요.'); return; }
      if (!selectedAlimtalkTemplate.sendable) { setMsg(selectedAlimtalkTemplate.unavailableReason || '발송할 수 없는 템플릿입니다.'); return; }
      const emptyVariable = alimtalkManualVariables.find((variable) => !String(alimtalkValues[variable] || '').trim());
      if (emptyVariable) { setMsg(`${emptyVariable} 값을 입력하세요.`); return; }
    }
    if (directPhones.length) { setMsg('입력한 번호를 먼저 누적 대상에 담아주세요.'); return; }
    if (!selectedCount) { setMsg('대상이 없습니다. 학생·교직원·번호를 추가하세요.'); return; }
    if (!isAlimtalk && !content.trim()) { setMsg('내용을 입력하세요.'); return; }
    if (kind === 'promo' && hasStaffTargets) { setMsg('교직원은 홍보성 문자 대상에 포함할 수 없습니다.'); return; }
    if (kind === 'promo' && hasDirectTargets && !directConsentConfirmed) { setMsg('직접 입력 번호의 광고 수신동의를 확인하세요.'); return; }
    const invalidVariables = isAlimtalk ? [] : invalidVariablesForGroups(selectedGroups, effectiveContent);
    if (invalidVariables.length) { setMsg(`선택한 대상과 함께 보낼 수 없는 변수입니다: ${invalidVariables.join('·')}`); return; }
    if (when === 'schedule' && !scheduledAt) { setMsg('예약 시각을 입력하세요.'); return; }
    if (selectedGroups.direct.length > DIRECT_MAX_RECIPIENTS) {
      setMsg(`직접 입력 번호는 한 번에 최대 ${DIRECT_MAX_RECIPIENTS}명까지 발송할 수 있습니다.`);
      return;
    }
    if (estimatedMessageCount > BULK_MAX_MESSAGES) {
      setMsg(`한 번에 최대 ${BULK_MAX_MESSAGES}건까지 발송할 수 있습니다 (현재 예상 ${estimatedMessageCount}건).`);
      return;
    }
    if (selectedCount >= BULK_CONFIRM_THRESHOLD && !confirming) { setConfirming(true); setMsg(''); return; }
    doSend();
  }

  async function doSend() {
    setConfirming(false);
    setSending(true); setMsg('');
    try {
      // 홍보는 (광고)·080 표기를 발송 직전 자동 보정 — 깜빡해도 법적 표기가 빠지지 않는다.
      const normalizedSchedule = when === 'schedule' ? `${scheduledAt.slice(0, 16).replace('T', ' ')}:00` : '';
      const requests = isAlimtalk ? buildAlimtalkAudienceRequests({
        groups: selectedGroups,
        recipientFields: [...recipientFields],
        templateId: selectedAlimtalkTemplate.templateId,
        templateVariables: alimtalkValues,
        requestId: reqIdRef.current,
        scheduledAt: normalizedSchedule,
      }) : buildAudienceRequests({
        groups: selectedGroups,
        recipientFields: [...recipientFields],
        content: effectiveContent,
        kind,
        consentConfirmed: directConsentConfirmed,
        requestId: reqIdRef.current,
        scheduledAt: normalizedSchedule,
        mmsImage: mmsImage ? { name: mmsImage.name, dataBase64: mmsImage.dataBase64 } : null,
      });
      const results = await Promise.allSettled(requests.map(async (request) => {
        let response;
        if (request.call === 'direct') response = await sendDirectMessage(request.payload);
        else if (request.call === 'promo') response = await createPromoCampaign(request.payload);
        else response = await createBulkMessage(request.payload);
        return responseSummary(request.audience, response, selectedGroups[request.audience].length);
      }));
      const completed = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length) {
        const completedKeys = completedTargetKeys(requests, results, selectedGroups);
        const failedDetails = results.flatMap((result, index) => result.status === 'rejected'
          ? [`${AUDIENCE_LABELS[requests[index].audience]}: ${result.reason?.message || result.reason}`]
          : []);
        setPicked((prev) => {
          const next = new Map(prev);
          for (const key of completedKeys) next.delete(key);
          return next;
        });
        setDirectConsentConfirmed(false);
        setMsg(`일부 발송 실패 — ${completed.join(' / ') || '접수 없음'} · ${failedDetails.join(' / ')}`);
        return;
      }
      setMsg('발송 접수 — ' + completed.join(' / '));
      clearAll(); setDirectRecipients(''); setContent(''); setMmsImage(null); setAlimtalkValues({});
    } catch (e) {
      setMsg('발송 실패: ' + (e?.message || e));
    } finally { setSending(false); }
  }

  const baseContent = kind === 'info'
    ? composeWithExtras(content, [withInvite ? invite : '', withFooter ? footer : ''])
    : content;
  const effectiveContent = kind === 'promo' ? ensurePromoCompliance(baseContent) : baseContent;
  const meta = messageMeta(effectiveContent);
  const firstEntry = rows.find((entry) => entry.on);
  const alimtalkPreviewName = firstEntry?.audience === 'direct'
    ? (alimtalkValues[ALIMTALK_NAME_VARIABLE] || ALIMTALK_NAME_VARIABLE)
    : (firstEntry?.target?.name || ALIMTALK_NAME_VARIABLE);
  const previewContent = isAlimtalk
    ? applyAlimtalkPreview(selectedAlimtalkTemplate, alimtalkValues, alimtalkPreviewName)
    : effectiveContent;
  let previewText = '내용을 입력하면 여기에 표시됩니다.';
  if (isAlimtalk) previewText = previewContent || '템플릿을 선택하면 여기에 표시됩니다.';
  else if (previewContent) previewText = applyVars(previewContent, firstEntry);
  let messageType = meta.type;
  if (mmsImage) messageType = 'MMS';
  if (isAlimtalk) messageType = '알림톡';
  let messageCategory = kind === 'promo' ? '홍보성' : '정보성';
  if (isAlimtalk) messageCategory = '승인 템플릿';
  const recipientParts = [];
  if (selectedGroups.student.length || !selectedCount) recipientParts.push(`학생 ${[...recipientFields].map((field) => RECIPIENT_LABELS[field]).join('·')}`);
  if (hasStaffTargets) recipientParts.push('교직원 본인');
  if (hasDirectTargets) recipientParts.push('입력 번호');
  const recipientText = recipientParts.join(' / ');
  const attachedLines = !isAlimtalk && kind === 'info'
    ? [withInvite ? invite : '', withFooter ? footer : ''].filter((line) => line && !content.includes(line))
    : [];
  let vars = hasStaffTargets ? ['%이름'] : VARS;
  if (hasDirectTargets) vars = [];

  return (
    <section className="mc-section">
      <div className="mc-card">
        <h2 className="mc-section-title"><Icon name={ICON_NAME.bulk_message} size={20} aria-hidden="true" /> 단체 메시지</h2>
        <div className="mc-seg mc-channel-seg" role="group" aria-label="발송 채널">
          <button type="button" disabled={sending} className={!isAlimtalk ? 'on' : ''} aria-pressed={!isAlimtalk} onClick={() => selectChannel('sms')}>문자</button>
          <button type="button" disabled={sending} className={isAlimtalk ? 'on' : ''} aria-pressed={isAlimtalk} onClick={() => selectChannel('alimtalk')}>알림톡</button>
        </div>
        <fieldset className="bulk-split bulk-send-fieldset" disabled={sending}>
          <div className="bulk-left">
            <p className="bulk-col-title">받는 사람</p>
            <div className="mc-seg" role="group" aria-label="수신 대상 종류" style={{ marginBottom: 8 }}>
              <button type="button" className={audience === 'student' ? 'on' : ''} aria-pressed={audience === 'student'} onClick={() => selectAudience('student')}>학생</button>
              <button type="button" className={audience === 'staff' ? 'on' : ''} aria-pressed={audience === 'staff'} onClick={() => selectAudience('staff')}>교직원</button>
              <button type="button" className={audience === 'direct' ? 'on' : ''} aria-pressed={audience === 'direct'} onClick={() => selectAudience('direct')}>번호 입력</button>
            </div>
            {isDirect ? <>
              <div className="mc-content-head">
                <p className="mc-field-label">수신번호 (줄바꿈/쉼표로 여러 명) · 입력 {directPhones.length}명</p>
                <div className="mc-vars mc-file-actions">
                  <IconButton icon={ICON_NAME.upload} label="Excel·CSV 업로드" onClick={() => fileRef.current?.click()} />
                  <IconButton icon={ICON_NAME.download} label="양식 다운로드" onClick={downloadRecipientSample} />
                </div>
              </div>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" aria-label="번호 파일 업로드" style={{ display: 'none' }} onChange={onRecipientFile} />
              <textarea aria-label="수신번호 목록" className="mc-textarea" value={directRecipients}
                onChange={(e) => { setDirectRecipients(e.target.value); resetReqId(); }}
                placeholder={'010-1234-5678\n010-9876-5432'} />
              <button type="button" className="mc-send bulk-add-direct" disabled={!directPhones.length} onClick={commitDirectRecipients}>번호 {directPhones.length}명 담기</button>
              <p className="mc-field-label" style={{ marginTop: 6 }}>DB에 없는 번호도 누적 대상에 추가됩니다. 직접 번호는 최대 {DIRECT_MAX_RECIPIENTS}명입니다.</p>
            </> : <>
              {!isStaff ? <div className="bulk-filters bulk-filters-row">
                <select aria-label="소속" value={branch} onChange={(e) => setBranch(e.target.value)}>
                  <option value="">소속 전체</option><option value="2단지">2단지</option><option value="10단지">10단지</option>
                </select>
                <select aria-label="수신 상태" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="all">전체</option><option value="enrolled">재원</option><option value="non">비원생</option>
                </select>
                <GradeFilter value={grades} onChange={setGrades} compact />
              </div> : <div className="bulk-filters bulk-filters-row">
                <select aria-label="교직원 상태" value={staffStatus} onChange={(e) => setStaffStatus(e.target.value)}>
                  <option value="active">재직</option><option value="inactive">휴직</option><option value="terminated">퇴직</option><option value="all">전체</option>
                </select>
                <select aria-label="교직원 소속" value={staffAffiliation} onChange={(e) => setStaffAffiliation(e.target.value)}>
                  <option value="">소속 전체</option>
                  {staffAffiliations.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
                <select aria-label="교직원 부서" value={staffDepartment} onChange={(e) => setStaffDepartment(e.target.value)}>
                  <option value="">부서 전체</option>
                  {staffDepartments.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>}
              <div className="mc-search">
                <input aria-label="대상 검색" value={q} onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) { e.preventDefault(); commitSearch(); }
                  }}
                  placeholder={isStaff ? '이름·부서·소속 검색 후 엔터' : '이름·학교·반·전화번호 검색 후 엔터 (예: 노현담, 영도초6, 5678)'} />
                <button onClick={commitSearch} disabled={isStaff && staffLoading}>{staffLoading ? '불러오는 중…' : q.trim() ? `결과 ${matches.length}명 담기` : '검색 결과 담기'}</button>
              </div>
              {isStaff && staffError && <p className="mc-field-label" role="alert">교직원 명단 조회 실패: {staffError}</p>}
            </>}
            <div className="bulk-cart">
              <span>누적 대상 {selectedCount}명{q.trim() && picked.size ? ` · 검색 일치 ${displayRows.length}명` : ''}</span>
              <span className="bulk-cart-actions">
                <IconButton icon="check-circle" label="전체선택" disabled={!picked.size} onClick={() => setAllOn(true)} />
                <IconButton icon="trash" label="비우기" disabled={!picked.size} onClick={clearAll} />
              </span>
            </div>
            <ul className="bulk-list">
              {displayRows.map((entry) => {
                const key = `${entry.audience}:${entry.target.id}`;
                return (
                  <li key={key} className={entry.on ? '' : 'off'}>
                    <label className="bulk-row">
                      <input type="checkbox" checked={entry.on} onChange={() => toggle(key)} />
                      <span className={`bulk-type ${entry.audience}`}>{AUDIENCE_LABELS[entry.audience]}</span>
                      <span className="bulk-name">{targetName(entry)}</span>
                      <span className="bulk-meta">{targetMeta(entry)}</span>
                    </label>
                  </li>
                );
              })}
              {picked.size === 0 && <li className="bulk-empty">학생·교직원·번호를 추가하면 여기에 함께 표시됩니다.</li>}
              {picked.size > 0 && displayRows.length === 0 && <li className="bulk-empty">"{q.trim()}" 일치하는 누적 대상이 없습니다.</li>}
            </ul>
          </div>

          <div className="bulk-mid">
            <p className="bulk-col-title">메시지</p>
            {isAlimtalk ? <>
              <div className="mc-routing-grid">
                <span className="mc-field-label">받는이 (다중 선택)</span>
                <span className="mc-field-label mc-kind-label">종류</span>
                <div className="mc-seg">
                  {['student', 'parent_1', 'parent_2'].map((f) => (
                    <button key={f} type="button" className={recipientFields.has(f) ? 'on' : ''} aria-pressed={recipientFields.has(f)} onClick={() => toggleRecipient(f)}>
                      {RECIPIENT_LABELS[f]}
                    </button>
                  ))}
                </div>
                <div className="mc-seg"><button type="button" className="on" aria-disabled="true">정보성</button></div>
              </div>
              <label className="mc-field-label" htmlFor="alimtalk-template">솔라피 승인 템플릿</label>
              <div className="mc-tpl mc-alimtalk-select">
                <select id="alimtalk-template" value={alimtalkTemplateId} onChange={(e) => selectAlimtalkTemplate(e.target.value)} disabled={alimtalkLoading}>
                  <option value="">{alimtalkLoading ? '템플릿 불러오는 중…' : '템플릿 선택'}</option>
                  {alimtalkTemplates.map((template) => (
                    <option key={template.templateId} value={template.templateId}>
                      {template.name}{template.sendable ? '' : ` — ${template.unavailableReason}`}
                    </option>
                  ))}
                </select>
                <button type="button" className="mc-var-btn" disabled={alimtalkLoading} onClick={loadAlimtalkTemplates}>새로고침</button>
              </div>
              {alimtalkError && <div className="mc-note" role="alert">템플릿 조회 실패: {alimtalkError}</div>}
              {selectedAlimtalkTemplate && <>
                <div className="mc-alimtalk-template">{selectedAlimtalkTemplate.content}</div>
                {!selectedAlimtalkTemplate.sendable && <div className="mc-note">발송 불가: {selectedAlimtalkTemplate.unavailableReason}</div>}
                {alimtalkManualVariables.length > 0 && <div className="mc-alimtalk-vars">
                  {alimtalkManualVariables.map((variable) => (
                    <label key={variable}>
                      <span className="mc-field-label">{variable === ALIMTALK_NAME_VARIABLE ? `${variable} (번호 입력 대상)` : variable}</span>
                      <input value={alimtalkValues[variable] || ''} maxLength={1000} onChange={(e) => {
                        setAlimtalkValues((prev) => ({ ...prev, [variable]: e.target.value }));
                        resetReqId();
                      }} />
                    </label>
                  ))}
                </div>}
                {selectedAlimtalkTemplate.buttons.length > 0 && <div className="mc-alimtalk-buttons">
                  {selectedAlimtalkTemplate.buttons.map((button, index) => <span key={`${button.name}-${index}`}>{button.name}</span>)}
                </div>}
              </>}
              <div className="mc-meta">
                <span className="mc-pill lms">알림톡</span>
                <span>대상 {selectedCount}명 · 예상 {estimatedMessageCount}건</span>
              </div>
            </> : <>
            <div className="mc-routing-grid">
              <span className="mc-field-label">받는이 {audience === 'student' ? (kind === 'promo' ? '(단일)' : '(다중 선택)') : '(고정)'}</span>
              <span className="mc-field-label mc-kind-label">종류</span>
              {audience === 'student' ? <div className="mc-seg">
                {['student', 'parent_1', 'parent_2'].map((f) => (
                  <button key={f} type="button" className={recipientFields.has(f) ? 'on' : ''} aria-pressed={recipientFields.has(f)} onClick={() => toggleRecipient(f)}>
                    {RECIPIENT_LABELS[f]}
                  </button>
                ))}
              </div> : <div className="mc-seg">
                <button type="button" className="on" aria-disabled="true" style={{ cursor: 'default' }}>{isStaff ? '교직원 본인' : '입력 번호'}</button>
              </div>}
              <div className="mc-seg">
                <button type="button" className={kind === 'info' ? 'on' : ''} aria-pressed={kind === 'info'} onClick={() => selectKind('info')}>정보성</button>
                <button type="button" disabled={hasStaffTargets} title={hasStaffTargets ? '교직원은 정보성 문자만 지원합니다.' : ''} className={kind === 'promo' ? 'on' : ''} aria-pressed={kind === 'promo'} onClick={() => selectKind('promo')}>홍보성</button>
              </div>
            </div>
            <p className="mc-recipient-fixed">교직원은 본인 휴대폰, 직접 입력은 입력 번호로 발송됩니다.</p>
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
            <input ref={imageRef} type="file" accept="image/*,.pdf,application/pdf" aria-label="MMS 사진 첨부" style={{ display: 'none' }} onChange={onMmsImage} />
            <textarea aria-label="메시지 내용" className="mc-textarea bulk-content" value={content} onChange={(e) => { setContent(e.target.value); resetReqId(); }}
              placeholder={kind === 'promo' ? `(광고) [임팩트세븐학원]\n\n...\n\n${OPT_OUT_LINE}` : '안내 내용을 입력하세요.'} />
            <TemplateBar content={content} onPick={(c) => { setContent(c); resetReqId(); }} />
            <div className="mc-meta">
              <span>{meta.chars}자 · {meta.bytes}byte</span>
              <span className={'mc-pill' + (messageType !== 'SMS' ? ' lms' : '')}>{messageType}</span>
              <span>· 대상 {selectedCount}명 · 예상 {estimatedMessageCount}건</span>
              <label className="mc-mms-toggle"><input type="checkbox" checked={!!mmsImage} onChange={(e) => { if (e.target.checked) imageRef.current?.click(); else { setMmsImage(null); resetReqId(); } }} /> MMS</label>
            </div>
            {kind === 'info' && <div className="mc-promo-checks"><label title={invite}><input type="checkbox" checked={withInvite} onChange={(e) => { setWithInvite(e.target.checked); resetReqId(); }} /> 채널 가입 안내</label><label title={footer || '문구 설정에서 꼬리말을 등록하세요'}><input type="checkbox" checked={withFooter} disabled={!footer} onChange={(e) => { setWithFooter(e.target.checked); resetReqId(); }} /> 학원 꼬리말</label><IconButton icon="gear" label="문구 설정" aria-expanded={setupOpen} onClick={() => { setFooterDraft(footer); setInviteDraft(inviteCustom); setSetupOpen(!setupOpen); }} /></div>}
            {hasStaffTargets && <div className="mc-note">교직원 문자는 관리자 이상만 발송할 수 있으며 업무성 정보 문자만 지원합니다.</div>}
            {kind === 'promo' && <div className="mc-promo-checks"><label><input type="checkbox" checked readOnly /> 광고 문구</label><label><input type="checkbox" checked readOnly /> 수신거부</label>{hasDirectTargets ? <label><input type="checkbox" checked={directConsentConfirmed} onChange={(e) => { setDirectConsentConfirmed(e.target.checked); resetReqId(); }} /> 직접 번호 광고 수신동의 확인</label> : <label><input type="checkbox" checked readOnly /> 학생 수신동의 자동 확인</label>}</div>}
            {attachedLines.length > 0 && <div className="mc-attached-lines">{attachedLines.join('\n\n')}</div>}
            {mmsImage && <div className="mc-mms-file"><img src={mmsImage.previewUrl} alt="MMS 첨부 미리보기" /><span>{mmsImage.name}<br />{mmsImage.width}×{mmsImage.height}px · {Math.ceil(mmsImage.size / 1024)}KB</span><IconButton icon="x" label="첨부 제거" onClick={() => { setMmsImage(null); resetReqId(); }} /></div>}
            {kind === 'info' && setupOpen && <div className="mc-message-setup"><label className="mc-field-label">채널 가입 안내 문구 (비우면 기본 문구)</label><textarea aria-label="채널 가입 안내 문구" className="mc-textarea" rows={2} value={inviteDraft} onChange={(e) => setInviteDraft(e.target.value)} placeholder={DEFAULT_CHANNEL_INVITE} maxLength={280} /><label className="mc-field-label">학원 꼬리말</label><input aria-label="학원 꼬리말" className="mc-tpl-title" value={footerDraft} onChange={(e) => setFooterDraft(e.target.value)} placeholder="예: -임팩트세븐학원 02-2649-0509" maxLength={200} /><div className="mc-vars"><button type="button" className="mc-var-btn" disabled={setupBusy} onClick={onSaveSetup}>{setupBusy ? '저장 중…' : '저장'}</button><IconButton icon="x" label="취소" onClick={() => setSetupOpen(false)} /></div></div>}
            </>}
          </div>

          <div className="bulk-right">
            <p className="bulk-col-title">미리보기 &amp; 발송</p>
            <div className="mc-phone">
              <p className="mc-phone-sender">임팩트세븐학원 → {firstEntry ? `${targetName(firstEntry)} 외 ${Math.max(0, selectedCount - 1)}명` : '대상 미선택'}</p>
              <div className={'mc-bubble' + (previewContent ? '' : ' empty')}>
                {!isAlimtalk && mmsImage && <img className="mc-preview-image" src={mmsImage.previewUrl} alt="MMS 첨부 미리보기" />}
                {previewText}
                {isAlimtalk && selectedAlimtalkTemplate?.buttons.length > 0 && <div className="mc-preview-buttons">
                  {selectedAlimtalkTemplate.buttons.map((button, index) => <span key={`${button.name}-${index}`}>{button.name}</span>)}
                </div>}
              </div>
            </div>
            <p className="mc-preview-foot">{firstEntry ? `${targetName(firstEntry)} 기준` : '대상 미선택'} · 실제는 선택한 대상별로 발송</p>
            <div className="bulk-summary">대상 {selectedCount}명 · 예상 {estimatedMessageCount}건 · 받는이 {recipientText} · {messageType} · {messageCategory}</div>
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
                  {selectedCount}명 · 예상 {estimatedMessageCount}건 · 받는이 {recipientText} · {isAlimtalk ? '알림톡 ' : ''}{messageCategory}
                  {when === 'schedule' && scheduledAt ? ` · 예약 ${scheduledAt.replace('T', ' ')}` : ' · 즉시 발송'}
                  — 맞으면 아래 버튼을 다시 눌러 발송하세요.
                </span>
                <IconButton icon="x" label="취소" onClick={() => setConfirming(false)} />
              </div>
            )}
            <button className="mc-send bulk-send-btn" disabled={sending} onClick={onSendClick}>
              {sending ? '발송 중…' : confirming ? `확인 후 ${selectedCount}명에게 발송` : `${selectedCount}명에게 발송`}
            </button>
            {msg && <p className="mc-field-label" role="status" aria-live="polite" style={{ marginTop: 8 }}>{msg}</p>}
            {!isAlimtalk && mmsImage && <p className="mc-mms-requirement">{MMS_SIZE_NOTICE}</p>}
            <div className="mc-note" style={{ marginTop: 10 }}>{isAlimtalk ? '솔라피에서 승인된 정보성 템플릿만 발송합니다. 알림톡 전송 실패 시 같은 내용이 SMS/LMS로 자동 대체됩니다.' : MESSAGE_KIND_NOTICE[kind]}</div>
          </div>
        </fieldset>
      </div>
    </section>
  );
}
