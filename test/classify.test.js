import { describe, expect, it } from "vitest";
import { classifyDomain, DISTRACTION_DOMAINS, PRODUCTIVE_DOMAINS } from "../classify.js";

describe("classify.js classifyDomain()", () => {
  it("buckets well-known distraction and productive domains, everything else neutral", () => {
    expect(classifyDomain("youtube.com")).toBe("distraction");
    expect(classifyDomain("reddit.com")).toBe("distraction");
    expect(classifyDomain("github.com")).toBe("productive");
    expect(classifyDomain("stackoverflow.com")).toBe("productive");
    expect(classifyDomain("example.com")).toBe("neutral");
    expect(classifyDomain("localhost")).toBe("neutral");
  });

  it("strips a leading www. and ignores case", () => {
    expect(classifyDomain("www.youtube.com")).toBe("distraction");
    expect(classifyDomain("WWW.GitHub.com")).toBe("productive");
    expect(classifyDomain("YouTube.COM")).toBe("distraction");
  });

  it("matches subdomains of a listed domain but not look-alike suffixes", () => {
    expect(classifyDomain("m.youtube.com")).toBe("distraction");
    expect(classifyDomain("gist.github.com")).toBe("productive");
    expect(classifyDomain("docs.google.com")).toBe("productive");
    expect(classifyDomain("notyoutube.com")).toBe("neutral");
    expect(classifyDomain("youtube.com.evil.example")).toBe("neutral");
  });

  it("an explicit distraction listing wins over a productive one for the same host", () => {
    // Guard the premise: the two curated lists must not overlap, otherwise a
    // domain's bucket would depend on list order.
    const overlap = DISTRACTION_DOMAINS.filter((d) => PRODUCTIVE_DOMAINS.includes(d));
    expect(overlap).toEqual([]);
    for (const d of DISTRACTION_DOMAINS) expect(classifyDomain(d)).toBe("distraction");
    for (const d of PRODUCTIVE_DOMAINS) expect(classifyDomain(d)).toBe("productive");
  });

  it("tolerates empty and missing input", () => {
    expect(classifyDomain("")).toBe("neutral");
    expect(classifyDomain(undefined)).toBe("neutral");
    expect(classifyDomain(null)).toBe("neutral");
  });
});
