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
  const d = now instanceof Date ? now : new Date(now);
  const year = d.getUTCFullYear();
  const jan = new Date(Date.UTC(year, 0, 1, 12, 0, 0));
  const jul = new Date(Date.UTC(year, 6, 1, 12, 0, 0));
  const fmt = (d) => {
    const off = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).format(d);
    const m = /GMT([+-]\d{2}):(\d{2})/.exec(off);
    return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2]) : 0;
  };
  return fmt(jul) !== fmt(jan);
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

// Next boundary crossing moment in UTC for a recurring window.
export function nextBoundaryUtc(timezone, start, end, now) {
  const d = now instanceof Date ? now : new Date(now);
  const cur = localMinutes(timezone, d);
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s === null || e === null || s === e) return null;
  const insideNow = inWindow(start, end, cur);
  const candidates = [];
  const oneDay = 24 * 60 * 60 * 1000;
  for (let i = 0; i <= 3; i++) {
    const day = new Date(d.getTime() + i * oneDay);
    for (const [label, target] of [["start", s], ["end", e]]) {
      const dt = new Date(day.getTime());
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(dt);
      const read = (t) => parts.find((p) => p.type === t).value;
      dt.setMinutes(0, 0, 0, 0);
      dt.setHours(0, 0, 0, 0);
      const targetDate = new Date(Date.UTC(Number(read("year")), Number(read("month")) - 1, Number(read("day")), 0, 0, 0, 0));
      const boundary = new Date(targetDate.getTime() + target * 60 * 1000);
      if (boundary.getTime() > d.getTime()) candidates.push({ label, boundary });
    }
  }
  candidates.sort((a, b) => a.boundary - b.boundary);
  return candidates[0] ? { label: candidates[0].label, at: candidates[0].boundary.toISOString() } : null;
}