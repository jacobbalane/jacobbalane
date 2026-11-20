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
    repos: repositories(ownerAffiliations: OWNER, isFork: false, first: 100, orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes { languages(first: 10, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name color } } } }
    }
    contributionsCollection { contributionCalendar { totalContributions } }
  }
}`;

// GitHub returns at most one year of contributions per collection, so the
// all-time history asks for one aliased collection per calendar year.
function historyQuery(years) {
  const fields = years.map((year) => {
    const to = year === now.getUTCFullYear() ? now.toISOString() : `${year}-12-31T23:59:59Z`;
    return `y${year}: contributionsCollection(from: "${year}-01-01T00:00:00Z", to: "${to}") { contributionCalendar { weeks { contributionDays { date contributionCount } } } }`;
  });
  return `query($login: String!) { user(login: $login) { ${fields.join(" ")} } }`;
}

async function graphql(query) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Set GITHUB_TOKEN, or pass --raw <saved data>.");
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "profile-terminal" },
    body: JSON.stringify({ query, variables: { login: config.login } }),
  });
  const body = await res.json();
  if (!res.ok || body.errors || !body.data?.user) {
    throw new Error(`GitHub API request failed (${res.status}): ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data.user;
}

async function fetchData() {
  const user = await graphql(PROFILE_QUERY);
  const years = [];
  for (let year = new Date(user.createdAt).getUTCFullYear(); year <= now.getUTCFullYear(); year++) years.push(year);
  const history = await graphql(historyQuery(years));
  return { user, years: Object.fromEntries(years.map((year) => [year, history[`y${year}`].contributionCalendar])) };
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

function summarize({ user, years }) {
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

  const sizes = new Map();
  for (const repo of user.repos.nodes) {
    for (const { size, node } of repo.languages.edges) {
      if (config.excludeLanguages.includes(node.name)) continue;
      const entry = sizes.get(node.name) ?? { name: node.name, color: node.color ?? "#8b949e", size: 0 };
      entry.size += size;
      sizes.set(node.name, entry);
    }
  }
  const totalSize = [...sizes.values()].reduce((sum, l) => sum + l.size, 0) || 1;
  const languages = [...sizes.values()]
    .sort((a, b) => b.size - a.size)
    .slice(0, 5)
    .map((l) => ({ name: l.name, pct: Math.max(1, Math.round((l.size / totalSize) * 100)) }));

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
  };
}

function uptime(createdAt) {
  const start = new Date(createdAt);
  let months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + now.getUTCMonth() - start.getUTCMonth();
  if (now.getUTCDate() < start.getUTCDate()) months--;
  const unit = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [];
  if (months >= 12) parts.push(unit(Math.floor(months / 12), "year"));
  if (months % 12) parts.push(unit(months % 12, "month"));
  return parts.length ? `${parts.join(", ")} on GitHub` : "just joined GitHub";
}

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
const ADV = 7.8; // every monospace line is stretched to exactly this advance per character
const COLS = Math.floor((W - 2 * PAD) / ADV);
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_START_DAY = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

