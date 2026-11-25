/**
 * DNS providers, told apart by their nameservers, so the editor can say
 * where to add a record and whether a root domain (example.com rather than
 * www.example.com) can point here. Only Cloudflare can: it flattens a CNAME
 * at the root. Elsewhere the owner connects www and has their provider
 * forward the root to it, or moves the domain's DNS to Cloudflare (free).
 */

export interface DnsProvider {
  id: string;
  name: string;
  /** Where its DNS records are edited. */
  dashboard: string | null;
  /** Whether a CNAME can point a root domain here. */
  root: boolean;
}

const PROVIDERS: Array<DnsProvider & { nameservers: RegExp }> = [
  { id: "cloudflare", name: "Cloudflare", nameservers: /\.ns\.cloudflare\.com$/, dashboard: "https://dash.cloudflare.com/", root: true },
  { id: "godaddy", name: "GoDaddy", nameservers: /\.domaincontrol\.com$/, dashboard: "https://dcc.godaddy.com/control/portfolio", root: false },
  { id: "namecheap", name: "Namecheap", nameservers: /\.registrar-servers\.com$/, dashboard: "https://ap.www.namecheap.com/domains/list/", root: false },
  { id: "porkbun", name: "Porkbun", nameservers: /\.porkbun\.com$/, dashboard: "https://porkbun.com/account/domainsSpeedy", root: false },
  { id: "squarespace", name: "Squarespace", nameservers: /\.(?:googledomains|squarespacedns)\.com$/, dashboard: "https://account.squarespace.com/domains", root: false },
  { id: "route53", name: "Amazon Route 53", nameservers: /\.awsdns-\d+\./, dashboard: "https://console.aws.amazon.com/route53/v2/hostedzones", root: false },
  { id: "hostinger", name: "Hostinger", nameservers: /\.(?:dns-parking\.com|hostinger\.[a-z.]+)$/, dashboard: "https://hpanel.hostinger.com/domains", root: false },
  { id: "ionos", name: "IONOS", nameservers: /\.ui-dns\.(?:com|de|org|biz)$/, dashboard: "https://my.ionos.com/domains", root: false },
  { id: "ovh", name: "OVHcloud", nameservers: /\.ovh\.(?:net|ca)$/, dashboard: "https://www.ovh.com/manager/", root: false },
  { id: "gandi", name: "Gandi", nameservers: /\.gandi\.net$/, dashboard: "https://admin.gandi.net/domain/", root: false },
  { id: "vercel", name: "Vercel", nameservers: /\.vercel-dns\.com$/, dashboard: "https://vercel.com/dashboard/domains", root: false },
  { id: "digitalocean", name: "DigitalOcean", nameservers: /\.digitalocean\.com$/, dashboard: "https://cloud.digitalocean.com/networking/domains", root: false },
  { id: "wix", name: "Wix", nameservers: /\.wixdns\.net$/, dashboard: "https://manage.wix.com/account/domains", root: false },
  { id: "namesilo", name: "NameSilo", nameservers: /\.dnsowl\.com$/, dashboard: "https://www.namesilo.com/account_domains.php", root: false },
  { id: "hetzner", name: "Hetzner", nameservers: /\.(?:hetzner\.com|your-server\.de|second-ns\.(?:com|de))$/, dashboard: "https://dns.hetzner.com/", root: false },
  { id: "zone", name: "Zone.ee", nameservers: /\.(?:zone\.(?:eu|ee)|zonedata\.net)$/, dashboard: "https://my.zone.eu/", root: false },
  { id: "dnsimple", name: "DNSimple", nameservers: /\.dnsimple(?:-edge)?\.(?:com|net|org)$/, dashboard: "https://dnsimple.com/dashboard", root: false },
  { id: "ns1", name: "NS1", nameservers: /\.nsone\.net$/, dashboard: null, root: false },
];

export function providerOf(nameservers: readonly string[]): DnsProvider | null {
  const found = PROVIDERS.find((provider) => nameservers.some((nameserver) => provider.nameservers.test(nameserver)));
  if (!found) return null;
  const { nameservers: _pattern, ...provider } = found;
  return provider;
}

export function providerById(id: string | null): DnsProvider | null {
  const found = PROVIDERS.find((provider) => provider.id === id);
  if (!found) return null;
  const { nameservers: _pattern, ...provider } = found;
  return provider;
}
