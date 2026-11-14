/**
 * BDScript parser: BDScript 2 (Bot Designer for Discord) and the D.js-BDscript / aoi.js dialect.
 *
 * - `$name` and `$name[arg;arg;…]`, nested calls, case-insensitive names, longest-name matching (`$authorID` is
 *   not `$author` + `ID`); an unknown `$word` stays as text
 * - escapes (backslash before `$ ; [ ]` or a backslash) and the special escapes `%{DOL}%`, `%{-SEMICOL-}%`,
 *   `%{-LEFT-}%`, `%{-RIGHT-}%` (resolved when output is produced, so they survive nested evaluation)
 * - blocks: `$if[..] $elseif[..] $else $endif`, `$try $catch $endtry`, `$async[name] $endasync`, loops;
 *   a `$if` with two or three arguments is the inline form `$if[cond;then;else]`
 * - `$c[...]` comments are dropped
 */

/** Placeholders for escaped characters, so nested evaluation never mistakes them for syntax. */
export const ESC: Record<string, string> = { $: "\x00D", ";": "\x00S", "[": "\x00L", "]": "\x00R", "\\": "\x00B" };
const SPECIAL: [string, string][] = [["%{DOL}%", "$"], ["%{-SEMICOL-}%", ";"], ["%semi%", ";"], ["%{-LEFT-}%", "["], ["%{-RIGHT-}%", "]"], ["%{-BSLASH-}%", "\\"]];

export function unescape(text: string, special = true): string {
  for (const [ch, ph] of Object.entries(ESC)) text = text.split(ph).join(ch);
  if (special) for (const [k, v] of SPECIAL) text = text.split(k).join(v);
  return text;
}

/** Protect characters in function output so later evaluation treats them as text. */
export function escape(text: string): string {
  let out = "";
  for (const ch of text) out += "$;[]".includes(ch) ? ESC[ch] : ch;
  return out;
}

export class ParseError extends Error {
  constructor(message: string, public readonly line = 0, public readonly col = 0) {
    super(message);
  }
}

export interface Text { t: "text"; value: string }
export interface Call { t: "call"; name: string; raw: string; args: Node[][] | null; line: number; col: number; source: string; text: string }
export interface If { t: "if"; branches: [Call, Node[]][]; elseBody: Node[] | null }
export interface Try { t: "try"; body: Node[]; catch: Node[] }
export interface Loop { t: "loop"; kind: "for" | "while" | "loop" | "jsonforeach"; call: Call; body: Node[] }
export interface Async { t: "async"; call: Call; body: Node[] }
export type Node = Text | Call | If | Try | Loop | Async;

const LOOPS: Record<string, string> = { for: "endfor", while: "endwhile", loop: "endloop", jsonforeach: "endjsonforeach" };

export type Brackets = "none" | "optional" | "required";

export class Parser {
  private byFirst = new Map<string, string[]>();
  private src = "";
  private lines: string[] = [];
  private i = 0;

  /** `names`: lowercase name -> [canonical, brackets]. */
  constructor(private readonly names: Map<string, [string, Brackets]>) {
    for (const n of [...names.keys()].sort((a, b) => b.length - a.length)) {
      const k = n.slice(0, 1);
      if (!this.byFirst.has(k)) this.byFirst.set(k, []);
      this.byFirst.get(k)!.push(n);
    }
  }

  parse(code: string): Node[] {
    this.src = code.replace(/\r\n/g, "\n");
    this.lines = this.src.split("\n");
    this.i = 0;
    return this.structure(this.sequence(true));
  }

  private pos(i: number): [number, number] {
    const before = this.src.slice(0, i);
    const line = before.split("\n").length;
    return [line, i - (before.lastIndexOf("\n") + 1) + 1];
  }

  private matchName(i: number): string | null {
    const rest = this.src.slice(i, i + 64).toLowerCase();
    for (const n of this.byFirst.get(rest.slice(0, 1)) ?? []) if (rest.startsWith(n)) return n;
    return null;
  }

