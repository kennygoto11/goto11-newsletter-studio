import type { Context, Config } from "@netlify/functions";

const NOTION_API = "https://api.notion.com/v1/pages";
const NOTION_VERSION = "2022-06-28";
const DATABASE_ID = "1c8674c26436809aa314e54f9fb86647";

// Newsletter Studio format -> Notion Content Type
const FORMAT_TO_CONTENT_TYPE: Record<string, string> = {
  adviser: "Perspective",
  framework: "Framework Deep-Dive",
  client: "Client Story",
  field: "Perspective",
  contrarian: "Reframe",
  personal: "Personal / Behind-the-Scenes",
};

// Newsletter Studio CTA -> Notion CTA Type (direct passthrough, values already aligned)
const CTA_MAP: Record<string, string> = {
  "Reply trigger": "Reply trigger",
  "Book a call": "Book a call",
  "Resonating close": "Resonating close",
  "No CTA": "No CTA",
  "Register": "Register",
  "Lead Magnet": "Lead Magnet",
};

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }

  const notionToken = Netlify.env.get("NOTION_TOKEN");
  if (!notionToken) {
    return new Response(
      JSON.stringify({ error: "NOTION_TOKEN not configured. Add it in Netlify environment variables." }),
      { status: 500 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  const p = body;

  // Title = subject line, fallback to first line of body
  const title =
    (p.subject && p.subject.trim()) ||
    (p.body || "").split("\n")[0].slice(0, 200) ||
    "Untitled newsletter";

  const properties: Record<string, any> = {
    Title: { title: [{ text: { content: title.slice(0, 200) } }] },
    Status: { status: { name: p.status === "sent" ? "Published" : "Not started" } },
    "Prompt tool": { select: { name: "Claude" } },
    "Platform(s)": { multi_select: [{ name: "MailChimp" }] },
    Medium: { multi_select: [{ name: "Text" }] },
  };

  if (p.sendDate) {
    properties["Publication Date"] = { date: { start: p.sendDate } };
  }

  if (p.format && FORMAT_TO_CONTENT_TYPE[p.format]) {
    properties["Content Type"] = { select: { name: FORMAT_TO_CONTENT_TYPE[p.format] } };
  }

  if (p.topic) {
    properties["Topic/Subject"] = { multi_select: [{ name: p.topic }] };
  }

  if (p.cta && CTA_MAP[p.cta]) {
    properties["CTA Type"] = { select: { name: CTA_MAP[p.cta] } };
  }

  if (p.campaignUrl) {
    properties["Link to Asset"] = { url: p.campaignUrl };
  }

  // Notes = preview text + source LinkedIn post reference
  const noteParts: string[] = [];
  if (p.preview) noteParts.push(`Preview: ${p.preview}`);
  if (p.sourceLinkedIn) noteParts.push(`Repurposed from LinkedIn post: ${p.sourceLinkedIn.slice(0, 120)}`);
  if (p.seed) noteParts.push(`Seed: ${p.seed}`);
  if (noteParts.length) {
    properties["Notes"] = { rich_text: [{ text: { content: noteParts.join(" | ").slice(0, 2000) } }] };
  }

  // Metrics
  if (p.metrics) {
    const m = p.metrics;
    if (m.opens != null) properties["Opens"] = { number: m.opens };
    if (m.clicks != null && m.sends) {
      properties["Click Rate"] = { number: m.clicks / m.sends };
    }
    if (m.replies != null) properties["Replies Received"] = { number: m.replies };
    if (m.unsubscribes != null) properties["Unsubscribes"] = { number: m.unsubscribes };
    if (m.sends != null) properties["Impressions"] = { number: m.sends };
  }

  // Build the page body — sectioned
  const children: any[] = [];

  if (p.subject) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: `Subject: ${p.subject}` } }] },
    });
  }
  if (p.preview) {
    children.push({
      object: "block",
      type: "quote",
      quote: { rich_text: [{ type: "text", text: { content: `Preview: ${p.preview}` } }] },
    });
  }

  if (p.body) {
    const paragraphs = p.body.split("\n").filter((line: string) => line.trim());
    for (const para of paragraphs.slice(0, 200)) {
      // Render section headings (lines starting with ##) as Notion heading_3
      if (para.startsWith("## ")) {
        children.push({
          object: "block",
          type: "heading_3",
          heading_3: {
            rich_text: [{ type: "text", text: { content: para.replace(/^##\s+/, "").slice(0, 2000) } }],
          },
        });
      } else {
        children.push({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: para.slice(0, 2000) } }],
          },
        });
      }
    }
  }

  if (p.sourceLinkedIn) {
    children.push({ object: "block", type: "divider", divider: {} });
    children.push({
      object: "block",
      type: "callout",
      callout: {
        rich_text: [{ type: "text", text: { content: `Repurposed from LinkedIn post: ${p.sourceLinkedIn.slice(0, 400)}` } }],
        icon: { emoji: "↩" },
      },
    });
  }

  const notionBody: any = {
    parent: { database_id: DATABASE_ID },
    properties,
  };
  if (children.length > 0) notionBody.children = children;

  try {
    const res = await fetch(NOTION_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: JSON.stringify(notionBody),
    });

    const data = await res.json();

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: data.message || "Notion API error", details: data }),
        { status: res.status }
      );
    }

    return new Response(
      JSON.stringify({ success: true, pageId: data.id, url: data.url }),
      { status: 200 }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Failed to reach Notion" }),
      { status: 500 }
    );
  }
};

export const config: Config = {
  path: "/api/newsletter-sync",
};
