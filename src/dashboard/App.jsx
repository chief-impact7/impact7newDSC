import React, { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { Icon, IconButton } from '@impact7/ui';
import { ICON_NAME } from './icon-map.js';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, dataAuthReady } from '../../firebase-config.js';
import { signInWithGoogle, logout } from '../../auth.js';
import { useStudents, useDashboardData, useConsultations } from './hooks/useFirestore.js';
import { branchFromStudent, enrollmentCode, todayStr, fetchSemesterSettings, getSemestersForDate, studentGradeKey } from '../shared/firestore-helpers.js';
import { openKoreanDatePicker } from '../../date-picker.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import DailyLogBoard from './components/DailyLogBoard.jsx';
import GradeFilter from './components/GradeFilter.jsx';
// 일별 뷰(기본)는 echarts를 안 쓴다. 차트를 쓰는 기간 뷰와 상담 뷰는 lazy 로드해
// 일별 첫 페인트에서 echarts(~수백KB)를 빼 초기 로딩을 가볍게 한다.
const PeriodLogBoard = lazy(() => import('./components/PeriodLogBoard.jsx'));
const ConsultationBoard = lazy(() => import('./components/ConsultationBoard.jsx'));

const pad2 = (value) => String(value).padStart(2, '0');
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function displayImpact7Email(email) {
    return String(email || '').replace(/@gw\.impact7\.kr$/i, '@impact7.kr');
}

function dateParts(dateStr) {
    const raw = String(dateStr || '').trim();
    const iso = raw.match(ISO_DATE_RE);
    if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
    const us = raw.match(US_DATE_RE);
    if (us) return { y: Number(us[3]), m: Number(us[1]), d: Number(us[2]) };
    return null;
}

function datePartsToIso(parts) {
    if (!parts || !parts.y || !parts.m || !parts.d) return '';
    return `${parts.y}-${pad2(parts.m)}-${pad2(parts.d)}`;
}

function normalizeDateStr(dateStr) {
    return datePartsToIso(dateParts(dateStr)) || todayStr();
}

