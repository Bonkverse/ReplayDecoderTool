// Tests for bonk.io's playback checks.  Run: npm test

import test   from "node:test";
import assert from "node:assert/strict";
import fs     from "node:fs";
import zlib   from "node:zlib";
import LZString from "lz-string";

import { flipCase, decodeReplayData, packInputs } from "../src/codec.js";
import { checkReplay, verdict } from "../src/replay-checks.js";

const psonBytes = zlib.gunzipSync(fs.readFileSync(new URL("./fixtures/sample-replay.pson.gz", import.meta.url)));
const fresh = () => decodeReplayData(flipCase(LZString.compressToEncodedURIComponent(psonBytes.toString("base64")))).decoded;
const level = (checks, id) => checks.find((c) => c.id === id)?.level;

test("a real recorded replay passes everything", () => {
    const checks = checkReplay(fresh());
    assert.equal(verdict(checks), "ok", JSON.stringify(checks.filter((c) => c.level !== "ok")));
});

test("hard failures: the menu would skip these", () => {
    let r = fresh(); r.startingState.physics.ppm = 40;
    assert.equal(level(checkReplay(r), "ppm"), "fail");

    r = fresh(); r.playerArray.find(Boolean).userName = "x".repeat(26);
    assert.equal(level(checkReplay(r), "names"), "fail");

    r = fresh(); r.startingState.discs = Array(9).fill(r.startingState.discs.find(Boolean));
    assert.equal(level(checkReplay(r), "count"), "fail");

    r = fresh(); delete r.adminInputs;
    assert.equal(level(checkReplay(r), "parts"), "fail");

    r = fresh(); r.inputs = r.inputs.slice(0, -8);
    assert.equal(level(checkReplay(r), "inputs"), "fail");
});

test("soft problems: bonk changes these instead of skipping", () => {
    let r = fresh(); r.mn = "a map name that is far too long to show";
    assert.equal(level(checkReplay(r), "text"), "warn");

    r = fresh(); r.playerArray.find(Boolean).avatar.layers[0].scale = 50;
    assert.equal(level(checkReplay(r), "skins"), "warn");

    r = fresh(); r.es = 3000;
    assert.equal(level(checkReplay(r), "es"), "warn");

    r = fresh(); r.inputs = packInputs([{ player: 7, step: 10, bits: 1 }]);
    assert.equal(level(checkReplay(r), "ghosts"), "warn");
});
