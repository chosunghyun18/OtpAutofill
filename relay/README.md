# relay

폰과 브라우저를 페어링하고 **암호문 봉투만** 중계하는 HTTP 서버. 메모리 전용 — 재시작하면 모든 페어링이 사라진다(설계 의도: 저장할 게 없으면 유출될 것도 없다).

```bash
npm run relay            # 루트에서. PORT=8787 기본
curl localhost:8787/healthz
```

## API

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| POST | `/v1/pairings` | — | 브라우저: `{publicKey}` → `{pairingCode, channelId, browserToken, expiresAt}` |
| POST | `/v1/pairings/:code/join` | — | 폰: `{publicKey}` → `{channelId, phoneToken, peerPublicKey}` (코드당 1회) |
| GET | `/v1/pairings/:code` | browserToken | 브라우저: 폰 합류 여부·공개키. 수신 후 코드 삭제 |
| POST | `/v1/channels/:id/messages` | phoneToken | 폰: `Envelope{v,iv,ct}` 전송 (≤4KB) |
| GET | `/v1/channels/:id/messages?waitMs=25000` | browserToken | 브라우저: long-poll 수신, 가져가면 삭제 |
| DELETE | `/v1/channels/:id` | 둘 중 하나 | 페어링 해제 |

## 한도 (`src/store.ts` `DEFAULT_CONFIG`)

- 페어링 코드 TTL 5분, 메시지 TTL 2분, 채널 유휴 30일, 채널당 대기 메시지 20개
- 토큰은 SHA-256 해시로만 보관, `timingSafeEqual` 비교

## TODO
- 페어링 join IP별 레이트 리밋 (8자리 코드 브루트포스 방어 — 31^8 ≈ 8.5e11이라 TTL 5분 내 현실적 위험은 낮지만 필요)
- 배포 시 HTTPS 필수 (리버스 프록시)
