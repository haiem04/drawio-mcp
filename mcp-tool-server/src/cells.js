// Cell-level access to one page of a local .drawio file, for list_cells and
// edit_cells: an LLM can change one node or edge without re-sending the whole
// page through set_page.
//
// Edits are splices into the page XML at offsets found by a small element
// scanner, never a re-serialization of a parsed model. Rebuilding the XML from
// a model drops custom <object>/<UserObject> attributes and reorders cells
// (z-order, and children ahead of their parent); a splice leaves every byte
// that no operation touched exactly as authored.

import { createHash, randomBytes } from "crypto";
import { readPageXml, writePageXml } from "./pages.js";

const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*"[^"]*")*)(\s*)(\/?)>/g;
const ATTR_RE = /([^\s=/>]+)\s*=\s*"([^"]*)"/g;
const XML_ENTITIES = { lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&" };
const WRAPPERS = { object: true, UserObject: true };

const DEFAULT_VERTEX_STYLE = "rounded=0;whiteSpace=wrap;html=1;";
const DEFAULT_EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;";
const DEFAULT_WIDTH = 120;
const DEFAULT_HEIGHT = 60;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

export function unescapeXml(s)
{
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, function (m, e)
  {
    if (e.charAt(0) !== "#")
    {
      return (XML_ENTITIES[e] != null) ? XML_ENTITIES[e] : m;
    }

    const code = (e.charAt(1) === "x") ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10);
    return (code > 0 && code <= 0x10FFFF) ? String.fromCodePoint(code) : m;
  });
}

// Line breaks and tabs become character references: a literal one in an
// attribute value is read back as a space (XML attribute normalization).
export function escapeXml(s)
{
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#xa;")
    .replace(/\r/g, "&#xd;")
    .replace(/\t/g, "&#x9;");
}

function parseAttrs(raw)
{
  const attrs = {};
  let m;

  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw)) !== null)
  {
    attrs[m[1]] = unescapeXml(m[2]);
  }

  return attrs;
}

export function pageHash(xml)
{
  return createHash("sha256").update(String(xml).trim(), "utf8").digest("hex").slice(0, 16);
}

// Builds the element tree under the first <root>.
// XML predefines only these five named entities; &nbsp; and the like break the page.
const ENTITY_OK_RE = /&(?:#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g;

// Checks the XML rules the tag pattern lets through, for markup that comes
// from the caller: draw.io cannot open a page with a raw < or a stray & in an
// attribute, or the same attribute twice.
function assertWellFormedTag(name, rawAttrs, offset)
{
  const seen = new Set();
  const re = /([^\s=/>]+)\s*=\s*"([^"]*)"/g;
  let m;

  while ((m = re.exec(rawAttrs)) !== null)
  {
    if (seen.has(m[1]))
    {
      throw new Error(`<${name}> at offset ${offset} has the attribute ${m[1]} twice`);
    }

    seen.add(m[1]);

    if (m[2].indexOf("<") !== -1 || m[2].replace(ENTITY_OK_RE, "").indexOf("&") !== -1)
    {
      throw new Error(`attribute ${m[1]} of <${name}> at offset ${offset} has a raw < or & (escape them as &lt; and &amp;)`);
    }
  }
}

// Text between elements must be whitespace: a "<" the tag pattern did not
// match is markup this scanner does not understand, and caller markup may not
// carry text at all.
function assertGap(text, offset, strict)
{
  if (text.indexOf("<") !== -1)
  {
    throw new Error(`Unsupported XML near offset ${offset}; use get_page/set_page for this page`);
  }

  if (strict && text.trim() !== "")
  {
    throw new Error(`unexpected text near offset ${offset}: ${JSON.stringify(text.trim().slice(0, 40))}`);
  }
}

