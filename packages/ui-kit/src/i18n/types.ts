/** Plural forms keyed by Intl.PluralRules categories; `other` is required, add the others a language uses. */
export type Plural = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type Leaf = string | Plural;

/** A translation: the same keys as the source catalogue (vi), each leaf a string or plural forms. */
export type Translation<T> = { [K in keyof T]: T[K] extends Leaf ? Leaf : Translation<T[K]> };

/** "nav.docs", "login.submit"…: every leaf of a catalogue as a dotted path. */
export type KeyPaths<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends Leaf ? `${P}${K}` : KeyPaths<T[K], `${P}${K}.`>;
}[keyof T & string];

export type Vars = Record<string, string | number>;
