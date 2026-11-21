import ByteBuffer from "bytebuffer";
import LZString    from "lz-string";
import PSON        from "pson";
import zlib        from "node:zlib";
import { promisify } from "node:util";

const gzip   = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// ─── The replaydata format, in one picture ────────────────────────────────────
//
//   ENCODE (what bonk.io does when it saves a replay)
//
//     replay object ──PSON──► bytes ──base64──► text ──LZString──► text ──flip──► replaydata
//
//   DECODE (what this file does to read one) is the same chain backwards:
//
//     replaydata ──flip──► text ──LZString──► base64 text ──base64──► bytes ──PSON──► replay object
//
// Every step is lossless and has an exact inverse, so decode(encode(x)) gives
// back x. See docs/HOW-REPLAYS-WORK.md for a longer walkthrough.

// ─── PSON dictionary (must match bonk.io's pair list exactly) ────────────────
//
// PSON is a compact binary JSON. A "static pair" dictionary lets it write a
// common string (like "physics") as a one-byte index instead of the full text.
// Both sides must use the same list in the same order, or every lookup lands
// on the wrong word. This is bonk.io's list, copied as-is (including the
// duplicated "fr" and "d" entries — bonk has them too).

const pairs = new PSON.StaticPair([
    "physics", "shapes", "fixtures", "bodies", "bro", "joints", "ppm",
    "lights", "spawns", "lasers", "capZones", "type", "w", "h", "c", "a",
    "v", "l", "s", "sh", "fr", "re", "de", "sn", "fc", "fm", "f", "d", "n",
    "bg", "lv", "av", "ld", "ad", "fr", "bu", "cf", "rv", "p", "d", "bf",
    "ba", "bb", "aa", "ab", "axa", "dr", "em", "mmt", "mms", "ms", "ut",
    "lt", "New body", "Box Shape", "Circle Shape", "Polygon Shape",
    "EdgeChain Shape", "priority", "Light", "Laser", "Cap Zone", "BG Shape",
    "Background Layer", "Rotate Joint", "Slider Joint", "Rod Joint",
    "Gear Joint", 65535, 16777215,
]);

// ─── Case flip ────────────────────────────────────────────────────────────────
//
// bonk.io swaps upper/lower case on the first 101 characters (indexes 0–100)
// of the string. It's a light scramble, not real protection. Flipping twice
// gives back the original, so the same function is used in both directions.

export const FLIP_LENGTH = 101;

export function flipCase(str) {
    let head = "";
    const n = Math.min(FLIP_LENGTH, str.length);
    for (let i = 0; i < n; i++) {
        const ch = str[i];
        head += ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
    }
    return head + str.slice(n);
}

// ─── Decode ───────────────────────────────────────────────────────────────────

/**
 * Decodes a raw replaydata string from the bonk.io API.
 *
 * The encoding pipeline (in reverse):
 *   1. First 101 chars have their case flipped (bonk quirk).
 *   2. LZString.decompressFromEncodedURIComponent → base64 string.
 *   3. ByteBuffer.fromBase64 → binary buffer.
 *   4. PSON.decode → plain JS object.
 *
 * Returns { decoded (JS object), rawBuffer (Buffer of PSON binary bytes) }.
 */
export function decodeReplayData(rawdata) {
    return traceDecode(rawdata).result;
}

/**
 * Same as decodeReplayData, but also returns what the data looked like after
 * each step, so the web tool can show the transformation.
 *
 * Returns { result: { decoded, rawBuffer }, steps: { flipped, base64 } }.
 * Throws an Error with a `stage` field ("lz" | "base64" | "pson") on failure.
 */
export function traceDecode(rawdata) {
    // Step 1 — case-flip first 101 chars
    const flipped = flipCase(rawdata);

    // Step 2 — LZ decompress → base64 string
    const base64 = LZString.decompressFromEncodedURIComponent(flipped);
    if (!base64) throw stageError("lz", "LZString decompression returned null — this isn't a replaydata string, or it was cut off.");

    // Step 3 — base64 → ByteBuffer
    let bb;
    try { bb = ByteBuffer.fromBase64(base64); }
    catch (err) { throw stageError("base64", `base64 decode failed: ${err.message}`); }

    // Step 4 — PSON decode → JS object
    let decoded;
    try { decoded = pairs.decode(bb.buffer); }
    catch (err) { throw stageError("pson", `PSON decode failed: ${err.message}`); }

    // Keep the raw PSON bytes; we'll gzip them for storage.
    // bb.buffer is an ArrayBuffer — wrap it in a Node Buffer.
    const rawBuffer = Buffer.from(bb.buffer);

    return { result: { decoded, rawBuffer }, steps: { flipped, base64 } };
}

// ─── Encode ───────────────────────────────────────────────────────────────────