// Grays plus one accent color, chosen with "accent" in config.json.
const NEUTRALS = {
  dark: { fg: "#f0f6fc", muted: "#9198a1", card: "#151b23", bar: "#212830", border: "#3d444d" },
  light: { fg: "#1f2328", muted: "#59636e", card: "#f6f8fa", bar: "#eaeef2", border: "#d1d9e0" },
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
      .map(([str, color]) => `<tspan fill="${color}">${esc(str)}</tspan>`)
      .join("")}</text>`;
  };
  const comment = (str) => [[str, t.muted]];
  const row = (key, value, width = COLS) => {
    const head = `. ${key}: `;
    const dots = Math.max(3, width - head.length - 1 - value.length);
    return [[". ", t.muted], [`${key}:`, t.key], [` ${".".repeat(dots)} `, t.muted], [value, t.fg]];
  };
  // A prompt whose command types itself out: a cover and a cursor slide off it one character at a time.
  // Their resting position is past the end of the command, so without animation the text is simply shown.
  const prompt = (y, cmd, start) => {
    const cmdX = PAD + (host.length + 5) * ADV;
    let out = mono(PAD, y, [[host, t.accent], [" ~ % ", t.muted]]);
    if (!cmd) return { svg: out, end: start, cursorX: cmdX };
    out += mono(cmdX, y, [[cmd, t.fg]]);
    const dist = cmd.length * ADV;
    const dur = cmd.length * 0.055;
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
  const first = prompt(y, "neofetch", 0.6);
  o += first.svg;
  let clock = first.end + 0.25;

  // Profile, full width, in the dotted style of the original README.
  y += LH + 10;
  const profile = [
    comment(`# ${host}`),
    row("Kernel", config.role),
    row("Host", config.location),
    row("Uptime", uptime(s.createdAt)),
    row("Shell", config.shell),
    ...Object.entries(config.stack).map(([group, items]) => row(`Stack.${group}`, items.join(", "))),
  ];
  profile.forEach((segs, i) => {
    o += mono(PAD, y, segs, fade(clock + i * 0.06));
    y += LH;
  });
  clock += profile.length * 0.06;

  // GitHub stats on the left, languages on the right.
  y += LH;
  const half = Math.floor((COLS - 5) / 2);
  const stats = [
    comment("# github stats"),
    row("Repos.Public", fmt(s.publicRepos), half),
    row("Contributions", `${fmt(s.lastYear)} in the last year`, half),
    row("Streak", s.streak.current ? `${plural(s.streak.current, "day")} (best ${fmt(s.streak.best)})` : `best ${plural(s.streak.best, "day")}`, half),
    row("Busiest.Day", s.busiest, half),
    row("Followers", fmt(s.followers), half),
  ];
  const rightX = PAD + (half + 5) * ADV;
  const rightEnd = PAD + COLS * ADV;
  const barX = rightX + 12 * ADV;
  const barMax = rightEnd - 5 * ADV - barX;
  const maxPct = Math.max(...s.languages.map((l) => l.pct), 1);
  const rowsHere = Math.max(stats.length, s.languages.length + 1);
  for (let i = 0; i < rowsHere; i++) {
    const delay = clock + i * 0.06;
    if (stats[i]) o += mono(PAD, y, stats[i], fade(delay));
    if (i === 0) o += mono(rightX, y, comment("# languages"), fade(delay));
    const l = s.languages[i - 1];
    if (l) {
      o += mono(rightX, y, [[l.name.slice(0, 11), t.fg]], fade(delay));
      o += `<rect x="${barX.toFixed(1)}" y="${y - 9}" width="${barMax.toFixed(1)}" height="8" rx="4" fill="${t.heat[0]}" ${fade(delay)}/>`;
      o += `<rect x="${barX.toFixed(1)}" y="${y - 9}" width="${((barMax * l.pct) / maxPct).toFixed(1)}" height="8" rx="4" fill="${t.accent}" class="g" style="animation-delay:${(delay + 0.1).toFixed(2)}s"/>`;
      o += mono(rightEnd - 4 * ADV, y, [[`${l.pct}%`.padStart(4), t.muted]], fade(delay));
    }
    y += LH;
  }
  clock += rowsHere * 0.06 + 0.3;

  // All-time contributions: one row per year, one square per week.
  y += 14;
  const second = prompt(y, "cal --contributions --all", clock + 0.25);
  o += `<g ${fade(clock)}>${second.svg}</g>`;
  clock = second.end + 0.2;
  const labelW = 5 * ADV;
  const gridX = PAD + labelW;
  const step = (COLS * ADV - labelW + 3) / 53; // the grid ends where the text does
  const cell = step - 3;
  const gridTop = y + 30;
  MONTHS.forEach((name, m) => {
    o += mono(gridX + Math.round(MONTH_START_DAY[m] / 7) * step, gridTop - 9, [[name, t.muted]], `font-size="11" ${fade(clock)}`);
  });
  const columns = Array(53).fill("");
  s.grid.forEach((yearRow, r) => {
    const top = gridTop + r * step;
    o += mono(PAD, top + cell / 2 + 4, [[String(yearRow.year), t.muted]], `font-size="11" ${fade(clock)}`);
    yearRow.weeks.forEach((week, c) => {
      if (!week.active) return; // before joining GitHub, or still ahead this year
      columns[c] += `<rect x="${(gridX + c * step).toFixed(1)}" y="${top.toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" rx="2" fill="${t.heat[week.level]}"/>`;
    });
  });
  columns.forEach((cells, c) => {
    if (cells) o += `<g ${fade(clock + c * 0.018)}>${cells}</g>`;
  });
  clock += 53 * 0.018;

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
  for (const line of config.heatmapNote ? wrap(config.heatmapNote, COLS - 2) : []) {
    y += LH;
    o += mono(PAD, y, comment(`# ${line}`), fade(clock));
  }

  // Final prompt with a blinking cursor.
  y += LH + 14;
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
    `.c{animation:c 1.1s step-end infinite}@keyframes c{50%{opacity:0}}` +
    css +
    `@media (prefers-reduced-motion:reduce){*{animation:none!important}}`;
  const label =
    `Terminal running neofetch for ${host}: ${config.role} in ${config.location}, ` +
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
