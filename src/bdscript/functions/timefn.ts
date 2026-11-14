/** Date and time. BDFD formats use Go's reference layout ("2006-01-02 15:04:05"). */
import { BDScriptError, fn, req, none } from "../registry";
import { humanDuration, seconds, stripMention, toInt, toNum } from "../util";
import type { Context } from "../context";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Calendar parts of `d` in time zone `tz` (default UTC). */
function parts(d: Date, tz?: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz ?? "UTC", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23", weekday: "short", timeZoneName: "short" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offMin = Math.round((asUTC - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  return { Y: +p.year, M: +p.month, D: +p.day, h: +p.hour, m: +p.minute, s: +p.second, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), zone: p.timeZoneName ?? "UTC", off: offMin };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function goFormat(d: Date, layout: string, tz?: string): string {
  const t = parts(d, tz);
  const off = (sep: string) => {
    const sign = t.off < 0 ? "-" : "+";
    const a = Math.abs(t.off);
    return `${sign}${pad(Math.floor(a / 60))}${sep}${pad(a % 60)}`;
  };
  const h12 = t.h % 12 || 12;
  const TOK: [string, () => string][] = [
    ["2006", () => String(t.Y)], ["January", () => MONTHS[t.M - 1]], ["Monday", () => DAYS[t.wd]], ["Jan", () => MONTHS[t.M - 1].slice(0, 3)],
    ["Mon", () => DAYS[t.wd].slice(0, 3)], ["MST", () => t.zone], ["-07:00", () => off(":")], ["-0700", () => off("")],
    ["15", () => pad(t.h)], ["06", () => pad(t.Y % 100)], ["01", () => pad(t.M)], ["02", () => pad(t.D)], ["03", () => pad(h12)],
    ["04", () => pad(t.m)], ["05", () => pad(t.s)], ["PM", () => (t.h >= 12 ? "PM" : "AM")], ["_2", () => String(t.D).padStart(2, " ")],
    ["1", () => String(t.M)], ["2", () => String(t.D)], ["3", () => String(h12)], ["4", () => String(t.m)], ["5", () => String(t.s)],
  ];
  let out = "";
  for (let i = 0; i < layout.length;) {
    const hit = TOK.find(([tok]) => layout.startsWith(tok, i));
    if (hit) {
      out += hit[1]();
      i += hit[0].length;
    } else out += layout[i++];
  }
  return out;
}

const tzOf = (ctx: Context): string | undefined => ctx.extras.timezone;
const now = (ctx: Context) => parts(new Date(), tzOf(ctx));

fn("time", (ctx, tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() });
  } catch {
    throw new BDScriptError(`invalid timezone '${tz}'`);
  }
  ctx.extras.timezone = tz.trim();
  return "";
}, req(1));
fn("date", (ctx) => {
  const t = now(ctx);
  return `${pad(t.M)}/${pad(t.D)}/${t.Y}`;
}, none);
fn("day", (ctx) => String(now(ctx).D), none);
fn("month", (ctx) => String(now(ctx).M), none);
fn("year", (ctx) => String(now(ctx).Y), none);
fn("hour", (ctx) => pad(now(ctx).h), none);
fn("minute", (ctx) => pad(now(ctx).m), none);
fn("second", (ctx) => pad(now(ctx).s), none);

fn(["getTimestamp", "getTimestampComplex"], (_c, unit = "s") => {
  const ns = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
  const u = unit.trim().toLowerCase() || "s";
  if (["s", "sec", "seconds"].includes(u)) return String(ns / 1_000_000_000n);
  if (["ms", "milliseconds"].includes(u)) return String(ns / 1_000_000n);
  if (["us", "µs", "microseconds"].includes(u)) return String(ns / 1_000n);
  if (["ns", "nanoseconds"].includes(u)) return String(ns);
  throw new BDScriptError(`invalid time unit '${unit}' (s, ms, us, ns)`);
});

/** Creation time for an id: Discord snowflakes encode it; for Vector we use cached users/messages. */
fn("creationDate", (ctx, oid, layout = "") => {
  const v = stripMention(oid);
  let d: Date | null = ctx.client.users.resolve(v)?.createdAt ?? ctx.client._state.messages.get(v)?.createdAt ?? null;
  if (!d && /^\d{15,20}$/.test(v)) d = new Date(Number((BigInt(v) >> 22n) + 1420070400000n));
  if (!d) throw new BDScriptError(`can't read a creation time from ID '${oid}'`);
  return layout ? goFormat(d, layout, tzOf(ctx)) : d.toUTCString();
}, req(1));
fn("dateStamp", () => String(Date.now()));
fn("parseTime", (_c, ms) => humanDuration(toInt(ms) / 1000), req(1));
fn("parseDuration", (_c, text) => String(Math.floor(seconds(text))), req(1));
fn("formatTime", (ctx, stamp, layout = "2006-01-02 15:04:05") => goFormat(new Date(Math.trunc(toNum(stamp)) * 1000), layout, tzOf(ctx)), req(1));
