# 학생 개인 성적표 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** impact7newDSC 학생 상세 패널에 "성적표" 탭을 추가하여 기간별 출석/숙제/테스트 집계를 조회한다.

**Architecture:** 기존 `renderStudentDetail()` 함수의 `#detail-cards` 영역에 탭 전환 시스템을 추가한다. 성적표 탭 선택 시 `daily_records` 컬렉션에서 기간별 데이터를 쿼리하여 출석 테이블과 숙제/테스트 O/△/X 집계를 렌더링한다.

**Tech Stack:** Vanilla JS, Firebase Firestore, CSS (기존 스택 유지)

---

### Task 1: Firestore 복합 인덱스 추가

성적표 쿼리는 `student_id == X AND date >= A AND date <= B` 패턴이므로 복합 인덱스가 필요하다.

**Files:**
- Modify: `/Users/jongsooyi/impact7newDSC/firestore.indexes.json`

**Step 1: 인덱스 추가**

```json
{
  "indexes": [
    {
      "collectionGroup": "daily_records",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "student_id", "order": "ASCENDING" },
        { "fieldPath": "date", "order": "ASCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

**Step 2: 인덱스 배포**

Run: `cd /Users/jongsooyi/impact7newDSC && npx firebase deploy --only firestore:indexes`
Expected: 인덱스 배포 성공 (빌드에 수 분 소요될 수 있음)

**Step 3: Commit**

```bash
git add firestore.indexes.json
git commit -m "feat: daily_records 복합 인덱스 추가 (student_id + date)"
```

---

### Task 2: HTML 탭 UI 추가

`#detail-content` 내부에 탭 버튼과 성적표 컨테이너를 추가한다.

**Files:**
- Modify: `/Users/jongsooyi/impact7newDSC/index.html:213-237`

**Step 1: 탭 UI 추가**

`<div id="detail-content">` (line 213) 안에, `#profile-header` (line 228) 바로 아래에 탭 버튼과 성적표 컨테이너를 추가한다:

```html
<!-- 상세 탭 -->
<div class="detail-tabs" id="detail-tabs">
    <button class="detail-tab active" data-tab="daily" onclick="switchDetailTab('daily')">일일현황</button>
    <button class="detail-tab" data-tab="report" onclick="switchDetailTab('report')">성적표</button>
</div>

<!-- 일일현황 (기존 카드들) -->
<div id="detail-cards">
    <!-- 기존 동적 렌더링 카드들 -->
</div>

<!-- 성적표 -->
<div id="report-tab" style="display:none;">
    <div class="report-date-range">
        <input type="date" id="report-start" class="field-input">
        <span class="report-date-sep">~</span>
        <input type="date" id="report-end" class="field-input">
        <button class="btn btn-primary btn-sm" onclick="loadReportCard()">조회</button>
    </div>
    <div id="report-content">
        <div class="detail-card-empty" style="padding:32px;text-align:center;">
            기간을 선택하고 조회를 눌러주세요
        </div>
    </div>
</div>
```

**Step 2: 기존 `#detail-cards` 확인**

기존 `index.html` line 231의 `<div id="detail-cards">` 는 그대로 유지. 탭으로 `#detail-cards`와 `#report-tab`을 토글한다.

**Step 3: 브라우저에서 확인**

Run: `npm run dev` (이미 실행 중이면 생략)
확인: 학생 클릭 시 프로필 헤더 아래에 [일일현황] [성적표] 탭 두 개가 보이는지 확인

**Step 4: Commit**

```bash
git add index.html
git commit -m "feat: 학생 상세 패널에 성적표 탭 HTML 추가"
```

---

### Task 3: 탭 전환 CSS 스타일

**Files:**
- Modify: `/Users/jongsooyi/impact7newDSC/daily-ops.css`

**Step 1: 탭 스타일 추가**

파일 끝에 추가:

