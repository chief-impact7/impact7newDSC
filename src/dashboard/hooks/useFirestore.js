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
    fetchConsultationsForRange,
} from '../../shared/firestore-helpers.js';

const getDeliveryStatus = httpsCallable(functions, 'getMessageDeliveryStatus');

const emptyDelivery = () => ({
    queueCounts: { pending: 0, processing: 0, failed_retryable: 0, failed_permanent: 0, sent: 0 },
    channelCounts: { kakao: 0, sms: 0, lms: 0 },
    sentCount: 0,
    failedCount: 0,
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
    absenceNoticeIds: [],
});

// 학생 목록 로드 (앱 시작 시 1회)
export function useStudents(user) {
    const [students, setStudents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!user) { setStudents([]); setLoading(false); setError(null); return; }
        let cancelled = false;
        setLoading(true);
        setError(null);
        // 1) 디스크 캐시에서 즉시 선표시 — 새로고침 시 네트워크 왕복을 기다리지 않게.
        fetchStudentsFromCache().then(cached => {
            if (!cancelled && cached) { setStudents(cached); setLoading(false); }
        }).catch(() => {});
        // 2) 서버 최신으로 갱신.
        fetchStudents()
            .then(list => { if (!cancelled) { setStudents(list); setError(null); } })
            .catch(err => {
                if (cancelled) return;
                console.error('[useStudents]', err);
                setError(err);
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [user]);

    return { students, loading, error };
}

// 기간별 daily_checks + postponed_tasks 로드
export function useDashboardData(user, startDate, endDate) {
    const [checks, setChecks] = useState([]);
    const [dailyRecords, setDailyRecords] = useState([]);
    const [postponed, setPostponed] = useState([]);
    const [dailyLog, setDailyLog] = useState(emptyDailyLogData);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const reqIdRef = useRef(0);

    const reload = useCallback(() => {
        if (!user || !startDate || !endDate) return;
        const reqId = ++reqIdRef.current;   // 빠른 기간 변경 시 이전 요청 응답이 최신을 덮지 않도록. F-09
        setLoading(true);
        setError(null);
        // 일별 뷰에선 fetchDashboardDailyLogData가 같은 날 daily_records를 이미 읽으므로
        // range 조회를 생략하고 그 결과를 재사용한다(동일 데이터 2회 read 제거).
        const isDaily = startDate === endDate;
        Promise.all([
            fetchDailyChecksRange(startDate, endDate),
            isDaily ? Promise.resolve(null) : fetchDailyRecordsRange(startDate, endDate),
            fetchPostponedTasksRange(startDate, endDate),
            isDaily ? fetchDashboardDailyLogData(startDate) : Promise.resolve(null),
        ])
            .then(([c, records, p, log]) => {
                if (reqId !== reqIdRef.current) return;
                setChecks(c);
                setDailyRecords(records ?? log?.dailyRecords ?? []);
                setPostponed(p);
                if (log) setDailyLog(log);
                else setDailyLog(emptyDailyLogData());
            })
            .catch(err => {
                if (reqId !== reqIdRef.current) return;
                console.error('[useDashboardData]', err);
                setError(err);
            })
            .finally(() => {
                if (reqId === reqIdRef.current) setLoading(false);
            });
    }, [user, startDate, endDate]);

    useEffect(() => { reload(); }, [reload]);

    return { checks, dailyRecords, postponed, dailyLog, loading, reload, error };
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

    const reload = useCallback(() => {
        if (!user) return;
        setLoading(true);
        setError(null);
        getDeliveryStatus()
            .then(res => setData({ ...emptyDelivery(), ...(res?.data ?? {}) }))
            .catch(err => {
                console.error('[useMessageDelivery]', err);
                setError(err);
            })
            .finally(() => setLoading(false));
    }, [user]);

    useEffect(() => { reload(); }, [reload]);

    return { data, loading, reload, error };
}
