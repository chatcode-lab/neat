import { env } from "cloudflare:workers";

import { requireFeature } from "./billing.server";
import type { Account } from "./db/accounts.server";
import {
  claimDomain,
  type DomainRecord,
  domainHeldElsewhere,
  domainOf,
  domainsToCheck,
  dropDomain,
  forgetHeldHostname,
  hostnameDeleted,
  orphanedHostnames,
  pruneDeletedHostnames,
  queueStaleHostname,
  saveDomainCheck,
  startDeletingHostname,
  staleHostnames,
} from "./db/domains.server";
import { pointsHere, TXT_PREFIX, txtProof, zoneOf } from "./dns.server";
import { providerById, providerOf } from "./dns-providers";
import { domainProblem, normalizeDomain } from "./domains";
import { newPostId } from "./ids";
import { Refusal } from "./refusal";
import { hostnameStatus, registerHostname, removeHostname, SaasError, saasConfigured } from "./saas.server";
import { requireOwnedSite } from "./sites.server";

/** How long a connected domain may point elsewhere before it is let go, and stops being billed. */
const LOST_SECONDS = 7 * 24 * 3600;

/**
 * Deletes listed custom hostnames nothing names any more. Deleting one
 * starts only while no claim holds it, and from then no claim takes it up;
 * one a claim holds again (the same name connected anew) leaves the list,
 * unless that claim let go meanwhile; one Cloudflare could not delete now
 * stays on it for the hourly run.
 */
async function releaseStale(cfIds: readonly string[]): Promise<void> {
  if (!saasConfigured()) return;
  for (const cfId of cfIds) {
    try {
      const now = Math.floor(Date.now() / 1000);
      if (!(await startDeletingHostname(env.DB, cfId, now))) {
        await forgetHeldHostname(env.DB, cfId);
        continue;
      }
      await removeHostname(cfId);
      await hostnameDeleted(env.DB, cfId, Math.floor(Date.now() / 1000));
    } catch (error) {
      console.error("stale custom hostname", cfId, error);
    }
  }
}

const hostOf = (origin: string) => {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
};

/** Names no site may claim: neat.link's own, its media domain, and the DNS target. */
function ownHosts(origin: string): string[] {
  return ["neat.link", hostOf(env.APP_ORIGIN), hostOf(env.MEDIA_ORIGIN), hostOf(origin), env.DOMAIN_TARGET].filter(Boolean);
}

/** A record's name as DNS providers' forms take it: relative to the zone, "@" for its root. */
function relativeName(name: string, zone: string | null): string {
  if (!zone) return name;
  if (name === zone) return "@";
  return name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name;
}

/** A site's domain as the API, MCP and the editor describe it, with what to set up while it waits. */
export function domainJson(record: DomainRecord) {
  const provider = providerById(record.provider);
  const connected = record.status === "active";
  // Made at Cloudflare, which is issuing its certificate: usually minutes.
  const status = connected ? "live" : record.cfId ? "issuing_certificate" : "pending";
  const records =
    record.kind === "route"
      ? []
      : [
          {
            type: "CNAME",
            name: relativeName(record.hostname, record.zone),
            host: record.hostname,
            value: `${record.code}.${env.DOMAIN_TARGET}`,
            required: true,
          },
          {
            type: "TXT",
            name: relativeName(`${TXT_PREFIX}.${record.hostname}`, record.zone),
            host: `${TXT_PREFIX}.${record.hostname}`,
            value: txtProof(record.code),
            // Cloudflare answers with its own addresses instead of a CNAME at
            // a root or behind its proxy; the TXT record then shows the claim.
            required: provider?.id === "cloudflare",
          },
        ];
  const notes: string[] = [];
  if (record.kind === "route") notes.push("Connected through neat.link's own Cloudflare account.");
  else if (status === "pending") {
    notes.push(
      provider
        ? `Add these records where the domain's DNS is: ${provider.name}${provider.dashboard ? ` (${provider.dashboard})` : ""}. The domain connects within minutes of them showing.`
        : "Add these records where the domain's DNS is managed. The domain connects within minutes of them showing.",
    );
    if (provider?.id === "cloudflare") notes.push("At Cloudflare, set the CNAME's proxy status to DNS only.");
    else notes.push(`The TXT record is needed only if your provider does not show the CNAME as it is.`);
  }
  const apex = record.zone && record.hostname === `www.${record.zone}` ? record.zone : null;
  if (apex && provider?.id !== "cloudflare") {
    notes.push(`To make ${apex} work too, have ${provider?.name ?? "your DNS provider"} forward it to https://${record.hostname}/.`);
  }
  if (status === "issuing_certificate") {
    notes.push("The domain points here. Cloudflare is setting it up and issuing its certificate, which usually takes a few minutes.");
  }
  return {
    hostname: record.hostname,
    status,
    url: `https://${record.hostname}/`,
    records,
    provider: provider ? { name: provider.name, dashboard: provider.dashboard } : null,
    certificate: record.kind === "route" ? "active" : record.sslStatus,
    error: record.error,
    notes,
    claimed_at: new Date(record.createdAt * 1000).toISOString(),
    checked_at: record.checkedAt ? new Date(record.checkedAt * 1000).toISOString() : null,
    connected_at: record.verifiedAt ? new Date(record.verifiedAt * 1000).toISOString() : null,
  };
}

