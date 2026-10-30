import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

// Execute the actual page script with browser/file handles replaced by test doubles.
const script = readFileSync(new URL("../../AUTORISATIONS.html", import.meta.url), "utf8")
  .match(/<script>([\s\S]*?)<\/script>/)[1];
function editor() {
  class Element {
    children = [];
    value = "";
    textContent = "";
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    setAttribute() {}
  }
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  let disk = JSON.stringify({ version: 1, title: "Test", context: "", example: "Example", guidance: "Scope",
    entries: [{ id: "A1", action: "<script>untrusted</script>", decision: "authorized", scope: "Shared only", category: "build" }] });
  let writes = 0;
  const handle = {
    getFile: async () => ({ name: "AUTORISATIONS.json", text: async () => disk }),
    createWritable: async () => ({ write: async (text) => { disk = text; writes++; }, close: async () => {} }),
  };
  const context = vm.createContext({
    document: { getElementById: get, createElement: () => new Element() },
    window: { showOpenFilePicker: true, addEventListener() {} },
    showOpenFilePicker: async () => [handle], confirm: () => true,
  });
  vm.runInContext(script, context);
  return { get, disk: () => disk, externalEdit: () => { disk += " "; }, writes: () => writes };
}

test("the page loads decisions, renders source as text and saves the selected file", async () => {
  const ui = editor();
  await ui.get("open").onclick();
  const card = ui.get("entries").children[0];
  assert.equal(card.children[0].children[1].textContent, "<script>untrusted</script>");
  const select = card.children[1];
  select.value = "forbidden"; select.onchange();
  const scope = card.children[2].children[0];
  scope.value = "No access"; scope.oninput();
  await ui.get("save").onclick();
  assert.equal(ui.writes(), 1);
  assert.equal(JSON.parse(ui.disk()).entries[0].decision, "forbidden");
  assert.equal(JSON.parse(ui.disk()).entries[0].scope, "No access");
  assert.equal(ui.get("save").disabled, true);
});

test("the page refuses to overwrite a concurrent change", async () => {
  const ui = editor(); await ui.get("open").onclick();
  ui.externalEdit(); await ui.get("save").onclick();
  assert.equal(ui.writes(), 0);
  assert.match(ui.get("status").textContent, /changé ailleurs/);
});

test("the page rejects an empty scope without writing", async () => {
  const ui = editor(); await ui.get("open").onclick();
  const scope = ui.get("entries").children[0].children[2].children[0];
  scope.value = ""; scope.oninput(); await ui.get("save").onclick();
  assert.equal(ui.writes(), 0);
  assert.match(ui.get("status").textContent, /invalide/);
});
