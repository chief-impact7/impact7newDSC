// impact7 바닐라 JS 앱(DSC·DB) 공용 접근성 DOM 유틸 — 공유 SSoT.
// 마스터: impact7DB/.agents/shared-dom/a11y-dom.js → 각 앱 루트로 복사.
// check-shared-dom.mjs(pre-push)가 마스터와 각 앱 복사본의 일치를 강제한다.
// 앱별 차이(키보드 활성화 셀렉터, 모달 닫기 동작)는 인자/콜백으로 흡수해 코드는 동일하게 유지.

// role=button/data-keyclick 등 비-native 인터랙티브 요소를 Enter/Space로 활성화한다.
// el===target 가드로 중첩 컨트롤(체크박스·내부 버튼)이 포커스일 때는 가로채지 않는다.
export function installKeyboardActivation(selector) {
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = e.target.closest(selector);
        if (!el || el !== e.target) return;
        e.preventDefault();
        // SVGElement에는 .click()이 없어(HTMLElement 전용) dispatchEvent로 통일 — 아이콘 svg가 role=button을 가질 때도 동작
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
}

// 화면에 보이는 최상위 모달의 Esc 닫기 + Tab 포커스 트랩.
// modalSelector: 모달 오버레이 셀렉터. closeModal(modal): 앱이 닫기 동작을 제공
// (정적 모달 display 토글 / 동적 모달 remove / 닫기 함수 호출 등).
export function installModalA11y({ modalSelector, closeModal }) {
    const topVisibleModal = () => {
        let top = null;
        document.querySelectorAll(modalSelector).forEach((m) => {
            if (getComputedStyle(m).display !== 'none') top = m;
        });
        return top;
    };
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' && e.key !== 'Tab') return;
        const modal = topVisibleModal();
        if (!modal) return;
        if (e.key === 'Escape') { closeModal(modal); return; }
        const focusables = [...modal.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )].filter((el) => el.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (!modal.contains(document.activeElement)) {
            e.preventDefault(); first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
        }
    });
}