function parseTree(xml, strict)
{
  const top = { name: "#doc", children: [] };
  const stack = [top];
  let rootNode = null;
  let last = 0;
  let m;

  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(xml)) !== null)
  {
    assertGap(xml.slice(last, m.index), last, strict);

    last = m.index + m[0].length;

    if (m[2] == null)
    {
      if (strict)
      {
        throw new Error(`comments are not allowed (offset ${m.index})`);
      }

      continue;
    }

    const closing = m[1] === "/";
    const name = m[2];

    if (closing)
    {
      const open = stack.pop();

      if (open == null || open.name !== name || stack.length === 0)
      {
        throw new Error(`Mismatched </${name}> at offset ${m.index}`);
      }

      open.closeStart = m.index;
      open.end = last;
      continue;
    }

    if (strict)
    {
      assertWellFormedTag(name, m[3] || "", m.index);
    }

    const node = {
      name: name,
      rawAttrs: m[3] || "",
      attrs: parseAttrs(m[3] || ""),
      start: m.index,
      openEnd: last,
      tail: m[4] || "",
      selfClosing: m[5] === "/",
      children: [],
    };

    stack[stack.length - 1].children.push(node);

    if (node.selfClosing)
    {
      node.closeStart = last;
      node.end = last;
    }
    else
    {
      stack.push(node);
    }

    if (name === "root" && rootNode == null)
    {
      rootNode = node;
    }
  }

  assertGap(xml.slice(last), last, strict);

  if (stack.length !== 1)
  {
    throw new Error(`Unclosed <${stack[stack.length - 1].name}> element`);
  }

  if (rootNode == null)
  {
    throw new Error("Page has no <root> element");
  }

  return rootNode;
}

function entryFromNode(node)
{
  const wrapper = WRAPPERS[node.name] ? node : null;
  const cellNode = wrapper ? wrapper.children.find(function (c) { return c.name === "mxCell"; }) : node;

  if (node.name !== "mxCell" && wrapper == null)
  {
    return null;
  }

  if (cellNode == null)
  {
    throw new Error(`<${node.name}> at offset ${node.start} has no inner <mxCell>`);
  }

  const geometry = cellNode.children.find(function (c)
  {
    return c.name === "mxGeometry" && (c.attrs.as == null || c.attrs.as === "geometry");
  }) || null;

  const id = wrapper ? wrapper.attrs.id : cellNode.attrs.id;

  return {
    node: node,
    wrapper: wrapper,
    cellNode: cellNode,
    geometry: geometry,
    id: id != null ? id : null,
    label: wrapper ? (wrapper.attrs.label != null ? wrapper.attrs.label : null) : (cellNode.attrs.value != null ? cellNode.attrs.value : null),
    style: cellNode.attrs.style != null ? cellNode.attrs.style : null,
    parent: cellNode.attrs.parent != null ? cellNode.attrs.parent : null,
    source: cellNode.attrs.source != null ? cellNode.attrs.source : null,
    target: cellNode.attrs.target != null ? cellNode.attrs.target : null,
    vertex: cellNode.attrs.vertex === "1",
    edge: cellNode.attrs.edge === "1",
  };
}

export function parseCells(xml, strict)
{
  const rootNode = parseTree(xml, strict === true);
  const entries = [];
  const byId = new Map();

  for (const child of rootNode.children)
  {
    const entry = entryFromNode(child);

    if (entry == null)
    {
      continue;
    }

    entries.push(entry);

    if (entry.id != null && !byId.has(entry.id))
    {
      byId.set(entry.id, entry);
    }
  }

  const rootCell = entries.find(function (e) { return e.parent == null && !e.vertex && !e.edge; }) || null;

  for (const entry of entries)
  {
    if (entry === rootCell)
    {
      entry.type = "root";
    }
    else if (entry.vertex)
    {
      entry.type = "vertex";
    }
    else if (entry.edge)
    {
      entry.type = "edge";
    }
    else if (rootCell != null && entry.parent === rootCell.id)
    {
      entry.type = "layer";
    }
    else
    {
      entry.type = "cell";
    }
  }

  return { xml: xml, rootNode: rootNode, entries: entries, byId: byId, rootCell: rootCell };
}

function num(v)
{
  const n = parseFloat(v);
  return Number.isNaN(n) ? 0 : n;
}

function fmt(n)
{
  const v = Math.round(Number(n) * 100) / 100;
  return String(v === 0 ? 0 : v);
}

