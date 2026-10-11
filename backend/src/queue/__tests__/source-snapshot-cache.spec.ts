// ============================================================
// CodeMorph — TESTS PHASE 39 : cache de snapshot des sources
// ------------------------------------------------------------
// Objectif 8 : ne pas re-télécharger / re-analyser les fichiers GitHub à
// chaque reprise, SANS compromettre la cohérence ni la mémoire.
// ============================================================
import {
  SourceSnapshotCache,
  SOURCE_CACHE_TTL_MS,
  SOURCE_CACHE_MAX_ENTRIES,
  SOURCE_CACHE_MAX_CHARS,
} from '../source-snapshot-cache';

function files(n: number, charsEach: number) {
  return Array.from({ length: n }, (_, i) => ({
    path:    `lib/f${i}.dart`,
    content: 'x'.repeat(charsEach),
  }));
}

describe('SourceSnapshotCache — comportement de base', () => {
  it('put puis get rend exactement les fichiers stockés', () => {
    const cache = new SourceSnapshotCache();
    const f = files(3, 100);
    cache.put('job-1', f);
    expect(cache.get('job-1')).toBe(f);
    expect(cache.size).toBe(1);
    expect(cache.chars).toBe(300);
  });

  it('get sur un jobId inconnu → undefined', () => {
    const cache = new SourceSnapshotCache();
    expect(cache.get('nope')).toBeUndefined();
  });

  it('delete retire l\'entrée et décrémente le poids', () => {
    const cache = new SourceSnapshotCache();
    cache.put('job-1', files(2, 50));
    cache.delete('job-1');
    expect(cache.get('job-1')).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.chars).toBe(0);
  });

  it('delete sur une entrée absente ne corrompt pas le compteur de caractères', () => {
    const cache = new SourceSnapshotCache();
    cache.put('job-1', files(2, 50));
    cache.delete('inconnu');
    expect(cache.chars).toBe(100);
  });

  it('clear vide tout', () => {
    const cache = new SourceSnapshotCache();
    cache.put('a', files(1, 10));
    cache.put('b', files(1, 10));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.chars).toBe(0);
  });
});

describe('SourceSnapshotCache — TTL (fraîcheur garantie)', () => {
  it('le snapshot expire après le TTL (jamais de code périmé servi)', () => {
    let t = 1_000_000;
    const cache = new SourceSnapshotCache({ ttlMs: 1_000, now: () => t });
    cache.put('job-1', files(1, 10));

    t += 999;
    expect(cache.get('job-1')).toBeDefined();

    t += 2; // t = +1001 > ttl
    expect(cache.get('job-1')).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.chars).toBe(0);
  });

  it('le TTL par défaut couvre largement la fenêtre de retry réelle (~75 s)', () => {
    expect(SOURCE_CACHE_TTL_MS).toBe(10 * 60 * 1_000);
    // backoff par défaut 5s + 10s + 20s + 40s = 75 s
    expect(SOURCE_CACHE_TTL_MS).toBeGreaterThan(75_000);
  });

  it('une entrée expirée est évincée et son poids libéré', () => {
    let t = 0;
    const cache = new SourceSnapshotCache({ ttlMs: 100, now: () => t });
    cache.put('old', files(1, 500));
    t = 200;
    cache.put('new', files(1, 10));
    expect(cache.chars).toBe(10);
    expect(cache.size).toBe(1);
  });
});

describe('SourceSnapshotCache — bornes mémoire (Render free tier, 512 Mo)', () => {
  it('évince la plus ancienne entrée quand maxEntries est atteint', () => {
    let t = 0;
    const cache = new SourceSnapshotCache({ maxEntries: 3, now: () => t++ });
    cache.put('j1', files(1, 10));
    cache.put('j2', files(1, 10));
    cache.put('j3', files(1, 10));
    cache.put('j4', files(1, 10));

    expect(cache.size).toBe(3);
    expect(cache.get('j1')).toBeUndefined();  // le plus ancien a sauté
    expect(cache.get('j4')).toBeDefined();
  });

  it('évince pour respecter le budget total de caractères', () => {
    let t = 0;
    const cache = new SourceSnapshotCache({ maxTotalChars: 250, now: () => t++ });
    cache.put('j1', files(1, 100));
    cache.put('j2', files(1, 100));
    cache.put('j3', files(1, 100)); // 300 > 250 → j1 évincé

    expect(cache.chars).toBeLessThanOrEqual(250);
    expect(cache.get('j1')).toBeUndefined();
    expect(cache.get('j3')).toBeDefined();
  });

  it('remplacer un jobId existant ne cumule pas son poids deux fois', () => {
    const cache = new SourceSnapshotCache();
    cache.put('j1', files(1, 100));
    cache.put('j1', files(1, 40));
    expect(cache.size).toBe(1);
    expect(cache.chars).toBe(40);
  });

  it('une entrée plus grosse que tout le budget est refusée SANS vider le cache', () => {
    const cache = new SourceSnapshotCache({ maxTotalChars: 100 });
    cache.put('keep', files(1, 50));
    cache.put('huge', files(1, 10_000));

    expect(cache.get('huge')).toBeUndefined();
    expect(cache.get('keep')).toBeDefined();  // l'entrée légitime survit
    expect(cache.chars).toBe(50);
  });

  it('les bornes par défaut sont finies et raisonnables', () => {
    expect(SOURCE_CACHE_MAX_ENTRIES).toBe(20);
    expect(SOURCE_CACHE_MAX_CHARS).toBe(20_000_000);
  });

  it('reste borné sur 200 jobs successifs (aucune fuite mémoire)', () => {
    let t = 0;
    const cache = new SourceSnapshotCache({ now: () => t++ });
    for (let i = 0; i < 200; i++) cache.put(`job-${i}`, files(5, 1_000));
    expect(cache.size).toBeLessThanOrEqual(SOURCE_CACHE_MAX_ENTRIES);
    expect(cache.chars).toBeLessThanOrEqual(SOURCE_CACHE_MAX_CHARS);
  });
});
