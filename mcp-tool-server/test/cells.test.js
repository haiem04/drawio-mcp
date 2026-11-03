import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pako from "pako";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  parseCells,
  listCellsInXml,
  editCellsInXml,
  mergeStyle,
  listCells,
  editCells,
  pageHash,
} from "../src/cells.js";
import { readPageXml } from "../src/pages.js";

const PAGE =
  '<mxGraphModel dx="800" dy="600" grid="1"><root>' +
  '<mxCell id="0"/>' +
  '<mxCell id="1" parent="0"/>' +
  '<mxCell id="a" value="Start" style="rounded=1;fillColor=#dae8fc;html=1;" vertex="1" parent="1">' +
  '<mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>' +
  '<object id="b" label="Server &amp; DB" owner="ops" placeholders="1">' +
  '<mxCell style="shape=cylinder3;" vertex="1" parent="1">' +
  '<mxGeometry x="240" y="40" width="80" height="80" as="geometry"/></mxCell></object>' +
  '<mxCell id="grp" value="Group" style="swimlane;" vertex="1" parent="1">' +
  '<mxGeometry x="40" y="200" width="300" height="200" as="geometry"><mxRectangle width="80" height="30" as="alternateBounds"/></mxGeometry></mxCell>' +
  '<mxCell id="child" value="Inside" style="" vertex="1" parent="grp">' +
  '<mxGeometry x="20" y="40" width="100" height="40" as="geometry"/></mxCell>' +
  '<mxCell id="e1" value="" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="a" target="b">' +
  '<mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="200" y="70"/></Array></mxGeometry></mxCell>' +
  '<mxCell id="e2" edge="1" parent="1" source="child" target="a">' +
  '<mxGeometry relative="1" as="geometry"/></mxCell>' +
  '<mxCell id="e2l" value="label" style="edgeLabel;" vertex="1" connectable="0" parent="e2">' +
  '<mxGeometry x="-0.5" relative="1" as="geometry"/></mxCell>' +
  "</root></mxGraphModel>";

function compress(xml)
{
  return Buffer.from(pako.deflateRaw(encodeURIComponent(xml))).toString("base64");
}

function makeFile(content)
{
  const dir = mkdtempSync(join(tmpdir(), "drawio-cells-"));
  const filePath = join(dir, "test.drawio");
  writeFileSync(filePath, content, "utf8");
  return { dir, filePath };
}

function ids(xml)
{
  return parseCells(xml).entries.map(function (e) { return e.id; });
}

test("parseCells types cells and reads wrapped cells", function ()
{
  const parsed = parseCells(PAGE);
  const types = Object.fromEntries(parsed.entries.map(function (e) { return [e.id, e.type]; }));

  assert.deepEqual(types, { 0: "root", 1: "layer", a: "vertex", b: "vertex", grp: "vertex", child: "vertex", e1: "edge", e2: "edge", e2l: "vertex" });
  assert.equal(parsed.byId.get("b").label, "Server & DB");
  assert.equal(parsed.byId.get("b").style, "shape=cylinder3;");
});

test("listCellsInXml returns compact cells and filters", function ()
{
  const all = listCellsInXml(PAGE);

  assert.equal(all.total, 9);
  assert.equal(all.hash, pageHash(PAGE));

  const a = all.cells.find(function (c) { return c.id === "a"; });
  assert.deepEqual(a, { id: "a", type: "vertex", label: "Start", parent: "1", style: "rounded=1;fillColor=#dae8fc;html=1;", x: 40, y: 40, width: 120, height: 60 });

  const b = all.cells.find(function (c) { return c.id === "b"; });
  assert.deepEqual(b.data, { owner: "ops", placeholders: "1" });

  const e1 = all.cells.find(function (c) { return c.id === "e1"; });
  assert.deepEqual(e1.points, [{ x: 200, y: 70 }]);
  assert.equal(e1.x, undefined);

  assert.deepEqual(listCellsInXml(PAGE, { filter: { type: "edge" } }).cells.map(function (c) { return c.id; }), ["e1", "e2"]);
  assert.deepEqual(listCellsInXml(PAGE, { filter: { parent: "grp" } }).cells.map(function (c) { return c.id; }), ["child"]);
  assert.deepEqual(listCellsInXml(PAGE, { filter: { label: "server" } }).cells.map(function (c) { return c.id; }), ["b"]);
  assert.deepEqual(listCellsInXml(PAGE, { filter: { style: "swimlane" } }).cells.map(function (c) { return c.id; }), ["grp"]);
  assert.deepEqual(listCellsInXml(PAGE, { filter: { connected_to: "a" } }).cells.map(function (c) { return c.id; }), ["e1", "e2"]);
  assert.deepEqual(listCellsInXml(PAGE, { offset: 2, limit: 2 }).cells.map(function (c) { return c.id; }), ["a", "b"]);

  const withXml = listCellsInXml(PAGE, { filter: { ids: ["child"] }, xml: true });
  assert.ok(withXml.cells[0].xml.startsWith('<mxCell id="child"'));
});