function pointsOf(geometry)
{
  if (geometry == null)
  {
    return null;
  }

  const arr = geometry.children.find(function (c) { return c.name === "Array" && c.attrs.as === "points"; });

  if (arr == null)
  {
    return null;
  }

  return arr.children
    .filter(function (c) { return c.name === "mxPoint"; })
    .map(function (c) { return { x: num(c.attrs.x), y: num(c.attrs.y) }; });
}

export function compactCell(entry, includeXml, xml)
{
  const out = { id: entry.id, type: entry.type };

  if (entry.label != null && entry.label !== "")
  {
    out.label = entry.label;
  }

  if (entry.parent != null)
  {
    out.parent = entry.parent;
  }

  if (entry.source != null)
  {
    out.source = entry.source;
  }

  if (entry.target != null)
  {
    out.target = entry.target;
  }

  if (entry.style != null && entry.style !== "")
  {
    out.style = entry.style;
  }

  if (entry.geometry != null && entry.type !== "edge")
  {
    const a = entry.geometry.attrs;
    out.x = num(a.x);
    out.y = num(a.y);
    out.width = num(a.width);
    out.height = num(a.height);
  }

  const points = pointsOf(entry.geometry);

  if (points != null && points.length > 0)
  {
    out.points = points;
  }

  if (entry.wrapper != null)
  {
    const data = {};

    for (const key of Object.keys(entry.wrapper.attrs))
    {
      if (key !== "id" && key !== "label")
      {
        data[key] = entry.wrapper.attrs[key];
      }
    }

    if (Object.keys(data).length > 0)
    {
      out.data = data;
    }
  }

  if (includeXml)
  {
    out.xml = xml.slice(entry.node.start, entry.node.end);
  }

  return out;
}

function matchesFilter(entry, filter)
{
  if (filter.ids != null && filter.ids.map(String).indexOf(entry.id) === -1)
  {
    return false;
  }

  if (filter.type != null && entry.type !== filter.type)
  {
    return false;
  }

  if (filter.parent != null && entry.parent !== filter.parent)
  {
    return false;
  }

  if (filter.label != null && String(entry.label || "").toLowerCase().indexOf(String(filter.label).toLowerCase()) === -1)
  {
    return false;
  }

  if (filter.style != null && String(entry.style || "").indexOf(String(filter.style)) === -1)
  {
    return false;
  }

  if (filter.connected_to != null && entry.source !== filter.connected_to && entry.target !== filter.connected_to)
  {
    return false;
  }

  return true;
}

export function listCellsInXml(xml, options)
{
  const opts = options || {};
  const filter = Object.assign({}, opts.filter);

  if (filter.ids != null && !Array.isArray(filter.ids))
  {
    filter.ids = [filter.ids];
  }

  const parsed = parseCells(xml);
  const matched = parsed.entries.filter(function (e) { return matchesFilter(e, filter); });
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(Number(opts.limit) || DEFAULT_LIST_LIMIT)));
  const slice = matched.slice(offset, offset + limit);

  return {
    hash: pageHash(xml),
    total: matched.length,
    offset: offset,
    returned: slice.length,
    cells: slice.map(function (e) { return compactCell(e, opts.xml === true, xml); }),
  };
}

// ─── Splicing helpers ────────────────────────────────────────────

// Walks the attributes in order rather than searching for the name, which
// would also match ` name="` inside another attribute's value.
function findAttr(rawAttrs, name)
{
  const re = /(\s+)([^\s=/>]+)\s*=\s*"[^"]*"/g;
  let m;

  while ((m = re.exec(rawAttrs)) !== null)
  {
    if (m[2] === name)
    {
      return { start: m.index, end: m.index + m[0].length };
    }
  }

  return null;
}

function setAttr(rawAttrs, name, value)
{
  const found = findAttr(rawAttrs, name);
  const piece = value == null ? "" : " " + name + "=\"" + escapeXml(value) + "\"";

  if (found == null)
  {
    return rawAttrs + piece;
  }

  return rawAttrs.slice(0, found.start) + piece + rawAttrs.slice(found.end);
}

