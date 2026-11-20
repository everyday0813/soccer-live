#!/usr/bin/env bash
# End-to-end smoke test: starts the real server on :18117 against the live ESPN
# API, exercises the public + admin API with curl, drives the UI in headless
# Chrome, then stops the server and removes all temporary data.
set -uo pipefail

cd "$(dirname "$0")/.."
PORT=18117
BASE="http://localhost:${PORT}"
DATA=/tmp/soccer-smoke
SHOTS=${SHOTS_DIR:-/tmp/soccer-shots}
LOG=/tmp/soccer-smoke.log
JAR="${DATA}/cookies.txt"
FAILS=0
SERVER_PID=""

pass() { echo "  [PASS] $*"; }
fail() { echo "  [FAIL] $*"; FAILS=$((FAILS + 1)); }
expect() { # expect <name> <expected> <actual>
  if [ "$2" = "$3" ]; then pass "$1 ($3)"; else fail "$1 (expected $2, got $3)"; fi
}

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  rm -rf "$DATA" "$LOG"
}
trap cleanup EXIT

if curl -s -o /dev/null "$BASE/healthz"; then
  echo "Something is already listening on :$PORT — aborting." >&2
  exit 1
fi

rm -rf "$DATA"
mkdir -p "$DATA" "$SHOTS"

echo "== 0. npm install"
npm install --no-audit --no-fund --loglevel=error >/dev/null && echo "  dependencies installed"

echo "== 1. start server"
PORT=$PORT DATA_DIR=$DATA ADMIN_PASSWORD=smoke-pass-123 SESSION_SECRET=dev-secret IP_SALT=dev-salt \
  node server.js >"$LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  curl -s -o /dev/null "$BASE/healthz" && break
  sleep 0.25
done
echo "  pid $SERVER_PID, log: $(head -1 "$LOG")"

echo "== 2a. GET /healthz"
echo "  $(curl -s "$BASE/healthz")"

echo "== 2b. GET /api/matches"
t_cold=$(curl -s -o "$DATA/matches.json" -w '%{time_total}' "$BASE/api/matches")
t_warm=$(curl -s -o "$DATA/matches.json" -w '%{time_total}' "$BASE/api/matches")
SUMMARY=$(python3 -I -c "import sys,json;d=json.load(sys.stdin);print(len(d['matches']),d['matches'][0]['league']['name'],d['matches'][0]['home']['logo'])" <"$DATA/matches.json")
echo "  $SUMMARY"
echo "  first call ${t_cold}s, warm call ${t_warm}s"
python3 -I - "$DATA/matches.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
m = d['matches']
states = {s: sum(1 for x in m if x['state'] == s) for s in ('in', 'pre', 'post')}
leagues = sorted({x['league']['name'] for x in m})
print(f"  states: live={states['in']} upcoming={states['pre']} finished={states['post']}  leagues={len(leagues)}")
PY
count=${SUMMARY%% *}
logo=$(echo "$SUMMARY" | awk '{print $NF}')
[ "${count:-0}" -ge 5 ] && pass "match count >= 5 ($count)" || fail "match count >= 5 ($count)"
[[ "$logo" == https://* ]] && pass "real logo URL" || fail "logo URL ($logo)"
python3 -I -c "import sys; sys.exit(0 if float('$t_warm') < 0.7 else 1)" && pass "warm /api/matches < 700 ms (${t_warm}s)" || fail "warm response ${t_warm}s"

MATCH_ID=$(python3 -I -c "
import json,sys
m=json.load(open('$DATA/matches.json'))['matches']
pick=[x for x in m if x['state']=='in'] or [x for x in m if x['state']=='pre'] or m
print(pick[0]['id'], pick[0]['state'], pick[0]['home']['name'], 'vs', pick[0]['away']['name'])")
read -r ID STATE REST <<<"$MATCH_ID"
echo "  selected match: $ID ($STATE) $REST"

echo "== 2c. pages"
for path in "/" "/match/$ID" "/admin"; do
  code=$(curl -s -o "$DATA/page.html" -w '%{http_code}' "$BASE$path")
  title=$(python3 -I -c "import re,sys;t=re.search(r'<title>(.*?)</title>',open(sys.argv[1],encoding='utf-8').read());print(t.group(1) if t else '')" "$DATA/page.html")
  khmer=$(python3 -I -c "import re,sys;print('yes' if re.search('[ក-៿]',sys.argv[1]) else 'no')" "$title")
  echo "  GET $path -> $code, title: $title"
  expect "GET $path status" 200 "$code"
  expect "GET $path Khmer title" yes "$khmer"
done

echo "== 2d. comments + rate limit"
rb=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"body":"   "}' "$BASE/api/match/$ID/comments")
expect "empty body rejected (does not consume the rate limit)" 400 "$rb"
ru=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"body":"hi"}' "$BASE/api/match/999999999/comments")
expect "unknown match rejected" 404 "$ru"
r1=$(curl -s -w ' HTTP %{http_code}' -H 'content-type: application/json' \
  -d '{"name":"<b>Dara</b>","body":"  សួស្តី! Great match <script>alert(1)</script>  "}' "$BASE/api/match/$ID/comments")
echo "  POST #1 -> $r1"
r2=$(curl -s -w ' HTTP %{http_code}' -H 'content-type: application/json' -d '{"body":"second one, too fast"}' "$BASE/api/match/$ID/comments")
echo "  POST #2 (immediate) -> $r2"
g=$(curl -s "$BASE/api/match/$ID/comments")
echo "  GET -> $g"
expect "first comment 201" 201 "${r1##* }"
expect "second comment 429" 429 "${r2##* }"
echo "$g" | grep -q '"count":1' && pass "comment read back (count 1)" || fail "comment read back"
sleep 10.5
rd=$(curl -s -H 'content-type: application/json' -d '{"body":"after cooldown"}' "$BASE/api/match/$ID/comments")
echo "$rd" | grep -q '"name":"អ្នកគាំទ្រ"' && pass "default name after 10 s cooldown: $rd" || fail "default name ($rd)"

echo "== 2e. admin"
w=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"password":"nope"}' "$BASE/api/admin/login")
expect "wrong password" 401 "$w"
u=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/state")
expect "state without session" 401 "$u"
ok=$(curl -s -c "$JAR" -D "$DATA/login.h" -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  -d '{"password":"smoke-pass-123"}' "$BASE/api/admin/login")
expect "right password" 200 "$ok"
echo "  $(grep -i '^set-cookie' "$DATA/login.h" | sed -E 's/sid=[^;]+/sid=<redacted>/' | tr -d '\r')"