```css
/* ─── 상세 패널 탭 ─── */
.detail-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    padding: 0 16px;
    background: var(--surface);
}
.detail-tab {
    padding: 10px 16px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-sec);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
}
.detail-tab:hover { color: var(--text-main); }
.detail-tab.active {
    color: var(--primary);
    border-bottom-color: var(--primary);
}

/* ─── 성적표 ─── */
.report-date-range {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
}
.report-date-range .field-input {
    flex: 1;
    padding: 6px 8px;
    font-size: 13px;
}
.report-date-sep {
    color: var(--text-sec);
    font-size: 13px;
}
.btn-sm {
    padding: 6px 14px;
    font-size: 12px;
    min-width: auto;
}

/* 출석 테이블 */
.report-attendance-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
}
.report-attendance-table th {
    text-align: left;
    padding: 6px 8px;
    font-weight: 500;
    color: var(--text-sec);
    border-bottom: 1px solid var(--border);
    font-size: 11px;
}
.report-attendance-table td {
    padding: 5px 8px;
    border-bottom: 1px solid var(--border-light, #f0f0f0);
}
.att-present { color: var(--success, #34a853); }
.att-absent { color: var(--danger, #ea4335); }
.att-late { color: var(--warning, #fbbc04); }
.att-makeup { color: var(--primary); }

/* 숙제/테스트 그리드 */
.report-ox-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 0 16px 16px;
}
.report-ox-section {
    background: var(--surface);
    border-radius: 12px;
    padding: 12px;
    border: 1px solid var(--border);
}
.report-ox-title {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 8px;
    color: var(--text-main);
}
.report-ox-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
    font-size: 12px;
}
.report-ox-label {
    min-width: 36px;
    font-weight: 500;
    color: var(--text-sec);
}
.report-ox-val {
    font-size: 11px;
    padding: 1px 4px;
    border-radius: 3px;
}
.report-ox-o { color: var(--success, #34a853); font-weight: 600; }
.report-ox-t { color: var(--warning, #fbbc04); font-weight: 600; }
.report-ox-x { color: var(--danger, #ea4335); font-weight: 600; }
```

**Step 2: 브라우저에서 확인**

확인: 탭이 Material Design 3 스타일과 어울리는지 확인

**Step 3: Commit**

```bash
git add daily-ops.css
git commit -m "feat: 성적표 탭 CSS 스타일 추가"
```

---

### Task 4: 탭 전환 로직 + 성적표 데이터 쿼리 함수

**Files:**
- Modify: `/Users/jongsooyi/impact7newDSC/daily-ops.js`

**Step 1: 상태 변수 추가**

파일 상단 state 영역 (line 46 근처)에 추가:

```javascript
let detailTab = 'daily'; // 'daily' | 'report'
```

**Step 2: 탭 전환 함수 추가**

`renderStudentDetail` 함수 앞에 추가:

```javascript
function switchDetailTab(tab) {
    detailTab = tab;
    document.querySelectorAll('.detail-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    document.getElementById('detail-cards').style.display = tab === 'daily' ? '' : 'none';
    document.getElementById('report-tab').style.display = tab === 'report' ? '' : 'none';
}
window.switchDetailTab = switchDetailTab;
```

**Step 3: 성적표 데이터 쿼리 함수 추가**

```javascript
async function loadReportCard() {
    const studentId = selectedStudentId;
    if (!studentId) return;

    const startDate = document.getElementById('report-start').value;
    const endDate = document.getElementById('report-end').value;
    if (!startDate || !endDate) {
        alert('시작일과 종료일을 모두 입력해주세요.');
        return;
    }
    if (startDate > endDate) {
        alert('시작일이 종료일보다 늦습니다.');
        return;
    }

    const contentEl = document.getElementById('report-content');
    contentEl.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;">조회 중...</div>';

    try {
        const q = query(
            collection(db, 'daily_records'),
            where('student_id', '==', studentId),
            where('date', '>=', startDate),
            where('date', '<=', endDate)
        );
        const snap = await getDocs(q);
        const records = [];
        snap.forEach(d => records.push(d.data()));
        records.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

        renderReportCard(records, studentId);
    } catch (err) {
        console.error('성적표 조회 실패:', err);
        contentEl.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;color:var(--danger);">조회 실패: ' + esc(err.message) + '</div>';
    }
}
window.loadReportCard = loadReportCard;
```

**Step 4: 성적표 렌더링 함수 추가**

