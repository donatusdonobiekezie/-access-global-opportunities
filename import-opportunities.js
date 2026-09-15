// ACCESS Opportunity Engine
// Vercel serverless endpoint: /api/import-opportunities
//
// Public feeds currently enabled:
//   - We Work Remotely public RSS
//   - Remote OK public JSON API
//   - Jobicy public Remote Jobs API (permitted for job discovery products)
//   - BOQQS public Nigeria jobs API (remote Nigeria vacancies)
//
// The engine keeps the original provider URL and source attribution on every row.
// It does NOT scrape Jobberman; Jobberman's terms prohibit automated extraction
// without prior written approval.

const WWR_FEED = "https://weworkremotely.com/remote-jobs.rss";
const REMOTE_OK_FEED = "https://remoteok.com/api";
const JOBICY_FEED = "https://jobicy.com/api/v2/remote-jobs?count=200";
const BOQQS_NG_REMOTE_FEED = "https://boqqs.com/api/v1/jobs?country=NG&remote=remote&per_page=100&page=1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripHtml(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanXml(value = "") {
  return stripHtml(value).replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function getTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? cleanXml(m[1]) : "";
}

function parseRssItems(xml) {
  const items = [];
  const matches = String(xml).match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of matches) {
    const title = getTag(block, "title");
    const link = getTag(block, "link");
    if (!title || !link) continue;
    items.push({
      title,
      link,
      guid: getTag(block, "guid") || link,
      description: getTag(block, "description"),
      pubDate: getTag(block, "pubDate"),
      region: getTag(block, "region"),
      country: getTag(block, "country"),
      category: getTag(block, "category"),
      type: getTag(block, "type"),
      skills: getTag(block, "skills"),
      expiresAt: getTag(block, "expires_at"),
    });
  }
  return items;
}

function splitCompanyTitle(title) {
  const index = String(title).indexOf(":");
  if (index > 0) return { company: title.slice(0, index).trim(), role: title.slice(index + 1).trim() };
  return { company: "", role: String(title).trim() };
}

function normalizeCountries(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
  return String(raw).split(/[,;|]/).map((x) => x.trim()).filter(Boolean).slice(0, 50);
}

function categoryFor(text) {
  const t = String(text).toLowerCase();
  if (/cyber|security|soc|penetration|infosec/.test(t)) return "Cybersecurity";
  if (/data scientist|data analyst|analytics|machine learning|ml engineer|data engineer/.test(t)) return "Data & AI";
  if (/ai trainer|ai evaluator|ai tutor|ai rater|annotation|data annot/.test(t)) return "AI Training & Evaluation";
  if (/software|developer|engineer|programmer|frontend|backend|full.?stack|devops/.test(t)) return "Software Development";
  if (/design|ux|ui\/ux|graphic|visual designer/.test(t)) return "Design";
  if (/writer|writing|copywriter|content/.test(t)) return "Writing & Content";
  if (/translator|translation|localization/.test(t)) return "Translation";
  if (/customer support|customer service|support specialist/.test(t)) return "Customer Support";
  if (/sales|business development|account executive/.test(t)) return "Sales";
  if (/marketing|seo|social media/.test(t)) return "Marketing";
  if (/virtual assistant|administrative|admin assistant/.test(t)) return "Virtual Assistant";
  if (/video|ugc|creator|content creator/.test(t)) return "Creator & Media";
  if (/research|researcher|user research/.test(t)) return "Research";
  if (/intern|internship/.test(t)) return "Internships";
  return "Remote Jobs";
}

function opportunityTypeFor(type, title) {
  const t = `${type || ""} ${title || ""}`.toLowerCase();
  if (/contract|freelance/.test(t)) return "Freelance / Contract";
  if (/part.?time/.test(t)) return "Part-time";
  if (/intern/.test(t)) return "Internship";
  return "Remote Job";
}