/**
 * Encodes a replay object back into a bonk.io replaydata string — the exact
 * reverse of decodeReplayData.
 *
 *   1. PSON.encode → binary buffer.
 *   2. base64-encode the bytes.
 *   3. LZString.compressToEncodedURIComponent → URL-safe text.
 *   4. Flip the case of the first 101 chars.
 *
 * Returns the replaydata string.
 */
export function encodeReplayData(replay) {
    return traceEncode(replay).replaydata;
}

/**
 * Same as encodeReplayData, but also returns each intermediate value.
 *
 * Returns { replaydata, psonBuffer, base64, compressed }.
 * Throws an Error with a `stage` field ("input" | "pson") on failure.
 */
export function traceEncode(replay) {
    if (replay === null || typeof replay !== "object" || Array.isArray(replay)) {
        throw stageError("input", "A replay must be a JSON object (the thing that starts with {).");
    }

    // Step 1 — JS object → PSON bytes
    let psonBuffer;
    try {
        const bb = pairs.encode(replay);
        psonBuffer = Buffer.from(bb.toBuffer());
    } catch (err) {
        throw stageError("pson", `PSON encode failed: ${err.message}`);
    }

    // Step 2 — bytes → base64 text
    const base64 = psonBuffer.toString("base64");

    // Step 3 — LZ compress → URL-safe text
    const compressed = LZString.compressToEncodedURIComponent(base64);

    // Step 4 — case-flip the first 101 chars
    const replaydata = flipCase(compressed);

    return { replaydata, psonBuffer, base64, compressed };
}

function stageError(stage, message) {
    const err = new Error(message);
    err.stage = stage;
    return err;
}

// ─── Inputs (the actual gameplay) ─────────────────────────────────────────────
//
// Inside a decoded replay, `inputs` is *another* base64 string: a packed list
// of "player X changed their keys to Y on step Z". bonk.io calls the packing
// step halfSerialize. Layout (big-endian):
//
//   uint16  count
//   then `count` records of:
//     uint16  player id (slot in playerArray)
//     uint32  step (physics frame, 30 per second)
//     uint8   key bits: left=1 right=2 up=4 down=8 action(heavy)=16 action2(special)=32
//
// Only *changes* are recorded. A key stays held until the next record for
// that player says otherwise.

export const INPUT_BITS = { left: 1, right: 2, up: 4, down: 8, action: 16, action2: 32 };

/** base64 inputs string → [{ player, step, bits }] in file order. */
export function unpackInputs(inputsBase64) {
    const buf = Buffer.from(inputsBase64, "base64");
    if (buf.length < 2) return [];
    const count = buf.readUInt16BE(0);
    const events = [];
    let p = 2;
    for (let i = 0; i < count && p + 7 <= buf.length; i++) {
        events.push({ player: buf.readUInt16BE(p), step: buf.readUInt32BE(p + 2), bits: buf.readUInt8(p + 6) });
        p += 7;
    }
    return events;
}

/** [{ player, step, bits }] → base64 inputs string. Inverse of unpackInputs. */
export function packInputs(events) {
    const buf = Buffer.alloc(2 + events.length * 7);
    buf.writeUInt16BE(events.length, 0);
    let p = 2;
    for (const e of events) {
        buf.writeUInt16BE(e.player, p);
        buf.writeUInt32BE(e.step, p + 2);
        buf.writeUInt8(e.bits, p + 6);
        p += 7;
    }
    return buf.toString("base64");
}

/** Key bits → readable list, e.g. 5 → ["left", "up"]. */
export function describeKeys(bits) {
    return Object.entries(INPUT_BITS).filter(([, b]) => (bits & b) === b).map(([k]) => k);
}

// ─── Storage compression ──────────────────────────────────────────────────────
//
// Why not just store the original encoded string?
//
//   original string  =  LZ-compressed data  →  base64-encoded  →  ~33 % larger
//
// We decode back to raw PSON binary (already compact), then gzip it.
// Typical savings vs. the original string: 40–60 %.
// Gzip level 6 (Node default) is a good speed/size tradeoff for bulk inserts.

/** Compress raw PSON bytes → gzip Buffer ready for BYTEA storage. */
export async function compressForStorage(rawBuffer) {
    return gzip(rawBuffer);
}

/** Decompress a BYTEA blob back to raw PSON bytes. */
export async function decompressFromStorage(blob) {
    return gunzip(blob);
}

/**
 * Full round-trip: encoded API string → gzip Buffer for DB storage.
 * Returns { replayBytes, decoded } or throws on decode failure.
 */
export async function encodeForStorage(rawdata) {
    const { decoded, rawBuffer } = decodeReplayData(rawdata);
    const replayBytes = await compressForStorage(rawBuffer);
    return { replayBytes, decoded };
}
