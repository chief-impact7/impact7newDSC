/* ── Help Guide Modal ─────────────────────────────────────────────────── */

const TABS = [
    { id: 'basics', label: '기본 사용법', icon: 'play_circle' },
    { id: 'data', label: '데이터 관리', icon: 'database' },
    { id: 'sidebar', label: '사이드바/필터', icon: 'filter_list' },
    { id: 'faq', label: 'FAQ', icon: 'quiz' },
  ];

  /* ── Content builders ──────────────────────────────────────────────── */

  function buildBasics() {
    return `
      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">login</span>
          로그인
        </h3>
        <ol class="help-guide-steps">
          <li>우측 상단의 <strong>G</strong> 아바타를 클릭합니다.</li>
          <li>Google 계정으로 로그인합니다. (<strong>@gw.impact7.kr</strong> 또는 <strong>@impact7.kr</strong> 계정만 가능)</li>
          <li>로그인에 성공하면 아바타가 프로필 사진으로 바뀌고, 학생 데이터가 로드됩니다.</li>
        </ol>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">calendar_month</span>
          날짜 이동
        </h3>
        <p class="help-guide-desc">
          우측 상단 날짜 영역에서 <strong>&larr; &rarr;</strong> 버튼으로 이전/다음날로 이동합니다.
          날짜를 직접 클릭하면 캘린더가 열려 원하는 날짜를 선택할 수 있습니다.
        </p>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">search</span>
          학생 검색
        </h3>
        <p class="help-guide-desc">상단 검색창에서 다양한 방식으로 학생을 찾을 수 있습니다.</p>
        <ul class="help-guide-list">
          <li><strong>이름</strong> &mdash; 학생 이름 전체 또는 일부 입력 (예: 김민준)</li>
          <li><strong>학교명</strong> &mdash; 학교 이름으로 검색 (예: 진명여고)</li>
          <li><strong>전화번호</strong> &mdash; 학부모 또는 학생 연락처 입력</li>
          <li><strong>담당 선생님</strong> &mdash; 담당 선생님 이름으로 해당 반 학생 검색 (예: 김선생)</li>
        </ul>
        <p class="help-guide-desc" style="margin-top:8px;">
          <strong>X</strong> 버튼을 클릭하면 검색어가 초기화됩니다.
        </p>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">person</span>
          학생 상세보기
        </h3>
        <ol class="help-guide-steps">
          <li>메인 화면의 학생 카드를 클릭합니다.</li>
          <li>우측에 학생 상세 패널이 열립니다.</li>
          <li>미완료 숙제, 미완료 테스트, 연기/재시 일정, 메모 등을 확인할 수 있습니다.</li>
        </ol>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">view_module</span>
          뷰 전환
        </h3>
        <p class="help-guide-desc">
          목록 상단 아이콘으로 <strong>목록 뷰</strong>와 <strong>그룹 뷰</strong>(지점별/반별)를 전환할 수 있습니다.
        </p>
      </section>
    `;
  }

  function buildDataManagement() {
    return `
      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">event_available</span>
          출결 관리
        </h3>
        <p class="help-guide-desc">학생 카드의 출결 버튼으로 상태를 변경합니다.</p>
        <ul class="help-guide-list">
          <li><strong>출석 / 결석 / 지각 / 조퇴</strong> 상태 변경 가능</li>
          <li>시간, 사유 입력 가능</li>
        </ul>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">task_alt</span>
          숙제 관리
        </h3>
        <p class="help-guide-desc">
          <strong>O/X</strong> 토글로 숙제 제출 여부를 체크합니다. (O=제출, X=미제출)
        </p>
        <ul class="help-guide-list">
          <li>과목: <strong>독해, 문법, 실전, 청해, 추가, 어휘, 숙어, 3단</strong></li>
          <li>숙제 추가 모달에서 새 숙제를 등록할 수 있습니다.</li>
        </ul>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">grading</span>
          테스트 관리
        </h3>
        <ul class="help-guide-list">
          <li><strong>리뷰테스트</strong> &mdash; O/X 체크로 합격 여부 기록</li>
          <li><strong>테스트 기록 모달</strong> &mdash; 점수/합격선 입력 (정기, 쪽지, 모의)</li>
        </ul>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">event_repeat</span>
          재시/보강 등록
        </h3>
        <p class="help-guide-desc">
          일정 지정 모달에서 <strong>재시/보충</strong> 날짜와 시간을 등록합니다.
        </p>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">auto_stories</span>
          다음 숙제 입력
        </h3>
        <p class="help-guide-desc">
          반별로 다음 수업 숙제 범위를 입력합니다. (청해, 요약, 독해, 문법, 실전 등)
        </p>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">person</span>
          담당/부담당 배정
        </h3>
        <ol class="help-guide-steps">
          <li>사이드바에서 <strong>반 관리</strong> 카테고리를 선택합니다.</li>
          <li>목록에서 반을 선택하면, 상세 패널 상단에 <strong>담당/부담당</strong> 드롭다운이 표시됩니다.</li>
          <li>선생님을 선택하면 자동 저장됩니다.</li>
        </ol>
        <p class="help-guide-desc" style="margin-top:8px;">
          배정된 담당 선생님 이름이 학생 카드에 <strong>뱃지</strong>로 표시됩니다.
        </p>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">sticky_note_2</span>
          메모
        </h3>
        <ul class="help-guide-list">
          <li>학생별 메모 작성 및 발송 (교수, 관리 수신자 선택)</li>
          <li>메모함에서 수신/발신 메모 확인</li>
        </ul>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">family_restroom</span>
          학부모 알림
        </h3>
        <p class="help-guide-desc">
          학생 상세 패널에서 학부모 알림 버튼을 클릭합니다.
          <strong>AI(Gemini)</strong> 자동 작성 또는 직접 작성 후 클립보드에 복사하여 메신저로 전송합니다.
        </p>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">checklist</span>
          일괄 선택 모드
        </h3>
        <ol class="help-guide-steps">
          <li>체크박스로 다수 학생을 선택합니다.</li>
          <li><strong>일괄 메모</strong>, <strong>일괄 알림</strong> 등의 작업을 수행합니다.</li>
        </ol>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">download</span>
          일일현황표 다운로드
        </h3>
        <ol class="help-guide-steps">
          <li>목록 상단의 <strong>다운로드(⬇)</strong> 아이콘을 클릭합니다.</li>
          <li>구글 드라이브에서 저장할 <strong>폴더</strong>를 선택합니다.</li>
          <li>선택한 폴더에 구글시트가 자동 생성되고 새 탭으로 열립니다.</li>
        </ol>
        <p class="help-guide-desc" style="margin-top:8px;">
          현재 필터(소속, 반)가 적용된 학생 데이터가 내보내집니다.
          처음 사용 시 드라이브 권한을 위해 <strong>로그아웃 후 재로그인</strong>이 필요할 수 있습니다.
        </p>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">person_add</span>
          진단평가
        </h3>
        <p class="help-guide-desc">
          사이드바 하단 <strong>"진단평가"</strong> 버튼으로 입학 테스트 대상 학생을 등록합니다. 저장 시 students에 '상담' 상태로 등록됩니다.
        </p>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">save</span>
          자동 저장
        </h3>
        <p class="help-guide-desc">
          모든 변경사항은 자동 저장됩니다. 하단 저장 인디케이터로 저장 상태를 확인할 수 있습니다.
        </p>
      </section>
    `;
  }

  function buildSidebarFilters() {
    return `

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">event_available</span>
          출결 (L1)
        </h3>
        <p class="help-guide-desc">전체 학생의 출결 현황을 봅니다.</p>
        <ul class="help-guide-list">
          <li><strong>L2 필터</strong> &mdash; 출석 / 결석 / 지각 / 미출결 등으로 세분화</li>
        </ul>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">task_alt</span>
          숙제 (L1)
        </h3>
        <p class="help-guide-desc">숙제 제출 현황을 봅니다.</p>
        <ul class="help-guide-list">
          <li><strong>L2 필터</strong> &mdash; 과목별 미제출 학생 필터링</li>
        </ul>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">grading</span>
          테스트 (L1)
        </h3>
        <p class="help-guide-desc">테스트 현황을 봅니다.</p>
        <ul class="help-guide-list">
          <li><strong>L2 필터</strong> &mdash; 테스트 항목별 필터링</li>
        </ul>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">smart_toy</span>
          자동화 (L1)
        </h3>
        <p class="help-guide-desc">
          부실 숙제 보완, 재시 관리 등 자동 생성 태스크를 관리합니다.
        </p>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">location_city</span>
          소속 (L1)
        </h3>
        <ul class="help-guide-list">
          <li><strong>2단지</strong> &mdash; 2단지 지점 학생 필터링</li>
          <li><strong>10단지</strong> &mdash; 10단지 지점 학생 필터링</li>
        </ul>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">class</span>
          반 관리 (L1)
        </h3>
        <p class="help-guide-desc">반별 설정을 관리합니다.</p>
        <ul class="help-guide-list">
          <li><strong>담당/부담당 배정</strong> &mdash; 선생님을 반에 배정</li>
          <li><strong>영역숙제관리</strong> &mdash; 반별 숙제 영역 설정</li>
          <li><strong>테스트관리</strong> &mdash; 테스트 섹션 구성</li>
          <li><strong>등원예정시간</strong> &mdash; 학생별 등원 시간 설정</li>
        </ul>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">admin_panel_settings</span>
          행정 (L1)
        </h3>
        <p class="help-guide-desc">휴원/퇴원 행정 업무를 관리합니다. L2 필터로 세부 기능을 선택합니다.</p>

        <h4 style="font-size:13.5px;font-weight:600;margin:14px 0 6px;color:var(--text-main,#1f1f1f);">결석대장</h4>
        <p class="help-guide-desc">
          결석 처리된 학생이 <strong>자동으로</strong> 결석대장에 등록됩니다. (결석 1건 = 결석대장 1건)
        </p>
        <ul class="help-guide-list">
          <li>출결에서 <strong>결석</strong> 체크 시 해당 날짜의 결석대장이 자동 생성됩니다.</li>
          <li>학생을 클릭하면 상세 패널에서 <strong>상담 체크</strong>, <strong>사유</strong>, <strong>보강 일정</strong> 등을 관리합니다.</li>
          <li><strong>행정완료</strong> 버튼으로 해당 건의 행정 처리를 완료 표시합니다.</li>
        </ul>

        <h4 style="font-size:13.5px;font-weight:600;margin:14px 0 6px;color:var(--text-main,#1f1f1f);">휴퇴원요청</h4>
        <p class="help-guide-desc">
          학생/학부모의 휴원 또는 퇴원 요청을 접수하고 처리합니다.
        </p>
        <ul class="help-guide-list">
          <li>상단 <strong>"새 요청"</strong> 버튼으로 새 요청을 등록합니다.</li>
          <li>요청 유형: <strong>가휴원, 실휴원, 퇴원, 휴원연장</strong></li>
          <li><strong>가휴원</strong> &mdash; 일시적 휴원 (복귀 예정)</li>
          <li><strong>실휴원</strong> &mdash; 장기 휴원</li>
          <li><strong>퇴원</strong> &mdash; 완전 퇴원 처리</li>
          <li><strong>휴원연장</strong> &mdash; 기존 휴원의 종료일만 변경 (사유 불필요)</li>
          <li>요청 상태: <strong>대기중 &rarr; 승인</strong> 순서로 처리됩니다.</li>
          <li>승인 시 학생 상태가 자동으로 변경됩니다 (가휴원/실휴원/퇴원).</li>
        </ul>

        <h4 style="font-size:13.5px;font-weight:600;margin:14px 0 6px;color:var(--text-main,#1f1f1f);">복귀예정</h4>
        <p class="help-guide-desc">
          휴원 중인 학생(가휴원/실휴원) 중 <strong>2주 이내에 복귀 예정</strong>인 학생을 보여줍니다.
        </p>
        <ul class="help-guide-list">
          <li><strong>1주일 이내</strong>(빨간 D-day 뱃지)와 <strong>2주일 이내</strong>(주황 뱃지)로 그룹이 나뉩니다.</li>
          <li><strong>D-n</strong> 뱃지로 복귀까지 남은 일수를 한눈에 확인합니다.</li>
          <li>📞 아이콘 &mdash; <strong>복귀유도상담</strong> 완료 여부를 토글합니다. (녹색 체크 = 완료)</li>
          <li>학생을 클릭하면 상세 패널에서 <strong>복귀상담 카드</strong>가 나타납니다.</li>
          <li>복귀상담 카드에서 상담 체크박스와 <strong>상담 메모</strong>를 기록할 수 있습니다.</li>
          <li>사이드바 카운트 뱃지: <strong>1주 이내 수 / 전체 수</strong>로 표시됩니다.</li>
        </ul>
      </section>

      <section class="help-guide-section">
        <h3 class="help-guide-section-title">
          <span class="material-symbols-outlined">label</span>
          필터 칩
        </h3>
        <p class="help-guide-desc">
          적용된 필터가 목록 상단에 칩으로 표시됩니다. 칩을 클릭하면 해당 필터가 해제됩니다.
        </p>
      </section>
    `;
  }

  function buildFAQ() {
    const faqs = [
      {
        q: '데이터가 안 보여요',
        a: '먼저 우측 상단에서 <strong>Google 로그인</strong>이 되어 있는지 확인하세요. 로그인 후에도 데이터가 비어 있다면, <strong>날짜</strong>에 해당하는 데이터가 있는지 확인하세요.',
      },
      {
        q: '출결 변경이 안 돼요',
        a: '학생 카드의 <strong>출결 버튼</strong>을 클릭하세요. 출석/결석/지각/조퇴 중 원하는 상태를 선택하면 자동 저장됩니다.',
      },
      {
        q: '숙제 O/X가 뭔가요?',
        a: '<strong>O</strong>=제출, <strong>X</strong>=미제출입니다. 해당 셀을 클릭하면 O/X가 토글됩니다.',
      },
      {
        q: '학부모 알림은 어떻게 보내나요?',
        a: '학생 상세 패널에서 <strong>학부모 알림</strong> 버튼을 클릭합니다. <strong>AI(Gemini) 자동 작성</strong> 또는 직접 작성 후 클립보드에 복사하여 메신저로 전송하세요.',
      },
      {
        q: '여러 학생에게 메모를 보내고 싶어요',
        a: '<strong>일괄 선택 모드</strong>를 활성화하고 학생들을 체크한 뒤, <strong>일괄 메모</strong> 버튼을 클릭하세요.',
      },
      {
        q: '진단평가가 뭔가요?',
        a: '입학 테스트 대상 학생을 등록하는 기능입니다. 사이드바 하단의 <strong>"진단평가"</strong> 버튼을 클릭하세요. 저장 시 students에 \'상담\' 상태로 등록됩니다.',
      },
      {
        q: '반 담당 선생님은 어떻게 배정하나요?',
        a: '<strong>반 관리</strong> 카테고리에서 반을 선택하면, 상세 패널 상단에 <strong>담당/부담당</strong> 드롭다운이 나타납니다. 선생님을 선택하면 자동 저장되며, 학생 카드에 담당 이름이 뱃지로 표시됩니다.',
      },
      {
        q: '일일현황표는 어떻게 다운로드하나요?',
        a: '목록 상단의 <strong>다운로드(⬇)</strong> 아이콘을 클릭합니다. 구글 드라이브 폴더를 선택하면 해당 위치에 구글시트가 생성되고 자동으로 열립니다. <strong>드라이브 권한</strong>이 필요하므로, 처음 사용 시 로그아웃 후 재로그인이 필요할 수 있습니다.',
      },
    ];

    return faqs
      .map(
        (f) => `
      <details class="help-guide-faq-item">
        <summary class="help-guide-faq-q">
          <span class="material-symbols-outlined">help</span>
          ${f.q}
          <span class="material-symbols-outlined help-guide-faq-chevron">expand_more</span>
        </summary>
        <div class="help-guide-faq-a">${f.a}</div>
      </details>
    `
      )
      .join('');
  }

  const CONTENT_MAP = {
    basics: buildBasics,
    data: buildDataManagement,
    sidebar: buildSidebarFilters,
    faq: buildFAQ,
  };

  /* ── Modal creation ────────────────────────────────────────────────── */

  function createModal() {
    const overlay = document.createElement('div');
    overlay.className = 'help-guide-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '사용 가이드');

    const tabsHTML = TABS.map(
      (t, i) => `
      <button class="help-guide-tab${i === 0 ? ' help-guide-tab--active' : ''}"
              data-tab="${t.id}" role="tab" aria-selected="${i === 0}">
        <span class="material-symbols-outlined">${t.icon}</span>
        <span>${t.label}</span>
      </button>`
    ).join('');

    overlay.innerHTML = `
      <div class="help-guide-modal">
        <header class="help-guide-header">
          <h2 class="help-guide-title">
            <span class="material-symbols-outlined">menu_book</span>
            사용 가이드
          </h2>
          <button class="help-guide-close" aria-label="닫기">
            <span class="material-symbols-outlined">close</span>
          </button>
        </header>
        <nav class="help-guide-tabs" role="tablist">${tabsHTML}</nav>
        <div class="help-guide-body" role="tabpanel"></div>
      </div>
    `;

    document.body.appendChild(overlay);
    return overlay;
  }

  /* ── Controller ────────────────────────────────────────────────────── */

  let overlayEl = null;
  let activeTab = TABS[0].id;

  function renderContent() {
    const body = overlayEl.querySelector('.help-guide-body');
    body.innerHTML = CONTENT_MAP[activeTab]();
    body.scrollTop = 0;
  }

  function switchTab(tabId) {
    activeTab = tabId;
    overlayEl.querySelectorAll('.help-guide-tab').forEach((btn) => {
      const isActive = btn.dataset.tab === tabId;
      btn.classList.toggle('help-guide-tab--active', isActive);
      btn.setAttribute('aria-selected', isActive);
    });
    renderContent();
  }

  function openModal() {
    if (!overlayEl) {
      overlayEl = createModal();

      /* Tab clicks */
      overlayEl.querySelector('.help-guide-tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.help-guide-tab');
        if (tab) switchTab(tab.dataset.tab);
      });

      /* Close button */
      overlayEl.querySelector('.help-guide-close').addEventListener('click', closeModal);

      /* Backdrop click */
      overlayEl.addEventListener('click', (e) => {
        if (e.target === overlayEl) closeModal();
      });
    }

    activeTab = TABS[0].id;
    switchTab(activeTab);
    overlayEl.classList.add('help-guide-overlay--visible');
    document.body.style.overflow = 'hidden';
    overlayEl.querySelector('.help-guide-close').focus();
  }

  function closeModal() {
    if (!overlayEl) return;
    overlayEl.classList.remove('help-guide-overlay--visible');
    document.body.style.overflow = '';
  }

  /* ── Keyboard ──────────────────────────────────────────────────────── */

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlayEl && overlayEl.classList.contains('help-guide-overlay--visible')) {
      closeModal();
    }
  });

  /* ── Bind to help button ───────────────────────────────────────────── */

  function bindHelpButton() {
    const btn = document.querySelector('[title="사용 가이드"]');
    if (btn) {
      btn.addEventListener('click', openModal);
    }
  }

  /* ── Inject styles ─────────────────────────────────────────────────── */

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      /* ── Overlay ── */
      .help-guide-overlay {
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.45);
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.2s, visibility 0.2s;
      }
      .help-guide-overlay--visible {
        opacity: 1;
        visibility: visible;
      }

      /* ── Modal ── */
      .help-guide-modal {
        background: #fff;
        border-radius: 16px;
        width: min(640px, calc(100vw - 32px));
        max-height: calc(100vh - 64px);
        display: flex;
        flex-direction: column;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
        transform: translateY(12px);
        transition: transform 0.2s;
      }
      .help-guide-overlay--visible .help-guide-modal {
        transform: translateY(0);
      }

      /* ── Header ── */
      .help-guide-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 20px 24px 12px;
      }
      .help-guide-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-family: var(--font-heading, 'Google Sans', sans-serif);
        font-size: 20px;
        font-weight: 500;
        color: var(--text-main, #1f1f1f);
      }
      .help-guide-title .material-symbols-outlined {
        color: var(--primary, #0b57d0);
        font-size: 24px;
      }
      .help-guide-close {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        border: none;
        border-radius: 50%;
        background: transparent;
        cursor: pointer;
        color: var(--text-sec, #444746);
        transition: background 0.15s;
      }
      .help-guide-close:hover {
        background: rgba(60, 64, 67, 0.08);
      }
      .help-guide-close:focus-visible {
        outline: 2px solid var(--primary, #0b57d0);
        outline-offset: 2px;
      }

      /* ── Tabs ── */
      .help-guide-tabs {
        display: flex;
        gap: 4px;
        padding: 0 24px;
        border-bottom: 1px solid var(--border, #e0e0e0);
      }
      .help-guide-tab {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 10px 16px;
        border: none;
        border-bottom: 2px solid transparent;
        background: transparent;
        font-family: var(--font-body, 'Roboto', sans-serif);
        font-size: 13px;
        font-weight: 500;
        color: var(--text-sec, #444746);
        cursor: pointer;
        transition: color 0.15s, border-color 0.15s;
        white-space: nowrap;
      }
      .help-guide-tab .material-symbols-outlined {
        font-size: 18px;
      }
      .help-guide-tab:hover {
        color: var(--primary, #0b57d0);
      }
      .help-guide-tab--active {
        color: var(--primary, #0b57d0);
        border-bottom-color: var(--primary, #0b57d0);
      }

      /* ── Body ── */
      .help-guide-body {
        flex: 1;
        overflow-y: auto;
        padding: 20px 24px 28px;
      }

      /* ── Sections ── */
      .help-guide-section {
        margin-bottom: 24px;
      }
      .help-guide-section:last-child {
        margin-bottom: 0;
      }
      .help-guide-section-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-family: var(--font-heading, 'Google Sans', sans-serif);
        font-size: 15px;
        font-weight: 500;
        color: var(--text-main, #1f1f1f);
        margin-bottom: 10px;
      }
      .help-guide-section-title .material-symbols-outlined {
        font-size: 20px;
        color: var(--primary, #0b57d0);
      }

      /* ── Lists & Steps ── */
      .help-guide-desc {
        font-size: 13.5px;
        line-height: 1.65;
        color: var(--text-sec, #444746);
      }
      .help-guide-steps,
      .help-guide-list {
        margin: 0;
        padding-left: 20px;
        font-size: 13.5px;
        line-height: 1.75;
        color: var(--text-sec, #444746);
      }
      .help-guide-steps li,
      .help-guide-list li {
        margin-bottom: 4px;
      }
      .help-guide-steps li::marker {
        color: var(--primary, #0b57d0);
        font-weight: 500;
      }
      .help-guide-list {
        list-style: disc;
      }

      /* ── FAQ ── */
      .help-guide-faq-item {
        border: 1px solid var(--border, #e0e0e0);
        border-radius: 10px;
        margin-bottom: 10px;
        overflow: hidden;
        transition: border-color 0.15s;
      }
      .help-guide-faq-item[open] {
        border-color: var(--primary, #0b57d0);
      }
      .help-guide-faq-q {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 14px 16px;
        font-family: var(--font-heading, 'Google Sans', sans-serif);
        font-size: 14px;
        font-weight: 500;
        color: var(--text-main, #1f1f1f);
        cursor: pointer;
        list-style: none;
        user-select: none;
      }
      .help-guide-faq-q::-webkit-details-marker {
        display: none;
      }
      .help-guide-faq-q .material-symbols-outlined:first-child {
        font-size: 20px;
        color: var(--primary, #0b57d0);
      }
      .help-guide-faq-chevron {
        margin-left: auto;
        font-size: 20px !important;
        color: var(--text-sec, #444746) !important;
        transition: transform 0.2s;
      }
      .help-guide-faq-item[open] .help-guide-faq-chevron {
        transform: rotate(180deg);
      }
      .help-guide-faq-a {
        padding: 0 16px 16px 44px;
        font-size: 13.5px;
        line-height: 1.7;
        color: var(--text-sec, #444746);
      }

      /* ── Mobile ── */
      @media (max-width: 600px) {
        .help-guide-modal {
          width: 100vw;
          max-height: 100vh;
          border-radius: 0;
        }
        .help-guide-tabs {
          overflow-x: auto;
          padding: 0 16px;
        }
        .help-guide-tab {
          padding: 10px 12px;
          font-size: 12px;
        }
        .help-guide-header {
          padding: 16px 16px 10px;
        }
        .help-guide-body {
          padding: 16px 16px 24px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  /* ── Init ───────────────────────────────────────────────────────────── */

  function init() {
    injectStyles();
    bindHelpButton();
  }

export function initHelpGuide() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
