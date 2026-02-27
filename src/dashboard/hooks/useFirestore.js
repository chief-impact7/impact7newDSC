import { useState, useEffect, useCallback } from 'react';
import {
    fetchStudents,
    fetchDailyChecksRange,
    fetchPostponedTasksRange,
} from '../../shared/firestore-helpers.js';

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
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const reload = useCallback(() => {
        if (!user || !startDate || !endDate) return;
        setLoading(true);
        setError(null);
        Promise.all([
            fetchDailyChecksRange(startDate, endDate),
            fetchPostponedTasksRange(startDate, endDate),
        ])
            .then(([c, p]) => { setChecks(c); setPostponed(p); })
            .catch(err => {
                console.error('[useDashboardData]', err);
                setError(err);
            })
            .finally(() => setLoading(false));
    }, [user, startDate, endDate]);

    useEffect(() => { reload(); }, [reload]);

    return { checks, postponed, loading, reload, error };
}
