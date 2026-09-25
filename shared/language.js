// Customer language detection: 'bn' (Bangla script), 'banglish' (Bangla in
// Latin letters) or 'en'. Dependency-free; inlined into n8n Code nodes.
// The model is told which language to use; we do not trust the model's own
// language label (it mislabelled Banglish as 'bn' during live testing).

const BANGLISH_MARKERS = [
  'ami', 'apni', 'apnar', 'amar', 'tumi', 'koto', 'kto', 'bhai', 'vai', 'bhaiya', 'apu', 'ache', 'ase', 'nai', 'nei',
  'kivabe', 'kibhabe', 'korbo', 'korben', 'korte', 'kore', 'dam', 'taka', 'kemon', 'hobe', 'hbe', 'chai', 'cai',
  'bolben', 'janaben', 'kotha', 'sathe', 'shathe', 'kno', 'keno', 'kobe', 'kokhon', 'ekhon', 'ekta', 'ekti', 'dilam',
  'dise', 'diyechi', 'pathabo', 'pathan', 'pathiye', 'hoy', 'hocche', 'hochhe', 'hoise', 'hoyeche', 'lagbe', 'thik',
  'accha', 'acha', 'dhonnobad', 'dao', 'kinbo', 'kinte', 'mas', 'maser', 'shob', 'sob', 'valo',
  'bhalo', 'jonno', 'jnno', 'theke', 'pore', 'ki',
];
const MARKER_RE = new RegExp(`(?:^|[^a-z])(?:${BANGLISH_MARKERS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=$|[^a-z])`, 'g');

export function detectLanguage(text) {
  const s = String(text || '');
  const letters = s.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (!letters) return null;
  const bangla = (s.match(/[ঀ-৿]/g) || []).length;
  if (bangla / letters.length >= 0.3) return 'bn';
  const hits = (s.toLowerCase().match(MARKER_RE) || []).length;
  const words = s.trim().split(/\s+/).length;
  if (hits >= 2 || (hits >= 1 && words <= 4)) return 'banglish';
  return 'en';
}
