// Human-handoff request detection (English, Bangla, Banglish).
// Pure functions, no imports: this file is also inlined into n8n Code nodes
// by n8n/build.mjs, so keep it dependency-free.
//
// Result:
//   { kind: 'explicit' | 'possible' | 'none', rule, lang }
// 'explicit' → take over immediately (clear phrase rule matched).
// 'possible' → a person/admin word appears without a clear request; the reply
//              workflow's intent classifier decides. Never hand off on a bare
//              "bhai" or "admin".

export function normalizeForHandoff(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[‌‍]/g, '')          // zero-width joiners used in Bangla typing
    .replace(/[“”"'`’‘]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Words that name a person/team the customer might ask for.
const EN_PERSON = '(?:human|humans|person|real person|real human|live agent|agent|representative|rep|someone real|staff|admin|administrator|owner|manager|operator|support team|customer care|customer service)';
const BL_PERSON = '(?:admin|agent|human|manush|manus|manushs?h|staff|owner|malik|moderator|support|customer care|keu)';
const BN_PERSON = '(?:মানুষ|মানুষের|এজেন্ট|এজেন্টের|অ্যাডমিন|অ্যাডমিনের|এডমিন|এডমিনের|প্রতিনিধি|প্রতিনিধির|স্টাফ|কর্মী|কর্মীর|মালিক|মালিকের|কাস্টমার কেয়ার|সাপোর্ট টিম|কেউ)';

const EXPLICIT_RULES = [
  // English
  { lang: 'en', rule: 'en_talk_to_person', re: new RegExp(`\\b(?:talk|speak|chat)\\s+(?:to|with)\\s+(?:a\\s+|an\\s+|the\\s+|your\\s+)?${EN_PERSON}\\b`) },
  { lang: 'en', rule: 'en_connect_me', re: new RegExp(`\\b(?:connect|transfer|forward|pass)\\s+(?:me\\s+)?(?:to|with)\\s+(?:a\\s+|an\\s+|the\\s+|your\\s+)?${EN_PERSON}\\b`) },
  { lang: 'en', rule: 'en_want_person', re: new RegExp(`\\bi\\s+(?:want|need|would like|wanna|want to talk to|need to talk to)\\s+(?:to\\s+(?:talk|speak)\\s+(?:to|with)\\s+)?(?:a\\s+|an\\s+|the\\s+|your\\s+)?${EN_PERSON}\\b`) },
  { lang: 'en', rule: 'en_get_me_person', re: new RegExp(`\\b(?:get|give|send)\\s+me\\s+(?:a\\s+|an\\s+|the\\s+|your\\s+)?${EN_PERSON}\\b`) },
  { lang: 'en', rule: 'en_not_bot', re: /\b(?:not|no|stop|dont want|don't want|do not want)\s+(?:a\s+|the\s+|this\s+)?(?:bot|robot|ai|machine|chatbot)\b|\b(?:are you|r u) (?:a )?(?:bot|robot)\b.*\b(?:human|person)\b/ },
  { lang: 'en', rule: 'en_short_request', re: /^(?:human|agent|live agent|real person|representative|operator|customer care|customer service)(?:\s+(?:please|pls|plz|now|asap))?[.!?\s]*$/ },
  { lang: 'en', rule: 'en_short_request_polite', re: /^(?:please|pls|plz)\s+(?:human|agent|live agent|real person|representative|operator)[.!?\s]*$/ },

  // Bangla script
  { lang: 'bn', rule: 'bn_talk_with_person', re: new RegExp(`${BN_PERSON}[^।?!]{0,12}(?:সাথে|সঙ্গে|সাথেই)[^।?!]{0,12}কথা`) },
  { lang: 'bn', rule: 'bn_talk_want_person', re: new RegExp(`কথা\\s*(?:বলতে|বলব|বলবো|বলাতে|বলার)[^।?!]{0,20}${BN_PERSON}`) },
  { lang: 'bn', rule: 'bn_want_person', re: /(?:মানুষ|এজেন্ট|অ্যাডমিন|এডমিন|প্রতিনিধি|স্টাফ)\s*(?:চাই|দরকার|লাগবে|দিন|দেন|দাও)/ },
  { lang: 'bn', rule: 'bn_connect', re: new RegExp(`${BN_PERSON}[^।?!]{0,12}(?:সাথে|সঙ্গে)[^।?!]{0,8}(?:যোগাযোগ|কানেক্ট)\\s*(?:করিয়ে|করে)\\s*(?:দিন|দেন|দাও)`) },
  { lang: 'bn', rule: 'bn_not_bot', re: /(?:বট|রোবট)[^।?!]{0,10}(?:না|চাই না|লাগবে না)/ },

  // Banglish (Bangla in Latin letters)
  { lang: 'banglish', rule: 'bl_talk_with_person', re: new RegExp(`\\b${BL_PERSON}\\s*(?:er|r|ar|ere|er\\s+shathe)?\\s*(?:sathe|shathe|sate|shate|songe|shonge|lagi)\\s*(?:ekto\\s+|ektu\\s+)?(?:kotha|kota|katha)\\b`) },
  { lang: 'banglish', rule: 'bl_talk_want_person', re: new RegExp(`\\b(?:kotha|kota|katha)\\s*(?:bolbo|bolte\\s*chai|bolte\\s*cai|bolte|bolar|bolaben|bolai)\\b[^.?!]{0,25}\\b${BL_PERSON}\\b`) },
  { lang: 'banglish', rule: 'bl_want_person', re: new RegExp(`\\b(?:admin|agent|manush|manus|human|staff|owner|malik)\\s*(?:chai|cai|dorkar|lagbe\\s+kotha|den|dao|dan|ke\\s+den|ke\\s+dao|ke\\s+dakun|ke\\s+daken|ke\\s+call\\s+den)\\b`) },
  { lang: 'banglish', rule: 'bl_connect', re: new RegExp(`\\b${BL_PERSON}\\s*(?:er|r)?\\s*(?:sathe|shathe|songe)\\s*(?:connect|jogajog|contact)\\s*(?:kore|koriye|koira)?\\s*(?:den|dao|dan|din)\\b`) },
  { lang: 'banglish', rule: 'bl_not_bot', re: /\b(?:bot|robot)\s*(?:er|r)?\s*(?:sathe|shathe)?\s*(?:kotha)?\s*(?:bolbo na|bolte chai na|chai na|lagbe na)\b/ },
];

// Mentions that might be a request but are ambiguous on their own
// ("admin panel e login hocche na", "bhai admin?").
const POSSIBLE_RE = new RegExp(
  `\\b(?:${EN_PERSON.slice(3, -1)}|manush|manus|malik)\\b|মানুষ|এজেন্ট|অ্যাডমিন|এডমিন|প্রতিনিধি`,
);

export function detectHandoffRequest(text) {
  const t = normalizeForHandoff(text);
  if (!t) return { kind: 'none', rule: null, lang: null };
  for (const r of EXPLICIT_RULES) {
    if (r.re.test(t)) return { kind: 'explicit', rule: r.rule, lang: r.lang };
  }
  if (POSSIBLE_RE.test(t)) return { kind: 'possible', rule: 'mentions_person', lang: null };
  return { kind: 'none', rule: null, lang: null };
}

// Marketing opt-out keywords. Service messages are unaffected.
export function detectMarketingOptOut(text) {
  const t = normalizeForHandoff(text);
  return /^(?:stop|unsubscribe|stop promo|stop promotions|stop offers|no more offers|offer pathaben na|ar offer diben na|বন্ধ করুন|অফার পাঠাবেন না|আর অফার দিবেন না)[.!\s]*$/.test(t);
}