export type DomainJson = ReturnType<typeof domainJson>;

/**
 * Checks one domain and records what was found. Once its DNS points here it
 * becomes a custom hostname at Cloudflare, and once Cloudflare serves it
 * with a certificate it is `active`: served, and the site's address. One
 * that stops working, or whose owner's plan ended, is let go a week later
 * (at once for the plan), so nothing is left billed. A hostname made on a
 * TXT record alone that never worked within a week is not made again until
 * the owner checks it (`manual`).
 */
export async function checkDomain(record: DomainRecord, now: number, entitled: boolean, manual = false): Promise<void> {
  const save = (changes: Parameters<typeof saveDomainCheck>[3]) => saveDomainCheck(env.DB, record.siteId, record.code, { checkedAt: now, ...changes });
  if (record.kind === "route") {
    await save({});
    return;
  }
  // The claim's hostname goes on the list to delete before the claim lets go of it, so it is never left unlisted.
  const letGo = async (error: string, stalled = false) => {
    if (record.cfId) await queueStaleHostname(env.DB, record.cfId, record.hostname, now);
    await save({
      status: "pending",
      cfId: null,
      sslStatus: null,
      registeredAt: null,
      cfHttpPath: null,
      cfHttpBody: null,
      verifiedAt: null,
      lostAt: null,
      stalledAt: stalled ? now : null,
      error,
    });
    if (record.cfId) await releaseStale([record.cfId]);
  };
  /** Something that worked has stopped: a week later it is let go. */
  const lose = async (why: string, changes: Parameters<typeof saveDomainCheck>[3] = {}) => {
    const since = record.lostAt ?? now;
    if (since <= now - LOST_SECONDS) await letGo(why);
    else await save({ ...changes, lostAt: since });
  };
  if (!entitled) {
    if (record.status === "active" || record.cfId) await letGo("Own domains are not in this account's plan any more.");
    else await save({});
    return;
  }
  const pointing = await pointsHere(record.hostname, record.code, env.DOMAIN_TARGET);
  if (pointing === "unknown") {
    await save({});
    return;
  }
  if (pointing === "no") {
    if (record.status === "active" || record.cfId) await lose("The domain stopped pointing here, so it was let go. Point it here again to reconnect it.");
    else await save({ error: null });
    return;
  }
  if (!saasConfigured()) {
    await save({ status: "active", error: null, verifiedAt: record.verifiedAt ?? now, lostAt: null, stalledAt: null });
    return;
  }
  if (!record.cfId && record.stalledAt !== null && pointing === "txt" && !manual) {
    await save({});
    return;
  }
  try {
    const current = record.cfId ? await hostnameStatus(record.cfId) : null;
    const hostname = current ?? (await registerHostname(record.hostname));
    const registeredAt = current ? (record.registeredAt ?? now) : now;
    const made = {
      cfId: hostname.id,
      sslStatus: hostname.ssl,
      registeredAt,
      cfHttpPath: hostname.httpPath,
      cfHttpBody: hostname.httpBody,
      stalledAt: null,
    };
    let saved: Awaited<ReturnType<typeof save>> | undefined;
    if (hostname.status === "active" && hostname.ssl === "active") {
      saved = await save({ ...made, status: "active", error: null, verifiedAt: record.verifiedAt ?? now, lostAt: null });
    } else if (record.status === "active") {
      await lose("Cloudflare stopped serving the domain for a week, so it was let go. Check its DNS records, then connect it again.", made);
    } else if (registeredAt <= now - LOST_SECONDS) {
      await letGo("Cloudflare saw no request for the domain reach neat.link within a week, so it was let go. Check its CNAME record, then check again.", true);
    } else {
      saved = await save({ ...made, error: null });
    }
    // Disconnected or replaced while Cloudflare made it: nothing names the
    // hostname now, so it would stay billed. A newer claim on the same name
    // that already holds it keeps it.
    if (saved === "gone") {
      await queueStaleHostname(env.DB, hostname.id, record.hostname, now);
      await releaseStale([hostname.id]);
    }
    // The name's hostname is being deleted: the next check makes it anew.
    if (saved === "deleting") await save({});
  } catch (error) {
    if (!(error instanceof SaasError)) throw error;
    console.error("custom hostname", record.hostname, error.message);
    await save({ error: `Cloudflare could not set up this domain yet (${error.message}). It is tried again every hour.` });
  }
}