test("mergeStyle keeps order, replaces, removes and appends keys", function ()
{
  assert.equal(mergeStyle("rounded=1;fillColor=#fff;html=1;", { fillColor: "#f00", html: null, strokeWidth: 2 }), "rounded=1;fillColor=#f00;strokeWidth=2;");
  assert.equal(mergeStyle("ellipse;whiteSpace=wrap;", { dashed: "1" }), "ellipse;whiteSpace=wrap;dashed=1;");
  assert.equal(mergeStyle(null, { a: "1" }), "a=1;");
  assert.equal(mergeStyle("a=1;", { a: null }), "");
});

test("update changes only the targeted cell and leaves other bytes alone", function ()
{
  const out = editCellsInXml(PAGE, [{ op: "update", id: "a", label: "Begin <now>", style_set: { fillColor: "#f8cecc" }, x: 60 }]);
  const before = PAGE.indexOf('<mxCell id="a"');
  const afterEnd = PAGE.indexOf("</mxCell>", before) + "</mxCell>".length;

  assert.equal(out.xml.slice(0, before), PAGE.slice(0, before));
  assert.ok(out.xml.endsWith(PAGE.slice(afterEnd)));
  assert.match(out.xml, /<mxCell id="a" value="Begin &lt;now&gt;" style="rounded=1;fillColor=#f8cecc;html=1;" vertex="1" parent="1"><mxGeometry x="60" y="40" width="120" height="60" as="geometry"\/><\/mxCell>/);
  assert.deepEqual(out.results, [{ op: "update", id: "a", status: "updated" }]);
  assert.equal(out.cells[0].label, "Begin <now>");
});

test("update on a wrapped cell sets the wrapper label and data", function ()
{
  const out = editCellsInXml(PAGE, [{ op: "update", id: "b", label: "API", data: { owner: "dev", tier: "1", placeholders: null } }]);
  const b = parseCells(out.xml).byId.get("b");

  assert.equal(b.label, "API");
  assert.deepEqual(b.wrapper.attrs, { id: "b", label: "API", owner: "dev", tier: "1" });
  assert.equal(b.style, "shape=cylinder3;");
});

test("update keeps geometry children it does not name, and sets or clears points", function ()
{
  const resized = editCellsInXml(PAGE, [{ op: "update", id: "grp", width: 400 }]).xml;
  assert.match(resized, /<mxGeometry x="40" y="200" width="400" height="200" as="geometry"><mxRectangle width="80" height="30" as="alternateBounds"\/><\/mxGeometry>/);

  const routed = editCellsInXml(PAGE, [{ op: "update", id: "e1", points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] }]).xml;
  assert.deepEqual(listCellsInXml(routed, { filter: { ids: ["e1"] } }).cells[0].points, [{ x: 10, y: 20 }, { x: 30, y: 40 }]);

  const cleared = editCellsInXml(PAGE, [{ op: "update", id: "e1", points: [] }]).xml;
  assert.equal(listCellsInXml(cleared, { filter: { ids: ["e1"] } }).cells[0].points, undefined);
  assert.match(cleared, /<mxCell id="e1"[^>]*><mxGeometry relative="1" as="geometry"\/><\/mxCell>/);
});

