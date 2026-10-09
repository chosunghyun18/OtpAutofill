# relay

폰과 브라우저를 페어링하고 **암호문 봉투만** 중계하는 HTTP 서버. 메모리 전용 — 재시작하면 모든 페어링이 사라진다(설계 의도: 저장할 게 없으면 유출될 것도 없다).

```bash
npm run relay            # 루트에서. PORT=8787 기본
curl localhost:8787/healthz
```

## API

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| POST | `/v1/pairings` | — | 브라우저: `{commitment}`(공개키 해시) → `{pairingCode, channelId, browserToken, expiresAt}` |
| POST | `/v1/pairings/:code/join` | — | 폰: `{publicKey}` → `{channelId, phoneToken, commitment}` (코드당 1회) |
| GET | `/v1/pairings/:code` | browserToken | 브라우저: `{status: waiting\|joined, peerPublicKey?}` |
| POST | `/v1/pairings/:code/reveal` | browserToken | 브라우저: 폰 키를 받은 뒤 `{publicKey}` 공개 → 204. 커밋과 다르면 400 |
| GET | `/v1/pairings/:code/reveal` | phoneToken | 폰: `{status: waiting\|revealed, peerPublicKey?}`. 응답 유실 대비 TTL까지 재조회 가능 |
| POST | `/v1/channels/:id/messages` | phoneToken | 폰: `Envelope{v,iv,ct}` 전송 (≤4KB) |
| GET | `/v1/channels/:id/messages?waitMs=25000` | browserToken | 브라우저: long-poll 수신, 가져가면 삭제 |
| DELETE | `/v1/channels/:id` | 둘 중 하나 | 페어링 해제 |

커밋-공개 순서인 이유: 안전번호가 32비트라, 릴레이가 브라우저 공개키를 먼저 알면 양쪽 안전번호가 같아지는
가짜 키 조합을 몇 초 만에 찾을 수 있다. 공개키를 늦게 공개하면 릴레이는 가짜 키를 먼저 정해야 해서 성공 확률이 2^-32로 떨어진다.

## 한도 (`src/store.ts` `DEFAULT_CONFIG`, `src/ratelimit.ts`)

- 페어링 코드 TTL 5분, 메시지 TTL 2분, 채널 유휴 30일, 채널당 대기 메시지 20개, 동시 페어링 10만 개(초과 503)
- 페어링 생성·join: 각각 IP당 분당 10회 (IPv6는 /56 단위, 초과 429 + `retry-after`). 추적 키 10만 개를 넘으면 가장 오래된 키를 버린다
- 리버스 프록시 뒤면 `TRUST_PROXY=<프록시 수>` — `X-Forwarded-For` 오른쪽에서 그 번째 값을 IP로 쓴다. 기본 0(소켓 주소만)
- 토큰은 SHA-256 해시로만 보관, `timingSafeEqual` 비교

## TODO
- 배포 시 HTTPS 필수 (리버스 프록시)
