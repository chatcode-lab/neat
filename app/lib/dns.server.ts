/**
 * DNS lookups over HTTPS (Cloudflare's resolver, JSON API), for checking
 * where a domain points and who serves its DNS. A lookup that fails to
 * answer is null, which callers treat as "do not know", never as "no".
 */

const TYPES = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28 } as const;
export type RecordType = keyof typeof TYPES;

export interface DnsAnswer {
  /** 0 for an answer, 3 for a name that does not exist; others are failures. */
  status: number;
  records: Array<{ name: string; type: RecordType | number; data: string }>;
}

const bare = (name: string) => name.replace(/\.$/, "").toLowerCase();

export async function lookup(name: string, type: RecordType): Promise<DnsAnswer | null> {
  try {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { Status: number; Answer?: Array<{ name: string; type: number; data: string }> };
    if (body.Status !== 0 && body.Status !== 3) return null;
    const names = Object.fromEntries(Object.entries(TYPES).map(([key, value]) => [value, key as RecordType]));
    return {
      status: body.Status,
      records: (body.Answer ?? []).map((record) => ({ name: bare(record.name), type: names[record.type] ?? record.type, data: record.data })),
    };
  } catch {
    return null;
  }
}

/** A TXT record's text, its quoted pieces joined. */
export function txtValue(data: string): string {
  const pieces = data.match(/"((?:[^"\\]|\\.)*)"/g);
  return pieces ? pieces.map((piece) => piece.slice(1, -1).replace(/\\(.)/g, "$1")).join("") : data;
}

export interface DnsZone {
  /** The zone the name is in: example.com for www.example.com. */
  zone: string;
  nameservers: string[];
}

/**
 * The zone a name belongs to, and its nameservers: the nearest name, from
 * the name itself upwards, that has nameservers of its own. "none" when no
 * name up to the top-level domain has any, as for a domain nobody
 * registered; null when the resolver could not say.
 */
export async function zoneOf(hostname: string): Promise<DnsZone | "none" | null> {
  const labels = hostname.split(".");
  for (let start = 0; start < labels.length - 1; start += 1) {
    const name = labels.slice(start).join(".");
    const answer = await lookup(name, "NS");
    if (!answer) return null;
    const nameservers = answer.records.filter((record) => record.type === "NS" && record.name === name).map((record) => bare(record.data));
    if (nameservers.length > 0) return { zone: name, nameservers };
  }
  return "none";
}

/** How a claim was seen: by its CNAME, by its TXT record alone, not at all, or not known. */
export type Pointing = "cname" | "txt" | "no" | "unknown";

/**
 * Whether a domain is sent here by the claim with `code`: a CNAME to the
 * claim's own target, or, where the provider hides CNAMEs (Cloudflare at
 * the root or behind its proxy), the claim's TXT record and an address,
 * which shows the claim but not that requests come here.
 */
export async function pointsHere(hostname: string, code: string, target: string): Promise<Pointing> {
  const cname = await lookup(hostname, "CNAME");
  if (!cname) return "unknown";
  const ownTarget = `${code}.${target}`;
  if (cname.records.some((record) => record.type === "CNAME" && record.name === hostname && bare(record.data) === ownTarget)) return "cname";
  const txt = await lookup(`${TXT_PREFIX}.${hostname}`, "TXT");
  if (!txt) return "unknown";
  if (txt.records.some((record) => record.type === "TXT" && txtValue(record.data) === txtProof(code))) {
    const [a, aaaa] = await Promise.all([lookup(hostname, "A"), lookup(hostname, "AAAA")]);
    if (!a || !aaaa) return "unknown";
    if ([...a.records, ...aaaa.records].some((record) => record.type === "A" || record.type === "AAAA")) return "txt";
  }
  return "no";
}

/** The name and value of the TXT record that proves a claim. */
export const TXT_PREFIX = "_neat-link";
export const txtProof = (code: string) => `neat-link=${code}`;
