export const BULK_MAX_MESSAGES = 10000;
export const DIRECT_MAX_RECIPIENTS = 100;

export function audienceMaxMessages(audience) {
  return audience === 'direct' ? DIRECT_MAX_RECIPIENTS : BULK_MAX_MESSAGES;
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
