import { query } from './database.js';

export interface DigestRow {
  ico: string;
  name: string;
  legal_form: string | null;
  city: string | null;
  nace_codes: string[] | null;
  first_seen: string;
}

export interface DigestResult {
  windowDays: number;
  count: number;
  sroCount: number;
  szcoCount: number;
  topCities: Array<{ city: string; count: number }>;
  rows: DigestRow[];
  text: string;
}

const NACE_PREFIX = '43.';

const LEGAL_FORM_PATTERNS = [
  '%ručením obmedzen%',
  '%s.r.o%',
  '%fyzická osoba podnikate%',
  '%samostatne hospodáriaci%',
  '%slobodné povolanie%',
];

export class WeeklyDigestService {
  /**
   * Query seen_icos for entries first observed in the last N days,
   * filtered to construction (NACE 43.xx) + s.r.o./SZČO.
   *
   * Returns the rows plus a pre-formatted Telegram-ready text block,
   * so the cron wrapper can dump+send without re-implementing the
   * presentation logic.
   */
  static async run(windowDays: number = 7): Promise<DigestResult> {
    const ilikeClause = LEGAL_FORM_PATTERNS.map(
      (_, i) => `legal_form ILIKE $${i + 2}`
    ).join(' OR ');

    const sql = `
      SELECT ico, name, legal_form, city, nace_codes, first_seen::text
      FROM seen_icos
      WHERE first_seen >= CURRENT_DATE - $1::int
        AND nace_codes IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM unnest(nace_codes) AS code
          WHERE code LIKE '${NACE_PREFIX}%'
        )
        AND (${ilikeClause})
      ORDER BY first_seen DESC, ico ASC
    `;

    const params: (number | string)[] = [windowDays, ...LEGAL_FORM_PATTERNS];
    const res = await query<DigestRow>(sql, params);
    const rows = res.rows;

    let sroCount = 0;
    let szcoCount = 0;
    const cityCounter = new Map<string, number>();
    for (const r of rows) {
      const lf = (r.legal_form || '').toLowerCase();
      if (lf.includes('ručením') || lf.includes('s.r.o')) sroCount++;
      else szcoCount++;
      const city = r.city || '—';
      cityCounter.set(city, (cityCounter.get(city) || 0) + 1);
    }

    const topCities = Array.from(cityCounter.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([city, count]) => ({ city, count }));

    const topCitiesStr = topCities
      .map((c) => `${c.city} (${c.count})`)
      .join(', ');

    const sample = rows
      .slice(0, 8)
      .map((r) => {
        const code = r.nace_codes?.find((c) => c.startsWith(NACE_PREFIX)) || '';
        return `• ${r.name} — ${r.city || '?'} — IČO ${r.ico} — ${code}`;
      })
      .join('\n');

    const text = rows.length === 0
      ? `📊 Týždenný digest (NACE 43.xx, ${windowDays}d): 0 nových firiem.`
      : `📊 Týždenný digest nových SK firiem v stavebníctve (NACE 43.xx)\n` +
        `Okno: posledných ${windowDays} dní\n\n` +
        `Spolu: ${rows.length} (s.r.o. ${sroCount}, SZČO ${szcoCount})\n` +
        `Top mestá: ${topCitiesStr}\n\n` +
        `Vzorka:\n${sample}`;

    return {
      windowDays,
      count: rows.length,
      sroCount,
      szcoCount,
      topCities,
      rows,
      text,
    };
  }
}
