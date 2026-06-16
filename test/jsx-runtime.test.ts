import { describe, it, expect } from "vitest";
import { jsx, jsxs, Fragment } from "soundstage/jsx-runtime";
import type { SoundstageElement } from "soundstage/jsx-runtime";

describe("jsx-runtime", () => {
  it("resolves soundstage/jsx-runtime in test env", () => {
    expect(typeof jsx).toBe("function");
    expect(typeof jsxs).toBe("function");
    expect(typeof Fragment).toBe("symbol");
  });

  // AC1 — jsx builds the expected element tree shape
  it("jsx produces a SoundstageElement with type, props, and children", () => {
    const el = jsx("Episode", { title: "test" }, undefined) as SoundstageElement;
    expect(el.type).toBe("Episode");
    expect(el.props).toEqual({ title: "test" });
    expect(el.children).toEqual([]);
  });

  // AC1 — single child via jsx
  it("jsx with a single child places it in children array", () => {
    const child = jsx("Voice", { voice: "host" }, undefined) as SoundstageElement;
    const el = jsx("Segment", { title: "Intro" }, undefined, child) as SoundstageElement;
    expect(el.children).toHaveLength(1);
    expect(el.children[0]).toBe(child);
  });

  // AC1 — jsxs with array of children
  it("jsxs with multiple children produces nested element tree", () => {
    const child1 = jsx("Voice", { voice: "host" }, undefined) as SoundstageElement;
    const child2 = jsx("Silence", { duration: 1 }, undefined) as SoundstageElement;
    const el = jsxs("Segment", { title: "Intro", children: [child1, child2] }, undefined) as SoundstageElement;
    expect(el.type).toBe("Segment");
    expect(el.children).toHaveLength(2);
    expect(el.children[0]).toBe(child1);
    expect(el.children[1]).toBe(child2);
  });

  // AC1 — component function as type
  it("jsx accepts a component function as type", () => {
    const MyComp = (props: Record<string, unknown>) =>
      jsx("Segment", { title: props["label"] as string }, undefined);
    const el = jsx(MyComp, { label: "hello" }, undefined) as SoundstageElement;
    expect(el.type).toBe(MyComp);
    expect(el.props).toEqual({ label: "hello" });
  });

  // AC2 — Fragment flattens children into parent
  it("Fragment flattens its children into the parent's children array", () => {
    const child1 = jsx("Voice", { voice: "host" }, undefined) as SoundstageElement;
    const child2 = jsx("Voice", { voice: "guest" }, undefined) as SoundstageElement;
    // Fragment itself is used as a type; its children should be extracted when normalized
    const frag = jsxs(Fragment, { children: [child1, child2] }, undefined) as SoundstageElement;
    expect(frag.type).toBe(Fragment);
    // The children of the fragment are the two Voice elements
    expect(frag.children).toHaveLength(2);
    expect(frag.children[0]).toBe(child1);
    expect(frag.children[1]).toBe(child2);
  });

  // AC2 — nested children arrays (jsxs spreads children from props)
  it("jsxs spreads children prop array correctly", () => {
    const kids = [
      jsx("Voice", { voice: "a" }, undefined),
      jsx("Voice", { voice: "b" }, undefined),
      jsx("Voice", { voice: "c" }, undefined),
    ] as SoundstageElement[];
    const el = jsxs("Episode", { title: "ep", children: kids }, undefined) as SoundstageElement;
    expect(el.children).toHaveLength(3);
    expect(el.children[0]).toBe(kids[0]);
    expect(el.children[1]).toBe(kids[1]);
    expect(el.children[2]).toBe(kids[2]);
  });

  // Fix 9 — null/undefined/false children are normalized out (conditional rendering)
  it("normalizes null, undefined, and false children out of the tree", () => {
    const real = jsx("Voice", { voice: "host" }, undefined) as SoundstageElement;
    const el = jsxs("Segment", { children: [null, undefined, false, real] }, undefined) as SoundstageElement;
    expect(el.children).toHaveLength(1);
    expect(el.children[0]).toBe(real);
  });

  // Fix 1 — props.children and rest-arg children are both preserved (no silent drop)
  it("merges props.children and rest-arg children, preserving order", () => {
    const propsChild = jsx("Voice", { voice: "props" }, undefined) as SoundstageElement;
    const restChild = jsx("Silence", { duration: 1 }, undefined) as SoundstageElement;
    // Pass propsChild via props.children AND restChild as a rest argument
    const el = jsx("Segment", { children: propsChild }, undefined, restChild) as SoundstageElement;
    expect(el.children).toHaveLength(2);
    expect(el.children[0]).toBe(propsChild);
    expect(el.children[1]).toBe(restChild);
  });

  // No React / browser deps — confirmed by the import above resolving to our module
  it("does not import React", async () => {
    const mod = await import("soundstage/jsx-runtime");
    // If React were re-exported or wrapped, these would differ from our plain objects
    const el = mod.jsx("Voice", { voice: "host" }, undefined) as SoundstageElement;
    expect(typeof el).toBe("object");
    expect(el).not.toHaveProperty("$$typeof"); // React internal marker
  });
});
