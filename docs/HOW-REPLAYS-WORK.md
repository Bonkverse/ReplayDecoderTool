# How bonk.io replays work

A guide for anyone new to the replay side of Bonkverse: what a replay is, what's
inside one, how bonk.io packs it into a string, and how this repo decodes and
re-encodes it. You don't need to know any of this to *use* the web tool, but
you'll want it before changing `src/codec.js`.

Try it as you read: run `npm run decoder`, open http://localhost:3000, decode a
replay, then press **Encode it back** and open **Show the data after every step**.

---

## 1. A replay is a recipe, not a video

A replay doesn't store any pictures. It stores:

1. **Where everything started** — the map, every player's position and speed,
   the scores, and the random seed.
   (A replay is a clip of **at most 15 seconds**, not a whole round. See
   [section 7](#7-the-replay-endpoints).)
2. **Who was there** — names, levels, teams, skins.
3. **Every key change** — "player 0 pressed left at step 45", "player 0 let go
   of left at step 77", and so on.

bonk.io's physics is **deterministic**: same start + same keys at the same
steps = the exact same game, every time. So to watch a replay, bonk.io (or our
ReplayRenderer) loads the starting state and re-runs the physics, feeding in
the recorded keys. That's why a replay fits in a few KB.

The physics runs at **30 steps per second**. "Step" and "frame" mean the same
thing here: one tick of that clock. A replay with `es: 450` lasts 15 seconds.

## 2. What's inside a decoded replay

Top-level keys of a real replay (from `test/fixtures/sample-replay.pson.gz`):

| Key | What it is |
|-----|------------|
| `playerArray` | One entry per player **slot**. Empty slots are `null`. Each has `userName`, `guest`, `team`, `level`, `ready`, `tabbed`, and `avatar` (the skin: `{ layers, bc }`). |
| `startingState` | The world at step 0. See below. |
| `inputs` | The gameplay, packed into a base64 string. See [section 5](#5-the-inputs-inside-the-replay). |
| `adminInputs` | Host actions during the round. Usually `[]`. |
| `gameSettings` | Room settings: `mo` mode (`b` classic, `ar` arrows, `ard` death arrows, `sp` grapple, `v` VTOL, `f` football), `tea` teams on/off, `wl` win limit, `q` quick play, `bal` per-slot balance. |
| `es` | End step. Length in seconds = `es / 30`. |
| `mn`, `ma`, `mid` | Map name, author, and id (repeated from `startingState.mm` for convenience). |

Inside `startingState`, the parts you'll use most:

- `mm` — map info: `n` name, `a` author, `dbid` map id, `date`, and `rxn`/`rxa`/`rxid` if it's a remix.
- `physics` — the map itself: bodies, shapes, fixtures, joints. This is the
  same format as a bonk.io map.
- `discs` — each player's ball: position `x`/`y`, velocity `xv`/`yv`, angle, team, and more.
- `scores` — one per team in team modes, one per slot otherwise.
- `seed` — the random seed, so random things (like spawns) replay the same.
- `rc` — round count.

> **Slots matter.** Player ids in `inputs` and indexes in `scores`/`discs`
> are slot numbers, i.e. positions in `playerArray`, including the `null`
> gaps. Don't filter out the nulls before matching things up.

## 3. How bonk.io packs a replay into a string

The bonk.io replay API (`bonk2.io/scripts/replay_get.php`) hands out each replay
as one long string called `replaydata`. bonk.io builds it in four steps:

```
replay object
   │ 1. PSON         compact binary JSON
   ▼
bytes
   │ 2. base64       bytes → text
   ▼
base64 text
   │ 3. LZString     compress → URL-safe text
   ▼
compressed text
   │ 4. case flip    swap upper/lower case on the first 101 characters
   ▼
replaydata
```

Sizes for the sample replay, at each point:

| After | Size |
|-------|------|
| replaydata (what the API sends) | 11,881 chars |
| LZString-decompressed (base64) | 15,216 chars |
| base64-decoded (PSON bytes) | 11,411 bytes |
| gzip of the PSON bytes (what we store) | 3,384 bytes |

### Step 1 — PSON

[PSON](https://github.com/dcodeIO/PSON) is JSON written as bytes instead of
text. Numbers become compact binary, and repeated strings get shortened.

The big trick is the **static dictionary** (`pairs` in `src/codec.js`). It's a
fixed list of common words (`"physics"`, `"shapes"`, `"Box Shape"`…). Any
string in the list is written as a 1-byte index instead of the full word.
Most of the words are map words, because the whole map rides along inside
`startingState.physics`.

> **The dictionary must match bonk.io's exactly** — same words, same order,
> including the two duplicated entries (`"fr"` and `"d"` appear twice). If the
> list is off by even one, every index after that point reads as the wrong
> word and you get garbage or a crash.

### Step 2 — base64

Raw bytes can't safely travel inside a web request, so they're turned into
plain characters (`A–Z a–z 0–9 + /`). This makes the data about 33% bigger.

### Step 3 — LZString

[lz-string](https://github.com/pieroxy/lz-string) compresses text by spotting
repeated chunks and replacing them with short references.
`compressToEncodedURIComponent` writes the result using only URL-safe
characters, so it can go in a form body without escaping.

### Step 4 — case flip

bonk.io swaps upper and lower case on the first **101** characters (indexes
0 to 100). That's all. It isn't encryption, just a speed bump: the string
won't decompress until you flip it back. Digits and symbols are left as they
are. Flipping twice gives back the original, so the same function
(`flipCase`) is used in both directions.

## 4. Decoding and encoding

This is the same code as bonk.io's own `Map.toDatabase()` (encode) and
`Map.fromDatabase()` (decode): the same four steps, the same word list, and the
same `i <= 100` flip loop.

Every step above can be undone exactly, so:

- **Decoding** = steps 4 → 1 in reverse: flip case, LZString-decompress,
  base64-decode, PSON-decode. (`decodeReplayData` / `traceDecode`)
- **Encoding** = steps 1 → 4 forwards: PSON-encode, base64-encode,
  LZString-compress, flip case. (`encodeReplayData` / `traceEncode`)

Because nothing is lost, **`encode(decode(s)) === s`**, character for
character. The tests check this on a real replay, including a trip through
JSON text (which is what the web tool does when you copy the JSON around).
JSON keeps every number exactly, and PSON keeps keys in their original order,
so the bytes come out identical.

What you can do with encoding:

- **Learn**: watch the same data go both ways in the web tool.
- **Edit a replay**: decode, change the JSON (rename a player, change the map
  name), encode. The result decodes fine. Whether bonk.io will *play* an
  edited replay depends on what you changed — touching `startingState` or
  `inputs` changes the game.
- **Rebuild the original string from storage**: the scraper stores PSON bytes,
  not the string. `gunzip` → PSON-decode → `encodeReplayData` gives back the
  exact `replaydata` bonk.io sent.

## 5. The inputs inside the replay

After decoding, `inputs` is *still* a base64 string. bonk.io packs it
separately (its code calls this `halfSerialize`). Unpacked, it's:

```
uint16   count                      (big-endian)
count × {
  uint16  player   slot in playerArray
  uint32  step     physics step (30 per second)
  uint8   keys     bit flags, see below
}
```

So each record is 7 bytes. The keys byte has one bit per key:

| Key | Bit | Value |
|-----|-----|-------|
| left | 0 | 1 |
| right | 1 | 2 |
| up | 2 | 4 |
| down | 3 | 8 |
| heavy (`action`) | 4 | 16 |
| special (`action2`) | 5 | 32 |

Add them up: `5` = left + up, `18` = right + heavy, `0` = everything released.

**Only changes are recorded.** A key stays held until that player's next
record. To know what a player is holding at step 300, find their last record
at or before step 300. (ReplayRenderer's `core/inputs.js` does this fast.)

In this repo: `unpackInputs`, `packInputs`, and `describeKeys` in
`src/codec.js`. The Decode tab shows the first 40 key changes in the
**Inputs** table.

## 6. How Bonkverse stores replays

The scraper (`src/scraper.js`) decodes each replay down to the PSON bytes,
gzips them, and stores them in `replays.replaydata` (`BYTEA`). That's 40–70%
smaller than the original string, and since every step is reversible, nothing
is lost.

Replay ids are not unique forever: when bonk.io wipes replays, ids start over
in a new **cycle**. The real key is `(cycle, id)`. See `config.js`.

## 7. The replay endpoints

bonk.io has three replay endpoints. All three are plain `POST` requests to
`https://bonk2.io/scripts/…` with a form-encoded body
(`application/x-www-form-urlencoded`), the same as a normal HTML form.
Everything below comes from reading bonk.io's own client code (the build in
ReplayRenderer's `vendor/bonk-core.mjs`), so it's what the game actually sends.

Here's how a replay moves through them:

```
in a game                         bonk.io server                  main menu
──────────                        ──────────────                  ─────────
someone presses Record
  → host's game packs the
    last ≤15 s into replaydata
  → replay_submit.php  ────────►  stores it, gives it an id
                                  replay_get.php  ◄──────────────  menu asks for replays
                                  (newest first)  ──────────────►  plays them in the background
                                  replay_report.php ◄────────────  someone presses Report
```

### `replay_submit.php` — save a replay

**Body**

| Field | Type | What it is |
|-------|------|------------|
| `version` | number | Game/API version (`game.version`; 49 as of July 2026). |
| `replaydata` | string | The encoded replay. Exactly what `encodeReplayData` makes. |
| `mapid` | number | The map's database id (`gameSettings.map.m.dbid`). |
| `mode` | string | Mode short code (`gameSettings.mo`, e.g. `ar`). Sent by the Record button. |

The game doesn't read the response. It sends the replay and moves on.

**When it's sent.** Not automatically at the end of every round. It goes like this:

1. Any player in the room clicks the replay (record) button at the top of the
   game screen.
2. Their game sends a "record" message (socket packet 33) to the room server,
   which passes it to everyone in the room.
3. Every game checks the rules below, but **only the host's game actually
   calls `replay_submit.php`**. Everyone else just sees the chat message.

The rules (with the chat message each one shows the player who asked):

| Rule | Message |
|------|---------|
| Not in Football (the game engine `gameSettings.ga` must be `b`) | `* No replays in Football mode` |
| At least 15 s since the last replay in this room | `* Please wait at least 15 seconds since the last replay` |
| At least 5 s of play to record | `* Replay must be at least 5 seconds long` |
| On success | `* The last 15 seconds have been recorded to the main menu` |

**What gets recorded.** The game walks back from the current step until it
finds the start of the round or hits 15 seconds (450 steps), whichever comes
first. That step becomes `startingState`. It then fills in:

- `inputs` — each player's key state at that start step, plus every change
  after it, with steps shifted so the replay starts at 0.
- `playerArray` — the players in those slots. A player who already left
  becomes `{ userName: "unknown" }` with an empty skin.
- `adminInputs`, `gameSettings` (with the map removed, because it's already
  inside `startingState.physics`), `mn`, `ma`, `es` (the length in steps), and
  `mid` (only for maps saved in bonk's current map format, `dbv == 2`).

So every replay is **15 seconds at most**, and usually exactly 450 steps.

> There's also an older "send the replay automatically at the end of each
> round" path in the code (it records up to 59 s), but the switch that turns
> it on is never set in the current game, so it never runs.

### `replay_get.php` — list replays

This is what fills the main menu's background replays, and what our scraper
calls (`src/api.js`).

**Body**

| Field | Type | What it is |
|-------|------|------------|
| `version` | number | Game/API version, same as above. |
| `offset` | number | How many replays to skip. Start at `0`; after each reply, add the number of replays you got back. |
| `startingFrom` | number | *Optional.* A replay id to count from. See below. |
| `mode` | string | *Optional.* Only replays of this mode. The menu sends it only when the player has turned the mode filter on. |

**Response** (JSON)

| Field | Type | What it is |
|-------|------|------------|
| `r` | string | `"success"`, or `"fail"` (we see `"fail"` when rate-limited). |
| `replays` | array | Newest first. Each item has `id` (number), `replaydata` (string), and `mapid`. An empty array means there are no more. |

**How paging works.** New replays arrive all the time, so "skip the first 20"
would shift under you. The game avoids that like this:

1. First call: `offset=0`, no `startingFrom`. Newest replays come back.
2. It remembers the **first** replay's id as `startingFrom`.
3. Every later call sends that same `startingFrom` with a bigger `offset`.
   Counting from a fixed id means new replays don't push things around.
4. If you leave the menu for more than 2 minutes, it forgets `startingFrom`
   and starts over from the newest.

The page size isn't fixed by the client. Always use `replays.length`.

**What the menu throws away.** After decoding, the game silently skips any
replay that looks broken or hostile: map scale (`physics.ppm`) outside 5–30,
a username longer than 25 characters, or more than 8 players. While playing
one, it also skips it if the screen shake gets huge (over 500). Worth doing
the same checks anywhere we display replays.

### `replay_report.php` — report a replay

The flag button on the menu's background replay.

**Body**

| Field | Type | What it is |
|-------|------|------------|
| `replayid` | number | The `id` from `replay_get.php`. |

The game doesn't read the response either. It removes the replay from the
player's own list right away and plays the next one. What the server does with
reports (hide after N reports? moderation queue?) isn't visible from the client.

## 8. Where the code lives

| File | What it does |
|------|--------------|
| `src/codec.js` | The whole format: `flipCase`, decode, encode, inputs pack/unpack, gzip for storage. Start here. |
| `src/server.js` | Web tool backend: `POST /api/decode`, `POST /api/encode`, `GET /api/latest`, `GET /api/fetch`. |
| `public/index.html` | Web tool page: Decode, Encode, and How replays work tabs. |
| `src/api.js` | Talks to the bonk.io replay API. |
| `src/scraper.js`, `src/db.js` | The 24/7 scraper and its Postgres storage. |
| `test/` | Round-trip tests on a real replay. Run `npm test`. |

## 9. Gotchas

- **101, not 100.** The flip covers indexes 0–100 inclusive. Old code wrote
  this as `i <= 100`, which is easy to misread.
- **Dictionary order.** See step 1. Never "clean up" the duplicate entries.
- **Null slots.** `playerArray` has `null` gaps. Ids in `inputs` refer to
  slots, gaps included.
- **Hostile names.** Player and map names come straight from players. Some are
  script-injection attempts. Always escape them before putting them in HTML.
- **Replays are short.** The Record button saves 15 seconds at most, so
  expect `es` of 450 or less.
- **Bad input fails at a specific step.** `traceDecode`/`traceEncode` throw
  errors with a `stage` field (`lz`, `base64`, `pson`, or `input`), and the web
  tool highlights that stage in red. A cut-off paste usually fails at `lz`.
