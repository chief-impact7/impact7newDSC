// 문자 길이/종류 표시용. 솔라피 SMS 기준 90바이트(한글·전각 2바이트, ASCII 1바이트, EUC-KR 근사).
// 90바이트 이하면 SMS(단문), 초과하면 LMS(장문)로 자동 분류된다.
const SMS_BYTE_LIMIT = 90;
const MMS_MAX_BYTES = 200 * 1024;
const MMS_MAX_WIDTH = 1500;
const MMS_MAX_HEIGHT = 1440;

export const MMS_SIZE_NOTICE = 'MMS 이미지는 200KB 이하만 첨부할 수 있습니다.';
export const MESSAGE_KIND_NOTICE = {
  info: '정보성 안내 전용입니다. 광고성 내용은 홍보성으로 전환해 발송하세요.',
  promo: '홍보성 문자는 수신동의 번호에만 발송합니다. 08:00~21:00에만 수신 가능하며, 야간 요청은 다음 허용 시각으로 예약됩니다. (광고)·무료 수신거부 문구를 서버에서도 다시 검증합니다.',
};

export function smsByteLen(text) {
  let n = 0;
  for (const ch of String(text ?? '')) {
    n += ch.codePointAt(0) > 0x7f ? 2 : 1;
  }
  return n;
}

export { digitsOf as onlyDigits } from '@impact7/shared/phone';

// 전화번호 정규화 — 서버 parseRecipients와 동일 규칙(줄바꿈/쉼표 분리 → 숫자만 → 9~11자리).
// 미리보기 건수·파일 인식·실제 발송이 같은 규칙을 쓰도록 단일 소스로 둔다.
export function normalizePhones(raw) {
  return String(raw ?? '')
    .split(/[\n,]+/)
    .map((s) => s.replace(/\D/g, ''))
    .filter((d) => d.length >= 9 && d.length <= 11);
}

// 작성 영역 하단에 보여줄 요약: 글자수·바이트·종류.
export function messageMeta(text) {
  const s = String(text ?? '');
  const bytes = smsByteLen(s);
  return { chars: [...s].length, bytes, type: bytes <= SMS_BYTE_LIMIT ? 'SMS' : 'LMS', limit: SMS_BYTE_LIMIT };
}

export function readMmsImage(file) {
  if (!/\.jpe?g$/i.test(file.name) || (file.type && file.type !== 'image/jpeg')) {
    return Promise.reject(new Error('MMS는 JPG 이미지만 첨부할 수 있습니다.'));
  }
  if (file.size > MMS_MAX_BYTES) {
    return Promise.reject(new Error(MMS_SIZE_NOTICE));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'));
    reader.onload = () => {
      const previewUrl = String(reader.result ?? '');
      const image = new Image();
      image.onerror = () => reject(new Error('올바른 JPG 이미지가 아닙니다.'));
      image.onload = () => {
        if (image.width > MMS_MAX_WIDTH || image.height > MMS_MAX_HEIGHT) {
          reject(new Error(`MMS 이미지는 최대 ${MMS_MAX_WIDTH}×${MMS_MAX_HEIGHT}px까지 사용할 수 있습니다.`));
          return;
        }
        resolve({
          name: file.name,
          dataBase64: previewUrl.split(',')[1] ?? '',
          previewUrl,
          width: image.width,
          height: image.height,
          size: file.size,
        });
      };
      image.src = previewUrl;
    };
    reader.readAsDataURL(file);
  });
}