  private sequence(top: boolean): Node[] {
    const out: Node[] = [];
    let buf = "";
    const s = this.src;
    const flush = () => {
      if (buf) out.push({ t: "text", value: buf });
      buf = "";
    };
    while (this.i < s.length) {
      const ch = s[this.i];
      if (ch === "\\" && this.i + 1 < s.length && "$;[]\\".includes(s[this.i + 1])) {
        buf += ESC[s[this.i + 1]];
        this.i += 2;
        continue;
      }
      if (!top && (ch === ";" || ch === "]")) break;
      if (ch === "$") {
        const name = this.matchName(this.i + 1);
        if (name !== null) {
          flush();
          out.push(this.call(name));
          continue;
        }
      }
      buf += ch;
      this.i++;
    }
    flush();
    return out;
  }

  private call(name: string): Call {
    const start = this.i;
    const [canonical, brackets] = this.names.get(name)!;
    const raw = this.src.slice(start + 1, start + 1 + name.length);
    this.i = start + 1 + name.length;
    const [line, col] = this.pos(start);
    let args: Node[][] | null = null;
    if (brackets !== "none" && this.src[this.i] === "[") {
      this.i++;
      args = [];
      for (;;) {
        args.push(this.sequence(false));
        if (this.i >= this.src.length) throw new ParseError(`$${raw}[ is missing its closing ]`, line, col);
        const ch = this.src[this.i++];
        if (ch === "]") break;
      }
    }
    return { t: "call", name: canonical, raw, args, line, col, source: (this.lines[line - 1] ?? "").trim(), text: this.src.slice(start, this.i) };
  }

  private structure(nodes: Node[]): Node[] {
    const flat: Node[] = [];
    for (const n of nodes) {
      if (n.t === "call") {
        if (n.name === "c") continue;
        if (n.args) n.args = n.args.map((a) => this.structure(a));
      }
      flat.push(n);
    }
    return this.blocks(flat, 0, [])[0];
  }

  private blocks(nodes: Node[], i: number, until: string[]): [Node[], number] {
    const out: Node[] = [];
    const isCall = (x: Node | undefined, ...names: string[]): boolean => !!x && x.t === "call" && (names.length === 0 || names.includes(x.name));
    while (i < nodes.length) {
      const n = nodes[i] as Call;
      if (isCall(n) && until.includes(n.name)) return [out, i];
      if (isCall(n, "if") && (n.args === null || n.args.length <= 1)) {
        const [block, next] = this.ifBlock(nodes, i);
        out.push(block);
        i = next;
        continue;
      }
      if (isCall(n, "try")) {
        let body: Node[];
        [body, i] = this.blocks(nodes, i + 1, ["catch", "endtry"]);
        let catchBody: Node[] = [];
        if (isCall(nodes[i], "catch")) [catchBody, i] = this.blocks(nodes, i + 1, ["endtry"]);
        out.push({ t: "try", body, catch: catchBody });
        i++;
        continue;
      }
      if (isCall(n) && n.name in LOOPS && (n.name !== "loop" || (n.args !== null && n.args.length === 1))) {
        let body: Node[];
        [body, i] = this.blocks(nodes, i + 1, [LOOPS[n.name]]);
        out.push({ t: "loop", kind: n.name as Loop["kind"], call: n, body });
        i++;
        continue;
      }
      if (isCall(n, "async")) {
        let body: Node[];
        [body, i] = this.blocks(nodes, i + 1, ["endasync"]);
        out.push({ t: "async", call: n, body });
        i++;
        continue;
      }
      out.push(n);
      i++;
    }
    return [out, i];
  }

  private ifBlock(nodes: Node[], i: number): [If, number] {
    const block: If = { t: "if", branches: [], elseBody: null };
    let cond = nodes[i] as Call;
    i++;
    for (;;) {
      let body: Node[];
      [body, i] = this.blocks(nodes, i, ["elseif", "else", "endif"]);
      block.branches.push([cond, body]);
      if (i >= nodes.length) return [block, i];
      const tag = nodes[i++] as Call;
      if (tag.name === "elseif") {
        cond = tag;
        continue;
      }
      if (tag.name === "else") {
        [block.elseBody, i] = this.blocks(nodes, i, ["endif"]);
        return [block, i + 1];
      }
      return [block, i];
    }
  }
}
