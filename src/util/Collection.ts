/** discord.js's `Collection`: a Map with array-like helpers. */
export class Collection<K, V> extends Map<K, V> {
  first(): V | undefined;
  first(amount: number): V[];
  first(amount?: number): V | V[] | undefined {
    if (amount === undefined) return this.values().next().value;
    return [...this.values()].slice(0, Math.max(0, amount));
  }
  last(): V | undefined;
  last(amount: number): V[];
  last(amount?: number): V | V[] | undefined {
    const arr = [...this.values()];
    if (amount === undefined) return arr[arr.length - 1];
    return amount <= 0 ? [] : arr.slice(-amount);
  }
  firstKey(): K | undefined {
    return this.keys().next().value;
  }
  lastKey(): K | undefined {
    return [...this.keys()].pop();
  }
  at(index: number): V | undefined {
    return [...this.values()].at(index);
  }
  random(): V | undefined {
    const arr = [...this.values()];
    return arr[Math.floor(Math.random() * arr.length)];
  }
  find(fn: (value: V, key: K, collection: this) => unknown): V | undefined {
    for (const [k, v] of this) if (fn(v, k, this)) return v;
    return undefined;
  }
  findKey(fn: (value: V, key: K, collection: this) => unknown): K | undefined {
    for (const [k, v] of this) if (fn(v, k, this)) return k;
    return undefined;
  }
  filter(fn: (value: V, key: K, collection: this) => unknown): Collection<K, V> {
    const out = new Collection<K, V>();
    for (const [k, v] of this) if (fn(v, k, this)) out.set(k, v);
    return out;
  }
  partition(fn: (value: V, key: K, collection: this) => unknown): [Collection<K, V>, Collection<K, V>] {
    const yes = new Collection<K, V>();
    const no = new Collection<K, V>();
    for (const [k, v] of this) (fn(v, k, this) ? yes : no).set(k, v);
    return [yes, no];
  }
  map<T>(fn: (value: V, key: K, collection: this) => T): T[] {
    const out: T[] = [];
    for (const [k, v] of this) out.push(fn(v, k, this));
    return out;
  }
  mapValues<T>(fn: (value: V, key: K, collection: this) => T): Collection<K, T> {
    const out = new Collection<K, T>();
    for (const [k, v] of this) out.set(k, fn(v, k, this));
    return out;
  }
  some(fn: (value: V, key: K, collection: this) => unknown): boolean {
    for (const [k, v] of this) if (fn(v, k, this)) return true;
    return false;
  }
  every(fn: (value: V, key: K, collection: this) => unknown): boolean {
    for (const [k, v] of this) if (!fn(v, k, this)) return false;
    return true;
  }
  reduce<T>(fn: (acc: T, value: V, key: K, collection: this) => T, initial: T): T {
    let acc = initial;
    for (const [k, v] of this) acc = fn(acc, v, k, this);
    return acc;
  }
  each(fn: (value: V, key: K, collection: this) => void): this {
    for (const [k, v] of this) fn(v, k, this);
    return this;
  }
  sweep(fn: (value: V, key: K, collection: this) => unknown): number {
    let n = 0;
    for (const [k, v] of this) if (fn(v, k, this)) (this.delete(k), n++);
    return n;
  }
  clone(): Collection<K, V> {
    return new Collection(this);
  }
  concat(...others: Collection<K, V>[]): Collection<K, V> {
    const out = this.clone();
    for (const c of others) for (const [k, v] of c) out.set(k, v);
    return out;
  }
  sort(compare: (a: V, b: V, ak: K, bk: K) => number = (a, b) => (a < b ? -1 : a > b ? 1 : 0)): this {
    const entries = [...this.entries()].sort(([ak, a], [bk, b]) => compare(a, b, ak, bk));
    this.clear();
    for (const [k, v] of entries) this.set(k, v);
    return this;
  }
  sorted(compare?: (a: V, b: V, ak: K, bk: K) => number): Collection<K, V> {
    return this.clone().sort(compare);
  }
  hasAll(...keys: K[]): boolean {
    return keys.every((k) => this.has(k));
  }
  hasAny(...keys: K[]): boolean {
    return keys.some((k) => this.has(k));
  }
  ensure(key: K, make: (key: K, collection: this) => V): V {
    if (!this.has(key)) this.set(key, make(key, this));
    return this.get(key)!;
  }
  toJSON(): V[] {
    return [...this.values()];
  }
}
