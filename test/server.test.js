// HTTP tests for /api/decode and /api/encode.  Run: npm test

import test   from "node:test";
import assert from "node:assert/strict";
import fs     from "node:fs";
import zlib   from "node:zlib";
import LZString from "lz-string";

import { server }   from "../src/server.js";
import { flipCase } from "../src/codec.js";

const psonBytes  = zlib.gunzipSync(fs.readFileSync(new URL("./fixtures/sample-replay.pson.gz", import.meta.url)));
const replaydata = flipCase(LZString.compressToEncodedURIComponent(psonBytes.toString("base64")));

let base;
test.before(() => new Promise((resolve) => server.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
})));
test.after(() => new Promise((resolve) => server.close(resolve)));

const post = (path, body) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test("decode → encode gives back the same string", async () => {
    const dec = await post("/api/decode", { replaydata });
    assert.equal(dec.status, 200);
    assert.ok(dec.body.steps.flipped.head.length > 0);
    assert.ok(dec.body.inputs.total > 0);

    const enc = await post("/api/encode", { replay: dec.body.decoded });
    assert.equal(enc.status, 200);
    assert.equal(enc.body.replaydata, replaydata);
    assert.equal(enc.body.roundTrip.ok, true);
    assert.deepEqual(enc.body.warnings, []);
    assert.equal(enc.body.steps.base64.head, dec.body.steps.base64.head);
});

test("encode warns about a replay missing the parts bonk needs", async () => {
    const enc = await post("/api/encode", { replay: { hello: "world" } });
    assert.equal(enc.status, 200);
    assert.equal(enc.body.roundTrip.ok, true);
    assert.equal(enc.body.warnings.length, 1);
});

test("encode rejects things that aren't an object", async () => {
    const enc = await post("/api/encode", { replay: [1, 2, 3] });
    assert.equal(enc.status, 422);
    assert.equal(enc.body.stage, "input");
});

test("decode of junk names the failing step", async () => {
    const dec = await post("/api/decode", { replaydata: "definitely-not-a-replay" });
    assert.equal(dec.status, 422);
    assert.ok(["lz", "base64", "pson"].includes(dec.body.stage));
});