```javascript
function renderReportCard(records, studentId) {
    const contentEl = document.getElementById('report-content');

    if (records.length === 0) {
        contentEl.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;">해당 기간에 기록이 없습니다.</div>';
        return;
    }

    // ── 출석 집계 ──
    const attendanceRows = records.map(rec => {
        const date = rec.date || '';
        const dayName = date ? getDayName(date) : '';
        const status = rec.attendance?.status || '';
        const reason = rec.attendance?.reason || '';
        return { date, dayName, status, reason };
    }).filter(r => r.date);

    const attendanceHtml = `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">event_available</span>
                출석 (${attendanceRows.length}일)
            </div>
            <table class="report-attendance-table">
                <thead><tr><th>날짜</th><th>구분</th><th>비고</th></tr></thead>
                <tbody>
                    ${attendanceRows.map(r => {
                        const dateShort = r.date.slice(5).replace('-', '/');
                        const cls = r.status === '출석' ? 'att-present' :
                                    r.status === '결석' ? 'att-absent' :
                                    r.status === '지각' ? 'att-late' :
                                    r.status === '보충' ? 'att-makeup' : '';
                        return `<tr>
                            <td>${esc(dateShort)}(${esc(r.dayName)})</td>
                            <td class="${cls}">${esc(r.status || '-')}</td>
                            <td>${esc(r.reason)}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;

    // ── 숙제 O/△/X 집계 ──
    const hwDomains = new Set();
    records.forEach(rec => {
        Object.keys(rec.hw_domains_1st || {}).forEach(d => hwDomains.add(d));
        Object.keys(rec.hw_domains_2nd || {}).forEach(d => hwDomains.add(d));
    });

    const hwStats = {};
    hwDomains.forEach(d => { hwStats[d] = { O: 0, '△': 0, X: 0 }; });
    records.forEach(rec => {
        // 2차가 있으면 2차 기준, 없으면 1차 기준
        hwDomains.forEach(d => {
            const val = (rec.hw_domains_2nd?.[d]) || (rec.hw_domains_1st?.[d]) || '';
            if (val === 'O' || val === '△' || val === 'X') {
                hwStats[d][val]++;
            }
        });
    });

    // ── 테스트 O/△/X 집계 ──
    const testDomains = new Set();
    records.forEach(rec => {
        Object.keys(rec.test_domains_1st || {}).forEach(d => testDomains.add(d));
        Object.keys(rec.test_domains_2nd || {}).forEach(d => testDomains.add(d));
    });

    const testStats = {};
    testDomains.forEach(d => { testStats[d] = { O: 0, '△': 0, X: 0 }; });
    records.forEach(rec => {
        testDomains.forEach(d => {
            const val = (rec.test_domains_2nd?.[d]) || (rec.test_domains_1st?.[d]) || '';
            if (val === 'O' || val === '△' || val === 'X') {
                testStats[d][val]++;
            }
        });
    });

    const renderOxSection = (title, icon, stats) => {
        const domains = Object.keys(stats);
        if (domains.length === 0) return '';
        return `
            <div class="report-ox-section">
                <div class="report-ox-title">
                    <span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;">${icon}</span>
                    ${esc(title)}
                </div>
                ${domains.map(d => {
                    const s = stats[d];
                    return `<div class="report-ox-row">
                        <span class="report-ox-label">${esc(d)}</span>
                        <span class="report-ox-val report-ox-o">O:${s.O}</span>
                        <span class="report-ox-val report-ox-t">△:${s['△']}</span>
                        <span class="report-ox-val report-ox-x">X:${s.X}</span>
                    </div>`;
                }).join('')}
            </div>
        `;
    };

    const oxGridHtml = (hwDomains.size > 0 || testDomains.size > 0) ? `
        <div class="report-ox-grid">
            ${renderOxSection('숙제', 'assignment', hwStats)}
            ${renderOxSection('테스트', 'quiz', testStats)}
        </div>
    ` : '';

    contentEl.innerHTML = attendanceHtml + oxGridHtml;
}
```

**Step 5: renderStudentDetail에서 탭 상태 복원**

`renderStudentDetail()` 함수 끝 (line 3901 근처, `cardsContainer.innerHTML = ...` 이후)에 탭 상태를 동기화하는 코드 추가:

```javascript
// 탭 상태 복원
const tabsEl = document.getElementById('detail-tabs');
if (tabsEl) {
    tabsEl.querySelectorAll('.detail-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === detailTab);
    });
}
document.getElementById('detail-cards').style.display = detailTab === 'daily' ? '' : 'none';
const reportTab = document.getElementById('report-tab');
if (reportTab) reportTab.style.display = detailTab === 'report' ? '' : 'none';
```

**Step 6: 브라우저에서 테스트**

1. 학생 선택 → [성적표] 탭 클릭
2. 시작일/종료일 입력 → 조회 클릭
3. 출석 테이블, 숙제/테스트 O/△/X 집계 확인

**Step 7: Commit**

```bash
git add daily-ops.js
git commit -m "feat: 성적표 탭 전환 로직 + 데이터 쿼리/렌더링 구현"
```

---

### Task 5: getDayName 함수 확인 및 날짜 헬퍼

**주의:** `renderReportCard`에서 `getDayName(date)` 를 호출한다. 이 함수가 날짜 문자열("2026-03-04")을 받아서 "화" 등 요일을 반환하는지 확인한다.

**Files:**
- Modify: `/Users/jongsooyi/impact7newDSC/daily-ops.js` (필요시)

**Step 1: getDayName 확인**

`daily-ops.js`에서 `getDayName` 함수를 찾아 시그니처 확인. 만약 `selectedDate` 전역 변수 기반이라면 인자를 받도록 수정이 필요할 수 있다.

**Step 2: 필요시 수정**

만약 `getDayName()`이 인자 없이 `selectedDate`를 쓴다면, `renderReportCard` 내부에서 별도로 요일을 계산:

```javascript
const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
const dayName = dayNames[new Date(date + 'T00:00:00').getDay()];
```

**Step 3: Commit (수정 있을 경우만)**

```bash
git add daily-ops.js
git commit -m "fix: getDayName 날짜 인자 지원"
```

---

### Task 6: 통합 테스트 및 엣지 케이스 확인

**Step 1: 데이터 없는 기간 테스트**

기록이 없는 미래 날짜 범위로 조회 → "해당 기간에 기록이 없습니다." 메시지 확인

**Step 2: 날짜 유효성 테스트**

- 시작일만 입력 후 조회 → 알림 확인
- 시작일 > 종료일 → 알림 확인

**Step 3: 탭 전환 테스트**

- [성적표] → [일일현황] → [성적표] 전환 시 기존 조회 결과 유지 여부 확인
- 다른 학생 선택 시 탭 상태 유지 확인

**Step 4: 모바일 반응형 확인**

브라우저 너비를 768px 이하로 줄여서:
- 탭이 정상 표시되는지
- 출석 테이블이 넘치지 않는지
- 숙제/테스트 그리드가 세로 배치로 전환되는지

필요시 미디어 쿼리 추가:

```css
@media (max-width: 768px) {
    .report-ox-grid {
        grid-template-columns: 1fr;
    }
}
```

**Step 5: 최종 Commit**

```bash
git add -A
git commit -m "feat: 학생 개인 성적표 기능 완성"
```

---

## 파일 수정 요약

| 파일 | 변경 내용 |
|------|----------|
| `firestore.indexes.json` | daily_records 복합 인덱스 (student_id + date) |
| `index.html` | detail-content에 탭 버튼 + 성적표 컨테이너 추가 |
| `daily-ops.css` | 탭, 출석 테이블, OX 그리드 스타일 |
| `daily-ops.js` | switchDetailTab, loadReportCard, renderReportCard 함수 추가 |

## 데이터 흐름

```
[성적표 탭] → 시작일/종료일 입력 → [조회 클릭]
    ↓
loadReportCard()
    ↓
Firestore: daily_records WHERE student_id == X AND date >= A AND date <= B
    ↓
renderReportCard(records)
    ├── 출석: 날짜별 테이블 (date, status, reason)
    ├── 숙제: 도메인별 O/△/X 집계 (hw_domains_1st/2nd)
    └── 테스트: 도메인별 O/△/X 집계 (test_domains_1st/2nd)
```