STREAM_URL="https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
s=$(curl -s -b "$JAR" -H 'content-type: application/json' -d "{\"matchId\":\"$ID\",\"url\":\"$STREAM_URL\"}" "$BASE/api/admin/stream")
echo "  POST /api/admin/stream -> $s"
m=$(curl -s "$BASE/api/match/$ID" | python3 -I -c "import sys,json;d=json.load(sys.stdin);print(d['stream']['url'] if d['stream'] else None, d['stream']['kind'] if d['stream'] else None, d['match']['hasStream'])")
echo "  GET /api/match/$ID -> stream: $m"
expect "stream url round-trip" "$STREAM_URL hls True" "$m"

python3 -I - "$DATA/slot1.png" <<'PY'
import struct, sys, zlib
w, h = 970, 90
rows = b''.join(b'\x00' + b''.join(
    bytes((34, 197, 94) if (x // 40 + y // 30) % 2 else (11, 15, 20)) for x in range(w)) for y in range(h))
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + \
      chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b'')
open(sys.argv[1], 'wb').write(png)
PY
b=$(curl -s -b "$JAR" -F slot=1 --form-string linkUrl=https://example.com/sponsor -F "image=@$DATA/slot1.png;type=image/png" "$BASE/api/admin/banner")
echo "  POST /api/admin/banner (slot 1, $(stat -c %s "$DATA/slot1.png") bytes) -> $b"
st=$(curl -s -b "$JAR" "$BASE/api/admin/state" | python3 -I -c "
import sys,json;d=json.load(sys.stdin)
b=[x for x in d['banners'] if x['slot']==1]
print('banners:',json.dumps(b,ensure_ascii=False),'| streams:',len(d['streams']),'| admin matches (7 days):',len(d['matches']))")
echo "  GET /api/admin/state -> $st"
echo "$st" | grep -q '"slot": 1, "type": "image"' && pass "state shows slot-1 image banner" || fail "banner in state"
img=$(echo "$b" | python3 -I -c "import sys,json;print(json.load(sys.stdin)['banner']['imageUrl'])")
ic=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$BASE$img")
expect "uploaded image served" "200 image/png" "$ic"
bad=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -F slot=2 --form-string linkUrl=https://example.com -F "image=@server.js;type=image/png" "$BASE/api/admin/banner")
expect "non-image upload rejected" 400 "$bad"
hb=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H 'content-type: application/json' \
  -d '{"slot":2,"type":"html","html":"<div class=\"x\">owner ad code</div>"}' "$BASE/api/admin/banner")
expect "html banner saved (slot 2)" 200 "$hb"
hd=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X DELETE "$BASE/api/admin/banner/2")
expect "banner slot 2 deleted" 200 "$hd"
curl -s -o /dev/null -b "$JAR" -H 'content-type: application/json' -d '{"showAdPlaceholders":false}' "$BASE/api/admin/settings"
off=$(curl -s "$BASE/api/slots" | python3 -I -c "import sys,json;print(json.load(sys.stdin)['showAdPlaceholders'])")
curl -s -o /dev/null -b "$JAR" -H 'content-type: application/json' -d '{"showAdPlaceholders":true}' "$BASE/api/admin/settings"
on=$(curl -s "$BASE/api/slots" | python3 -I -c "import sys,json;print(json.load(sys.stdin)['showAdPlaceholders'])")
expect "placeholder toggle off/on" "False True" "$off $on"
curl -s -o /dev/null -b "$JAR" -X POST "$BASE/api/admin/logout"
lo=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/api/admin/state")
expect "session invalid after logout" 401 "$lo"

echo "== 3. headless browser"
ADMIN_PASSWORD=smoke-pass-123 node scripts/browser-check.mjs "$BASE" "$ID" "$SHOTS" || FAILS=$((FAILS + 1))

echo "== 4. stop server + clean up"
kill "$SERVER_PID" && wait "$SERVER_PID" 2>/dev/null
SERVER_PID=""
grep -E 'warn|error' -i "$LOG" | head -5 | sed 's/^/  server log: /'
rm -rf "$DATA" "$LOG"
if curl -s -o /dev/null "$BASE/healthz"; then fail "port $PORT still in use"; else pass "nothing listening on :$PORT"; fi
[ -e "$DATA" ] && fail "$DATA still exists" || pass "$DATA removed"

echo
if [ "$FAILS" -eq 0 ]; then echo "SMOKE: ALL CHECKS PASSED"; else echo "SMOKE: $FAILS FAILURE(S)"; fi
exit $((FAILS > 0))
