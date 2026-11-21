// Round-trip tests for the replay codec.  Run: npm test
//
// The fixture is one real replay as the scraper stores it (gzipped PSON).
// We rebuild the replaydata string from those bytes, then check that decode
// and encode are exact inverses of each other.

import test   from "node:test";
import assert from "node:assert/strict";
import fs     from "node:fs";
import zlib   from "node:zlib";
import LZString from "lz-string";

import {
    flipCase, decodeReplayData, encodeReplayData, traceDecode, traceEncode,
    unpackInputs, packInputs, describeKeys, FLIP_LENGTH,
} from "../src/codec.js";

const psonBytes = zlib.gunzipSync(fs.readFileSync(new URL("./fixtures/sample-replay.pson.gz", import.meta.url)));
// Build the replaydata string by hand (independent of encodeReplayData).
const replaydata = flipCase(LZString.compressToEncodedURIComponent(psonBytes.toString("base64")));

test("flipCase is its own inverse and only touches the first 101 chars", () => {
    const s = "abcDEF".repeat(30);
    assert.equal(flipCase(flipCase(s)), s);
    assert.equal(flipCase(s).slice(FLIP_LENGTH), s.slice(FLIP_LENGTH));
    assert.equal(flipCase("aB1-$"), "Ab1-$");
});

test("decode reads the real fixture", () => {
    const { decoded, rawBuffer } = decodeReplayData(replaydata);
    assert.ok(Array.isArray(decoded.playerArray));
    assert.equal(typeof decoded.inputs, "string");
    assert.equal(Buffer.compare(rawBuffer, psonBytes), 0);
});

test("encode(decode(s)) gives back the exact same string", () => {
    const { decoded } = decodeReplayData(replaydata);
    assert.equal(encodeReplayData(decoded), replaydata);
});

test("the round trip survives a trip through JSON text (what the web tool does)", () => {
    const { decoded } = decodeReplayData(replaydata);
    const viaJson = JSON.parse(JSON.stringify(decoded));
    const { replaydata: again, psonBuffer } = traceEncode(viaJson);
    assert.equal(again, replaydata);
    assert.equal(Buffer.compare(psonBuffer, psonBytes), 0);
});

test("trace steps line up in both directions", () => {
    const dec = traceDecode(replaydata);
    const enc = traceEncode(dec.result.decoded);
    assert.equal(enc.base64, dec.steps.base64);
    assert.equal(enc.compressed, dec.steps.flipped);
});

test("decode failures say which step broke", () => {
    assert.throws(() => decodeReplayData("not a replay at all!!"), (e) => ["lz", "base64", "pson"].includes(e.stage));
    assert.throws(() => traceEncode([1, 2]), (e) => e.stage === "input");
    assert.throws(() => traceEncode(null), (e) => e.stage === "input");
});

test("inputs unpack and repack to the same base64", () => {
    const { decoded } = decodeReplayData(replaydata);
    const events = unpackInputs(decoded.inputs);
    assert.ok(events.length > 0);
    assert.equal(packInputs(events), decoded.inputs);
    assert.deepEqual(describeKeys(1 | 4 | 16), ["left", "up", "action"]);
});