// `tail` is the whitespace the source had before `>` or `/>`, kept so a
// rewritten tag matches the file's own formatting.
function openTag(name, rawAttrs, selfClosing, tail)
{
  return "<" + name + rawAttrs + (tail || "") + (selfClosing ? "/>" : ">");
}

// draw.io styles are `[named;]key=value;...`; a null value removes the key.
// Key order is kept so a diff of the file stays readable.
export function mergeStyle(style, changes)
{
  for (const key of Object.keys(changes || {}))
  {
    const v = changes[key];

    if (!/^[A-Za-z_][\w.-]*$/.test(key))
    {
      throw new Error(`style_set key "${key}" is not a style key`);
    }

    // "=" is fine inside a value (base64 padding in image data URIs): a style
    // part is split at its first "=" only.
    if (v != null && String(v).indexOf(";") !== -1)
    {
      throw new Error(`style_set value for ${key} must not contain ;`);
    }
  }

  const parts = String(style || "").split(";").filter(function (p) { return p !== ""; });
  const remaining = Object.assign({}, changes);
  const out = [];

  for (const part of parts)
  {
    const eq = part.indexOf("=");

    if (eq === -1)
    {
      out.push(part);
      continue;
    }

    const key = part.slice(0, eq);

    if (Object.prototype.hasOwnProperty.call(remaining, key))
    {
      const v = remaining[key];
      delete remaining[key];

      if (v != null)
      {
        out.push(key + "=" + v);
      }
    }
    else
    {
      out.push(part);
    }
  }

  for (const key of Object.keys(remaining))
  {
    if (remaining[key] != null)
    {
      out.push(key + "=" + remaining[key]);
    }
  }

  return out.length > 0 ? out.join(";") + ";" : "";
}

function renderPoints(points)
{
  return "<Array as=\"points\">" + points.map(function (p)
  {
    assertPoint(p);
    return "<mxPoint x=\"" + fmt(p.x) + "\" y=\"" + fmt(p.y) + "\" />";
  }).join("") + "</Array>";
}

function isNumeric(v)
{
  return (typeof v === "number" || typeof v === "string") && String(v).trim() !== "" && Number.isFinite(Number(v));
}

function assertPoint(p)
{
  if (p == null || !isNumeric(p.x) || !isNumeric(p.y))
  {
    throw new Error("points must be an array of {x, y} numbers");
  }
}

function assertNumber(name, v)
{
  if (v != null && !isNumeric(v))
  {
    throw new Error(`${name} must be a number`);
  }
}

// Rebuilds the geometry element with the given changes. Children the change
// does not name (alternateBounds, sourcePoint, offset, ...) ride along verbatim.
function renderGeometry(xml, geometry, changes, isEdge)
{
  let rawAttrs = geometry ? geometry.rawAttrs : (isEdge ? " relative=\"1\" as=\"geometry\"" : " as=\"geometry\"");

  for (const key of ["x", "y", "width", "height"])
  {
    if (changes[key] != null)
    {
      rawAttrs = setAttr(rawAttrs, key, fmt(changes[key]));
    }
  }

  let inner = "";

  if (geometry != null && !geometry.selfClosing)
  {
    const pieces = [];
    let cursor = geometry.openEnd;

    for (const child of geometry.children)
    {
      if (changes.points !== undefined && child.name === "Array" && child.attrs.as === "points")
      {
        pieces.push(xml.slice(cursor, child.start));
        cursor = child.end;
      }
    }

    pieces.push(xml.slice(cursor, geometry.closeStart));
    inner = pieces.join("");
  }

  if (Array.isArray(changes.points) && changes.points.length > 0)
  {
    inner += renderPoints(changes.points);
  }

  const tail = geometry ? geometry.tail : "";

  return inner === "" ? openTag("mxGeometry", rawAttrs, true, tail) : openTag("mxGeometry", rawAttrs, false, tail) + inner + "</mxGeometry>";
}

