import { ArrowUp, ExternalLink, ImageUp, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Form, redirect, useActionData, useNavigation, useSubmit } from "react-router";

import { PageCard } from "~/components/page-card";
import { MAX_BUTTONS, normalizeButtonUrl, type PageButton } from "~/lib/buttons";
import { MAX_HEADLINE_LENGTH, MAX_TITLE_LENGTH } from "~/lib/limits";
import { MAX_BODY_LENGTH, renderMarkdown } from "~/lib/markdown";
import { MAX_UPLOAD_BYTES, mediaUrl } from "~/lib/media.server";
import { privateMeta } from "~/lib/meta";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import {
  deleteSiteFor,
  Refusal,
  removePictureFor,
  requireOwnedSite,
  setPictureFor,
  updateSiteFor,
} from "~/lib/sites.server";
import { requireAccount } from "~/lib/viewer.server";

import type { Route } from "./+types/app-site";

export function meta({ loaderData }: Route.MetaArgs) {
  return privateMeta(loaderData ? `Edit ${loaderData.handle}` : "Edit");
}

export async function loader({ request, url, params, context }: Route.LoaderArgs) {
  const account = await requireAccount(request, context);
  let site;
  try {
    site = await requireOwnedSite(account, params.handle);
  } catch (error) {
    if (error instanceof Refusal) throw new Response("Not Found", { status: 404 });
    throw error;
  }
  return {
    host: url.host,
    created: url.searchParams.has("created"),
    handle: site.handle,
    published: site.published,
    title: site.page.title,
    headline: site.page.headline,
    body: site.page.body,
    buttons: site.page.buttons,
    picture: site.page.imageKey ? mediaUrl(site.page.imageKey, url.origin) : null,
  };
}

type ActionResult = { ok: true; message: string } | { error: string };

export async function action({ request, url, params, context }: Route.ActionArgs): Promise<ActionResult | Response> {
  const account = await requireAccount(request, context);
  const now = Math.floor(Date.now() / 1000);
  const picture = (request.headers.get("Content-Type") ?? "").startsWith("multipart/form-data");
  if (picture && Number(request.headers.get("Content-Length") ?? "0") > MAX_UPLOAD_BYTES + 64 * 1024) {
    return { error: "That picture is over 8 MB." };
  }
  if (!(await withinLimits(request, picture ? "upload" : "write", account.id))) return { error: RATE_LIMITED_MESSAGE };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    switch (intent) {
      case "save": {
        let buttons: unknown;
        try {
          buttons = JSON.parse(String(form.get("buttons") ?? "[]"));
        } catch {
          return { error: "The buttons could not be read. Reload the page and try again." };
        }
        // Rows left completely empty are not buttons.
        if (Array.isArray(buttons)) {
          buttons = buttons.filter((button: PageButton) => String(button?.label ?? "").trim() || String(button?.url ?? "").trim());
        }
        await updateSiteFor(
          account,
          params.handle,
          { title: form.get("title"), headline: form.get("headline"), body: form.get("body"), buttons },
          now,
        );
        return { ok: true, message: "Saved." };
      }
      case "publish":
      case "unpublish":
        await updateSiteFor(account, params.handle, { published: intent === "publish" }, now);
        return { ok: true, message: intent === "publish" ? "Published! Your page is live." : "Unpublished: only you can see it now." };
      case "rename": {
        const site = await updateSiteFor(account, params.handle, { handle: form.get("handle") }, now);
        return redirect(`/app/sites/${site.handle}`);
      }
      case "picture": {
        const file = form.get("picture");
        if (!(file instanceof File) || file.size === 0) return { error: "Choose a picture first." };
        await setPictureFor(account, params.handle, { bytes: new Uint8Array(await file.arrayBuffer()) }, { now, ownHost: url.hostname });
        return { ok: true, message: "Picture updated." };
      }
      case "remove_picture":
        await removePictureFor(account, params.handle, now);
        return { ok: true, message: "Picture removed." };
      case "delete": {
        if (String(form.get("confirm") ?? "").trim().toLowerCase() !== params.handle.toLowerCase()) {
          return { error: `Type ${params.handle} to confirm.` };
        }
        await deleteSiteFor(account, params.handle, now);
        return redirect("/app");
      }
      default:
        return { error: "Unknown action." };
    }
  } catch (error) {
    if (error instanceof Refusal) return { error: error.message };
    throw error;
  }
}

interface Row extends PageButton {
  key: number;
}

