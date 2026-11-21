// ─── "Would bonk.io play this replay?" ───────────────────────────────────────
//
// Runs the same checks bonk.io's own game code runs on a replay, so you can
// test a hand-made ("artificial") or edited replay before doing anything with
// it. Every rule here was read out of the bonk.io client (Map.fromJSONObject,
// Map.halfUnserialize, Skin.fromObject/makeSafe, and the main-menu
// ReplayRenderer). See docs/HOW-REPLAYS-WORK.md section 8.
//
// What this CAN'T tell you: what bonk.io's *server* does with a submitted
// replay. That code isn't public. It also can't run the physics, so a replay
// can pass every check here and still fail mid-playback.
//
// Each check returns { id, level, title, detail }:
//   "fail" — the main menu skips this replay (or it can't be packed at all)
//   "warn" — it plays, but bonk.io quietly changes something, or it's unusual
//   "ok"   — passes

const MAX_NAME = 25;          // longer usernames → menu skips the replay
const MAX_PLAYERS = 8;        // more discs than this → skipped
const PPM_MIN = 5, PPM_MAX = 30;
const MAX_TEXT = 29;          // mn/ma/rxn/rxa must be shorter than 30
const MAX_LAYERS = 16;        // more skin layers → skin is thrown away
const MAX_INPUTS = 65535;     // input count is a uint16
const RECORD_STEPS = 15 * 30; // the Record button never makes longer replays

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function checkReplay(replay) {
    const out = [];
    const add = (id, level, title, detail = "") => out.push({ id, level, title, detail });

    if (!isObj(replay)) {
        add("shape", "fail", "Replay must be an object");
        return out;
    }
    const ss = replay.startingState;
    const players = replay.playerArray;

    // ── Parts the menu needs or it throws (and skips the replay) ──
    const missing = [];
    if (!isObj(ss)) missing.push("startingState");
    if (!Array.isArray(players)) missing.push("playerArray");
    if (typeof replay.inputs !== "string") missing.push("inputs (packed base64 string)");
    if (!Array.isArray(replay.adminInputs)) missing.push("adminInputs (array, can be empty)");
    if (!isObj(replay.gameSettings)) missing.push("gameSettings");
    if (isObj(ss)) {
        if (!isObj(ss.physics)) missing.push("startingState.physics");
        if (!Array.isArray(ss.discs)) missing.push("startingState.discs");
        if (!Array.isArray(ss.players)) missing.push("startingState.players");
    }
    if (missing.length) add("parts", "fail", "Missing parts the game needs", `No ${missing.join(", ")}. The menu errors on load and skips the replay.`);
    else add("parts", "ok", "Has every part the game needs");

    // ── Map scale ──
    const ppm = ss?.physics?.ppm;
    if (typeof ppm === "number" && ppm >= PPM_MIN && ppm <= PPM_MAX) add("ppm", "ok", `Map scale ppm = ${ppm} (allowed ${PPM_MIN}–${PPM_MAX})`);
    else add("ppm", "fail", "Map scale out of range", `startingState.physics.ppm is ${JSON.stringify(ppm)}. The menu only plays replays with ppm from ${PPM_MIN} to ${PPM_MAX}.`);

    // ── Player names ──
    if (Array.isArray(players)) {
        const bad = [];
        players.forEach((p, i) => {
            if (!p) return;
            if (typeof p.userName !== "string") bad.push(`slot ${i} has no userName`);
            else if (p.userName.length > MAX_NAME) bad.push(`slot ${i} name is ${p.userName.length} characters`);
        });
        if (bad.length) add("names", "fail", "Player name problem", `${bad.join("; ")}. Names must be text of at most ${MAX_NAME} characters, or the menu skips the replay.`);
        else add("names", "ok", `Player names are ${MAX_NAME} characters or fewer`);
    }

    // ── Player count ──
    if (Array.isArray(ss?.discs)) {
        const n = ss.discs.filter(Boolean).length;
        if (n > MAX_PLAYERS) add("count", "fail", "Too many players", `${n} discs in startingState. The menu skips replays with more than ${MAX_PLAYERS}.`);
        else add("count", "ok", `${n} player${n === 1 ? "" : "s"} (max ${MAX_PLAYERS})`);

        if (Array.isArray(players)) {
            const orphans = ss.discs.map((d, i) => (d && !players[i] ? i : null)).filter((i) => i !== null);
            if (orphans.length) add("slots", "warn", "Discs with no player", `Slot${orphans.length > 1 ? "s" : ""} ${orphans.join(", ")} have a disc but no playerArray entry. The renderer needs one per disc (bonk uses { userName: "unknown" } for players who left).`);
            else add("slots", "ok", "Every disc has a matching player");
        }
    }

    // ── Inputs ──
    if (typeof replay.inputs === "string") {
        const buf = Buffer.from(replay.inputs, "base64");
        const count = buf.length >= 2 ? buf.readUInt16BE(0) : -1;
        if (count < 0 || buf.length !== 2 + count * 7) {
            add("inputs", "fail", "Inputs aren't packed correctly", `Expected 2 + 7 × count bytes; got ${buf.length} bytes for count ${count}. bonk reads past the end and the replay breaks.`);
        } else {
            const slots = new Set();
            let maxStep = 0;
            for (let i = 0, p = 2; i < count; i++, p += 7) {
                slots.add(buf.readUInt16BE(p));
                maxStep = Math.max(maxStep, buf.readUInt32BE(p + 2));
            }
            add("inputs", "ok", `${count} key changes, packed correctly`);
            const ghost = [...slots].filter((s) => !Array.isArray(players) || !players[s]);
            if (ghost.length) add("ghosts", "warn", "Inputs for empty slots", `Slot${ghost.length > 1 ? "s" : ""} ${ghost.join(", ")} have key presses but no player. They do nothing.`);
            if (typeof replay.es === "number" && maxStep > replay.es) add("late", "warn", "Key presses after the end", `Last key change is at step ${maxStep}, after es = ${replay.es}. Those never happen.`);
        }
    }

    // ── Length ──
    const es = replay.es;
    if (!(Number.isInteger(es) && es > 0)) add("es", "warn", "No valid length (es)", "Without es the menu plays until the round ends on its own, which may be never.");
    else if (es > RECORD_STEPS) add("es", "warn", `Longer than a recorded replay (${(es / 30).toFixed(1)}s)`, `The Record button never makes more than ${RECORD_STEPS} steps (15s). The menu will play it, but nobody knows if the server accepts longer ones.`);
    else add("es", "ok", `Length ${es} steps (${(es / 30).toFixed(1)}s)`);

    // ── Text fields bonk replaces instead of rejecting ──
    const textFix = [];
    for (const [k, fallback] of [["mn", "Unknown"], ["ma", "Unknown"], ["rxn", "(blank)"], ["rxa", "(blank)"]]) {
        const v = replay[k];
        if (v === undefined && (k === "rxn" || k === "rxa")) continue;
        if (typeof v !== "string" || v.length > MAX_TEXT) textFix.push(`${k} → ${fallback}`);
    }
    if (textFix.length) add("text", "warn", "Map credit text gets replaced", `${textFix.join(", ")}. These must be text under 30 characters.`);
    else add("text", "ok", "Map name and author are valid");

    // ── Skins bonk repairs instead of rejecting ──
    if (Array.isArray(players)) {
        const notes = [];
        players.forEach((p, i) => {
            if (!p) return;
            const name = typeof p.userName === "string" ? p.userName : `slot ${i}`;
            const av = p.avatar;
            if (!av || !Array.isArray(av.layers)) return;
            if (av.layers.length > MAX_LAYERS) { notes.push(`${name}: ${av.layers.length} layers (max ${MAX_LAYERS}), so all layers are dropped`); return; }
            const fixes = skinFixes(av);
            if (fixes.length) notes.push(`${name}: ${fixes.join(", ")}`);
        });
        if (notes.length) add("skins", "warn", "Some skins get changed", notes.join("; ") + ".");
        else add("skins", "ok", "Skins are within bonk's limits");
    }

    return out;
}