// Rebuilds the <mxCell> element (not its wrapper) with new attributes and,
// when asked, a new geometry. Other children keep their bytes.
function renderCellNode(xml, cellNode, rawAttrs, geometryText, geometryNode)
{
  if (geometryText == null)
  {
    return cellNode.selfClosing
      ? openTag("mxCell", rawAttrs, true, cellNode.tail)
      : openTag("mxCell", rawAttrs, false, cellNode.tail) + xml.slice(cellNode.openEnd, cellNode.closeStart) + "</mxCell>";
  }

  if (cellNode.selfClosing)
  {
    return openTag("mxCell", rawAttrs, false) + geometryText + "</mxCell>";
  }

  let body;

  if (geometryNode != null)
  {
    body = xml.slice(cellNode.openEnd, geometryNode.start) + geometryText + xml.slice(geometryNode.end, cellNode.closeStart);
  }
  else
  {
    body = xml.slice(cellNode.openEnd, cellNode.closeStart) + geometryText;
  }

  return openTag("mxCell", rawAttrs, false, cellNode.tail) + body + "</mxCell>";
}

function splice(xml, start, end, text)
{
  return xml.slice(0, start) + text + xml.slice(end);
}

// ─── Operations ──────────────────────────────────────────────────

function newId(parsed)
{
  let id;

  do
  {
    id = "c-" + randomBytes(6).toString("base64url");
  }
  while (parsed.byId.has(id));

  return id;
}

function defaultLayer(parsed)
{
  const layer = parsed.entries.find(function (e) { return e.type === "layer"; });

  if (layer == null)
  {
    throw new Error("Page has no layer to add cells to; pass parent explicitly");
  }

  return layer.id;
}

function requireCell(parsed, id, role)
{
  const entry = parsed.byId.get(String(id));

  if (entry == null)
  {
    throw new Error(`${role} "${id}" does not exist on this page`);
  }

  return entry;
}

function isAncestor(parsed, ancestorId, id)
{
  let current = parsed.byId.get(id);
  const seen = new Set();

  while (current != null && current.parent != null && !seen.has(current.id))
  {
    if (current.parent === ancestorId)
    {
      return true;
    }

    seen.add(current.id);
    current = parsed.byId.get(current.parent);
  }

  return false;
}

function checkParent(parsed, parentId, selfId, isShape)
{
  const parent = requireCell(parsed, parentId, "parent");

  // A shape or edge directly under the root would be read as a layer.
  if (isShape && parent.type === "root")
  {
    throw new Error(`parent "${parentId}" is the root; use a layer or a container`);
  }

  if (selfId != null && (parentId === selfId || isAncestor(parsed, selfId, parentId)))
  {
    throw new Error(`parent "${parentId}" would put "${selfId}" inside itself`);
  }

  return parent;
}

function checkTerminal(parsed, id, role)
{
  const terminal = requireCell(parsed, id, role);

  if (terminal.type === "root" || terminal.type === "layer")
  {
    throw new Error(`${role} "${id}" is a ${terminal.type}, not a shape`);
  }
}

function countCellElements(node)
{
  let count = (node.name === "mxCell" || WRAPPERS[node.name]) ? 1 : 0;

  for (const child of node.children)
  {
    count += countCellElements(child);
  }

  return count;
}

function addFromXml(parsed, op)
{
  const fragment = String(op.xml).trim();

  if (/<\/?(?:diagram|mxGraphModel|root)\b/.test(fragment))
  {
    throw new Error("xml must be a single cell, not a page or file");
  }

  const probe = parseCells("<root>" + fragment + "</root>", true);

  if (probe.rootNode.children.length !== 1 || probe.entries.length !== 1)
  {
    throw new Error("xml must hold exactly one <mxCell>, <object> or <UserObject> element");
  }

  if (countCellElements(probe.rootNode.children[0]) !== (probe.entries[0].wrapper ? 2 : 1))
  {
    throw new Error("xml must hold one cell only, with no other cells nested inside it");
  }

  const entry = probe.entries[0];

  if (entry.id == null || entry.id === "")
  {
    throw new Error("xml cell needs an id");
  }

  if (op.id != null && String(op.id) !== entry.id)
  {
    throw new Error(`id "${op.id}" does not match the id "${entry.id}" in xml`);
  }

  return { id: entry.id, text: fragment, parent: entry.parent, source: entry.source, target: entry.target, edge: entry.edge, vertex: entry.vertex };
}