test("update reconnects and detaches edge ends, and reports unchanged", function ()
{
  const out = editCellsInXml(PAGE, [{ op: "update", id: "e1", target: "child" }, { op: "update", id: "e2", source: "" }]);
  const parsed = parseCells(out.xml);

  assert.equal(parsed.byId.get("e1").target, "child");
  assert.equal(parsed.byId.get("e2").source, null);

  const encoded = PAGE.replace('value="Start"', 'value="Crow&#x27;s"');
  assert.equal(editCellsInXml(encoded, [{ op: "update", id: "a", label: "Crow's" }]).xml, encoded);

  const same = editCellsInXml(PAGE, [{ op: "update", id: "a", label: "Start" }]);
  assert.equal(same.results[0].status, "unchanged");
  assert.equal(same.xml, PAGE);
});

test("add from fields appends a vertex and an edge that uses it", function ()
{
  const out = editCellsInXml(PAGE, [
    { op: "add", id: "n1", label: "New", x: 400, y: 40 },
    { op: "add", source: "a", target: "n1", label: "go" },
    { op: "add", id: "n2", label: "In group", parent: "grp", x: 150, y: 40, width: 80, height: 30, style_set: { fillColor: "#fff2cc" } },
  ]);
  const parsed = parseCells(out.xml);
  const n1 = parsed.byId.get("n1");

  assert.equal(n1.type, "vertex");
  assert.equal(n1.parent, "1");
  assert.equal(n1.style, "rounded=0;whiteSpace=wrap;html=1;");
  assert.deepEqual(listCellsInXml(out.xml, { filter: { ids: ["n1"] } }).cells[0], { id: "n1", type: "vertex", label: "New", parent: "1", style: "rounded=0;whiteSpace=wrap;html=1;", x: 400, y: 40, width: 120, height: 60 });

  const edgeId = out.results[1].id;
  const edge = parsed.byId.get(edgeId);
  assert.match(edgeId, /^c-/);
  assert.equal(edge.type, "edge");
  assert.equal(edge.source, "a");
  assert.equal(edge.target, "n1");
  assert.equal(parsed.byId.get("n2").style, "rounded=0;whiteSpace=wrap;html=1;fillColor=#fff2cc;");
  assert.ok(out.xml.startsWith(PAGE.slice(0, PAGE.indexOf("</root>"))));
  assert.equal(out.cells.length, 3);
});

test("add from xml accepts one wrapped cell", function ()
{
  const xml = '<UserObject id="u1" label="Link" link="https://example.com"><mxCell style="text;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="60" height="20" as="geometry"/></mxCell></UserObject>';
  const out = editCellsInXml(PAGE, [{ op: "add", xml: xml }]);

  assert.ok(out.xml.includes(xml + "</root>"));
  assert.equal(parseCells(out.xml).byId.get("u1").label, "Link");
});

test("delete cascades to children, their edges and edge labels", function ()
{
  const out = editCellsInXml(PAGE, [{ op: "delete", id: "grp" }, { op: "delete", id: "e2" }]);

  assert.deepEqual(ids(out.xml), ["0", "1", "a", "b", "e1"]);
  assert.deepEqual(out.results[0], { op: "delete", id: "grp", status: "deleted", also_removed: ["child", "e2", "e2l"] });
  assert.deepEqual(out.results[1], { op: "delete", id: "e2", status: "already removed" });
  assert.ok(out.xml.includes('<object id="b" label="Server &amp; DB" owner="ops" placeholders="1">'));
});

test("deleting a wrapped vertex removes the wrapper and connected edges", function ()
{
  const out = editCellsInXml(PAGE, [{ op: "delete", id: "b" }]);

  assert.deepEqual(ids(out.xml), ["0", "1", "a", "grp", "child", "e2", "e2l"]);
  assert.ok(!out.xml.includes("<object"));
});

