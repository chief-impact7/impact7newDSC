import { useState, useEffect, useCallback } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../../firebase-config.js';
import {
    fetchStudents,
    fetchDailyChecksRange,
    fetchDailyRecordsRange,
    fetchPostponedTasksRange,
    fetchDashboardDailyLogData,
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
});

// 학생 목록 로드 (앱 시작 시 1회)
export function useStudents(user) {
    const [students, setStudents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!user) { setStudents([]); setLoading(false); setError(null); return; }
        setLoading(true);
        setError(null);
        fetchStudents()
            .then(list => setStudents(list))
            .catch(err => {
                console.error('[useStudents]', err);
                setError(err);
            })
            .finally(() => setLoading(false));
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

    const reload = useCallback(() => {
        if (!user || !startDate || !endDate) return;
        setLoading(true);
        setError(null);
        Promise.all([
            fetchDailyChecksRange(startDate, endDate),
            fetchDailyRecordsRange(startDate, endDate),
            fetchPostponedTasksRange(startDate, endDate),
            startDate === endDate ? fetchDashboardDailyLogData(startDate) : Promise.resolve(null),
        ])
            .then(([c, records, p, log]) => {
                setChecks(c);
                setDailyRecords(records);
                setPostponed(p);
                if (log) setDailyLog(log);
                else setDailyLog(emptyDailyLogData());
            })
            .catch(err => {
                console.error('[useDashboardData]', err);
                setError(err);
            })
            .finally(() => setLoading(false));
    }, [user, startDate, endDate]);

    useEffect(() => { reload(); }, [reload]);

    return { checks, dailyRecords, postponed, dailyLog, loading, reload, error };
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
