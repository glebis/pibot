import { describe, expect, it } from "vitest";
import {
  LineDecoder,
  contentBlocksToText,
  encodeMessage,
  isNotification,
  isRequest,
  isResponse,
  parseMessage,
  type ContentBlock,
} from "./protocol.js";

describe("ACP framing", () => {
  it("encodes one message per line with a trailing newline and no embedded newlines", () => {
    const encoded = encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { text: "a\nb" } });
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.trimEnd().includes("\n")).toBe(false);
  });

  it("classifies requests, notifications and responses", () => {
    const req = parseMessage('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    const note = parseMessage('{"jsonrpc":"2.0","method":"session/update","params":{}}');
    const res = parseMessage('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(req.ok && isRequest(req.message)).toBe(true);
    expect(note.ok && isNotification(note.message)).toBe(true);
    expect(res.ok && isResponse(res.message)).toBe(true);
    // a response is never mistaken for a request (id 0 is still a response)
    const zero = parseMessage('{"jsonrpc":"2.0","id":0,"result":{}}');
    expect(zero.ok && isRequest(zero.message)).toBe(false);
    expect(zero.ok && isResponse(zero.message)).toBe(true);
  });

  it("reports parse failures instead of throwing", () => {
    expect(parseMessage("not json").ok).toBe(false);
    expect(parseMessage("42").ok).toBe(false);
    expect(parseMessage('"a string"').ok).toBe(false);
    expect(parseMessage("{}").ok).toBe(false);
    expect(parseMessage("").ok).toBe(false);
  });

  it("buffers a partial trailing line until its newline arrives", () => {
    const d = new LineDecoder();
    expect(d.push('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":')).toEqual(['{"jsonrpc":"2.0","id":1,"method":"a"}']);
    expect(d.push('"2.0","method":"b"}\n')).toEqual(['{"jsonrpc":"2.0","method":"b"}']);
  });

  it("reassembles a multi-byte character split across chunks", () => {
    const line = encodeMessage({ jsonrpc: "2.0", method: "x", params: { t: "😀 done" } });
    const buf = Buffer.from(line, "utf8");
    const cut = buf.indexOf(Buffer.from("😀")) + 2; // inside the 4-byte emoji
    const d = new LineDecoder();
    expect(d.push(buf.subarray(0, cut))).toEqual([]);
    const [out] = d.push(buf.subarray(cut));
    expect(JSON.parse(out)).toEqual({ jsonrpc: "2.0", method: "x", params: { t: "😀 done" } });
  });

  it("skips blank lines and flushes a trailing line without a newline", () => {
    const d = new LineDecoder();
    expect(d.push('{"jsonrpc":"2.0","method":"a"}\n\n\n')).toEqual(['{"jsonrpc":"2.0","method":"a"}']);
    d.push('{"jsonrpc":"2.0","method":"b"}');
    expect(d.flush()).toEqual(['{"jsonrpc":"2.0","method":"b"}']);
    expect(d.flush()).toEqual([]);
  });
});

describe("contentBlocksToText", () => {
  it("joins text blocks and describes attachments", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "hello" },
      { type: "resource_link", uri: "file:///tmp/x.md" },
      { type: "resource", resource: { uri: "file:///tmp/y.ts", text: "let a = 1;" } },
      { type: "image", mimeType: "image/png", data: "AAA" },
    ];
    const text = contentBlocksToText(blocks);
    expect(text).toContain("hello");
    expect(text).toContain("[resource file:///tmp/x.md]");
    expect(text).toContain("let a = 1;");
    expect(text).toContain("[image attachment]");
  });

  it("returns an empty string for no usable blocks", () => {
    expect(contentBlocksToText([])).toBe("");
  });
});
