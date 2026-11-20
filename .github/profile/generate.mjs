#!/usr/bin/env node
// Draws the terminal card shown in the profile README (assets/terminal-dark.svg
// and assets/terminal-light.svg) from live GitHub data. The "Profile terminal"
// workflow runs this once a day and commits the result.
//
//   GITHUB_TOKEN=<token> node .github/profile/generate.mjs
//   node .github/profile/generate.mjs --raw data.json --out <dir> --now 2026-11-20T00:00:00Z
//
// --raw renders from saved data ({ user, years }, as fetchData returns) instead of calling the API.
// --accent overrides the color in config.json.
// --readme is the README to point at the new images (default: the repo's, unless --out is given).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, "config.json"), "utf8"));
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg, i, all) => (arg.startsWith("--") ? [[arg.slice(2), all[i + 1]]] : [])),
);
const outDir = path.resolve(args.out ?? path.join(here, "../../assets"));
const now = args.now ? new Date(args.now) : new Date();

// ---------------------------------------------------------------- data

const PROFILE_QUERY = `query($login: String!) {
  user(login: $login) {
    createdAt
    followers { totalCount }
    publicRepos: repositories(ownerAffiliations: OWNER, privacy: PUBLIC) { totalCount }
    contributionsCollection { contributionCalendar { totalContributions } }
  }
}`;

// Languages come from every non-fork repo the token can see: your own, your
// organizations' and ones you collaborate on. The workflow's built-in token
// only sees public repos; a PROFILE_TOKEN secret also brings in private ones.
const REPOS_QUERY = `query($login: String!, $cursor: String) {
  user(login: $login) {
    repositories(ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR], isFork: false, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { languages(first: 10, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name } } } }
    }
  }
}`;

