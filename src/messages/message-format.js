// 문자 길이/종류 표시용. 솔라피 SMS 기준 90바이트(한글·전각 2바이트, ASCII 1바이트, EUC-KR 근사).
// 90바이트 이하면 SMS(단문), 초과하면 LMS(장문)로 자동 분류된다.
export const SMS_BYTE_LIMIT = 90;
export const LMS_BYTE_LIMIT = 2000;
export const ALIMTALK_CHAR_LIMIT = 1000;
const MMS_MAX_BYTES = 200 * 1024;
const MMS_MAX_WIDTH = 1500;
const MMS_MAX_HEIGHT = 1440;
const SPLIT_BODY_MAX_BYTES = LMS_BYTE_LIMIT - 8;

export const MMS_SIZE_NOTICE = '이미지는 JPG 200KB 이하로 자동 변환·압축됩니다. PDF는 1페이지짜리만 첨부할 수 있습니다.';
export const MESSAGE_KIND_NOTICE = {
  info: '정보성 안내 전용입니다. 광고성 내용은 홍보성으로 전환해 발송하세요.',
  promo: '홍보성 문자는 수신동의 번호에만 발송합니다. 08:00~21:00에만 수신 가능하며, 야간 요청은 다음 허용 시각으로 예약됩니다. (광고)·무료 수신거부 문구를 서버에서도 다시 검증합니다.',
};

export function smsByteLen(text) {
  let n = 0;
  for (const ch of String(text ?? '')) {
    const codePoint = ch.codePointAt(0);
    n += codePoint > 0xffff ? 4 : codePoint > 0x7f ? 2 : 1;
  }
  return n;
}

export function splitSmsText(text) {
  const source = String(text ?? '').trim();
  if (smsByteLen(source) <= LMS_BYTE_LIMIT) return [source];

  const chars = [...source];
  const bodies = [];
  let start = 0;
  while (start < chars.length) {
    let end = start;
    let bytes = 0;
    let lastBreak = -1;
    while (end < chars.length) {
      const nextBytes = smsByteLen(chars[end]);
      if (bytes + nextBytes > SPLIT_BODY_MAX_BYTES) break;
      bytes += nextBytes;
      end += 1;
      if (/\s/.test(chars[end - 1])) lastBreak = end;
    }
    if (end < chars.length && lastBreak > start) {
      let tokenBytes = 0;
      let tokenEnd = lastBreak;
      while (tokenEnd < chars.length && !/\s/.test(chars[tokenEnd])) {
        tokenBytes += smsByteLen(chars[tokenEnd]);
        tokenEnd += 1;
      }
      if (tokenBytes <= SPLIT_BODY_MAX_BYTES) end = lastBreak;
    }
    bodies.push(chars.slice(start, end).join(''));
    start = end;
  }
  if (bodies.length > 99) throw new Error('문자가 너무 길어 최대 99건으로도 나눌 수 없습니다.');
  return bodies.map((body, index) => `[${index + 1}/${bodies.length}] ${body}`);
}

import { digitsOf } from '@impact7/shared/phone';
export { digitsOf as onlyDigits };

// 전화번호 정규화 — 서버 parseRecipients와 동일 규칙(줄바꿈/쉼표 분리 → 숫자만 → 9~11자리).
// 미리보기 건수·파일 인식·실제 발송이 같은 규칙을 쓰도록 단일 소스로 둔다.
export function normalizePhones(raw) {
  return String(raw ?? '')
    .split(/[\n,]+/)
    .map(digitsOf)
    .filter((d) => d.length >= 9 && d.length <= 11);
}

// 작성 영역 하단에 보여줄 요약: 글자수·바이트·종류.
export function messageMeta(text) {
  const s = String(text ?? '');
  const bytes = smsByteLen(s);
  let splitParts = 1;
  if (bytes > LMS_BYTE_LIMIT) {
    try {
      splitParts = splitSmsText(s).length;
    } catch {
      splitParts = 100;
    }
  }
  return {
    chars: [...s].length,
    bytes,
    type: bytes <= SMS_BYTE_LIMIT ? 'SMS' : bytes <= LMS_BYTE_LIMIT ? 'LMS' : '발송 불가',
    limit: bytes <= SMS_BYTE_LIMIT ? SMS_BYTE_LIMIT : LMS_BYTE_LIMIT,
    overLimit: bytes > LMS_BYTE_LIMIT,
    splitParts,
  };
}

