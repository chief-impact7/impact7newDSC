import React, { useState, useEffect, useMemo } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../../firebase-config.js';
import { signInWithGoogle, logout } from '../../auth.js';
import { useStudents, useDashboardData } from './hooks/useFirestore.js';
import { branchFromStudent, enrollmentCode, todayStr, addDays, toDateStrKST, parseDateKST, fetchSemesterSettings, getSemestersForDate } from '../shared/firestore-helpers.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import OverviewCard from './components/OverviewCard.jsx';
import AttendanceSummary from './components/AttendanceSummary.jsx';
import HomeworkSummary from './components/HomeworkSummary.jsx';
import TestSummary from './components/TestSummary.jsx';
import RetestSummary from './components/RetestSummary.jsx';
import ScheduleSummary from './components/ScheduleSummary.jsx';
import PostponedTasks from './components/PostponedTasks.jsx';

// 이번 주 월요일~일요일 구하기
function getWeekRange(dateStr) {
    const d = parseDateKST(dateStr);
    const day = d.getDay();
    const diffToMon = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setDate(d.getDate() + diffToMon);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { start: toDateStrKST(monday), end: toDateStrKST(sunday) };
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
    const [rangeType, setRangeType] = useState('week'); // 'day' | 'week' | 'custom'
    const [baseDate, setBaseDate] = useState(todayStr());
    const [customStart, setCustomStart] = useState(todayStr());
    const [customEnd, setCustomEnd] = useState(todayStr());
    const [branchFilter, setBranchFilter] = useState('');
    const [classFilter, setClassFilter] = useState('');
    const [semesterSettings, setSemesterSettings] = useState({});

    // 학기 설정 로드 (1회)
    useEffect(() => {
        fetchSemesterSettings().then(setSemesterSettings).catch(() => {});
    }, []);

    // 인증 상태
    useEffect(() => {
        const unsub = onAuthStateChanged(auth, (u) => {
            if (u) {
                const email = u.email || '';
                const allowed = email.endsWith('@gw.impact7.kr') || email.endsWith('@impact7.kr');
                if (!u.emailVerified || !allowed) {
                    alert('허용되지 않은 계정입니다.');
                    logout();
                    setUser(null);
                } else {
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
    const { startDate, endDate } = useMemo(() => {
        if (rangeType === 'day') return { startDate: baseDate, endDate: baseDate };
        if (rangeType === 'week') return getWeekRange(baseDate);
        return { startDate: validCustomStart, endDate: validCustomEnd };
    }, [rangeType, baseDate, validCustomStart, validCustomEnd]);

    // 데이터 로드
    const { students, loading: studentsLoading, error } = useStudents(user);
    const { checks, postponed, loading: dataLoading, error: dashError } = useDashboardData(user, startDate, endDate);

    // 선택 날짜 기준 학기 감지
    const currentSemesters = useMemo(() =>
        getSemestersForDate(startDate, semesterSettings),
    [startDate, semesterSettings]);

    // 반 목록 추출
    const classList = useMemo(() => {
        const set = new Set();
        students.forEach(s => {
            (s.enrollments || []).forEach(e => {
                const code = enrollmentCode(e);
                if (code) set.add(code);
            });
        });
        return [...set].sort();
    }, [students]);

    // 필터 적용된 checks
    const filteredChecks = useMemo(() => {
        return checks.filter(c => {
            if (branchFilter && c.branch !== branchFilter) return false;
            if (classFilter && c.class_code !== classFilter) return false;
            return true;
        });
    }, [checks, branchFilter, classFilter]);

    const filteredPostponed = useMemo(() => {
        if (!branchFilter && !classFilter) return postponed;
        return postponed.filter(p => {
            const student = students.find(s => s.id === p.student_id);
            if (!student) return true;
            if (branchFilter && branchFromStudent(student) !== branchFilter) return false;
            if (classFilter) {
                const hasClass = (student.enrollments || []).some(e => enrollmentCode(e) === classFilter);
                if (!hasClass) return false;
            }
            return true;
        });
    }, [postponed, branchFilter, classFilter, students]);

    // ─── 로그인 화면 ───
    if (authLoading) {
        return <div className="dash-loading">로딩 중...</div>;
    }

    if (!user) {
        return (
            <div className="dash-login">
                <div className="dash-login-card">
                    <h1>Impact7 DSC</h1>
                    <p>대시보드</p>
                    <button className="dash-login-btn" onClick={() => signInWithGoogle()}>
                        Google 로그인
                    </button>
                </div>
            </div>
        );
    }

    const loading = studentsLoading || dataLoading;

    if (error || dashError) {
        return (
            <div style={{
                padding: '20px',
                margin: '20px',
                background: '#fce8e6',
                color: '#c5221f',
                borderRadius: '8px',
                textAlign: 'center'
            }}>
                <p style={{ fontWeight: 500 }}>데이터 로드 실패</p>
                <p style={{ fontSize: '14px', marginTop: '8px' }}>{(error || dashError)?.message || '알 수 없는 오류가 발생했습니다'}</p>
                <button
                    onClick={() => window.location.reload()}
                    style={{ marginTop: '12px', padding: '8px 16px', cursor: 'pointer', borderRadius: '4px', border: '1px solid #c5221f', background: 'white', color: '#c5221f' }}
                >
                    새로고침
                </button>
            </div>
        );
    }

    return (
        <div className="dash-app">
            {/* 상단 바 */}
            <header className="dash-header">
                <div className="dash-header-left">
                    <h1 className="dash-title">Impact7 DSC</h1>
                    <span className="dash-subtitle">대시보드</span>
                    <a href="/" className="dash-link">입력 페이지</a>
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
                    <span className="dash-user-email">{user.email}</span>
                    <button className="dash-avatar" onClick={() => logout()} title="로그아웃">
                        {user.email[0].toUpperCase()}
                    </button>
                </div>
            </header>

            {/* 필터 바 */}
            <div className="dash-filters">
                <div className="dash-filter-group">
                    <label>기간</label>
                    <select value={rangeType} onChange={e => setRangeType(e.target.value)}>
                        <option value="day">일별</option>
                        <option value="week">주별</option>
                        <option value="custom">직접 선택</option>
                    </select>
                </div>

                {rangeType === 'day' && (
                    <div className="dash-filter-group">
                        <label>날짜</label>
                        <div className="dash-date-nav">
                            <button onClick={() => setBaseDate(addDays(baseDate, -1))}>
                                <span className="material-symbols-outlined">chevron_left</span>
                            </button>
                            <input type="date" value={baseDate} onChange={e => setBaseDate(e.target.value)} />
                            <button onClick={() => setBaseDate(addDays(baseDate, 1))}>
                                <span className="material-symbols-outlined">chevron_right</span>
                            </button>
                            <button onClick={() => setBaseDate(todayStr())} title="오늘">
                                <span className="material-symbols-outlined">today</span>
                            </button>
                        </div>
                    </div>
                )}

                {rangeType === 'week' && (
                    <div className="dash-filter-group">
                        <label>주</label>
                        <div className="dash-date-nav">
                            <button onClick={() => setBaseDate(addDays(baseDate, -7))}>
                                <span className="material-symbols-outlined">chevron_left</span>
                            </button>
                            <span className="dash-range-label">{startDate} ~ {endDate}</span>
                            <button onClick={() => setBaseDate(addDays(baseDate, 7))}>
                                <span className="material-symbols-outlined">chevron_right</span>
                            </button>
                            <button onClick={() => setBaseDate(todayStr())} title="이번 주">
                                <span className="material-symbols-outlined">today</span>
                            </button>
                        </div>
                    </div>
                )}

                {rangeType === 'custom' && (
                    <div className="dash-filter-group">
                        <label>기간</label>
                        <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} />
                        <span>~</span>
                        <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} />
                        {dateRangeSwapped && (
                            <span className="dash-date-warning">시작일과 종료일이 바뀌어 자동 보정됩니다</span>
                        )}
                    </div>
                )}

                <div className="dash-filter-group">
                    <label>소속</label>
                    <select value={branchFilter} onChange={e => setBranchFilter(e.target.value)}>
                        <option value="">전체</option>
                        <option value="2단지">2단지</option>
                        <option value="10단지">10단지</option>
                    </select>
                </div>

                <div className="dash-filter-group">
                    <label>반</label>
                    <select value={classFilter} onChange={e => setClassFilter(e.target.value)}>
                        <option value="">전체</option>
                        {classList.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                </div>

                {loading && <span className="dash-loading-indicator">로딩 중...</span>}
            </div>

            {/* 대시보드 카드 그리드 */}
            <div className="dash-grid">
                {loading ? (
                    <>
                        <SkeletonCard />
                        <SkeletonCard />
                        <SkeletonCard />
                        <SkeletonCard />
                        <SkeletonCard />
                        <SkeletonCard />
                    </>
                ) : (
                    <>
                        <ErrorBoundary>
                            <OverviewCard checks={filteredChecks} students={students} />
                        </ErrorBoundary>
                        <ErrorBoundary>
                            <AttendanceSummary checks={filteredChecks} startDate={startDate} endDate={endDate} />
                        </ErrorBoundary>
                        <ErrorBoundary>
                            <HomeworkSummary checks={filteredChecks} />
                        </ErrorBoundary>
                        <ErrorBoundary>
                            <TestSummary checks={filteredChecks} />
                        </ErrorBoundary>
                        <ErrorBoundary>
                            <RetestSummary checks={filteredChecks} />
                        </ErrorBoundary>
                        <ErrorBoundary>
                            <ScheduleSummary checks={filteredChecks} />
                        </ErrorBoundary>
                        <ErrorBoundary>
                            <PostponedTasks tasks={filteredPostponed} />
                        </ErrorBoundary>
                    </>
                )}
            </div>
        </div>
    );
}