test("a failing operation rejects the whole batch", function ()
{
  const cases = [
    [{ op: "add", id: "a" }, /already exists/],
    [{ op: "add", parent: "nope" }, /parent "nope" does not exist/],
    [{ op: "add", source: "a", target: "1" }, /is a layer/],
    [{ op: "update", id: "grp", parent: "child" }, /inside itself/],
    [{ op: "update", id: "a", source: "b" }, /only be set on an edge/],
    [{ op: "update", id: "a", data: { k: "v" } }, /object/],
    [{ op: "update", id: "a", x: "left" }, /x must be a number/],
    [{ op: "delete", id: "1" }, /layer/],
    [{ op: "delete", id: "0" }, /root/],
    [{ op: "delete", id: "missing" }, /does not exist/],
    [{ op: "move", id: "a" }, /op must be/],
    [{ op: "add", xml: '<mxCell id="x1" vertex="1" parent="1"/><mxCell id="x2" vertex="1" parent="1"/>' }, /exactly one/],
    [{ op: "add", id: "y", xml: '<mxCell id="x1" vertex="1" parent="1"/>' }, /does not match/],
  ];

  for (const [op, pattern] of cases)
  {
    assert.throws(function () { editCellsInXml(PAGE, [{ op: "update", id: "a", label: "changed" }, op]); },
      function (e) { return pattern.test(e.message) && /Operation 1/.test(e.message) && /No changes were written/.test(e.message); },
      JSON.stringify(op));
  }

  assert.throws(function () { editCellsInXml(PAGE, []); }, /non-empty/);
});

test("markup the scanner does not understand is refused, not edited", function ()
{
  const broken = PAGE.replace('<mxCell id="a"', "<mxCell id='a'");
  assert.throws(function () { editCellsInXml(broken, [{ op: "delete", id: "b" }]); }, /Unsupported XML/);
  assert.throws(function () { parseCells("<mxGraphModel><root><mxCell id=\"0\"></root></mxGraphModel>"); }, /Mismatched/);
});

