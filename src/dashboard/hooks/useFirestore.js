import { useState, useEffect, useCallback, useRef } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../../firebase-config.js';
import {
    fetchStudents,
    fetchStudentsFromCache,
    fetchDailyChecksRange,
    fetchDailyRecordsRange,
    fetchPostponedTasksRange,
    fetchDashboardDailyLogData,
    fetchDashboardDailyLogDataFromCache,
    fetchConsultationsForRange,
    fetchStudentStatusSummaries,
    fetchClassSettingsMap,
    fetchStaffNameMap,
    fetchAiStatusDataFromCache,
} from '../../shared/firestore-helpers.js';
import { kstDayRangeParams } from '../message-period.js';

const getDeliveryStatus = httpsCallable(functions, 'getMessageDeliveryStatus');

const emptyDelivery = () => ({
    queueCounts: { pending: 0, processing: 0, failed_retryable: 0, failed_permanent: 0, sent: 0 },
    channelCounts: { kakao: 0, sms: 0, mms: 0 },
    sentCount: 0,
    failedCount: 0,
    queueDetails: {},
    failures: [],
});

const emptyDailyLogData = () => ({
    dailyRecords: [],
    tempAttendances: [],
    hwFailTasks: [],
    testFailTasks: [],
    absenceRecords: [],
    leaveRequests: [],
    classSettings: {},
    attendanceEvents: [],
    absenceNoticeStatus: {},
    importantRecords: [],
});