let nextKey = 1;
/** An address as people type it: an email or phone without its mailto: or tel:. */
const typed = (url: string) => url.replace(/^(mailto:|tel:)/i, "");
const toRows = (buttons: PageButton[]): Row[] => buttons.map((button) => ({ label: button.label, url: typed(button.url), key: nextKey++ }));
const asTyped = (buttons: PageButton[]) => JSON.stringify(buttons.map(({ label, url }) => ({ label, url: typed(url) })));

export default function EditSite({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>() as ActionResult | undefined;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const intent = navigation.formData?.get("intent");
  const submit = useSubmit();
  const pictureInput = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState(loaderData.title);
  const [headline, setHeadline] = useState(loaderData.headline);
  const [body, setBody] = useState(loaderData.body);
  const [rows, setRows] = useState<Row[]>(() => toRows(loaderData.buttons));

  // After a save the server's version, normalized links included, is the one to edit.
  useEffect(() => {
    setTitle(loaderData.title);
    setHeadline(loaderData.headline);
    setBody(loaderData.body);
    setRows(toRows(loaderData.buttons));
  }, [loaderData]);

  const changed =
    title !== loaderData.title ||
    headline !== loaderData.headline ||
    body !== loaderData.body ||
    asTyped(rows) !== asTyped(loaderData.buttons);

  const preview = useMemo(
    () => ({
      title: title || "Your name",
      headline,
      bodyHtml: renderMarkdown(body),
      buttons: rows.flatMap(({ label, url }) => {
        const href = label.trim() ? normalizeButtonUrl(url) : null;
        return href ? [{ label: label.trim(), url: href }] : [];
      }),
      picture: loaderData.picture,
    }),
    [title, headline, body, rows, loaderData.picture],
  );

  const update = (key: number, field: "label" | "url", value: string) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, [field]: value } : row)));
  const move = (index: number) =>
    setRows((current) => {
      if (index === 0) return current;
      const copy = [...current];
      [copy[index - 1], copy[index]] = [copy[index]!, copy[index - 1]!];
      return copy;
    });

  const address = `${loaderData.host}/${loaderData.handle}`;

  return (
    <main className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <div className="flex min-w-0 flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold">{address}</h1>
            <p className={`text-sm ${loaderData.published ? "text-success" : "text-text-faint"}`}>
              {loaderData.published ? "Published" : "Draft — only you can see it"}
            </p>
          </div>
          <div className="flex gap-2">
            <a href={`/${loaderData.handle}`} target="_blank" rel="noopener" className="btn">
              <ExternalLink size={16} aria-hidden /> View
            </a>
            <Form method="post">
              <input type="hidden" name="intent" value={loaderData.published ? "unpublish" : "publish"} />
              <button type="submit" className={loaderData.published ? "btn" : "btn btn-primary"} disabled={busy || changed}>
                {loaderData.published ? "Unpublish" : "Publish"}
              </button>
            </Form>
          </div>
        </div>

        {loaderData.created ? (
          <p className="rounded bg-accent-soft px-4 py-3 text-sm">Your page is ready as a draft. Fill it in, save, then publish.</p>
        ) : null}
        {result ? (
          <p
            role={"error" in result ? "alert" : "status"}
            className={`rounded px-4 py-3 text-sm ${"error" in result ? "bg-danger-soft text-danger" : "bg-accent-soft text-text"}`}
          >
            {"error" in result ? result.error : result.message}
          </p>
        ) : null}

        <section className="flex items-center gap-4">
          {loaderData.picture ? (
            <img src={loaderData.picture} alt="" width={80} height={80} className="h-20 w-20 rounded-full border border-border object-cover" />
          ) : (
            <span className="h-20 w-20 rounded-full bg-surface-2" aria-hidden />
          )}
          <Form method="post" encType="multipart/form-data" className="flex flex-wrap gap-2">
            <input type="hidden" name="intent" value="picture" />
            <input
              ref={pictureInput}
              type="file"
              name="picture"
              accept="image/jpeg,image/png,image/webp,image/gif"
              hidden
              onChange={(event) => {
                if (event.currentTarget.files?.length) submit(event.currentTarget.form, { method: "post", encType: "multipart/form-data" });
              }}
            />
            <button type="button" className="btn" disabled={busy} onClick={() => pictureInput.current?.click()}>
              <ImageUp size={16} aria-hidden /> {intent === "picture" ? "Uploading…" : loaderData.picture ? "Change picture" : "Add a picture"}
            </button>
          </Form>
          {loaderData.picture ? (
            <Form method="post">
              <input type="hidden" name="intent" value="remove_picture" />
              <button type="submit" className="btn btn-quiet" disabled={busy}>
                Remove
              </button>
            </Form>
          ) : null}
        </section>

        <Form method="post" className="flex flex-col gap-5">
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="buttons" value={JSON.stringify(rows.map(({ label, url }) => ({ label, url })))} />
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Title</span>
            <input name="title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={MAX_TITLE_LENGTH} className="field" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Headline</span>
            <input
              name="headline"
              value={headline}
              onChange={(event) => setHeadline(event.target.value)}
              maxLength={MAX_HEADLINE_LENGTH}
              placeholder="What you do, in one line"
              className="field"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="flex items-baseline justify-between text-sm">
              <span className="font-medium">Text</span>
              <span className="text-text-faint">Markdown: **bold**, *italic*, [link](https://…)</span>
            </span>
            <textarea
              name="body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={7}
              maxLength={MAX_BODY_LENGTH}
              className="field font-mono text-sm"
            />
          </label>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium">Buttons</legend>
            {rows.map((row, index) => (
              <div key={row.key} className="flex flex-wrap items-center gap-2 rounded border border-border bg-surface p-2 sm:flex-nowrap">
                <input
                  aria-label={`Button ${index + 1} label`}
                  value={row.label}
                  onChange={(event) => update(row.key, "label", event.target.value)}
                  placeholder="Label"
                  maxLength={40}
                  className="field min-w-0 flex-1 sm:max-w-44"
                />
                <input
                  aria-label={`Button ${index + 1} link`}
                  value={row.url}
                  onChange={(event) => update(row.key, "url", event.target.value)}
                  placeholder="t.me/you, you@mail.com or +1 234…"
                  className="field min-w-0 flex-[2]"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <div className="flex">
                  <button type="button" className="btn btn-quiet h-9 w-9 p-0" aria-label="Move up" disabled={index === 0} onClick={() => move(index)}>
                    <ArrowUp size={16} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet h-9 w-9 p-0"
                    aria-label="Remove button"
                    onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}
                  >
                    <X size={16} aria-hidden />
                  </button>
                </div>
              </div>
            ))}
            {rows.length < MAX_BUTTONS ? (
              <button
                type="button"
                className="btn self-start"
                onClick={() => setRows((current) => [...current, { label: "", url: "", key: nextKey++ }])}
              >
                <Plus size={16} aria-hidden /> Add a button
              </button>
            ) : null}
          </fieldset>

          <div className="sticky bottom-0 -mx-4 flex items-center gap-3 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur">
            <button type="submit" className="btn btn-primary" disabled={busy || !changed}>
              {intent === "save" ? "Saving…" : "Save"}
            </button>
            <span className="text-sm text-text-faint">
              {changed ? "Unsaved changes" : loaderData.published ? "Saved changes are live at once." : "Saved."}
            </span>
          </div>
        </Form>

        <details className="rounded-md border border-border px-4 py-3">
          <summary className="cursor-pointer font-medium">Address and deletion</summary>
          <div className="mt-4 flex flex-col gap-6">
            <Form method="post" className="flex flex-col gap-2">
              <input type="hidden" name="intent" value="rename" />
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Change the address</span>
                <span className="flex items-center rounded border border-border-strong bg-surface">
                  <span className="pl-3 text-text-muted">{loaderData.host}/</span>
                  <input
                    name="handle"
                    defaultValue={loaderData.handle}
                    required
                    maxLength={32}
                    autoCapitalize="none"
                    spellCheck={false}
                    className="min-w-0 flex-1 bg-transparent py-2 pr-3 outline-none"
                  />
                </span>
                <span className="text-sm text-text-faint">The old address stops working at once, and someone else may take it.</span>
              </label>
              <button type="submit" className="btn self-start" disabled={busy}>
                Change address
              </button>
            </Form>
            <Form method="post" className="flex flex-col gap-2">
              <input type="hidden" name="intent" value="delete" />
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-danger">Delete this page</span>
                <span className="text-sm text-text-muted">Type {loaderData.handle} to confirm. This cannot be undone.</span>
                <input name="confirm" autoComplete="off" autoCapitalize="none" className="field" />
              </label>
              <button type="submit" className="btn btn-danger self-start" disabled={busy}>
                <Trash2 size={16} aria-hidden /> Delete
              </button>
            </Form>
          </div>
        </details>
      </div>

      <aside className="lg:sticky lg:top-6 lg:self-start" aria-label="Preview">
        <p className="mb-2 text-sm font-medium text-text-muted">Preview</p>
        <div className="max-h-[80vh] overflow-auto rounded-md border border-border bg-bg px-5 py-8">
          <PageCard page={preview} compact />
        </div>
      </aside>
    </main>
  );
}