/**
 * Claims a domain for a site, replacing the one it had, and checks it at
 * once in case its DNS is already set. A root domain needs DNS at
 * Cloudflare, the one provider that can point a root with a CNAME.
 */
export async function setDomainFor(account: Account, handle: string, input: unknown, now: number, origin: string): Promise<DomainJson> {
  await requireFeature(account, "domains", origin);
  const site = await requireOwnedSite(account, handle);
  if (typeof input !== "string") throw new Refusal(400, "invalid_domain", 'Send {"hostname": "www.example.com"}.');
  const hostname = normalizeDomain(input);
  const problem = hostname ? domainProblem(hostname, ownHosts(origin)) : "That is not a domain name.";
  if (!hostname || problem) throw new Refusal(400, "invalid_domain", problem!);

  const current = await domainOf(env.DB, site.id);
  if (current?.hostname === hostname) {
    await checkDomain(current, now, true, true);
    return domainJson((await domainOf(env.DB, site.id))!);
  }
  if (await domainHeldElsewhere(env.DB, hostname, site.id)) {
    throw new Refusal(409, "domain_taken", "Another page is connected to that domain.");
  }
  const zone = await zoneOf(hostname);
  if (zone === "none") throw new Refusal(400, "invalid_domain", `${hostname} has no DNS. Is the domain registered?`);
  const provider = zone ? providerOf(zone.nameservers) : null;
  if (zone && zone.zone === hostname && provider?.id !== "cloudflare") {
    throw new Refusal(
      400,
      "root_domain",
      `${hostname} is a root domain, and ${provider?.name ?? "its DNS provider"} cannot point a root domain here with a CNAME. ` +
        `Connect www.${hostname} instead and forward ${hostname} to it (most registrars and DNS providers can), ` +
        `or move ${hostname}'s DNS to Cloudflare (free), which can.`,
    );
  }
  // The replaced claim's hostname, as it is when replaced: a check may have made it meanwhile.
  const replaced = await claimDomain(env.DB, {
    siteId: site.id,
    hostname,
    code: newPostId(10),
    zone: zone ? zone.zone : null,
    provider: provider?.id ?? null,
    now,
  });
  await releaseStale(replaced);
  const claimed = (await domainOf(env.DB, site.id))!;
  await checkDomain(claimed, now, true, true);
  return domainJson((await domainOf(env.DB, site.id))!);
}

export async function domainFor(account: Account, handle: string): Promise<DomainJson> {
  const site = await requireOwnedSite(account, handle);
  const record = await domainOf(env.DB, site.id);
  if (!record) throw new Refusal(404, "no_domain", `${site.handle} has no domain of its own. Connect one with PUT …/domain.`);
  return domainJson(record);
}

/** Checks a site's domain now, as the owner asks after setting their DNS. */
export async function checkDomainFor(account: Account, handle: string, now: number, origin: string): Promise<DomainJson> {
  await requireFeature(account, "domains", origin);
  const site = await requireOwnedSite(account, handle);
  const record = await domainOf(env.DB, site.id);
  if (!record) throw new Refusal(404, "no_domain", `${site.handle} has no domain of its own. Connect one with PUT …/domain.`);
  await checkDomain(record, now, true, true);
  return domainJson((await domainOf(env.DB, site.id))!);
}

/** Disconnects a site's domain; its neat.link address stays. */
export async function removeDomainFor(account: Account, handle: string): Promise<void> {
  const site = await requireOwnedSite(account, handle);
  await removeSiteDomain(site.id);
}

/**
 * Lets a site's domain go. Its hostname, as it is when the claim goes, is
 * deleted at Cloudflare now, or by the hourly run should Cloudflare fail,
 * so nothing is left billed.
 */
export async function removeSiteDomain(siteId: string): Promise<void> {
  const { stale } = await dropDomain(env.DB, siteId, Math.floor(Date.now() / 1000));
  await releaseStale(stale);
}

/** The hourly check: hostnames left to delete, of deleted sites too; waiting claims, and connected domains. */
export async function checkDomains(now: number): Promise<void> {
  for (const orphan of await orphanedHostnames(env.DB)) await dropDomain(env.DB, orphan.siteId, now);
  await releaseStale(await staleHostnames(env.DB, 50));
  await pruneDeletedHostnames(env.DB, now - 24 * 3600);
  // Each check is a few DNS, Cloudflare and database calls; 50 an hour stays well inside a run's limits.
  for (const record of await domainsToCheck(env.DB, now, 50)) {
    try {
      await checkDomain(record, now, record.entitled);
    } catch (error) {
      console.error("domain check", record.hostname, error);
    }
  }
}
