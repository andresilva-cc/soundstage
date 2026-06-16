export type ComponentType<P = Record<string, unknown>> = (props: P) => SoundstageElement | null;

export type ElementType = string | ComponentType<Record<string, unknown>> | typeof Fragment;

export interface SoundstageElement {
  type: ElementType;
  props: Record<string, unknown>;
  children: Array<SoundstageElement | string | number | boolean | null | undefined>;
}

// The Fragment symbol is used as a type for <>…</> shorthand.
export const Fragment: unique symbol = Symbol("soundstage.Fragment");

type FragmentType = typeof Fragment;

type AnyComponentType = ComponentType<Record<string, unknown>>;

type ValidType = string | AnyComponentType | FragmentType;

type Props = Record<string, unknown> & { children?: unknown };

function normalizeChildren(raw: unknown): SoundstageElement["children"] {
  if (raw === undefined || raw === null || raw === false) return [];
  if (Array.isArray(raw)) {
    return (raw as unknown[])
      .flat()
      .filter((c) => c !== null && c !== undefined && c !== false) as SoundstageElement["children"];
  }
  return [raw as SoundstageElement | string | number | boolean];
}

function createElement(
  type: ValidType,
  props: Props | null,
  key: string | undefined,
  ...rest: unknown[]
): SoundstageElement {
  void key; // key is part of the automatic runtime signature; unused in v0.1
  const { children: propsChildren, ...ownProps } = props ?? {};
  const explicitChildren = normalizeChildren(propsChildren);
  const extraChildren = normalizeChildren(rest.length === 1 ? rest[0] : rest.length > 1 ? rest : undefined);
  const children = [...explicitChildren, ...extraChildren];
  return {
    type,
    props: ownProps as Record<string, unknown>,
    children,
  };
}

// Automatic JSX runtime exports — shapes expected by TypeScript when
// `jsxImportSource: 'soundstage'` and `jsx: 'react-jsx'` are set.

/** Used for elements with a single child or no children. */
export function jsx(
  type: ValidType,
  props: Props | null,
  key?: string,
  ...rest: unknown[]
): SoundstageElement {
  return createElement(type, props, key, ...rest);
}

/** Used for elements with multiple children (spread into props.children). */
export function jsxs(
  type: ValidType,
  props: Props | null,
  key?: string,
): SoundstageElement {
  return createElement(type, props, key);
}

/** Dev-mode alias — identical to the production variant for our runtime. */
export { jsx as jsxDEV };