test("editCells writes one page of a file, keeps compression and other pages", function ()
{
  const other = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
  const fileText =
    '<mxfile host="test"><diagram id="p1" name="Main">' + compress(PAGE) + "</diagram>" +
    '<diagram id="p2" name="Other">' + other + "</diagram></mxfile>";
  const { dir, filePath } = makeFile(fileText);

  try
  {
    const listed = listCells(filePath, "Main", { filter: { type: "edge" } });
    assert.equal(listed.page.name, "Main");
    assert.equal(listed.total, 2);

    const dry = editCells(filePath, "Main", [{ op: "delete", id: "a" }], { dry_run: true, if_hash: listed.hash });
    assert.equal(dry.dry_run, true);
    assert.equal(readFileSync(filePath, "utf8"), fileText);

    const done = editCells(filePath, "Main", [{ op: "update", id: "a", label: "Go" }], { if_hash: listed.hash });
    const after = readFileSync(filePath, "utf8");

    assert.ok(after.includes('<diagram id="p2" name="Other">' + other + "</diagram>"));
    assert.ok(!after.includes('<diagram id="p1" name="Main"><mxGraphModel'), "page stays compressed");
    assert.equal(readPageXml(filePath, "Main").xml, PAGE.replace('value="Start"', 'value="Go"'));
    assert.equal(done.hash, pageHash(readPageXml(filePath, "Main").xml));

    assert.throws(function () { editCells(filePath, "Main", [{ op: "delete", id: "a" }], { if_hash: listed.hash }); }, /Page changed/);
  }
  finally
  {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list_cells and edit_cells work over stdio", async function ()
{
  const fileText = '<mxfile><diagram id="p1" name="Main">' + PAGE + "</diagram></mxfile>";
  const { dir, filePath } = makeFile(fileText);
  const client = new Client({ name: "cells-test", version: "0.0.0" });

  await client.connect(new StdioClientTransport(
  {
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
    stderr: "ignore",
  }));

  try
  {
    const listed = await client.callTool({ name: "list_cells", arguments: { path: filePath, page: "0", label: "start" } });
    const body = JSON.parse(listed.content[0].text);
    assert.deepEqual(body.cells.map(function (c) { return c.id; }), ["a"]);

    const edited = await client.callTool({
      name: "edit_cells",
      arguments: { path: filePath, page: "Main", if_hash: body.hash, operations: [{ op: "update", id: "a", style_set: { fillColor: "#000" } }] },
    });
    assert.equal(edited.isError, undefined);
    assert.ok(readFileSync(filePath, "utf8").includes('style="rounded=1;fillColor=#000;html=1;"'));

    const failed = await client.callTool({ name: "edit_cells", arguments: { path: filePath, page: "Main", operations: [{ op: "delete", id: "zzz" }] } });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /does not exist/);

    const badPath = await client.callTool({ name: "list_cells", arguments: { path: join(dir, "x.txt"), page: "0" } });
    assert.equal(badPath.isError, true);
  }
  finally
  {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an attribute name inside another value is not mistaken for the attribute", function ()
{
  const page = PAGE.replace('<mxCell id="e2" edge="1"', '<mxCell id="e2" value="Set source=" edge="1"');
  const out = editCellsInXml(page, [{ op: "update", id: "e2", source: "" }]).xml;
  const e2 = parseCells(out).byId.get("e2");

  assert.equal(e2.label, "Set source=");
  assert.equal(e2.edge, true);
  assert.equal(e2.source, null);
  assert.equal(e2.target, "a");

  const wrapped = PAGE.replace('owner="ops"', 'note="use owner=" owner="ops"');
  const b = parseCells(editCellsInXml(wrapped, [{ op: "update", id: "b", data: { owner: null } }]).xml).byId.get("b");
  assert.deepEqual(b.wrapper.attrs, { id: "b", label: "Server & DB", note: "use owner=", placeholders: "1" });
});

test("add with xml refuses markup draw.io could not open", function ()
{
  const bad = [
    ['<mxCell id="x" value="R&D" vertex="1" parent="1"/>', /raw < or &/],
    ['<mxCell id="x" value="<b>hi</b>" vertex="1" parent="1"/>', /Unsupported XML|raw < or &/],
    ['<mxCell id="x" id="y" vertex="1" parent="1"/>', /twice/],
    ['<mxCell id="x" vertex="1" parent="1"/> junk', /unexpected text/],
    ['<mxCell id="x" vertex="1" parent="1"><mxCell id="2" vertex="1" parent="1"/></mxCell>', /nested/],
    ['<mxCell id="x" vertex="1" parent="0"/>', /is the root/],
    ['<mxCell id="x" value="a&nbsp;b" vertex="1" parent="1"/>', /raw < or &/],
    ['<!-- c --><mxCell id="x" vertex="1" parent="1"/>', /comments/],
  ];

  for (const [xml, pattern] of bad)
  {
    assert.throws(function () { editCellsInXml(PAGE, [{ op: "add", xml: xml }]); }, pattern, xml);
  }

  const ok = '<mxCell id="x" value="R&amp;D &lt;b&gt; &#xa;" vertex="1" parent="1"><mxGeometry width="10" height="10" as="geometry"/></mxCell>';
  assert.equal(parseCells(editCellsInXml(PAGE, [{ op: "add", xml: ok }]).xml).byId.get("x").label, "R&D <b> \n");
});

test("field checks refuse empty ids, non-numbers, the root as parent and style injection", function ()
{
  const cases = [
    [{ op: "add", id: "" }, /must not be empty/],
    [{ op: "add", x: true }, /x must be a number/],
    [{ op: "add", y: "" }, /y must be a number/],
    [{ op: "add", parent: "0" }, /is the root/],
    [{ op: "update", id: "a", parent: "0" }, /is the root/],
    [{ op: "update", id: "a", style_set: { "b=2;c": "3" } }, /not a style key/],
    [{ op: "update", id: "a", style_set: { fillColor: "#fff;shape=x" } }, /must not contain/],
    [{ op: "update", id: "e1", points: [{ x: true, y: 2 }] }, /points must be/],
  ];

  for (const [op, pattern] of cases)
  {
    assert.throws(function () { editCellsInXml(PAGE, [op]); }, pattern, JSON.stringify(op));
  }

  const img = editCellsInXml(PAGE, [{ op: "update", id: "a", style_set: { image: "data:image/png,iVBORw0KGgo==" } }]).xml;
  assert.match(parseCells(img).byId.get("a").style, /image=data:image\/png,iVBORw0KGgo==;$/);

  assert.deepEqual(listCellsInXml(PAGE, { filter: { ids: "a" } }).cells.map(function (c) { return c.id; }), ["a"]);
});

test("the hash ignores whitespace around the page", function ()
{
  assert.equal(pageHash("\n" + PAGE + "  "), pageHash(PAGE));
});