// GitHub returns at most one year of contributions per collection, so the
// all-time history asks for one aliased collection per calendar year. The
// projects listed in config.json come along in the same request.
function historyQuery(years) {
  const fields = years.map((year) => {
    const to = year === now.getUTCFullYear() ? now.toISOString() : `${year}-12-31T23:59:59Z`;
    return `y${year}: contributionsCollection(from: "${year}-01-01T00:00:00Z", to: "${to}") { contributionCalendar { weeks { contributionDays { date contributionCount } } } }`;
  });
  const projects = (config.projects ?? []).map(({ repo }, i) => {
    const [owner, name] = repo.split("/");
    return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { name description stargazerCount forkCount primaryLanguage { name } }`;
  });
  return `query($login: String!) { user(login: $login) { ${fields.join(" ")} } ${projects.join(" ")} }`;
}

async function graphql(query, variables = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Set GITHUB_TOKEN, or pass --raw <saved data>.");
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "profile-terminal" },
    body: JSON.stringify({ query, variables: { login: config.login, ...variables } }),
  });
  const body = await res.json();
  if (!res.ok || body.errors || !body.data?.user) {
    throw new Error(`GitHub API request failed (${res.status}): ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
}

async function fetchData() {
  const { user } = await graphql(PROFILE_QUERY);
  user.repos = { nodes: [] };
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const { repositories } = (await graphql(REPOS_QUERY, { cursor })).user;
    user.repos.nodes.push(...repositories.nodes);
    if (!repositories.pageInfo.hasNextPage) break;
    cursor = repositories.pageInfo.endCursor;
  }
  const years = [];
  for (let year = new Date(user.createdAt).getUTCFullYear(); year <= now.getUTCFullYear(); year++) years.push(year);
  const history = await graphql(historyQuery(years));
  const projects = (config.projects ?? []).flatMap((project, i) => {
    const repo = history[`p${i}`];
    if (!repo) return []; // renamed, deleted or private: leave it out rather than fail the run
    return [{
      name: repo.name,
      description: project.description ?? repo.description ?? "",
      stars: repo.stargazerCount,
      forks: repo.forkCount,
      language: repo.primaryLanguage?.name ?? "",
    }];
  });
  return { user, years: Object.fromEntries(years.map((year) => [year, history.user[`y${year}`].contributionCalendar])), projects };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 86400000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
// Column of a date in its year's row: weeks start on Sunday, like GitHub's calendar.
function weekOfYear(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  const jan1 = Date.UTC(new Date(ms).getUTCFullYear(), 0, 1);
  return Math.min(52, Math.floor(((ms - jan1) / DAY_MS + new Date(jan1).getUTCDay()) / 7));
}

function summarize({ user, years, projects = [] }) {
  const counts = new Map();
  for (const calendar of Object.values(years)) {
    for (const week of calendar.weeks) for (const day of week.contributionDays) counts.set(day.date, day.contributionCount);
  }
  const joined = user.createdAt.slice(0, 10);
  const today = isoDate(now.getTime());
  const days = [];
  for (let ms = Date.parse(`${joined}T00:00:00Z`); isoDate(ms) <= today; ms += DAY_MS) {
    days.push({ date: isoDate(ms), count: counts.get(isoDate(ms)) ?? 0 });
  }

  let best = 0;
  let run = 0;
  for (const day of days) {
    run = day.count ? run + 1 : 0;
    best = Math.max(best, run);
  }
  // A day with nothing yet doesn't break the current streak until it's over.
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--;
  let current = 0;
  for (; i >= 0 && days[i].count > 0; i--) current++;

  const perWeekday = Array(7).fill(0);
  for (const day of days) perWeekday[new Date(`${day.date}T00:00:00Z`).getUTCDay()] += day.count;
  const top = Math.max(...perWeekday);

  // One row per year, one cell per week, shaded by quartile of the non-empty weeks.
  const firstYear = Number(joined.slice(0, 4));
  const grid = [];
  for (let year = firstYear; year <= now.getUTCFullYear(); year++) {
    grid.push({ year, weeks: Array.from({ length: 53 }, () => ({ count: 0, active: false, level: 0 })) });
  }
  for (const day of days) {
    const week = grid[Number(day.date.slice(0, 4)) - firstYear].weeks[weekOfYear(day.date)];
    week.count += day.count;
    week.active = true;
  }
  const sums = grid.flatMap((row) => row.weeks).filter((w) => w.count > 0).map((w) => w.count).sort((a, b) => a - b);
  const quartile = (p) => sums[Math.min(sums.length - 1, Math.floor(p * sums.length))] ?? 0;
  const [q1, q2, q3] = [quartile(0.25), quartile(0.5), quartile(0.75)];
  for (const week of grid.flatMap((row) => row.weeks)) {
    week.level = week.count === 0 ? 0 : week.count <= q1 ? 1 : week.count <= q2 ? 2 : week.count <= q3 ? 3 : 4;
  }
  // Company commits use a shared work email GitHub can't credit, so from the
  // start date in config.json, weeks GitHub shows as empty are marked as company work.
  const companySince = config.companyWork?.since;
  if (companySince) {
    for (const day of days) {
      if (day.date >= companySince) grid[Number(day.date.slice(0, 4)) - firstYear].weeks[weekOfYear(day.date)].atCompany = true;
    }
  }
  for (const week of grid.flatMap((row) => row.weeks)) week.company = Boolean(week.atCompany) && week.count === 0;

  // Each language scores sqrt(bytes x repos using it), so one huge repo can't
  // outweigh the language most of your projects are written in.
  const usage = new Map();
  for (const repo of user.repos.nodes) {
    for (const { size, node } of repo.languages.edges) {
      if (config.excludeLanguages.includes(node.name) || !size) continue;
      const entry = usage.get(node.name) ?? { name: node.name, bytes: 0, repos: 0 };
      entry.bytes += size;
      entry.repos += 1;
      usage.set(node.name, entry);
    }
  }
  const scored = [...usage.values()].map((l) => ({ name: l.name, score: Math.sqrt(l.bytes * l.repos) }));
  const totalScore = scored.reduce((sum, l) => sum + l.score, 0) || 1;
  const languages = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((l) => ({ name: l.name, pct: Math.max(1, Math.round((l.score / totalScore) * 100)) }));

  return {
    createdAt: user.createdAt,
    followers: user.followers.totalCount,
    publicRepos: user.publicRepos.totalCount,
    lastYear: user.contributionsCollection.contributionCalendar.totalContributions,
    allTime: days.reduce((sum, day) => sum + day.count, 0),
    firstYear,
    grid,
    streak: { current, best },
    busiest: top > 0 ? `${WEEKDAYS[perWeekday.indexOf(top)]}s` : "still warming up",
    languages,
    projects,
  };
}

// "March 2020"
const monthYear = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function lastLogin() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `Last login: ${get("weekday")} ${get("month")} ${get("day")} ${get("hour")}:${get("minute")} on ttys001`;
}

// ---------------------------------------------------------------- drawing

const W = 840;
const PAD = 24;
const SIZE = 13;
const LH = 21;
const PROMPT_GAP = 26; // extra space above each command
const OUTPUT_GAP = 8; // extra space between a command and its output
const ADV = 7.8; // every monospace line is stretched to exactly this advance per character
const COLS = Math.floor((W - 2 * PAD) / ADV);
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_START_DAY = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

// Grays plus one accent color, chosen with "accent" in config.json.
const NEUTRALS = {
  dark: {
    fg: "#f0f6fc", muted: "#9198a1", card: "#151b23", bar: "#212830", border: "#3d444d", company: "#8957e5",
    about: "#79c0ff", stats: "#ffa657", languages: "#ffa657", projects: "#56d4dd", error: "#ff7b72",
  },
  light: {
    fg: "#1f2328", muted: "#59636e", card: "#f6f8fa", bar: "#eaeef2", border: "#d1d9e0", company: "#a475f9",
    about: "#0969da", stats: "#bc4c00", languages: "#bc4c00", projects: "#1b7c83", error: "#cf222e",
  },
};
// accent: prompt and bars, key: row labels, heat: contribution levels 0-4.
const ACCENTS = {
  green: {
    dark: { accent: "#3fb950", key: "#7ee787", heat: ["#262c36", "#0e4429", "#006d32", "#26a641", "#39d353"] },
    light: { accent: "#1a7f37", key: "#116329", heat: ["#e4e8ec", "#9be9a8", "#40c463", "#30a14e", "#216e39"] },
  },
  orange: {
    dark: { accent: "#f0883e", key: "#ffa657", heat: ["#262c36", "#4a2208", "#8a3d0f", "#d4621a", "#ff9a4d"] },
    light: { accent: "#bc4c00", key: "#953800", heat: ["#e4e8ec", "#ffd8b5", "#ffa657", "#e16f24", "#a63c03"] },
  },
  red: {
    dark: { accent: "#f85149", key: "#ff7b72", heat: ["#262c36", "#4c1416", "#8e1f22", "#da3633", "#ff6a69"] },
    light: { accent: "#cf222e", key: "#a40e26", heat: ["#e4e8ec", "#ffcecb", "#ff8182", "#e5534b", "#a40e26"] },
  },
};
const accentName = args.accent ?? config.accent ?? "green";
if (!ACCENTS[accentName]) throw new Error(`Unknown accent "${accentName}". Use one of: ${Object.keys(ACCENTS).join(", ")}.`);
const THEMES = Object.fromEntries(
  Object.entries(NEUTRALS).map(([mode, neutral]) => [mode, { ...neutral, ...ACCENTS[accentName][mode] }]),
);

// 16x16 stroke icons for the project rows.
const ICONS = {
  star: '<path d="M8 1.75l1.9 3.85 4.25.62-3.08 3 .73 4.23L8 11.45l-3.8 2 .73-4.23-3.08-3 4.25-.62z"/>',
  fork: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="11.5" cy="3.5" r="1.5"/><circle cx="8" cy="12.5" r="1.5"/><path d="M4.5 5v1A1.5 1.5 0 0 0 6 7.5h4A1.5 1.5 0 0 0 11.5 6V5M8 7.5V11"/>',
};
const icon = (name, x, y, size, color, extra = "") =>
  `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${size / 16})" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" ${extra}>${ICONS[name]}</g>`;
const clip = (text, width) => (text.length <= width ? text : `${text.slice(0, width - 1).trimEnd()}…`);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => n.toLocaleString("en-US");
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;

function wrap(text, width) {
  const lines = [""];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const cur = lines[lines.length - 1];
    if (cur && cur.length + 1 + word.length > width) lines.push(word);
    else lines[lines.length - 1] = cur ? `${cur} ${word}` : word;
  }
  return lines.filter(Boolean);
}

