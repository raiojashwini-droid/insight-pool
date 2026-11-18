/**
 * Timesheet Calculation Utility
 * Advanced interval arithmetic: non-overlapping session merging, cross-midnight splitting,
 * unpaid break deductions, and configurable weekly overtime thresholds.
 */

function isValidDate(d) {
    if (d === null || d === undefined || d === '') return false;
    if (d instanceof Date) return !isNaN(d.getTime());
    if (typeof d !== 'string') return false;
    const date = new Date(d.includes('T') ? d : d + 'T00:00:00Z');
    return !isNaN(date.getTime());
}

function isoDay(d) {
    if (!d) return '';
    const date = new Date(d);
    return date.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function mondayOf(d = new Date()) {
    if (d === null || d === undefined || d === '') d = new Date();
    const date = typeof d === 'string' ? new Date(d.includes('T') ? d : d + 'T00:00:00Z') : new Date(d);
    if (isNaN(date.getTime())) {
        const err = new Error(`Invalid date format for week: "${d}". Expected valid date (e.g. YYYY-MM-DD)`);
        err.statusCode = 400;
        throw err;
    }
    const day = date.getUTCDay();
    const diff = (day + 6) % 7; // diff to Monday
    date.setUTCDate(date.getUTCDate() - diff);
    return date.toISOString().slice(0, 10);
}

function weekDates(weekStart) {
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/**
 * Merges overlapping and adjacent intervals: [[s1, e1], [s2, e2], ...]
 */
function mergeIntervals(intervals) {
    if (!intervals || intervals.length === 0) return [];
    const valid = intervals.filter(([s, e]) => typeof s === 'number' && typeof e === 'number' && e > s);
    if (valid.length === 0) return [];
    
    valid.sort((a, b) => a[0] - b[0]);
    const merged = [valid[0]];

    for (let i = 1; i < valid.length; i++) {
        const [currStart, currEnd] = valid[i];
        const last = merged[merged.length - 1];

        if (currStart <= last[1]) {
            last[1] = Math.max(last[1], currEnd);
        } else {
            merged.push([currStart, currEnd]);
        }
    }
    return merged;
}

/**
 * Subtracts break intervals from work intervals
 */
function subtractIntervals(workIntervals, breakIntervals) {
    let remaining = [...workIntervals];
    for (const [bStart, bEnd] of breakIntervals) {
        const next = [];
        for (const [wStart, wEnd] of remaining) {
            if (bEnd <= wStart || bStart >= wEnd) {
                // No overlap
                next.push([wStart, wEnd]);
            } else {
                // Overlap: split around break
                if (wStart < bStart) {
                    next.push([wStart, bStart]);
                }
                if (wEnd > bEnd) {
                    next.push([bEnd, wEnd]);
                }
            }
        }
        remaining = next;
    }
    return remaining;
}

/**
 * Calculates per-day minutes and detailed breakdown for 7 days (Mon-Sun).
 * Supports:
 * - Unpaid break deductions
 * - Cross-midnight attendance & overnight shifts
 * - Deduplication of overlapping attendance & manual time
 */
function buildDailyBreakdown(attendanceRecords = [], manualRecords = [], breakRecordsOrWeekStart = [], weekStartArg = '', nowMs = Date.now()) {
    let breakRecords = [];
    let weekStart = '';

    if (typeof breakRecordsOrWeekStart === 'string') {
        weekStart = breakRecordsOrWeekStart;
        nowMs = typeof weekStartArg === 'number' ? weekStartArg : Date.now();
    } else {
        breakRecords = Array.isArray(breakRecordsOrWeekStart) ? breakRecordsOrWeekStart : [];
        weekStart = weekStartArg;
    }

    const dates = weekDates(weekStart);
    const byDay = Object.fromEntries(dates.map(d => [d, {
        rawWorkIntervals: [],
        rawBreakIntervals: [],
        sessions: []
    }]));

    // 1. Process Attendance records (supports cross-midnight)
    attendanceRecords.forEach(att => {
        const sMs = new Date(att.clockIn).getTime();
        const isLive = !att.clockOut;
        const eMs = att.clockOut ? new Date(att.clockOut).getTime() : nowMs;
        if (isNaN(sMs) || isNaN(eMs) || eMs <= sMs) return;

        // Clip across week calendar days
        dates.forEach(d => {
            const dayStart = new Date(d + 'T00:00:00Z').getTime();
            const dayEnd = new Date(d + 'T23:59:59.999Z').getTime() + 1; // 24:00:00.000

            const ws = Math.max(sMs, dayStart);
            const we = Math.min(eMs, dayEnd);

            if (we > ws) {
                byDay[d].rawWorkIntervals.push([ws, we]);
                const crossMidnight = (sMs < dayStart) || (eMs > dayEnd);
                byDay[d].sessions.push({
                    id: att.id,
                    type: 'attendance',
                    clockIn: att.clockIn,
                    clockOut: att.clockOut,
                    durationSeconds: att.duration || Math.max(0, Math.floor((eMs - sMs) / 1000)),
                    minutes: Math.round((we - ws) / 60000),
                    isLive,
                    crossMidnight
                });
            }
        });
    });

    // 2. Process Manual Time records (work vs break)
    manualRecords.forEach(man => {
        const sMs = new Date(man.startTime).getTime();
        const eMs = new Date(man.endTime).getTime();
        if (isNaN(sMs) || isNaN(eMs) || eMs <= sMs) return;

        const isBreak = String(man.type || '').trim().toUpperCase() === 'BREAK';

        dates.forEach(d => {
            const dayStart = new Date(d + 'T00:00:00Z').getTime();
            const dayEnd = new Date(d + 'T23:59:59.999Z').getTime() + 1;

            const ws = Math.max(sMs, dayStart);
            const we = Math.min(eMs, dayEnd);

            if (we > ws) {
                if (isBreak) {
                    byDay[d].rawBreakIntervals.push([ws, we]);
                } else {
                    byDay[d].rawWorkIntervals.push([ws, we]);
                    byDay[d].sessions.push({
                        id: man.id,
                        type: 'manual',
                        note: man.note || man.type,
                        startTime: man.startTime,
                        endTime: man.endTime,
                        durationSeconds: man.duration || Math.max(0, Math.floor((we - ws) / 1000)),
                        minutes: Math.round((we - ws) / 60000)
                    });
                }
            }
        });
    });

    // 3. Process ActivityLog Breaks
    breakRecords.forEach(b => {
        const sMs = new Date(b.startTime || b.timestamp).getTime();
        const durationSec = b.duration || 0;
        const eMs = b.endTime ? new Date(b.endTime).getTime() : sMs + (durationSec * 1000);
        if (isNaN(sMs) || isNaN(eMs) || eMs <= sMs) return;

        dates.forEach(d => {
            const dayStart = new Date(d + 'T00:00:00Z').getTime();
            const dayEnd = new Date(d + 'T23:59:59.999Z').getTime() + 1;

            const bs = Math.max(sMs, dayStart);
            const be = Math.min(eMs, dayEnd);

            if (be > bs) {
                byDay[d].rawBreakIntervals.push([bs, be]);
            }
        });
    });

    // 4. Interval Merging & Break Subtraction for each Day
    const days = dates.map(d => {
        const mergedWork = mergeIntervals(byDay[d].rawWorkIntervals);
        const mergedBreaks = mergeIntervals(byDay[d].rawBreakIntervals);
        const netWork = subtractIntervals(mergedWork, mergedBreaks);

        const grossMs = mergedWork.reduce((acc, [s, e]) => acc + (e - s), 0);
        const netMs = netWork.reduce((acc, [s, e]) => acc + (e - s), 0);
        const breakMs = Math.max(0, grossMs - netMs);

        const netMinutes = Math.round(netMs / 60000);
        const grossMinutes = Math.round(grossMs / 60000);
        const breakMinutes = Math.round(breakMs / 60000);

        return {
            date: d,
            minutes: netMinutes,
            grossMinutes,
            breakMinutes,
            sessions: byDay[d].sessions
        };
    });

    return days;
}

/**
 * Weekly Rollup: computes regular/overtime minutes against threshold.
 */
function summarizeWeek(days, otThresholdMinutes = 2400) {
    const totalMinutes = days.reduce((acc, d) => acc + d.minutes, 0);
    const totalGrossMinutes = days.reduce((acc, d) => acc + (d.grossMinutes || d.minutes), 0);
    const totalBreakMinutes = days.reduce((acc, d) => acc + (d.breakMinutes || 0), 0);

    const threshold = Number(otThresholdMinutes) > 0 ? Number(otThresholdMinutes) : 2400;
    const regularMinutes = Math.min(totalMinutes, threshold);
    const overtimeMinutes = Math.max(0, totalMinutes - threshold);

    return {
        totalMinutes,
        totalGrossMinutes,
        totalBreakMinutes,
        regularMinutes,
        overtimeMinutes,
        overThreshold: overtimeMinutes > 0,
        otThresholdMinutes: threshold
    };
}

/**
 * Pay calculation in standard currency float (2 decimal places).
 */
function calculatePay(regularMinutes, overtimeMinutes, hourlyRate = 0, otMultiplierPct = 150) {
    const rate = Number(hourlyRate) || 0;
    const multiplier = (Number(otMultiplierPct) > 0 ? Number(otMultiplierPct) : 150) / 100;

    const regularPay = Math.round(((regularMinutes / 60) * rate) * 100) / 100;
    const overtimePay = Math.round(((overtimeMinutes / 60) * (rate * multiplier)) * 100) / 100;
    const totalPay = Math.round((regularPay + overtimePay) * 100) / 100;

    return {
        hourlyRate: rate,
        regularPay,
        overtimePay,
        totalPay,
        otMultiplierPct: multiplier * 100
    };
}

module.exports = {
    isValidDate,
    isoDay,
    addDays,
    mondayOf,
    weekDates,
    mergeIntervals,
    subtractIntervals,
    buildDailyBreakdown,
    summarizeWeek,
    calculatePay
};
