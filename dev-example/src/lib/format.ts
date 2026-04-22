export function shortId(id: string | undefined | null, n = 7): string {
  if (!id) return '—';
  return id.slice(0, n);
}

export function relTime(input: string | number | Date): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  const ms = Date.now() - d.getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const dy = Math.round(h / 24);
  if (dy < 30) return `${dy}d ago`;
  return d.toLocaleDateString();
}

export function fmtCoord(n: number | undefined, axis: 'lat' | 'lon'): string {
  if (n == null || Number.isNaN(n)) return '—';
  const hem = axis === 'lat' ? (n >= 0 ? 'N' : 'S') : (n >= 0 ? 'E' : 'W');
  return `${Math.abs(n).toFixed(4)}° ${hem}`;
}

export function fmtDateTime(iso: string | number | Date | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export function isHexId(value: unknown): boolean {
  return typeof value === 'string' && value.length > 20 && /^[0-9a-f]+$/i.test(value);
}

export function presetInitial(name: string | undefined): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