function addFromFields(parsed, op)
{
  const isEdge = op.type === "edge" || (op.type == null && (op.source != null || op.target != null));

  if (op.type != null && op.type !== "edge" && op.type !== "vertex")
  {
    throw new Error("type must be \"vertex\" or \"edge\"");
  }

  for (const key of ["x", "y", "width", "height"])
  {
    assertNumber(key, op[key]);
  }

  if (op.id != null && String(op.id).trim() === "")
  {
    throw new Error("id must not be empty");
  }

  const id = op.id != null ? String(op.id) : newId(parsed);
  const parent = op.parent != null ? String(op.parent) : defaultLayer(parsed);
  let style = op.style != null ? String(op.style) : (isEdge ? DEFAULT_EDGE_STYLE : DEFAULT_VERTEX_STYLE);

  if (op.style_set != null)
  {
    style = mergeStyle(style, op.style_set);
  }

  let rawAttrs = "";
  rawAttrs = setAttr(rawAttrs, "id", id);
  rawAttrs = setAttr(rawAttrs, "value", op.label != null ? String(op.label) : "");
  rawAttrs = setAttr(rawAttrs, "style", style);
  rawAttrs = setAttr(rawAttrs, isEdge ? "edge" : "vertex", "1");
  rawAttrs = setAttr(rawAttrs, "parent", parent);

  if (isEdge && op.source != null)
  {
    rawAttrs = setAttr(rawAttrs, "source", String(op.source));
  }

  if (isEdge && op.target != null)
  {
    rawAttrs = setAttr(rawAttrs, "target", String(op.target));
  }

  const geoChanges = isEdge
    ? { points: op.points }
    : {
      x: op.x != null ? op.x : 0,
      y: op.y != null ? op.y : 0,
      width: op.width != null ? op.width : DEFAULT_WIDTH,
      height: op.height != null ? op.height : DEFAULT_HEIGHT,
    };

  const geometry = renderGeometry("", null, geoChanges, isEdge);
  const text = openTag("mxCell", rawAttrs, false) + geometry + "</mxCell>";

  return { id: id, text: text, parent: parent, source: isEdge ? op.source : null, target: isEdge ? op.target : null, edge: isEdge, vertex: !isEdge };
}

function applyAdd(parsed, op)
{
  const built = op.xml != null ? addFromXml(parsed, op) : addFromFields(parsed, op);

  if (parsed.byId.has(built.id))
  {
    throw new Error(`a cell with id "${built.id}" already exists`);
  }

  if (built.parent == null)
  {
    throw new Error("the new cell needs a parent");
  }

  checkParent(parsed, built.parent, null, built.edge || built.vertex);

  if (built.source != null)
  {
    checkTerminal(parsed, built.source, "source");
  }

  if (built.target != null)
  {
    checkTerminal(parsed, built.target, "target");
  }

  const root = parsed.rootNode;

  if (root.selfClosing)
  {
    throw new Error("Page has an empty <root/>; use set_page to create its base cells");
  }

  // Appending keeps the parent ahead of the child in document order, which
  // draw.io's codec needs, and puts the new cell on top of the z-order.
  const xml = splice(parsed.xml, root.closeStart, root.closeStart, built.text);

  return { xml: xml, result: { op: "add", id: built.id, status: "added" } };
}

