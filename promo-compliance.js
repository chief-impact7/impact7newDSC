// 광고 규제(정보통신망법 §50) 필수 표기 — (광고) 머리말 + 무료수신거부 080.
// 발송 직전 자동 보정(멱등) — BulkSendCard(메시지센터 대량)와 message-card(상세패널 개별)가 공유.
// 080-500-4233 = 솔라피 무료 공용 수신거부 번호. 전화 시 솔라피 수신거부 명단에 등록되고
// 이후 광고 발송이 자동 차단된다(우리 DB 동의 기록과는 optOut080Sweeper가 동기화).
export const OPT_OUT_LINE = '무료수신거부 080-500-4233';

export function ensurePromoCompliance(content) {
  let c = content;
  if (!/\(광고\)/.test(c)) c = '(광고) [임팩트세븐학원]\n' + c;
  if (!/(무료거부|수신거부|080)/.test(c)) c = c.replace(/\s*$/, '') + '\n' + OPT_OUT_LINE;
  return c;
}
