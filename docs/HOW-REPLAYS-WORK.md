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
2. **Who was there** — names, levels, teams, skins.
3. **Every key change** — "player 0 pressed left at step 45", "player 0 let go
   of left at step 77", and so on.

bonk.io's physics is **deterministic**: same start + same keys at the same
steps = the exact same game, every time. So to watch a replay, bonk.io (or our
ReplayRenderer) loads the starting state and re-runs the physics, feeding in
the recorded keys. That's why a whole round fits in a few KB.

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

## 7. Where the code lives

| File | What it does |
|------|--------------|
| `src/codec.js` | The whole format: `flipCase`, decode, encode, inputs pack/unpack, gzip for storage. Start here. |
| `src/server.js` | Web tool backend: `POST /api/decode`, `POST /api/encode`, `GET /api/latest`, `GET /api/fetch`. |
| `public/index.html` | Web tool page: Decode, Encode, and How replays work tabs. |
| `src/api.js` | Talks to the bonk.io replay API. |
| `src/scraper.js`, `src/db.js` | The 24/7 scraper and its Postgres storage. |
| `test/` | Round-trip tests on a real replay. Run `npm test`. |

## 8. Gotchas

- **101, not 100.** The flip covers indexes 0–100 inclusive. Old code wrote
  this as `i <= 100`, which is easy to misread.
- **Dictionary order.** See step 1. Never "clean up" the duplicate entries.
- **Null slots.** `playerArray` has `null` gaps. Ids in `inputs` refer to
  slots, gaps included.
- **Hostile names.** Player and map names come straight from players. Some are
  script-injection attempts. Always escape them before putting them in HTML.
- **Bad input fails at a specific step.** `traceDecode`/`traceEncode` throw
  errors with a `stage` field (`lz`, `base64`, `pson`, or `input`), and the web
  tool highlights that stage in red. A cut-off paste usually fails at `lz`.
