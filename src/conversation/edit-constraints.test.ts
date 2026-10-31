import { expect, it } from "vitest";
import { assertSingleParagraphEdit, ParagraphEditLimitError } from "./edit-constraints.js";
import { parseRewrite } from "./rewrite.js";

it("allows one modified paragraph while preserving its unchanged neighbours", () => {
  expect(() => {
    assertSingleParagraphEdit([
      {
        before: "Premier.\n\nAncien.\n\nDernier.",
        after: "Premier.\n\nNouveau et développé.\n\nDernier.",
      },
    ]);
  }).not.toThrow();
});

it("rejects two modified paragraphs, including disjoint changes and single-line paragraphs", () => {
  for (const [before, after] of [
    ["A.\n\nB.", "X.\n\nY."],
    ["A.\n\nStable.\n\nB.", "X.\n\nStable.\n\nY."],
    ["A.\n \nB.", "X.\n \nY."],
  ])
    expect(() => {
      assertSingleParagraphEdit([{ before: before ?? "", after: after ?? "" }]);
    }).toThrow(ParagraphEditLimitError);
});

it("allows one inserted paragraph but rejects a multi-paragraph insertion or replacement", () => {
  expect(() => {
    assertSingleParagraphEdit([{ before: "A.\n\nB.", after: "A.\n\nNouveau.\n\nB." }]);
  }).not.toThrow();
  expect(() => {
    assertSingleParagraphEdit([{ before: "A.", after: "A.\n\nX.\n\nY." }]);
  }).toThrow(ParagraphEditLimitError);
  expect(() => {
    assertSingleParagraphEdit([{ before: "A.\n\nB.", after: "Fusion nouvelle." }]);
  }).toThrow(ParagraphEditLimitError);
});

it("exempts pure deletions across many paragraphs, including deleting all text", () => {
  for (const after of ["", "A.\n\nD.", "A.B.C.D.", ".\n\n.\n\n.\n\n."])
    expect(() => {
      assertSingleParagraphEdit([{ before: "A.\n\nB.\n\nC.\n\nD.", after }]);
    }).not.toThrow();
});

it("counts changes across all messages in a call and ignores unchanged/deleted text", () => {
  expect(() => {
    assertSingleParagraphEdit([
      { before: "A.", after: "X." },
      { before: "B.", after: "Y." },
    ]);
  }).toThrow(ParagraphEditLimitError);
  expect(() => {
    assertSingleParagraphEdit([
      { before: "A.\n\nB.\n\nC.", after: "A." },
      { before: "D.", after: "X." },
    ]);
  }).not.toThrow();
});

it("handles CRLF, blank lines and a paragraph containing soft line breaks", () => {
  expect(() => {
    assertSingleParagraphEdit([{ before: "A\r\nligne\r\n\r\nB", after: "X\nligne changée\n\nB" }]);
  }).not.toThrow();
  expect(() => {
    assertSingleParagraphEdit([{ before: "A\r\n\r\nB", after: "X\r\n\r\nY" }]);
  }).toThrow(ParagraphEditLimitError);
});

it("rejects a bulk rewrite before exposing candidate messages or repository updates", () => {
  const original = [
    { role: "user" as const, content: "Question" },
    { role: "assistant" as const, content: "A.\n\nB." },
  ];
  const result = (content: string) =>
    JSON.stringify({
      messages: [original[0], { role: "assistant", content }],
      improvements: [],
      repository: [],
    });
  expect(() => parseRewrite(result("X.\n\nY."), original)).toThrow(ParagraphEditLimitError);
  expect(parseRewrite(result("X.\n\nB."), original).messages[1]?.content).toBe("X.\n\nB.");
  expect(parseRewrite(result("A."), original).messages[1]?.content).toBe("A.");
});

it("enforces conversation and md/txt edits while leaving other file formats unrestricted", () => {
  const bulk = { before: "A.\n\nB.", after: "X.\n\nY." };
  for (const filePath of ["notes.md", "NOTES.MD", "C:/travail/notes.txt", "notes.TxT"])
    expect(() => {
      assertSingleParagraphEdit([{ ...bulk, filePath }]);
    }).toThrow(ParagraphEditLimitError);
  for (const filePath of [
    "module.ts",
    "main.rs",
    "data.json",
    "page.html",
    "notes.md.bak",
    "README",
  ])
    expect(() => {
      assertSingleParagraphEdit([{ ...bulk, filePath }]);
    }).not.toThrow();
  expect(() => {
    assertSingleParagraphEdit([bulk]);
  }).toThrow(ParagraphEditLimitError);
  expect(() => {
    assertSingleParagraphEdit([
      { ...bulk, filePath: "data.json" },
      { before: "A.", after: "X.", filePath: "notes.md" },
    ]);
  }).not.toThrow();
});
