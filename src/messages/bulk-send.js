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
