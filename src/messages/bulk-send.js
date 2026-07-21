export const BULK_MAX_MESSAGES = 10000;
export const DIRECT_MAX_RECIPIENTS = 100;

export function audienceMaxMessages(audience) {
  return audience === 'direct' ? DIRECT_MAX_RECIPIENTS : BULK_MAX_MESSAGES;
}

export function groupSelectedTargets(rows) {
  const groups = { student: [], staff: [], direct: [] };
  for (const row of rows) {
    if (row.on && groups[row.audience]) groups[row.audience].push(row.target.id);
  }
  return groups;
}

export function estimateAudienceMessages(groups, recipientFields) {
  return groups.student.length * recipientFields.length + groups.staff.length + groups.direct.length;
}

export function invalidVariablesForGroups(groups, content) {
  const variables = groups.direct.length
    ? ['%이름', '%학교', '%학년', '%반']
    : groups.staff.length
      ? ['%학교', '%학년', '%반']
      : [];
  return variables.filter((variable) => content.includes(variable));
}

export const ALIMTALK_NAME_VARIABLE = '#{학생명}';

export function alimtalkInputVariables(template) {
  return [...new Set((template?.variables || []).filter((variable) => variable && variable !== ALIMTALK_NAME_VARIABLE))];
}

export function applyAlimtalkPreview(template, values = {}, recipientName = '') {
  let content = String(template?.content || '').replaceAll(ALIMTALK_NAME_VARIABLE, recipientName);
  for (const variable of alimtalkInputVariables(template)) {
    content = content.replaceAll(variable, String(values[variable] || variable));
  }
  return content;
}

// #{학생명}은 학생·교직원엔 서버가 자동 주입하므로 제외하고, 이름을 모르는 직접 번호에만 전달한다.
export function buildAlimtalkAudienceRequests({ groups, recipientFields, templateId, templateVariables, requestId, scheduledAt }) {
  const schedule = scheduledAt ? { scheduledAt } : {};
  const autoVariables = Object.fromEntries(
    Object.entries(templateVariables).filter(([key]) => key !== ALIMTALK_NAME_VARIABLE),
  );
  const base = { channel: 'alimtalk', templateId };
  const requests = [];
  if (groups.student.length) {
    requests.push({
      audience: 'student',
      call: 'bulk',
      payload: {
        ...base,
        studentIds: groups.student,
        recipientFields,
        recipientField: recipientFields[0],
        templateVariables: autoVariables,
        requestId: `${requestId}-student`,
        ...schedule,
      },
    });
  }
  if (groups.staff.length) {
    requests.push({
      audience: 'staff',
      call: 'bulk',
      payload: { ...base, staffIds: groups.staff, templateVariables: autoVariables, requestId: `${requestId}-staff`, ...schedule },
    });
  }
  if (groups.direct.length) {
    requests.push({
      audience: 'direct',
      call: 'direct',
      payload: { ...base, recipients: groups.direct.join('\n'), templateVariables, requestId: `${requestId}-direct`, ...schedule },
    });
  }
  return requests;
}

export function completedTargetKeys(requests, results, groups) {
  const keys = [];
  results.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;
    const audience = requests[index].audience;
    for (const id of groups[audience]) keys.push(`${audience}:${id}`);
  });
  return keys;
}

export function buildAudienceRequests({ groups, recipientFields, content, kind, consentConfirmed, requestId, scheduledAt, mmsImage }) {
  const requests = [];
  for (const audience of ['student', 'staff', 'direct']) {
    const ids = groups[audience];
    if (!ids.length) continue;
    const request = buildAudienceRequest({
      audience,
      ids,
      recipientFields,
      directRecipients: ids.join('\n'),
      content,
      kind,
      consentConfirmed,
      requestId: `${requestId}-${audience}`,
      scheduledAt,
      mmsImage,
    });
    requests.push({ audience, ...request });
  }
  return requests;
}

export function buildAudienceRequest({
  audience, ids, recipientFields, directRecipients, content, kind,
  consentConfirmed, requestId, scheduledAt, mmsImage,
}) {
  const schedule = scheduledAt ? { scheduledAt } : {};
  const image = mmsImage ? { mmsImage } : {};
  if (audience === 'direct') {
    return {
      call: 'direct',
      payload: {
        recipients: directRecipients,
        text: content,
        messageKind: kind,
        consentConfirmed,
        requestId,
        ...schedule,
        ...image,
      },
    };
  }

  const payload = { title: '문자 발송', content, requestId, ...schedule, ...image };
  if (audience === 'staff') return { call: 'bulk', payload: { ...payload, staffIds: ids } };
  Object.assign(payload, {
    studentIds: ids,
    recipientFields,
    recipientField: recipientFields[0],
  });
  if (kind === 'promo') return { call: 'promo', payload: { ...payload, targeting: 'M' } };
  return { call: 'bulk', payload };
}