function render(s, t) {
  const host = config.prompt;
  let css = "";
  let keyframeId = 0;
  const fade = (delay) => `class="f" style="animation-delay:${delay.toFixed(2)}s"`;
  // One monospace line made of [text, color] segments, stretched to an exact width.
  const mono = (x, y, segs, extra = "") => {
    const chars = segs.reduce((n, [str]) => n + str.length, 0);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" textLength="${(chars * ADV).toFixed(1)}" lengthAdjust="spacing" ${extra}>${segs
      .map(([str, color, weight]) => `<tspan fill="${color}"${weight ? ` font-weight="${weight}"` : ""}>${esc(str)}</tspan>`)
      .join("")}</text>`;
  };
  const comment = (str) => [[str, t.muted]];
  const row = (key, value, width = COLS, color = t.key) => {
    const head = `. ${key}: `;
    const dots = Math.max(3, width - head.length - 1 - value.length);
    return [[". ", t.muted], [`${key}:`, color], [` ${".".repeat(dots)} `, t.muted], [value, t.fg]];
  };
  // A prompt whose command types itself out: a cover and a cursor slide off it one character at a time.
  // Their resting position is past the end of the command, so without animation the text is simply shown.
  const prompt = (y, cmd, start) => {
    const cmdX = PAD + (host.length + 5) * ADV;
    let out = mono(PAD, y, [[host, t.key, 700], [" ~ % ", t.muted]]);
    if (!cmd) return { svg: out, end: start, cursorX: cmdX };
    out += mono(cmdX, y, [[cmd, t.fg]]);
    const dist = cmd.length * ADV;
    const dur = cmd.length * 0.03;
    const id = keyframeId++;
    css += `@keyframes s${id}{from{transform:translateX(-${dist}px)}to{transform:translateX(0)}}`;
    css += `@keyframes k${id}{from{opacity:1;transform:translateX(-${dist}px)}to{opacity:1;transform:translateX(0)}}`;
    const timing = `${dur.toFixed(2)}s steps(${cmd.length}) ${start.toFixed(2)}s`;
    out += `<rect x="${(cmdX + dist).toFixed(1)}" y="${y - 15}" width="${(dist + 2).toFixed(1)}" height="${LH}" fill="${t.card}" style="animation:s${id} ${timing} both"/>`;
    out += `<rect x="${(cmdX + dist).toFixed(1)}" y="${y - 12}" width="8" height="16" fill="${t.fg}" opacity="0" style="animation:k${id} ${timing} backwards"/>`;
    return { svg: out, end: start + dur, cursorX: cmdX };
  };

  let o = "";
  let y = 36 + 30;
  o += mono(PAD, y, comment(lastLogin()));
  y += LH;
  const first = prompt(y, "whoami", 0.4);
  o += first.svg;
  let clock = first.end + 0.25;

  // Profile, full width, in the dotted style of the original README.
  y += LH + OUTPUT_GAP + 2;
  const profile = [
    comment("# about me"),
    row("Role", config.role, COLS, t.about),
    row("Location", config.location, COLS, t.about),
    row("On GitHub since", monthYear(s.createdAt), COLS, t.about),
    row("AI tools", config.aiTools, COLS, t.about),
    ...Object.entries(config.stack).map(([group, items]) => row(group, items.join(", "), COLS, t.about)),
  ];
  profile.forEach((segs, i) => {
    o += mono(PAD, y, segs, fade(clock + i * 0.04));
    y += LH;
  });
  clock += profile.length * 0.04;

  // GitHub stats on the left, languages on the right.
  y += LH;
  const half = Math.floor((COLS - 5) / 2);
  const stats = [
    comment("# github stats"),
    row("Public repos", fmt(s.publicRepos), half, t.stats),
    row("Contributions", `${fmt(s.lastYear)} in the last year`, half, t.stats),
    row("Streak", s.streak.current ? `${plural(s.streak.current, "day")} (best ${fmt(s.streak.best)})` : `best ${plural(s.streak.best, "day")}`, half, t.stats),
    row("Busiest day", s.busiest, half, t.stats),
    row("Followers", fmt(s.followers), half, t.stats),
  ];
  const rightX = PAD + (half + 5) * ADV;
  const rightEnd = PAD + COLS * ADV;
  const barX = rightX + 12 * ADV;
  const barMax = rightEnd - 5 * ADV - barX;
  const maxPct = Math.max(...s.languages.map((l) => l.pct), 1);
  const rowsHere = Math.max(stats.length, s.languages.length + 1);
  for (let i = 0; i < rowsHere; i++) {
    const delay = clock + i * 0.04;
    if (stats[i]) o += mono(PAD, y, stats[i], fade(delay));
    if (i === 0) o += mono(rightX, y, comment("# languages"), fade(delay));
    const l = s.languages[i - 1];
    if (l) {
      o += mono(rightX, y, [[l.name.slice(0, 11), t.fg]], fade(delay));
      o += `<rect x="${barX.toFixed(1)}" y="${y - 9}" width="${barMax.toFixed(1)}" height="8" rx="4" fill="${t.heat[0]}" ${fade(delay)}/>`;
      o += `<rect x="${barX.toFixed(1)}" y="${y - 9}" width="${((barMax * l.pct) / maxPct).toFixed(1)}" height="8" rx="4" fill="${t.languages}" class="g" style="animation-delay:${(delay + 0.1).toFixed(2)}s"/>`;
      o += mono(rightEnd - 4 * ADV, y, [[`${l.pct}%`.padStart(4), t.muted]], fade(delay));
    }
    y += LH;
  }
  clock += rowsHere * 0.04 + 0.2;

  // Personal projects, in columns: name, stars, forks, language, description.
  if (s.projects.length) {
    y += PROMPT_GAP;
    const list = prompt(y, "ls ~/projects/personal", clock + 0.15);
    o += `<g ${fade(clock)}>${list.svg}</g>`;
    clock = list.end + 0.2;
    y += LH + OUTPUT_GAP;
    s.projects.forEach((p, i) => {
      const delay = clock + i * 0.08;
      o += mono(PAD, y, [[clip(p.name, 22), t.projects, 700]], fade(delay));
      o += icon("star", PAD + 24 * ADV, y - 11, 13, t.muted, fade(delay));
      o += mono(PAD + 24 * ADV + 17, y, [[fmt(p.stars), t.muted]], fade(delay));
      if (p.forks) {
        o += icon("fork", PAD + 31 * ADV, y - 11, 13, t.muted, fade(delay));
        o += mono(PAD + 31 * ADV + 17, y, [[fmt(p.forks), t.muted]], fade(delay));
      }
      if (p.language) o += mono(PAD + 38 * ADV, y, [[clip(p.language, 11), t.muted]], fade(delay));
      if (p.description) o += mono(PAD + 51 * ADV, y, [[clip(p.description, COLS - 51), t.muted]], fade(delay));
      y += LH;
    });
    clock += s.projects.length * 0.08 + 0.2;
  }

  // Company work can't be listed, and the card says so.
  if (config.companyNote) {
    y += PROMPT_GAP;
    const company = prompt(y, "ls ~/projects/company", clock + 0.15);
    o += `<g ${fade(clock)}>${company.svg}</g>`;
    clock = company.end + 0.2;
    y += LH + OUTPUT_GAP;
    o += mono(PAD, y, [["ls: company: ", t.fg], ["Permission denied", t.error], [clip(`  # ${config.companyNote}`, COLS - 30), t.muted]], fade(clock));
    y += LH;
    clock += 0.3;
  }

  // All-time contributions: one row per year, one square per week.
  y += PROMPT_GAP;
  const second = prompt(y, "contributions --all-time", clock + 0.15);
  o += `<g ${fade(clock)}>${second.svg}</g>`;
  clock = second.end + 0.2;
  const labelW = 5 * ADV;
  const gridX = PAD + labelW;
  const step = (COLS * ADV - labelW + 3) / 53; // the grid ends where the text does
  const cell = step - 3;
  const gridTop = y + 30 + OUTPUT_GAP;
  MONTHS.forEach((name, m) => {
    o += mono(gridX + Math.round(MONTH_START_DAY[m] / 7) * step, gridTop - 9, [[name, t.muted]], `font-size="11" ${fade(clock)}`);
  });
  // The empty grid appears first, then every week with contributions pops in
  // in order, year by year and left to right, replaying the history.
  const square = (x, top, color, extra = "") =>
    `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" rx="2" fill="${color}" ${extra}/>`;
  let empty = "";
  const filled = [];
  s.grid.forEach((yearRow, r) => {
    const top = gridTop + r * step;
    o += mono(PAD, top + cell / 2 + 4, [[String(yearRow.year), t.muted]], `font-size="11" ${fade(clock)}`);
    yearRow.weeks.forEach((week, c) => {
      if (!week.active) return; // before joining GitHub, or still ahead this year
      const x = gridX + c * step;
      empty += square(x, top, t.heat[0]);
      if (week.level) filled.push({ x, top, color: t.heat[week.level] });
      else if (week.company) filled.push({ x, top, color: t.company });
    });
  });
  o += `<g ${fade(clock)}>${empty}</g>`;
  clock += 0.35;
  const gap = filled.length ? Math.min(0.03, 2.2 / filled.length) : 0;
  filled.forEach(({ x, top, color }, i) => {
    o += square(x, top, color, `class="p" style="animation-delay:${(clock + i * gap).toFixed(3)}s"`);
  });
  clock += filled.length * gap + 0.2;

  const legendY = Math.round(gridTop + s.grid.length * step - 3 + 19);
  let lx = rightEnd - 4 * ADV - 4 - 5 * 14;
  o += mono(lx - 5 * ADV, legendY, [["less ", t.muted]], `font-size="11" ${fade(clock)}`);
  t.heat.forEach((color, i) => {
    o += `<rect x="${(lx + i * 14).toFixed(1)}" y="${legendY - 10}" width="11" height="11" rx="2" fill="${color}" ${fade(clock)}/>`;
  });
  lx += 5 * 14 + 4;
  o += mono(lx, legendY, [["more", t.muted]], `font-size="11" ${fade(clock)}`);
  o += mono(PAD, legendY, [[`${plural(s.allTime, "contribution")} since ${s.firstYear}`, t.muted]], `font-size="11" ${fade(clock)}`);
  y = legendY;

  // What the two colors mean.
  if (config.companyWork) {
    y += LH;
    let ix = PAD;
    for (const [color, label] of [[t.heat[3], "tracked by GitHub"], [t.company, config.companyWork.label]]) {
      o += `<rect x="${ix.toFixed(1)}" y="${y - 10}" width="11" height="11" rx="2" fill="${color}" ${fade(clock)}/>`;
      o += mono(ix + 18, y, [[label, t.muted]], `font-size="11" ${fade(clock)}`);
      ix += 18 + (label.length + 4) * ADV;
    }
  }
  for (const line of config.heatmapNote ? wrap(config.heatmapNote, COLS - 2) : []) {
    y += LH;
    o += mono(PAD, y, comment(`# ${line}`), fade(clock));
  }

  // Final prompt with a blinking cursor.
  y += LH + PROMPT_GAP;
  const last = prompt(y, "", clock + 0.2);
  o += `<g ${fade(clock + 0.2)}>${last.svg}<rect x="${last.cursorX.toFixed(1)}" y="${y - 12}" width="8" height="16" fill="${t.fg}" class="c"/></g>`;

  const H = y + 24;
  const frame =
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${t.card}" stroke="${t.border}"/>` +
    `<path d="M0.5 10.5a10 10 0 0 1 10-10h${W - 21}a10 10 0 0 1 10 10v25.5h-${W - 1}z" fill="${t.bar}"/>` +
    `<line x1="0.5" y1="36" x2="${W - 0.5}" y2="36" stroke="${t.border}"/>` +
    [0, 1, 2].map((i) => `<circle cx="${20 + i * 18}" cy="18.5" r="6" fill="${t.border}"/>`).join("") +
    `<text x="${W / 2}" y="23" font-size="12" text-anchor="middle" fill="${t.muted}">${esc(host)} — zsh</text>`;

  const style =
    `text{font-family:${MONO};font-size:${SIZE}px;white-space:pre}` +
    `.f{animation:f .35s ease-out both}@keyframes f{from{opacity:0}}` +
    `.g{animation:g .6s ease-out both;transform-box:fill-box;transform-origin:left center}@keyframes g{from{transform:scaleX(0)}}` +
    `.p{animation:p .3s cubic-bezier(.2,.8,.3,1.4) both;transform-box:fill-box;transform-origin:center}` +
    `@keyframes p{from{opacity:0;transform:scale(.2)}}` +
    `.c{animation:c 1.1s step-end infinite}@keyframes c{50%{opacity:0}}` +
    css +
    `@media (prefers-reduced-motion:reduce){*{animation:none!important}}`;
  const label =
    `Terminal profile card for ${host}: ${config.role} in ${config.location}, ` +
    `${fmt(s.lastYear)} contributions in the last year and ${fmt(s.allTime)} since ${s.firstYear}.`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">` +
    `<title>${esc(label)}</title><style>${style}</style>${frame}${o}</svg>\n`
  );
}

