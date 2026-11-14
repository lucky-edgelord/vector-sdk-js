/** Condition checks shared by $if, $elseif, $onlyIf, $checkCondition, $and, $or. */
import { unescape } from "./parser";
import { BDScriptError } from "./registry";

const OPERATORS = ["==", "!=", ">=", "<=", ">", "<"];

function num(x: string): number | null {
  if (!x.trim()) return null;
  const v = Number(x.replace(/,/g, ""));
  return Number.isNaN(v) ? null : v;
}

/** `a==b`, `a!=b`, `a>b` …; also accepts plain true/false. */
export function check(cond: string): boolean {
  const raw = cond;
  cond = unescape(cond, false);
  let best: [number, string] | null = null;
  for (const op of OPERATORS) {
    const i = cond.indexOf(op);
    if (i !== -1 && (best === null || i < best[0] || (i === best[0] && op.length > best[1].length))) best = [i, op];
  }
  if (best === null) {
    const low = cond.trim().toLowerCase();
    if (["true", "yes", "1"].includes(low)) return true;
    if (["false", "no", "0", ""].includes(low)) return false;
    throw new BDScriptError(`invalid condition '${raw.trim()}': no operator (==, !=, <, >, <=, >=)`);
  }
  const [i, op] = best;
  const a = cond.slice(0, i).trim();
  const b = cond.slice(i + op.length).trim();
  const na = num(a), nb = num(b);
  if (op === "==") return na !== null && nb !== null ? na === nb : a === b;
  if (op === "!=") return na !== null && nb !== null ? na !== nb : a !== b;
  if (na === null || nb === null) throw new BDScriptError(`can't compare '${a}' ${op} '${b}': ${op} needs numbers`);
  return op === ">" ? na > nb : op === "<" ? na < nb : op === ">=" ? na >= nb : na <= nb;
}