function applyUpdate(parsed, op)
{
  if (op.id == null)
  {
    throw new Error("update needs id");
  }

  const entry = requireCell(parsed, op.id, "cell");

  if (entry.type === "root")
  {
    throw new Error("the root cell cannot be changed");
  }

  for (const key of ["x", "y", "width", "height"])
  {
    assertNumber(key, op[key]);
  }

  if (op.points !== undefined && op.points !== null && !Array.isArray(op.points))
  {
    throw new Error("points must be an array of {x, y} numbers");
  }

  if (op.parent != null)
  {
    checkParent(parsed, String(op.parent), entry.id, entry.vertex || entry.edge);
  }

  for (const role of ["source", "target"])
  {
    if (op[role] != null && op[role] !== "")
    {
      if (!entry.edge)
      {
        throw new Error(`${role} can only be set on an edge`);
      }

      checkTerminal(parsed, op[role], role);
    }
  }

  const xml = parsed.xml;
  let cellAttrs = entry.cellNode.rawAttrs;
  let wrapperAttrs = entry.wrapper ? entry.wrapper.rawAttrs : null;

  // An unchanged value keeps its authored bytes (e.g. &#x27; instead of ').
  if (op.label !== undefined && (op.label == null ? "" : String(op.label)) !== (entry.label || ""))
  {
    const label = op.label == null ? "" : String(op.label);

    if (entry.wrapper)
    {
      wrapperAttrs = setAttr(wrapperAttrs, "label", label);
    }
    else
    {
      cellAttrs = setAttr(cellAttrs, "value", label);
    }
  }

  if (op.data != null)
  {
    if (!entry.wrapper)
    {
      throw new Error("data can only be set on an <object>/<UserObject> cell");
    }

    for (const key of Object.keys(op.data))
    {
      if (key === "id" || key === "label" || !/^[A-Za-z_][\w.-]*$/.test(key))
      {
        throw new Error(`data key "${key}" is not allowed`);
      }

      wrapperAttrs = setAttr(wrapperAttrs, key, op.data[key] == null ? null : String(op.data[key]));
    }
  }

  let style = entry.style;

  if (op.style !== undefined)
  {
    style = op.style == null ? "" : String(op.style);
  }

  if (op.style_set != null)
  {
    style = mergeStyle(style, op.style_set);
  }

  if (style !== entry.style)
  {
    cellAttrs = setAttr(cellAttrs, "style", style);
  }

  if (op.parent != null)
  {
    cellAttrs = setAttr(cellAttrs, "parent", String(op.parent));
  }

  for (const role of ["source", "target"])
  {
    if (op[role] !== undefined)
    {
      cellAttrs = setAttr(cellAttrs, role, op[role] == null || op[role] === "" ? null : String(op[role]));
    }
  }

  const geoChanges = { x: op.x, y: op.y, width: op.width, height: op.height };

  if (op.points !== undefined)
  {
    geoChanges.points = op.points == null ? [] : op.points;
  }

  const touchesGeometry = ["x", "y", "width", "height"].some(function (k) { return op[k] != null; }) || op.points !== undefined;
  const geometryText = touchesGeometry ? renderGeometry(xml, entry.geometry, geoChanges, entry.edge) : null;
  const cellText = renderCellNode(xml, entry.cellNode, cellAttrs, geometryText, entry.geometry);

  let text;

  if (entry.wrapper)
  {
    const w = entry.wrapper;
    text = openTag(w.name, wrapperAttrs, false, w.tail) + xml.slice(w.openEnd, entry.cellNode.start) + cellText +
      xml.slice(entry.cellNode.end, w.closeStart) + "</" + w.name + ">";
  }
  else
  {
    text = cellText;
  }

  const before = xml.slice(entry.node.start, entry.node.end);

  return {
    xml: splice(xml, entry.node.start, entry.node.end, text),
    result: { op: "update", id: entry.id, status: text === before ? "unchanged" : "updated" },
  };
}

// Removing a cell takes its descendants with it, and every edge that would be
// left with a dangling end, as draw.io's own delete does.
function collectRemoval(parsed, id)
{
  const removed = new Set([id]);
  let grew = true;

  while (grew)
  {
    grew = false;

    for (const entry of parsed.entries)
    {
      if (entry.id == null || removed.has(entry.id))
      {
        continue;
      }

      if (removed.has(entry.parent) || removed.has(entry.source) || removed.has(entry.target))
      {
        removed.add(entry.id);
        grew = true;
      }
    }
  }

  return removed;
}