function addDays(dateStr, days) {
    const parts = dateParts(normalizeDateStr(dateStr));
    const utcNoon = Date.UTC(parts.y, parts.m - 1, parts.d, 12) + days * 24 * 60 * 60 * 1000;
    const shifted = new Date(utcNoon);
    return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

// 선택한 기준일이 속한 월요일~일요일
function getWeekRange(dateStr) {
    const iso = normalizeDateStr(dateStr);
    const parts = dateParts(iso);
    const day = new Date(Date.UTC(parts.y, parts.m - 1, parts.d, 12)).getUTCDay();
    const diffToMon = day === 0 ? -6 : 1 - day;
    const startDate = addDays(iso, diffToMon);
    return { startDate, endDate: addDays(startDate, 6) };
}

function formatWeekRangeLabel(startDate, endDate) {
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const fmt = (dateStr) => {
        if (!dateStr) return '-';
        const iso = normalizeDateStr(dateStr);
        const parts = dateParts(iso);
        const day = new Date(Date.UTC(parts.y, parts.m - 1, parts.d, 12)).getUTCDay();
        return `${iso.slice(5).replace('-', '/')}(${dayNames[day]})`;
    };
    return `${fmt(startDate)} - ${fmt(endDate)}`;
}

function SkeletonCard() {
    return (
        <div className="dash-card">
            <div className="dash-card-header">
                <div className="dash-skeleton" style={{ width: 120, height: 16 }} />
            </div>
            <div className="dash-card-body">
                <div className="dash-skeleton" style={{ width: '80%', height: 14, marginBottom: 12 }} />
                <div className="dash-skeleton" style={{ width: '60%', height: 14, marginBottom: 12 }} />
                <div className="dash-skeleton" style={{ width: '90%', height: 14 }} />
            </div>
        </div>
    );
}

export default function App() {
    const [user, setUser] = useState(null);
    const [authLoading, setAuthLoading] = useState(true);
    const [rangeType, setRangeType] = useState('day'); // 'day' | 'week' | 'custom'
    const [baseDate, setBaseDate] = useState(todayStr());
    const [customStart, setCustomStart] = useState(todayStr());
    const [customEnd, setCustomEnd] = useState(todayStr());
    const [branchFilter, setBranchFilter] = useState('');
    const [classFilter, setClassFilter] = useState('');
    const [gradeFilter, setGradeFilter] = useState(new Set());
    const [semesterSettings, setSemesterSettings] = useState({});
    const [loginError, setLoginError] = useState('');
    const [view, setView] = useState('logbook'); // 'logbook' | 'consult'

    // 학기 설정 로드 (1회)
    useEffect(() => {
        fetchSemesterSettings().then(setSemesterSettings).catch(() => {});
    }, []);

    // 인증 상태
    useEffect(() => {
        const unsub = onAuthStateChanged(auth, async (u) => {
            if (u) {
                const email = u.email || '';
                const allowed = email.endsWith('@gw.impact7.kr') || email.endsWith('@impact7.kr');
                if (!u.emailVerified || !allowed) {
                    alert('허용되지 않은 계정입니다.\n학원 계정(@gw.impact7.kr 또는 @impact7.kr)으로 다시 로그인해주세요.');
                    logout().catch(err => console.error('[dashboard logout]', err));
                    setUser(null);
                } else {
                    // dataApp(Firestore/Functions) 토큰 미러링 완료 후 user 설정 —
                    // getMessageDeliveryStatus callable이 토큰 없이 발사되는 것 방지.
                    await dataAuthReady();
                    setLoginError('');
                    setUser(u);
                }
            } else {
                setUser(null);
            }
            setAuthLoading(false);
        });
        return unsub;
    }, []);

    // custom 날짜 범위 검증: start > end 이면 swap
    const validCustomStart = customStart <= customEnd ? customStart : customEnd;
    const validCustomEnd = customStart <= customEnd ? customEnd : customStart;
    const dateRangeSwapped = rangeType === 'custom' && customStart > customEnd;

    // 날짜 범위 계산
    const normalizedBaseDate = useMemo(() => normalizeDateStr(baseDate), [baseDate]);

    const { startDate, endDate } = useMemo(() => {
        if (rangeType === 'day') return { startDate: normalizedBaseDate, endDate: normalizedBaseDate };
        if (rangeType === 'week') return getWeekRange(normalizedBaseDate);
        return { startDate: validCustomStart, endDate: validCustomEnd };
    }, [rangeType, normalizedBaseDate, validCustomStart, validCustomEnd]);

    // 데이터 로드
    const { students, loading: studentsLoading, error } = useStudents(user);
    const { checks, dailyRecords, postponed, dailyLog, loading: dataLoading, error: dashError } = useDashboardData(user, startDate, endDate);
    const { consultations, loading: consultLoading } = useConsultations(user, startDate, endDate, view === 'consult');

    // 선택 날짜 기준 학기 감지
    const currentSemesters = useMemo(() =>
        getSemestersForDate(startDate, semesterSettings),
    [startDate, semesterSettings]);

    // 반 목록 추출
    const classList = useMemo(() => {
        const set = new Set();
        students.forEach(s => {
            if (branchFilter && branchFromStudent(s) !== branchFilter) return;
            (s.enrollments || []).forEach(e => {
                const code = enrollmentCode(e);
                if (code) set.add(code);
            });
        });
        return [...set].sort();
    }, [students, branchFilter]);

    useEffect(() => {
        if (classFilter && !classList.includes(classFilter)) {
            setClassFilter('');
        }
    }, [classFilter, classList]);

    // 필터 적용된 checks
    const filteredChecks = useMemo(() => {
        const studentById = new Map(students.map(s => [s.id, s]));
        return checks.filter(c => {
            if (branchFilter && c.branch !== branchFilter) return false;
            if (classFilter && c.class_code !== classFilter) return false;
            if (gradeFilter?.size) {
                const student = studentById.get(c.student_id);
                if (student && !gradeFilter.has(studentGradeKey(student))) return false;
            }
            return true;
        });
    }, [checks, branchFilter, classFilter, gradeFilter, students]);

    const filteredPostponed = useMemo(() => {
        if (!branchFilter && !classFilter && !gradeFilter?.size) return postponed;
        return postponed.filter(p => {
            const student = students.find(s => s.id === p.student_id);
            if (!student) return true;
            if (branchFilter && branchFromStudent(student) !== branchFilter) return false;
            if (gradeFilter?.size && !gradeFilter.has(studentGradeKey(student))) return false;
            if (classFilter) {
                const hasClass = (student.enrollments || []).some(e => enrollmentCode(e) === classFilter);
                if (!hasClass) return false;
            }
            return true;
        });
    }, [postponed, branchFilter, classFilter, gradeFilter, students]);

    const filteredDailyRecords = useMemo(() => {
        const studentById = new Map(students.map(s => [s.id, s]));
        return dailyRecords.filter(rec => {
            const student = studentById.get(rec.student_id);
            if (!student) return !branchFilter && !classFilter && !gradeFilter?.size;
            if (branchFilter && branchFromStudent(student) !== branchFilter) return false;
            if (gradeFilter?.size && !gradeFilter.has(studentGradeKey(student))) return false;
            if (classFilter) {
                const hasClass = (student.enrollments || []).some(e => enrollmentCode(e) === classFilter);
                if (!hasClass) return false;
            }
            return true;
        });
    }, [dailyRecords, branchFilter, classFilter, gradeFilter, students]);

    const handleDashboardLogin = async () => {
        setLoginError('');
        try {
            await signInWithGoogle();
        } catch (err) {
            const messages = {
                'auth/popup-blocked': '팝업이 차단되었습니다. 브라우저에서 팝업을 허용해주세요.',
                'auth/popup-closed-by-user': '로그인 팝업이 닫혔습니다. 다시 시도해주세요.',
                'auth/cancelled-popup-request': '이미 로그인 팝업이 열려 있습니다.',
                'auth/unauthorized-domain': '현재 접속 주소가 Firebase 로그인 허용 도메인에 없습니다. 로컬에서는 http://localhost:5174/dashboard.html 로 접속해주세요.',
            };
            const message = messages[err?.code] || `로그인 실패: ${err?.code || err?.message || err}`;
            setLoginError(message);
            alert(message);
        }
    };

    // ─── 로그인 화면 ───
    if (authLoading) {
        return <div className="dash-loading">로딩 중...</div>;
    }

    if (!user) {
        return (
            <div className="dash-login">
                <div className="dash-login-card">
                    <h1>Impact7 DSC</h1>
                    <p>로그북</p>
                    <button className="dash-login-btn" onClick={handleDashboardLogin}>
                        Google 로그인
                    </button>
                    {loginError && <p className="dash-login-error">{loginError}</p>}
                </div>
            </div>
        );
    }

    const loading = studentsLoading || dataLoading;

    if (error || dashError) {
        return (
            <div role="alert" style={{
                padding: '20px',
                margin: '20px',
                background: '#fce8e6',
                color: '#c5221f',
                borderRadius: '8px',
                textAlign: 'center'
            }}>
                <p style={{ fontWeight: 500 }}>데이터 로드 실패</p>
                <p style={{ fontSize: '14px', marginTop: '8px' }}>{(error || dashError)?.message || '알 수 없는 오류가 발생했습니다'}</p>
                <IconButton
                    icon={ICON_NAME.refresh}
                    label="새로고침"
                    onClick={() => window.location.reload()}
                    style={{ marginTop: '12px' }}
                />
            </div>
        );
    }

    return (
        <div className="dash-app">
            {/* 상단 바 */}
            <header className="dash-header">
                <div className="dash-header-left">
                    <h1 className="dash-title">Impact7 DSC</h1>
                    <a href="./" className="dash-link" target="_blank" rel="noopener">DSC</a>
                    <span className="dash-view-toggle" role="group" aria-label="화면 전환">
                        <button type="button" className={view === 'logbook' ? 'active' : ''} aria-pressed={view === 'logbook'} onClick={() => setView('logbook')}>로그북</button>
                        <button type="button" className={view === 'consult' ? 'active' : ''} aria-pressed={view === 'consult'} onClick={() => setView('consult')}>상담</button>
                    </span>
                    <a href="./messages.html" className="dash-link" target="_blank" rel="noopener">메시지</a>
                </div>
                <div className="dash-header-right">
                    {Object.entries(currentSemesters).some(([, v]) => v) && (
                        <div className="dash-semester-badges">
                            {Object.entries(currentSemesters).map(([level, sem]) =>
                                sem ? (
                                    <span key={level} className="dash-semester-badge" title={`${level} 현재 학기`}>
                                        {level} {sem.split('-').slice(1).join('-')}
                                    </span>
                                ) : null
                            )}
                        </div>
                    )}
                    <span className="dash-user-email">{displayImpact7Email(user.email)}</span>
                    <button className="dash-avatar" onClick={() => logout()} title="로그아웃" aria-label="로그아웃">
                        {user.email[0].toUpperCase()}
                    </button>
                </div>
            </header>

            {/* 필터 바 */}
            <div className="dash-filters">
                <div className="dash-filter-group">
                    <label>기간</label>
                    <select aria-label="기간" value={rangeType} onChange={e => setRangeType(e.target.value)}>
                        <option value="day">일별</option>
                        <option value="week">주별</option>
                        <option value="custom">직접 선택</option>
                    </select>
                </div>

                {rangeType === 'day' && (
                    <div className="dash-filter-group">
                        <label>날짜</label>
                        <div className="dash-date-nav">
                            <button type="button" aria-label="이전 날" onClick={() => setBaseDate(addDays(normalizedBaseDate, -1))}>
                                <Icon name={ICON_NAME.chevron_left} size={20} aria-hidden="true" />
                            </button>
                            <button type="button" className="dash-date-btn" onClick={e => openKoreanDatePicker(e.currentTarget, normalizedBaseDate, setBaseDate)}>{normalizedBaseDate}</button>
                            <button type="button" aria-label="다음 날" onClick={() => setBaseDate(addDays(normalizedBaseDate, 1))}>
                                <Icon name={ICON_NAME.chevron_right} size={20} aria-hidden="true" />
                            </button>
                            <button type="button" aria-label="오늘" onClick={() => setBaseDate(todayStr())} title="오늘">
                                <Icon name={ICON_NAME.today} size={20} aria-hidden="true" />
                            </button>
                        </div>
                    </div>
                )}

                {rangeType === 'week' && (
                    <div className="dash-filter-group">
                        <label>기준일</label>
                        <div className="dash-date-nav">
                            <button type="button" aria-label="이전 주" onClick={() => setBaseDate(addDays(normalizedBaseDate, -7))}>
                                <Icon name={ICON_NAME.chevron_left} size={20} aria-hidden="true" />
                            </button>
                            <button type="button" className="dash-date-btn" onClick={e => openKoreanDatePicker(e.currentTarget, normalizedBaseDate, setBaseDate)}>{normalizedBaseDate}</button>
                            <button type="button" aria-label="다음 주" onClick={() => setBaseDate(addDays(normalizedBaseDate, 7))}>
                                <Icon name={ICON_NAME.chevron_right} size={20} aria-hidden="true" />
                            </button>
                            <IconButton icon="calendarDateRange" label="이번 주" onClick={() => setBaseDate(todayStr())} />
                            <span className="dash-range-label week">{formatWeekRangeLabel(startDate, endDate)}</span>
                        </div>
                    </div>
                )}

                {rangeType === 'custom' && (
                    <div className="dash-filter-group">
                        <label>기간</label>
                        <button type="button" className="dash-date-btn" onClick={e => openKoreanDatePicker(e.currentTarget, customStart, setCustomStart)}>{customStart || '시작일'}</button>
                        <span>~</span>
                        <button type="button" className="dash-date-btn" onClick={e => openKoreanDatePicker(e.currentTarget, customEnd, setCustomEnd)}>{customEnd || '종료일'}</button>
                        {dateRangeSwapped && (
                            <span className="dash-date-warning">시작일과 종료일이 바뀌어 자동 보정됩니다</span>
                        )}
                    </div>
                )}

                <div className="dash-filter-group">
                    <label>소속</label>
                    <select aria-label="소속" value={branchFilter} onChange={e => setBranchFilter(e.target.value)}>
                        <option value="">전체</option>
                        <option value="2단지">2단지</option>
                        <option value="10단지">10단지</option>
                    </select>
                </div>

                <div className="dash-filter-group">
                    <label>학년</label>
                    <GradeFilter value={gradeFilter} onChange={setGradeFilter} />
                </div>

                <div className="dash-filter-group">
                    <label>반</label>
                    <select aria-label="반" value={classFilter} onChange={e => setClassFilter(e.target.value)}>
                        <option value="">전체</option>
                        {classList.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                </div>

                {loading && <span className="dash-loading-indicator">로딩 중...</span>}
            </div>

            {view === 'consult' ? (
                consultLoading ? (
                    <div className="dash-grid"><SkeletonCard /><SkeletonCard /><SkeletonCard /></div>
                ) : (
                    <ErrorBoundary>
                        <Suspense fallback={<div className="dash-grid"><SkeletonCard /><SkeletonCard /><SkeletonCard /></div>}>
                            <ConsultationBoard
                                consultations={consultations}
                                students={students}
                                branchFilter={branchFilter}
                                classFilter={classFilter}
                                gradeFilter={gradeFilter}
                                startDate={startDate}
                                endDate={endDate}
                            />
                        </Suspense>
                    </ErrorBoundary>
                )
            ) : rangeType === 'day' ? (
                loading ? (
                    <div className="dash-grid">
                        <SkeletonCard />
                        <SkeletonCard />
                        <SkeletonCard />
                    </div>
                ) : (
                    <ErrorBoundary>
                        <DailyLogBoard
                            students={students}
                            dailyLog={dailyLog}
                            branchFilter={branchFilter}
                            classFilter={classFilter}
                            gradeFilter={gradeFilter}
                            date={normalizedBaseDate}
                        />
                    </ErrorBoundary>
                )
            ) : (
                <div className="period-log-page">
                    {loading ? (
                        <div className="dash-grid">
                            <SkeletonCard />
                            <SkeletonCard />
                            <SkeletonCard />
                            <SkeletonCard />
                            <SkeletonCard />
                            <SkeletonCard />
                        </div>
                    ) : (
                        <ErrorBoundary>
                            <Suspense fallback={<div className="dash-grid"><SkeletonCard /><SkeletonCard /><SkeletonCard /></div>}>
                                <PeriodLogBoard
                                    checks={filteredChecks}
                                    dailyRecords={filteredDailyRecords}
                                    students={students}
                                    postponed={filteredPostponed}
                                    startDate={startDate}
                                    endDate={endDate}
                                />
                            </Suspense>
                        </ErrorBoundary>
                    )}
                </div>
            )}
        </div>
    );
}
