import { Link2, Mail, Phone } from "lucide-react";
import {
  siApple,
  siBehance,
  siBluesky,
  siDiscord,
  siDribbble,
  siFacebook,
  siGithub,
  siGitlab,
  siInstagram,
  siMastodon,
  siMedium,
  siPatreon,
  siPinterest,
  siReddit,
  siSignal,
  siSnapchat,
  siSoundcloud,
  siSpotify,
  siSubstack,
  siTelegram,
  siThreads,
  siTiktok,
  siTwitch,
  siViber,
  siVk,
  siWhatsapp,
  siX,
  siYoutube,
} from "simple-icons";

import type { LinkKind } from "~/lib/buttons";

/** Brand marks from Simple Icons (CC0), drawn in a 24-unit box. */
const BRANDS: Partial<Record<LinkKind, string>> = {
  apple: siApple.path,
  behance: siBehance.path,
  bluesky: siBluesky.path,
  discord: siDiscord.path,
  dribbble: siDribbble.path,
  facebook: siFacebook.path,
  github: siGithub.path,
  gitlab: siGitlab.path,
  instagram: siInstagram.path,
  mastodon: siMastodon.path,
  medium: siMedium.path,
  patreon: siPatreon.path,
  pinterest: siPinterest.path,
  reddit: siReddit.path,
  signal: siSignal.path,
  snapchat: siSnapchat.path,
  soundcloud: siSoundcloud.path,
  spotify: siSpotify.path,
  substack: siSubstack.path,
  telegram: siTelegram.path,
  threads: siThreads.path,
  tiktok: siTiktok.path,
  twitch: siTwitch.path,
  viber: siViber.path,
  vk: siVk.path,
  whatsapp: siWhatsapp.path,
  x: siX.path,
  youtube: siYoutube.path,
};

/**
 * Marks Simple Icons no longer carries, from Font Awesome Free (CC BY 4.0,
 * https://fontawesome.com/license/free), drawn in a 448 by 512 box.
 */
const FONT_AWESOME: Partial<Record<LinkKind, string>> = {
  linkedin:
    "M416 32H31.9C14.3 32 0 46.5 0 64.3v383.4C0 465.5 14.3 480 31.9 480H416c17.6 0 32-14.5 32-32.3V64.3c0-17.8-14.4-32.3-32-32.3zM135.4 416H69V202.2h66.5V416zm-33.2-243c-21.3 0-38.5-17.3-38.5-38.5S80.9 96 102.2 96c21.2 0 38.5 17.3 38.5 38.5 0 21.3-17.2 38.5-38.5 38.5zm282.1 243h-66.4V312c0-24.8-.5-56.7-34.5-56.7-34.6 0-39.9 27-39.9 54.9V416h-66.4V202.2h63.7v29.2h.9c8.9-16.8 30.6-34.5 62.9-34.5 67.2 0 79.7 44.3 79.7 101.9V416z",
  amazon:
    "M257.2 162.7c-48.7 1.8-169.5 15.5-169.5 117.5 0 109.5 138.3 114 183.5 43.2 6.5 10.2 35.4 37.5 45.3 46.8l56.8-56S341 288.9 341 261.4V114.3C341 89 316.5 32 228.7 32 140.7 32 94 87 94 136.3l73.5 6.8c16.3-49.5 54.2-49.5 54.2-49.5 40.7-.1 35.5 29.8 35.5 69.1zm0 86.8c0 80-84.2 68-84.2 17.2 0-47.2 50.5-56.7 84.2-57.8v40.6zm136 163.5c-7.7 10-70 67-174.5 67S34.2 408.5 9.7 379c-6.8-7.7 1-11.3 5.5-8.3C88.5 415.2 203 488.5 387.7 401c7.5-3.7 13.3 2 5.5 12zm39.8 2.2c-6.5 15.8-16 26.8-21.2 31-5.5 4.5-9.5 2.7-6.5-3.8s19.3-46.5 12.7-55c-6.5-8.3-37-4.3-48-3.2-10.8 1-13 2-14-.3-2.3-5.7 21.7-15.5 37.5-17.5 15.7-1.8 41-.8 46 5.7 3.7 5.1 0 27.1-6.5 43.1z",
};

/** A button's icon, by the service its address belongs to. */
export function LinkIcon({ kind, size = 18 }: { kind: LinkKind; size?: number }) {
  const brand = BRANDS[kind];
  if (brand) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
        <path d={brand} />
      </svg>
    );
  }
  const awesome = FONT_AWESOME[kind];
  if (awesome) {
    return (
      <svg width={size} height={size} viewBox="0 0 448 512" fill="currentColor" aria-hidden focusable="false">
        <path d={awesome} />
      </svg>
    );
  }
  if (kind === "email") return <Mail size={size} aria-hidden />;
  if (kind === "phone") return <Phone size={size} aria-hidden />;
  return <Link2 size={size} aria-hidden />;
}
