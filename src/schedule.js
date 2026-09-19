export function parseHHMM(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function toHHMM(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

// UTC offset of an instant as signed minutes east of UTC (e.g. +120 for CEST).
export function localOffsetMinutes(timezone, epochMs) {
  const off = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).format(new Date(epochMs));
  const m = /GMT([+-]\d{2}):(\d{2})/.exec(off);
  return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2]) : 0;
}

// Local wall-clock time (HH:mm) in the given IANA zone, using Intl (DST-safe:
// skipped minutes never occur, repeated minutes produce the same value).
export function localMinutes(timezone, now) {
  const d = now instanceof Date ? now : new Date(now);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const h = parts.find((p) => p.type === "hour").value;
  const m = parts.find((p) => p.type === "minute").value;
  return Number(h) * 60 + Number(m);
}

export function isDaylight(timezone, now) {
  const d = new Date(now instanceof Date ? now : new Date(now));
  const jan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1, 12, 0, 0));
  return localOffsetMinutes(timezone, d.getTime()) !== localOffsetMinutes(timezone, jan.getTime());
}

// Local wall-clock breakdown (year/month/day/hour/minute) in a zone via Intl.
function localWall(timezone, epochMs) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const read = (t) => parts.find((p) => p.type === t).value;
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")),
    minute: Number(read("minute")),
  };
}

// Epoch (ms) at which the owner's local wall clock shows hh:mm on the given
// local date, or null when that wall time never occurs (DST-gap minutes).
function epochForLocal(timezone, { year, month, day }, minutes) {
  const noon = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
  const off = localOffsetMinutes(timezone, noon);
  const t = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - off * 60000 + minutes * 60000);
  for (let k = 0; k < 3; k++) {
    const wall = localWall(timezone, t.getTime());
    const sameDate = wall.year === year && wall.month === month && wall.day === day;
    const diff = minutes - (wall.hour * 60 + wall.minute);
    if (sameDate && diff === 0) return t.getTime();
    t.setTime(t.getTime() + diff * 60000);
  }
  return null;
}

// Recurring daily window: start-inclusive, end-exclusive. Overnight windows
// (start > end) match time >= start OR time < end. Equal start/end = all-day
// guard (rejected by validation at the feature layer) -> never active here.
export function inWindow(start, end, minutes) {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s === null || e === null || s === e) return false;
  if (s < e) return minutes >= s && minutes < e;
  return minutes >= s || minutes < e;
}

export function nightActive(timezone, start, end, now) {
  return inWindow(start, end, localMinutes(timezone, now));
}

// Next boundary crossing moment in UTC for a recurring window. Exact under DST:
// boundaries are converted from owner wall-clock to real instants, and a wall
// time that never occurs (spring-forward gap) is simply skipped.
export function nextBoundaryUtc(timezone, start, end, now) {
  const d = new Date(now instanceof Date ? now : new Date(now));
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s === null || e === null || s === e) return null;
  const today = localWall(timezone, d.getTime());
  const baseLocalMidnight = Date.UTC(today.year, today.month - 1, today.day, 0, 0, 0, 0);
  const candidates = [];
  for (let i = 0; i <= 3; i++) {
    const day = localWall(timezone, baseLocalMidnight + i * 86400000 + 12 * 3600000);
    for (const [label, target] of [["opens", s], ["closes", e]]) {
      const epoch = epochForLocal(timezone, day, target);
      if (epoch !== null && epoch > d.getTime()) candidates.push({ label, at: new Date(epoch).toISOString() });
    }
  }
  candidates.sort((a, b) => a.at.localeCompare(b.at));
  return candidates[0] || null;
}