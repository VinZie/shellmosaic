import { describe, expect, it } from "vitest";
import {
  basename,
  deepDiff,
  dirname,
  formatBytes,
  formatDuration,
  fuzzyScore,
  getPath,
  joinPath,
  luminance,
  parseColor,
  setPath,
  shellQuote,
  toHex6,
  uid,
  withAlpha,
} from "./util";

describe("shellQuote", () => {
  // names come from disk, repositories and SFTP servers: they must never run code when pasted
  it("single-quotes for bash and escapes embedded quotes", () => {
    expect(shellQuote("a b", "bash")).toBe("'a b'");
    expect(shellQuote("$(rm -rf ~)", "wsl")).toBe("'$(rm -rf ~)'");
    expect(shellQuote("it's", "bash")).toBe(`'it'\\''s'`);
  });

  it("leaves plain PowerShell paths alone and single-quotes the rest", () => {
    expect(shellQuote("C:\\Users\\me\\file.txt", "pwsh")).toBe("C:\\Users\\me\\file.txt");
    expect(shellQuote("C:\\My Files\\$(calc)", "pwsh")).toBe("'C:\\My Files\\$(calc)'");
    expect(shellQuote("a `whoami` b", "powershell")).toBe("'a `whoami` b'");
  });

  it("doubles every quote PowerShell treats as a single quote", () => {
    expect(shellQuote("it's", "pwsh")).toBe("'it''s'");
    expect(shellQuote("a\u2019b c", "pwsh")).toBe("'a\u2019\u2019b c'");
    expect(shellQuote("a\u2018\u201a\u201bb", "pwsh")).toBe("'a\u2018\u2018\u201a\u201a\u201b\u201bb'");
  });

  it("double-quotes for cmd only when needed", () => {
    expect(shellQuote("C:\\plain\\path")).toBe("C:\\plain\\path");
    expect(shellQuote("C:\\My Files")).toBe('"C:\\My Files"');
    expect(shellQuote("a&b", "cmd")).toBe('"a&b"');
  });
});

describe("paths", () => {
  it("basename handles both separators and trailing slashes", () => {
    expect(basename("C:\\a\\b.txt")).toBe("b.txt");
    expect(basename("/home/me/dir/")).toBe("dir");
    expect(basename("file")).toBe("file");
  });

  it("dirname keeps drive roots", () => {
    expect(dirname("C:\\a\\b")).toBe("C:\\a");
    expect(dirname("C:\\a")).toBe("C:\\");
    expect(dirname("/home/me")).toBe("/home");
    expect(dirname("/home")).toBe("/");
    expect(dirname("file")).toBe("file");
  });

  it("joinPath uses the separator the directory already uses", () => {
    expect(joinPath("C:\\a", "b")).toBe("C:\\a\\b");
    expect(joinPath("/home/me", "b")).toBe("/home/me/b");
    expect(joinPath("C:\\a\\", "b")).toBe("C:\\a\\b");
  });
});

describe("formatting", () => {
  it("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3, 0)).toBe("5 GB");
    expect(formatBytes(NaN)).toBe("–");
  });

  it("formatDuration", () => {
    expect(formatDuration(42)).toBe("0m 42s");
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe("3h 5m");
    expect(formatDuration(2 * 86400 + 4 * 3600)).toBe("2d 4h");
  });
});

describe("fuzzyScore", () => {
  it("ranks direct and early matches higher", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("xyz", "terminal")).toBe(-1);
    expect(fuzzyScore("term", "terminal")).toBeGreaterThan(fuzzyScore("term", "new terminal"));
    expect(fuzzyScore("term", "terminal")).toBeGreaterThan(fuzzyScore("tml", "terminal"));
    expect(fuzzyScore("tml", "terminal")).toBeGreaterThan(-1);
  });
});

describe("settings helpers", () => {
  it("deepDiff keeps only changed keys", () => {
    const base = { a: 1, b: { c: 2, d: [1, 2] } };
    expect(deepDiff(base, { a: 1, b: { c: 3, d: [1, 2] } })).toEqual({ b: { c: 3 } });
    expect(deepDiff(base, structuredClone(base))).toBeUndefined();
    expect(deepDiff(base, { ...base, b: { ...base.b, d: [1] } })).toEqual({ b: { d: [1] } });
  });

  it("getPath / setPath", () => {
    const obj = { a: { b: 1 } };
    expect(getPath(obj, "a.b")).toBe(1);
    expect(getPath(obj, "a.x.y")).toBeUndefined();
    const out = setPath(obj, "a.c.d", 2);
    expect(out).toEqual({ a: { b: 1, c: { d: 2 } } });
    expect(obj).toEqual({ a: { b: 1 } }); // input untouched
  });
});

describe("colors", () => {
  it("parseColor", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255, 1]);
    expect(parseColor("#11223380")).toEqual([17, 34, 51, 128 / 255]);
    expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3, 0.5]);
    expect(parseColor("rgb(1 2 3 / 0.25)")).toEqual([1, 2, 3, 0.25]);
    expect(parseColor("not a color")).toBeNull();
  });

  it("withAlpha, toHex6 and luminance", () => {
    expect(withAlpha("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.500)");
    expect(withAlpha("bogus", 0.5)).toBe("bogus");
    expect(toHex6("#abc")).toBe("#aabbcc");
    expect(toHex6("bogus")).toBe("#000000");
    expect(luminance("#ffffff")).toBeCloseTo(1);
    expect(luminance("#000000")).toBe(0);
  });
});

describe("uid", () => {
  it("is lowercase alphanumeric of the requested length", () => {
    expect(uid()).toMatch(/^[a-z0-9]{10}$/);
    expect(uid(4)).toHaveLength(4);
  });
});