function applyDelete(parsed, op, deletedInBatch)
{
  if (op.id == null)
  {
    throw new Error("delete needs id");
  }

  const id = String(op.id);
  const entry = parsed.byId.get(id);

  if (entry == null)
  {
    if (deletedInBatch.has(id))
    {
      return { xml: parsed.xml, result: { op: "delete", id: id, status: "already removed" } };
    }

    throw new Error(`cell "${id}" does not exist on this page`);
  }

  if (entry.type === "root" || entry.type === "layer")
  {
    throw new Error(`"${id}" is the ${entry.type}; layers and the root cannot be deleted here`);
  }

  const removed = collectRemoval(parsed, id);
  const targets = parsed.entries
    .filter(function (e) { return removed.has(e.id); })
    .sort(function (a, b) { return b.node.start - a.node.start; });

  let xml = parsed.xml;

  for (const target of targets)
  {
    xml = splice(xml, target.node.start, target.node.end, "");
  }

  for (const removedId of removed)
  {
    deletedInBatch.add(removedId);
  }

  const also = Array.from(removed).filter(function (r) { return r !== id; });
  const result = { op: "delete", id: id, status: "deleted" };

  if (also.length > 0)
  {
    result.also_removed = also;
  }

  return { xml: xml, result: result };
}

/**
 * Applies a batch of add/update/delete operations to one page's XML. All or
 * nothing: the first failing operation throws and no change is kept.
 */
export function editCellsInXml(xml, operations)
{
  if (!Array.isArray(operations) || operations.length === 0)
  {
    throw new Error("operations must be a non-empty array");
  }

  let current = xml;
  const results = [];
  const touched = [];
  const deletedInBatch = new Set();

  for (let i = 0; i < operations.length; i++)
  {
    const op = operations[i] || {};

    try
    {
      const parsed = parseCells(current);
      let step;

      if (op.op === "add")
      {
        step = applyAdd(parsed, op);
      }
      else if (op.op === "update")
      {
        step = applyUpdate(parsed, op);
      }
      else if (op.op === "delete")
      {
        step = applyDelete(parsed, op, deletedInBatch);
      }
      else
      {
        throw new Error("op must be \"add\", \"update\" or \"delete\"");
      }

      current = step.xml;
      results.push(step.result);

      if (step.result.status === "added" || step.result.status === "updated")
      {
        touched.push(step.result.id);
      }
    }
    catch (e)
    {
      throw new Error(`Operation ${i} (${op.op || "?"}${op.id != null ? " " + op.id : ""}) failed: ${e.message}. No changes were written.`);
    }
  }

  const finalParsed = parseCells(current);
  const cells = touched
    .filter(function (id, idx) { return touched.indexOf(id) === idx && finalParsed.byId.has(id); })
    .map(function (id) { return compactCell(finalParsed.byId.get(id), false, current); });

  return { xml: current, results: results, cells: cells };
}

export function listCells(filePath, pageRef, options)
{
  const page = readPageXml(filePath, pageRef);
  const listed = listCellsInXml(page.xml, options);

  return Object.assign({ page: { index: page.index, id: page.id, name: page.name } }, listed);
}

export function editCells(filePath, pageRef, operations, options)
{
  const opts = options || {};
  const page = readPageXml(filePath, pageRef);
  const before = pageHash(page.xml);

  if (opts.if_hash != null && opts.if_hash !== before)
  {
    throw new Error(`Page changed since hash ${opts.if_hash} (now ${before}). Call list_cells again before editing.`);
  }

  const edited = editCellsInXml(page.xml, operations);

  if (opts.dry_run !== true && edited.xml !== page.xml)
  {
    // Narrows the window in which another writer's change would be lost.
    if (pageHash(readPageXml(filePath, String(page.index)).xml) !== before)
    {
      throw new Error("Page changed while the edit ran. Call list_cells again before editing.");
    }

    writePageXml(filePath, String(page.index), edited.xml);
  }

  return {
    page: { index: page.index, id: page.id, name: page.name },
    dry_run: opts.dry_run === true,
    hash: pageHash(edited.xml),
    results: edited.results,
    cells: edited.cells,
  };
}