// ---------------------------------------------------------------- main

const data = args.raw ? JSON.parse(fs.readFileSync(args.raw, "utf8")) : await fetchData();
const summary = summarize(data);
fs.mkdirSync(outDir, { recursive: true });

// Each version gets a new file name (a hash of its content) and the README is
// pointed at it, so GitHub's image caches can never serve yesterday's card.
const readmePath = args.readme ?? (args.out ? null : path.join(here, "../../README.md"));
const CARD_FILE = /^terminal-(dark|light)(-[0-9a-f]+)?\.svg$/;
for (const old of fs.readdirSync(outDir).filter((name) => CARD_FILE.test(name))) fs.rmSync(path.join(outDir, old));
let readme = readmePath ? fs.readFileSync(readmePath, "utf8") : null;
for (const [mode, theme] of Object.entries(THEMES)) {
  const svg = render(summary, theme);
  const name = `terminal-${mode}-${createHash("sha256").update(svg).digest("hex").slice(0, 10)}.svg`;
  fs.writeFileSync(path.join(outDir, name), svg);
  console.log(`wrote ${path.relative(process.cwd(), path.join(outDir, name))}`);
  if (readme) readme = readme.replace(new RegExp(`assets/terminal-${mode}(-[0-9a-f]+)?\\.svg`, "g"), `assets/${name}`);
}
if (readme) {
  fs.writeFileSync(readmePath, readme);
  console.log(`updated ${path.relative(process.cwd(), readmePath)}`);
}