export function alimtalkMeta(text, fallbackText = text) {
  const chars = [...String(text ?? '')].length;
  const fallback = messageMeta(fallbackText);
  return {
    chars,
    maxChars: ALIMTALK_CHAR_LIMIT,
    fallbackBytes: fallback.bytes,
    maxFallbackBytes: LMS_BYTE_LIMIT,
    overLimit: chars > ALIMTALK_CHAR_LIMIT || fallback.overLimit,
    splitParts: fallback.splitParts,
  };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('브라우저가 열 수 없는 이미지입니다. JPG·PNG 등 일반 이미지나 PDF를 첨부하세요.'));
    image.onload = () => resolve(image);
    image.src = dataUrl;
  });
}

function base64Bytes(base64) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

// 규격 초과 이미지(포맷 무관)를 JPG 200KB 이하로 변환 — 크기 축소 → 품질 하향 순으로 맞춘다.
function convertToMmsJpeg(source, sourceWidth, sourceHeight, name) {
  let scale = Math.min(1, MMS_MAX_WIDTH / sourceWidth, MMS_MAX_HEIGHT / sourceHeight);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; // PNG 투명 배경이 JPG에서 검정으로 변하는 것 방지
    context.fillRect(0, 0, width, height);
    context.drawImage(source, 0, 0, width, height);
    for (const quality of [0.92, 0.85, 0.75, 0.65, 0.55, 0.45]) {
      const previewUrl = canvas.toDataURL('image/jpeg', quality);
      const dataBase64 = previewUrl.split(',')[1] ?? '';
      const size = base64Bytes(dataBase64);
      if (size <= MMS_MAX_BYTES) {
        return {
          name: name.replace(/\.[^.]*$/, '') + '.jpg',
          dataBase64,
          previewUrl,
          width,
          height,
          size,
          converted: true,
        };
      }
    }
    scale *= 0.75;
  }
  throw new Error('이미지를 200KB 이하로 압축하지 못했습니다. 더 작은 이미지를 사용하세요.');
}

// PDF 1페이지를 캔버스로 렌더 — 여러 페이지면 불가 판정. pdfjs는 PDF 선택 시에만 동적 로드.
async function renderPdfFirstPage(file) {
  const [pdfjs, workerUrl] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url').then((m) => m.default),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  if (pdf.numPages > 1) {
    throw new Error(`${pdf.numPages}페이지 PDF입니다. MMS에는 1페이지짜리 PDF만 첨부할 수 있습니다.`);
  }
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(MMS_MAX_WIDTH / base.width, MMS_MAX_HEIGHT / base.height, 3) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  // display 인텐트는 requestAnimationFrame에 묶여 백그라운드 탭에서 렌더가 멈춘다 — print로 즉시 렌더.
  await page.render({ canvas, viewport, intent: 'print' }).promise;
  return canvas;
}

export async function readMmsImage(file) {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    const canvas = await renderPdfFirstPage(file);
    return convertToMmsJpeg(canvas, canvas.width, canvas.height, file.name);
  }
  const previewUrl = await readFileAsDataUrl(file);
  const image = await loadImageElement(previewUrl);
  const isJpg = /\.jpe?g$/i.test(file.name) && (!file.type || file.type === 'image/jpeg');
  if (isJpg && file.size <= MMS_MAX_BYTES && image.width <= MMS_MAX_WIDTH && image.height <= MMS_MAX_HEIGHT) {
    return {
      name: file.name,
      dataBase64: previewUrl.split(',')[1] ?? '',
      previewUrl,
      width: image.width,
      height: image.height,
      size: file.size,
    };
  }
  return convertToMmsJpeg(image, image.naturalWidth || image.width, image.naturalHeight || image.height, file.name);
}