function riskFor(sourceName, text) {
  const t = String(text).toLowerCase();
  if (/pay.*fee|registration fee|buy.*course|crypto.*deposit/.test(t)) return "high";
  return ["We Work Remotely", "Remote OK", "Jobicy", "BOQQS"].includes(sourceName) ? "low" : "medium";
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function hashString(input) {
  let h = 2166136261;
  const s = String(input || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function buildWwrRows(items) {
  return items.map((item, index) => {
    const { company, role } = splitCompanyTitle(item.title);
    const combined = [role, company, item.description, item.category, item.skills].join(" ");
    const countries = normalizeCountries(item.country);
    const location = item.country || item.region || "Remote / location varies";
    const expires = parseDate(item.expiresAt);
    return {
      title: role || item.title,
      company: company || "We Work Remotely employer",
      description: item.description || "Remote opportunity listed on We Work Remotely.",
      category: categoryFor(combined), opportunity_type: opportunityTypeFor(item.type, role),
      country: location, countries, currency: "USD",
      compensation_text: "See original listing for compensation details.",
      application_url: item.link, source_url: item.link,
      eligibility_text: "Eligibility, location restrictions, experience requirements and application steps are defined by the original employer listing.",
      verification_status: "verified", risk_level: riskFor("We Work Remotely", combined),
      deadline: expires, published_at: parseDate(item.pubDate),
      source_name: "We Work Remotely", external_id: item.guid || item.link || `wwr-${hashString(item.title + index)}`,
      last_checked_at: new Date().toISOString(), active: true,
      source_attribution: "Source: We Work Remotely", expires_at: expires,
    };
  });
}

function buildRemoteOkRows(items) {
  return items.filter((item) => item && item.position && item.url).map((item) => {
    const tags = Array.isArray(item.tags) ? item.tags.join(", ") : "";
    const location = item.location || "Remote / location varies";
    const countries = normalizeCountries(location);
    const combined = [item.position, item.company, item.description, tags, location].join(" ");
    let compensation = "See original listing for compensation details.";
    if (item.salary_min || item.salary_max) {
      const min = item.salary_min || ""; const max = item.salary_max || "";
      compensation = `$${min}${max ? `–$${max}` : "+"} USD`;
    }
    return {
      title: item.position, company: item.company || "Remote OK employer",
      description: stripHtml(item.description || ""), category: categoryFor(combined),
      opportunity_type: opportunityTypeFor("", item.position), country: location, countries,
      currency: "USD", compensation_text: compensation,
      application_url: item.apply_url || item.url, source_url: item.url,
      eligibility_text: "Eligibility, location restrictions, experience requirements and application steps are defined by the original employer listing.",
      verification_status: "verified", risk_level: riskFor("Remote OK", combined), deadline: null,
      published_at: parseDate(item.date), source_name: "Remote OK",
      external_id: String(item.id || hashString(item.url)), last_checked_at: new Date().toISOString(),
      active: true, source_attribution: "Source: Remote OK", expires_at: null,
    };
  });
}

function buildJobicyRows(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item && (item.jobTitle || item.jobUrl || item.url)).map((item) => {
    const title = stripHtml(item.jobTitle || item.title || "Remote Job");
    const company = stripHtml(item.companyName || item.company || "Jobicy employer");
    const location = stripHtml(item.jobGeo || item.location || "Worldwide / location varies");
    const description = stripHtml(item.jobDescription || item.jobExcerpt || item.description || "");
    const combined = [title, company, location, item.jobIndustry, item.jobLevel, description].join(" ");
    const countries = normalizeCountries(location);
    const salary = (item.annualSalaryMin || item.annualSalaryMax)
      ? `${item.salaryCurrency || "USD"} ${item.annualSalaryMin || ""}${item.annualSalaryMax ? `–${item.annualSalaryMax}` : "+"} / year`
      : "See original listing for compensation details.";
    const url = item.url || item.jobUrl || item.jobLink;
    return {
      title, company, description, category: categoryFor(combined),
      opportunity_type: opportunityTypeFor(item.jobType, title), country: location, countries,
      currency: item.salaryCurrency || "USD", compensation_text: salary,
      application_url: url, source_url: url,
      eligibility_text: "Jobicy location data is shown from the original listing. ACCESS treats explicit Nigeria, Africa, or Worldwide locations as Nigeria-compatible; other regions require checking the provider listing.",
      verification_status: "verified", risk_level: riskFor("Jobicy", combined), deadline: null,
      published_at: parseDate(item.pubDate || item.publicationDate), source_name: "Jobicy",
      external_id: String(item.id || item.jobSlug || hashString(url || title)), last_checked_at: new Date().toISOString(),
      active: true, source_attribution: "Source: Jobicy", expires_at: null,
    };
  }).filter((x) => x.application_url);
}

function buildBoqqsRows(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item && item.id && item.url).map((item) => {
    const loc = item.location || {};
    const city = loc.city || "Nigeria";
    const country = loc.country || "NG";
    const location = `${city}, Nigeria`;
    const description = stripHtml(item.description || item.excerpt || "");
    const combined = [item.title, item.employer, item.category, description, location].join(" ");
    const salary = item.salary?.display || (item.salary?.min || item.salary?.max
      ? `${item.salary.currency || "NGN"} ${item.salary.min || ""}${item.salary.max ? `–${item.salary.max}` : "+"}`
      : "See original listing for compensation details.");
    return {
      title: stripHtml(item.title), company: stripHtml(item.employer || "BOQQS employer"),
      description, category: categoryFor(combined), opportunity_type: opportunityTypeFor(item.employmentType, item.title),
      country: location, countries: ["Nigeria"], currency: item.salary?.currency || "NGN",
      compensation_text: salary, application_url: item.url, source_url: item.url,
      eligibility_text: "Nigeria vacancy. Review the employer's original listing for qualifications, experience, location and application requirements.",
      verification_status: "verified", risk_level: riskFor("BOQQS", combined), deadline: parseDate(item.expiresAt),
      published_at: parseDate(item.postedAt), source_name: "BOQQS", external_id: String(item.id),
      last_checked_at: new Date().toISOString(), active: true, source_attribution: "Source: BOQQS", expires_at: parseDate(item.expiresAt),
    };
  });
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ACCESS-Opportunity-Engine/1.1 (+https://access-global-opportunities.vercel.app/)",
      "Accept": "application/rss+xml, application/json, text/xml, */*",
    },
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return await response.text();
}

async function fetchJson(url) { return JSON.parse(await fetchText(url)); }

async function supabaseRequest(path, options = {}) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: process.env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json",
    ...options.headers,
  };
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function upsertRows(rows) {
  if (!rows.length) return { inserted: 0 };
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await supabaseRequest("opportunities?on_conflict=source_name%2Cexternal_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(chunk),
    });
    inserted += chunk.length;
    await sleep(100);
  }
  return { inserted };
}

