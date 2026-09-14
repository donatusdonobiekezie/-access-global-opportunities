const WWR_FEED = "https://weworkremotely.com/remote-jobs.rss";
const REMOTE_OK_FEED = "https://remoteok.com/api";

function clean(value = "") {
  return value
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block, name) {
  const match = block.match(
    new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i")
  );
  return match ? clean(match[1]) : "";
}

function parseRSS(xml) {
  const items = [];
  const matches = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  for (const block of matches) {
    const title = tag(block, "title");
    const link = tag(block, "link");
    const description = tag(block, "description");
    const pubDate = tag(block, "pubDate");
    const guid = tag(block, "guid") || link;

    if (!title || !link) continue;

    items.push({
      title,
      link,
      description,
      pubDate,
      guid
    });
  }

  return items;
}

function category(text) {
  const t = text.toLowerCase();

  if (/cyber|security|infosec|penetration/.test(t))
    return "Cybersecurity";

  if (/data scientist|data analyst|analytics|machine learning|ml engineer/.test(t))
    return "Data & AI";

  if (/ai trainer|ai evaluator|ai rater|annotation|data annot/.test(t))
    return "AI Training & Evaluation";

  if (/software|developer|engineer|programmer|frontend|backend|full.?stack|devops/.test(t))
    return "Software Development";

  if (/design|ux|ui\/ux|graphic/.test(t))
    return "Design";

  if (/writer|writing|copywriter|content/.test(t))
    return "Writing & Content";

  if (/translator|translation|localization/.test(t))
    return "Translation";

  if (/customer support|customer service/.test(t))
    return "Customer Support";

  if (/marketing|seo|social media/.test(t))
    return "Marketing";

  if (/video|ugc|creator/.test(t))
    return "Creator & Media";

  if (/research|researcher/.test(t))
    return "Research";

  if (/intern|internship/.test(t))
    return "Internships";

  return "Remote Jobs";
}

function typeFor(text) {
  const t = text.toLowerCase();

  if (/freelance|contract/.test(t))
    return "Freelance / Contract";

  if (/part.?time/.test(t))
    return "Part-time";

  if (/intern/.test(t))
    return "Internship";

  return "Remote Job";
}

function dateOrNull(value) {
  if (!value) return null;

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

async function getText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "ACCESS-Opportunity-Engine/1.0 (+https://access-global-opportunities.vercel.app/)",
      "Accept": "application/rss+xml, application/json, text/xml, */*"
    }
  });

  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }

  return response.text();
}

async function supabase(path, options = {}) {
  const response = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        ...options.headers
      }
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

function buildWWR(items) {
  return items.map((item, index) => ({
    title: item.title,
    company: "We Work Remotely employer",
    description:
      item.description ||
      "Remote opportunity listed on We Work Remotely.",
    category: category(item.title + " " + item.description),
    opportunity_type: typeFor(item.title),
    country: "Remote / location varies",
    countries: [],
    currency: "USD",
    compensation_text:
      "See original listing for compensation details.",
    application_url: item.link,
    source_url: item.link,
    eligibility_text:
      "Eligibility and location requirements are determined by the original employer.",
    verification_status: "verified",
    risk_level: "low",
    deadline: null,
    published_at: dateOrNull(item.pubDate),
    source_name: "We Work Remotely",
    external_id: item.guid || item.link || `wwr-${index}`,
    last_checked_at: new Date().toISOString(),
    active: true,
    source_attribution: "Source: We Work Remotely",
    expires_at: null
  }));
}

function buildRemoteOK(items) {
  return items
    .filter(item => item && item.position && item.url)
    .map(item => ({
      title: item.position,
      company: item.company || "Remote OK employer",
      description: clean(item.description || ""),
      category: category(
        `${item.position} ${item.company || ""} ${item.description || ""}`
      ),
      opportunity_type: typeFor(item.position),
      country: item.location || "Remote / location varies",
      countries: [],
      currency: "USD",
      compensation_text:
        item.salary_min || item.salary_max
          ? `$${item.salary_min || ""}${item.salary_max ? "–$" + item.salary_max : "+"} USD`
          : "See original listing for compensation details.",
      application_url: item.apply_url || item.url,
      source_url: item.url,
      eligibility_text:
        "Eligibility and location requirements are determined by the original employer.",
      verification_status: "verified",
      risk_level: "low",
      deadline: null,
      published_at: dateOrNull(item.date),
      source_name: "Remote OK",
      external_id: String(item.id || item.url),
      last_checked_at: new Date().toISOString(),
      active: true,
      source_attribution: "Source: Remote OK",
      expires_at: null
    }));
}

async function upsert(rows) {
  if (!rows.length) return;

  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);

    await supabase(
      "opportunities?on_conflict=source_name%2Cexternal_id",
      {
        method: "POST",
        headers: {
          Prefer: "resolution=merge-duplicates,return=minimal"
        },
        body: JSON.stringify(batch)
      }
    );
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  const authorization = req.headers.authorization || "";

  if (
    !process.env.CRON_SECRET ||
    authorization !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  try {
    const [wwrXML, remoteOKText] = await Promise.all([
      getText(WWR_FEED),
      getText(REMOTE_OK_FEED)
    ]);

    const wwrItems = parseRSS(wwrXML);

    const remoteOKData = JSON.parse(remoteOKText);

    const remoteOKItems = Array.isArray(remoteOKData)
      ? remoteOKData.filter(item => item && item.position)
      : [];

    const rows = [
      ...buildWWR(wwrItems),
      ...buildRemoteOK(remoteOKItems)
    ];

    rows.forEach((row, index) => {
      row.access_tier = index < 10 ? "free" : "premium";
      row.featured = index < 6;
    });

    await upsert(rows);

    return res.status(200).json({
      ok: true,
      we_work_remotely: wwrItems.length,
      remote_ok: remoteOKItems.length,
      processed: rows.length,
      message:
        "ACCESS opportunity import completed successfully."
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Importer failed"
    });
  }
}
