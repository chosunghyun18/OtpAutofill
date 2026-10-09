/**
 * 서비스명 ↔ 도메인 매핑 — 순수 함수 (피싱 "경고"용, 차단하지 않는다).
 *
 * 국내 문자는 대부분 `[Web발신] [네이버] 인증번호 [123456]` 형식이라 WebOTP origin이 없다.
 * 문자 속 서비스명을 알려진 도메인과 맞춰 보고, 현재 사이트가 다르면 칩에 경고를 띄운다.
 * SSO·제휴 로그인처럼 정상인데 도메인이 다른 경우가 있어 차단은 하지 않는다 (Design Spec 7절).
 */

export interface ServiceHint {
  /** 문자에 적힌 서비스 표시명 (예: "네이버") */
  name: string;
  /** 이 서비스가 인증번호를 입력받는 도메인들 (하위 도메인 포함) */
  domains: string[];
}

interface ServiceEntry {
  aliases: string[];
  domains: string[];
}

// 별칭은 비교 전에 소문자·공백 제거로 정규화하고, 라벨과 정확히 같을 때만 매칭한다
// ([카카오뱅크]·[네이버페이]처럼 다른 도메인을 쓰는 계열사가 접두 일치로 걸리지 않게).
// 본인인증 문자(통신사 SKT·KT·LGU+, PASS, NICE, KCB, 카드사·PG)는 넣지 않는다 —
// 제3자 사이트의 iframe·팝업에서 입력하는 것이 정상 흐름이라 넣으면 매번 경고가 뜬다.
const SERVICES: ServiceEntry[] = [
  { aliases: ["네이버", "naver"], domains: ["naver.com"] },
  { aliases: ["카카오", "카카오톡", "kakao", "kakaotalk", "다음", "daum"], domains: ["kakao.com", "daum.net"] },
  { aliases: ["구글", "google"], domains: ["google.com", "google.co.kr"] },
  { aliases: ["쿠팡", "coupang"], domains: ["coupang.com"] },
  { aliases: ["토스", "toss"], domains: ["toss.im", "tossbank.com"] },
  { aliases: ["당근", "당근마켓", "daangn"], domains: ["daangn.com"] },
  { aliases: ["배달의민족", "배민", "baemin"], domains: ["baemin.com"] },
  { aliases: ["애플", "apple"], domains: ["apple.com", "icloud.com"] },
  { aliases: ["마이크로소프트", "microsoft"], domains: ["microsoft.com", "live.com", "microsoftonline.com"] },
];

/** 서비스명이 아닌 대괄호 라벨 */
const NON_SERVICE_LABELS = new Set(["web발신", "국외발신", "국제발신", "광고", "인증번호", "알림"]);

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");

const byAlias = new Map<string, ServiceEntry>();
for (const e of SERVICES) for (const a of e.aliases) byAlias.set(normalize(a), e);

// 영문 브랜드는 대괄호 없이도 쓰이지만 ("G-123456 is your Google verification code"),
// "Apple Pay"·"Google Play" 같은 일반 언급과 구분하려고 "<브랜드> verification code" 형태에서만 인정한다
const ENGLISH_ALIAS = new RegExp(
  `\\b(${SERVICES.flatMap((e) => e.aliases.filter((a) => /^[a-z]+$/.test(a))).join("|")})\\s+` +
    `(?:account\\s+)?(?:verification|security|login|sign[- ]?in)\\s+code\\b`,
  "i",
);

/** 문자에서 서비스를 찾는다. 대괄호 라벨 우선, 없으면 영문 템플릿. 모르면 null */
export function detectService(text: string): ServiceHint | null {
  for (const m of text.matchAll(/[[【]([^\]】\n]{1,20})[\]】]/g)) {
    const label = m[1]!.trim();
    const key = normalize(label);
    if (NON_SERVICE_LABELS.has(key) || /^\d+$/.test(key)) continue;
    const e = byAlias.get(key);
    if (e) return { name: label, domains: e.domains };
  }
  const en = ENGLISH_ALIAS.exec(text);
  if (en) {
    const e = byAlias.get(normalize(en[1]!))!;
    return { name: en[1]!, domains: e.domains };
  }
  return null;
}