// Mirrors Skin.makeSafe(): out-of-range values are reset, not rejected.
function skinFixes(av) {
    const fixes = new Set();
    if (!(av.bc >= 0 && av.bc <= 16777215)) fixes.add("base color reset");
    for (const l of av.layers) {
        if (!l) continue;
        if (!(l.id >= 1 && l.id <= 115)) fixes.add("shape id outside 1–115");
        if (!(l.x >= -99999 && l.x <= 99999) || !(l.y >= -99999 && l.y <= 99999)) fixes.add("position reset");
        if (!(l.scale >= -10 && l.scale <= 10)) fixes.add("scale outside ±10");
        if (!(l.angle >= -9999 && l.angle <= 9999)) fixes.add("angle reset");
        if (!(l.color >= 0 && l.color <= 16777215)) fixes.add("layer color reset");
    }
    return [...fixes];
}

/** Summary for the UI: "fail" if any check fails, else "warn" if any warns, else "ok". */
export function verdict(checks) {
    if (checks.some((c) => c.level === "fail")) return "fail";
    if (checks.some((c) => c.level === "warn")) return "warn";
    return "ok";
}

export const LIMITS = { MAX_NAME, MAX_PLAYERS, PPM_MIN, PPM_MAX, MAX_TEXT, MAX_LAYERS, MAX_INPUTS, RECORD_STEPS };
