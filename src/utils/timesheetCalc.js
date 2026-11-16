/**
 * Timesheet Calculation Utility
 * Adapts Punchcard timeclock logic to existing Prisma/MySQL Attendance and ManualTime records.
 */

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
    const date = typeof d === 'string' ? new Date(d + 'T00:00:00Z') : new Date(d);
    const day = date.getUTCDay();
    // In JS getUTCDay(): 0 is Sunday, 1 is Monday ... 6 is Saturday
    const diff = (day + 6) % 7; // diff to Monday
    date.setUTCDate(date.getUTCDate() - diff);
    return date.toISOString().slice(0, 10);
}

function weekDates(weekStart) {
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/**
 * Calculates per-day minutes and detailed breakdown for 7 days (Mon-Sun).
 */
function buildDailyBreakdown(attendanceRecords, manualRecords, weekStart, nowMs = Date.now()) {
    const dates = weekDates(weekStart);
    const byDay = Object.fromEntries(dates.map(d => [d, { minutes: 0, sessions: [] }]));

    // 1. Process Attendance records
    attendanceRecords.forEach(att => {
        const d = isoDay(att.date || att.clockIn);
        if (!byDay[d]) return;

        let seconds = 0;
        let isLive = false;

        if (att.duration && att.duration > 0) {
            seconds = att.duration;
        } else if (att.clockIn && att.clockOut) {
            seconds = Math.max(0, Math.floor((new Date(att.clockOut).getTime() - new Date(att.clockIn).getTime()) / 1000));
        } else if (att.clockIn && !att.clockOut) {
            seconds = Math.max(0, Math.floor((nowMs - new Date(att.clockIn).getTime()) / 1000));
            isLive = true;
        }

        const mins = Math.round(seconds / 60);
        byDay[d].minutes += mins;
        byDay[d].sessions.push({
            id: att.id,
            type: 'attendance',
            clockIn: att.clockIn,
            clockOut: att.clockOut,
            minutes: mins,
            isLive
        });
    });

    // 2. Process Manual Time records
    manualRecords.forEach(man => {
        const d = isoDay(man.startTime);
        if (!byDay[d]) return;

        const seconds = man.duration || Math.max(0, Math.floor((new Date(man.endTime).getTime() - new Date(man.startTime).getTime()) / 1000));
        const mins = Math.round(seconds / 60);
        byDay[d].minutes += mins;
        byDay[d].sessions.push({
            id: man.id,
            type: 'manual',
            note: man.note || man.type,
            startTime: man.startTime,
            endTime: man.endTime,
            minutes: mins
        });
    });

    const days = dates.map(d => ({
        date: d,
        minutes: byDay[d].minutes,
        sessions: byDay[d].sessions
    }));

    return days;
}

/**
 * Weekly Rollup: computes regular/overtime minutes against threshold.
 */
function summarizeWeek(days, otThresholdMinutes = 2400) {
    const totalMinutes = days.reduce((acc, d) => acc + d.minutes, 0);
    const regularMinutes = Math.min(totalMinutes, otThresholdMinutes);
    const overtimeMinutes = Math.max(0, totalMinutes - otThresholdMinutes);

    return {
        totalMinutes,
        regularMinutes,
        overtimeMinutes,
        overThreshold: overtimeMinutes > 0
    };
}

/**
 * Pay calculation in standard currency float (2 decimal places).
 */
function calculatePay(regularMinutes, overtimeMinutes, hourlyRate = 0, otMultiplierPct = 150) {
    const rate = Number(hourlyRate) || 0;
    const regularPay = Math.round(((regularMinutes / 60) * rate) * 100) / 100;
    const overtimePay = Math.round(((overtimeMinutes / 60) * (rate * (otMultiplierPct / 100))) * 100) / 100;
    const totalPay = Math.round((regularPay + overtimePay) * 100) / 100;

    return {
        hourlyRate: rate,
        regularPay,
        overtimePay,
        totalPay
    };
}

module.exports = {
    isoDay,
    addDays,
    mondayOf,
    weekDates,
    buildDailyBreakdown,
    summarizeWeek,
    calculatePay
};
