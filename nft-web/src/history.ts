// Shared helpers for the demo history lists: the demos indexer API, pagination and small formatters.
// The same file is copied into each demo app.

export interface Page<T> {
  page: number
  per: number
  total: number
  pages: number
  items: T[]
}

export interface Vrf {
  request_id: string
  key_hash: string
  pre_seed: string
  min_conf: number
  req_block: number
  req_tx: string
  req_ts: number
  output_seed: string | null
  word0: string | null
  payment: string | null
  success: number | null
  ful_block: number | null
  ful_tx: string | null
  ful_ts: number | null
}

/** GET a path from the demos indexer; throws if it is unreachable or answers with an error. */
export async function api<T>(base: string | undefined, path: string): Promise<T> {
  if (!base) throw new Error('no demos indexer configured')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8_000)
  try {
    const r = await fetch(`${base}${path}`, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`demos indexer ${r.status}`)
    return (await r.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** Prev / page x of y / Next. Hidden when everything fits on one page. */
export function renderPager(box: HTMLElement, page: number, pages: number, go: (p: number) => void) {
  box.hidden = pages <= 1
  const btn = (label: string, to: number, disabled: boolean) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.disabled = disabled
    b.addEventListener('click', () => go(to))
    return b
  }
  const info = document.createElement('span')
  info.className = 'muted small'
  info.textContent = `Page ${page + 1} of ${pages}`
  box.replaceChildren(btn('← Newer', page - 1, page === 0), info, btn('Older →', page + 1, page >= pages - 1))
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