// 학생 목록 로드 (앱 시작 시 1회)
export function useStudents(user, includeEnded = false) {
    const [students, setStudents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!user) { setStudents([]); setLoading(false); setError(null); return; }
        let cancelled = false;
        setLoading(true);
        setError(null);
        // 1) 디스크 캐시에서 즉시 선표시 — 새로고침 시 네트워크 왕복을 기다리지 않게.
        fetchStudentsFromCache(includeEnded).then(cached => {
            if (!cancelled && cached) { setStudents(cached); setLoading(false); }
        }).catch(() => {});
        // 2) 서버 최신으로 갱신.
        fetchStudents(includeEnded)
            .then(list => {
                if (!cancelled) {
                    setStudents(list);
                    setError(null);
                    globalThis.performance?.mark?.('students-loaded');
                }
            })
            .catch(err => {
                if (cancelled) return;
                console.error('[useStudents]', err);
                setError(err);
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [user, includeEnded]);

    return { students, loading, error };
}

// 기간별 daily_checks + postponed_tasks 로드
export function useDashboardData(user, startDate, endDate, enabled, dailyView) {
    const [checks, setChecks] = useState([]);
    const [dailyRecords, setDailyRecords] = useState([]);
    const [postponed, setPostponed] = useState([]);
    const [dailyLog, setDailyLog] = useState(emptyDailyLogData);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [loadedKey, setLoadedKey] = useState('');
    const reqIdRef = useRef(0);
    const requestKey = enabled && user && startDate && endDate ? `${startDate}:${endDate}:${dailyView}` : '';

    const reload = useCallback(() => {
        if (!enabled || !user || !startDate || !endDate) {
            ++reqIdRef.current;
            setLoading(false);
            setError(null);
            return;
        }
        const reqId = ++reqIdRef.current;   // 빠른 기간 변경 시 이전 요청 응답이 최신을 덮지 않도록. F-09
        setLoading(true);
        setError(null);
        const applyData = (data) => {
            setChecks(data.checks);
            setDailyRecords(data.dailyRecords);
            setPostponed(data.postponed);
            setDailyLog(data.dailyLog);
            setLoadedKey(`${startDate}:${endDate}:${dailyView}`);
        };
        // daily 뷰(DailyLogBoard)만 dailyLog 단일 요청 — custom 같은 날짜 기간은 PeriodLogBoard가
        // checks·postponed를 쓰므로 범위 조회를 유지한다.
        let request;
        if (dailyView) {
            let serverDone = false;
            fetchDashboardDailyLogDataFromCache(startDate).then(dailyLog => {
                if (serverDone || reqId !== reqIdRef.current || !dailyLog) return;
                applyData({ checks: [], dailyRecords: dailyLog.dailyRecords, postponed: [], dailyLog });
                setLoading(false);
            });
            request = fetchDashboardDailyLogData(startDate).then(dailyLog => {
                serverDone = true;
                globalThis.performance?.mark?.('dailylog-loaded');
                return { checks: [], dailyRecords: dailyLog.dailyRecords, postponed: [], dailyLog };
            });
        } else {
            request = Promise.all([
                fetchDailyChecksRange(startDate, endDate),
                fetchDailyRecordsRange(startDate, endDate),
                fetchPostponedTasksRange(startDate, endDate),
            ]).then(([checks, dailyRecords, postponed]) => ({
                checks, dailyRecords, postponed, dailyLog: emptyDailyLogData(),
            }));
        }
        request
            .then(data => {
                if (reqId !== reqIdRef.current) return;
                applyData(data);
            })
            .catch(err => {
                if (reqId !== reqIdRef.current) return;
                console.error('[useDashboardData]', err);
                setError(err);
            })
            .finally(() => {
                if (reqId === reqIdRef.current) setLoading(false);
            });
    }, [enabled, user, startDate, endDate, dailyView]);

    useEffect(() => { reload(); }, [reload]);

    return {
        checks, dailyRecords, postponed, dailyLog,
        loading: loading || (Boolean(requestKey) && loadedKey !== requestKey),
        reload, error: enabled ? error : null,
    };
}

// 기간 상담 조회 훅. enabled=false(상담 뷰 비활성)면 fetch하지 않는다(불필요 읽기 방지).
export function useConsultations(user, startDate, endDate, enabled) {
    const [consultations, setConsultations] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const reqIdRef = useRef(0);
    const prevEnabledRef = useRef(false);

    // enabled가 막 켜졌으면 첫 렌더에 즉시 로딩 표시 — 데이터 도착 전 '없음' 빈 상태 깜빡임 방지.
    if (enabled && !prevEnabledRef.current) setLoading(true);
    prevEnabledRef.current = enabled;

    const reload = useCallback(() => {
        if (!enabled || !user || !startDate || !endDate) {
            ++reqIdRef.current; // 비활성 후 도착한 in-flight 응답이 비운 상태를 덮지 않도록 무효화
            setConsultations([]);
            return;
        }
        const reqId = ++reqIdRef.current; // 빠른 기간 변경 시 stale 응답이 최신을 덮지 않도록
        setLoading(true);
        setError(null);
        fetchConsultationsForRange(startDate, endDate)
            .then(list => { if (reqId === reqIdRef.current) setConsultations(list); })
            .catch(err => {
                if (reqId !== reqIdRef.current) return;
                console.error('[useConsultations]', err);
                setError(err);
            })
            .finally(() => { if (reqId === reqIdRef.current) setLoading(false); });
    }, [enabled, user, startDate, endDate]);

    useEffect(() => { reload(); }, [reload]);
    return { consultations, loading, error };
}

// 메시지 발송 현황 집계. message_queue는 평문 번호를 보유한 서버 전용 데이터라 클라가 직접
// read하지 않고(rules read 차단), getMessageDeliveryStatus callable이 카운트+마스킹 실패목록만 내려준다.
export function useMessageDelivery(user) {
    const [data, setData] = useState(emptyDelivery);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const reqIdRef = useRef(0);

    // params: { fromMs?, toMs? } — 발송 통계 기간 필터.
    const reload = useCallback((params) => {
        if (!user) return;
        const reqId = ++reqIdRef.current; // 빠른 기간 전환 시 느린 이전 응답이 최신을 덮지 않도록. F-03
        setLoading(true);
        setError(null);
        getDeliveryStatus(params ?? {})
            .then(res => { if (reqId === reqIdRef.current) setData({ ...emptyDelivery(), ...(res?.data ?? {}) }); })
            .catch(err => {
                if (reqId !== reqIdRef.current) return;
                console.error('[useMessageDelivery]', err);
                setError(err);
            })
            .finally(() => { if (reqId === reqIdRef.current) setLoading(false); });
    }, [user]);

    useEffect(() => { reload(kstDayRangeParams()); }, [reload]);

    return { data, loading, reload, error };
}

// AI 종합상태 뷰 데이터. 월 단위 갱신이라 세션당 1회만 fetch — 모듈 캐시로 뷰 재진입 시 재사용.
let _aiStatusCache = null;

export function useAiStatusData(user, enabled) {
    const [data, setData] = useState(_aiStatusCache);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const reqIdRef = useRef(0);

    const load = useCallback((force) => {
        if (!user || (!force && (_aiStatusCache || !enabled))) return;
        const reqId = ++reqIdRef.current;
        setLoading(true);
        setError(null);
        // 디스크 캐시 선표시. 서버 응답이 먼저 도착했으면 캐시로 덮어쓰지 않는다.
        let serverDone = false;
        fetchAiStatusDataFromCache().then(cached => {
            if (serverDone || reqId !== reqIdRef.current || !cached) return;
            _aiStatusCache = cached;
            setData(cached);
        });
        Promise.all([fetchStudentStatusSummaries(), fetchClassSettingsMap(), fetchStaffNameMap()])
            .then(([summaries, classSettings, staffByLocal]) => {
                serverDone = true;
                if (reqId !== reqIdRef.current) return;
                _aiStatusCache = { summaries, classSettings, staffByLocal };
                setData(_aiStatusCache);
            })
            .catch(err => {
                if (reqId !== reqIdRef.current) return;
                console.error('[useAiStatusData]', err);
                setError(err);
            })
            .finally(() => { if (reqId === reqIdRef.current) setLoading(false); });
    }, [user, enabled]);

    useEffect(() => { load(false); }, [load]);

    const reload = useCallback(() => { _aiStatusCache = null; load(true); }, [load]);
    return { data, loading, error, reload };
}