async function deactivateExpired() {
  const now = new Date().toISOString();
  return supabaseRequest(`opportunities?expires_at=lt.${encodeURIComponent(now)}&active=eq.true`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ active: false, last_checked_at: now }),
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  const auth = req.headers.authorization || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: "Unauthorized. This importer is protected." });

  try {
    const results = await Promise.allSettled([
      fetchText(WWR_FEED),
      fetchJson(REMOTE_OK_FEED),
      fetchJson(JOBICY_FEED),
      fetchJson(BOQQS_NG_REMOTE_FEED),
    ]);

    const [wwrResult, remoteOkResult, jobicyResult, boqqsResult] = results;
    const wwrItems = wwrResult.status === "fulfilled" ? parseRssItems(wwrResult.value) : [];
    const remoteOkItems = remoteOkResult.status === "fulfilled" && Array.isArray(remoteOkResult.value) ? remoteOkResult.value.filter((x) => x && x.position) : [];
    const jobicyPayload = jobicyResult.status === "fulfilled" ? jobicyResult.value : null;
    const boqqsPayload = boqqsResult.status === "fulfilled" ? boqqsResult.value : null;

    const jobicyItems = Array.isArray(jobicyPayload) ? jobicyPayload : (jobicyPayload?.jobs || []);
    const boqqsItems = Array.isArray(boqqsPayload) ? boqqsPayload : (boqqsPayload?.jobs || []);

    const wwrRows = buildWwrRows(wwrItems);
    const remoteOkRows = buildRemoteOkRows(remoteOkItems);
    const jobicyRows = buildJobicyRows(jobicyItems);
    const boqqsRows = buildBoqqsRows(boqqsItems);
    const allRows = [...boqqsRows, ...jobicyRows, ...wwrRows, ...remoteOkRows];

    // Premium locking is enforced by the dashboard. Keep DB tier deterministic too.
    allRows.forEach((row, index) => {
      row.access_tier = index === 0 ? "free" : "premium";
      row.featured = index < 10;
    });

    const upsert = await upsertRows(allRows);
    await deactivateExpired();

    return res.status(200).json({
      ok: true,
      sources: {
        boqqs_nigeria_remote: boqqsRows.length,
        jobicy: jobicyRows.length,
        we_work_remotely: wwrRows.length,
        remote_ok: remoteOkRows.length,
      },
      source_errors: {
        boqqs: boqqsResult.status === "rejected" ? String(boqqsResult.reason?.message || boqqsResult.reason) : null,
        jobicy: jobicyResult.status === "rejected" ? String(jobicyResult.reason?.message || jobicyResult.reason) : null,
        we_work_remotely: wwrResult.status === "rejected" ? String(wwrResult.reason?.message || wwrResult.reason) : null,
        remote_ok: remoteOkResult.status === "rejected" ? String(remoteOkResult.reason?.message || remoteOkResult.reason) : null,
      },
      processed: allRows.length,
      upserted: upsert.inserted,
      message: "ACCESS opportunity import completed with Nigeria-focused and global public feeds.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("ACCESS importer error:", error);
    return res.status(500).json({ ok: false, error: error?.message || "Importer failed" });
  }
}
