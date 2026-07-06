export const MESSAGE_RECIPIENT_SETTINGS_FIELD = 'message_recipient_settings';

export function defaultRecipientFields(availableFields) {
  if (availableFields.includes('parent_1')) return ['parent_1'];
  return availableFields[0] ? [availableFields[0]] : [];
}

export function normalizeRecipientFields(fields, availableFields) {
  if (!Array.isArray(fields)) return null;
  const allowed = new Set(availableFields);
  const selected = [];
  for (const field of fields) {
    if (!allowed.has(field) || selected.includes(field)) continue;
    selected.push(field);
  }
  return selected;
}

export function resolveRecipientFields(settings, channel, availableFields) {
  const saved = normalizeRecipientFields(settings?.[channel], availableFields);
  return saved ?? defaultRecipientFields(availableFields);
}

export function buildRecipientSettings(alimtalkFields, bmsFields) {
  return {
    alimtalk: [...alimtalkFields],
    bms: [...bmsFields],
  };
}

export function createRecipientSettingsSaveQueue(writeSettings, onError) {
  let chain = Promise.resolve();
  return function enqueue(studentId, settings) {
    const snapshot = buildRecipientSettings(settings.alimtalk ?? [], settings.bms ?? []);
    chain = chain
      .catch(() => {})
      .then(() => writeSettings(studentId, snapshot))
      .catch((err) => {
        onError?.(err, studentId, snapshot);
      });
    return chain;
  };
}
