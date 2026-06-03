import { useState, useEffect, useCallback } from 'react';
import {
    fetchStudents,
    fetchDailyChecksRange,
    fetchPostponedTasksRange,
    fetchDashboardDailyLogData,
} from '../../shared/firestore-helpers.js';

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
            fetchPostponedTasksRange(startDate, endDate),
            startDate === endDate ? fetchDashboardDailyLogData(startDate) : Promise.resolve(null),
        ])
            .then(([c, p, log]) => {
                setChecks(c);
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

    return { checks, postponed, dailyLog, loading, reload, error };
}
