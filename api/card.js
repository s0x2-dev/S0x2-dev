const { kv } = require("@vercel/kv");

const KV_KEY = "profile_views";
const username = "S0x2-dev", spotifyUserId = "31leep2d5rpspzgszzi6glolhul4", spotifyGreen = "#1db954";
const IGNORED_LANGUAGES = new Set(["HTML", "CSS", "Makefile", "Shell"]);

const theme = { background: "#171517", cardBackground: "#1d1b1d", border: "#212022", accent: "#91a1f1", text: "#c8c8c8", muted: "#8c8c8c", font: `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"` };

const escapeXml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const formatDate = (iso) => iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
const formatNumber = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
const decodeEntities = (t) => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)));

async function executeGraphQL(query, variables, token) {
  const res = await fetch("https://api.github.com/graphql", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "profile-card-generator" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
  return res.json();
}

async function httpGet(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "profile-card-generator" }, signal: AbortSignal.timeout(4000) });
    return res.ok ? await res.text() : "";
  } catch { return ""; }
}

async function fetchGitHubData(token) {
  const startTime = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await executeGraphQL(`query($login: String!, $startTime: DateTime!) { user(login: $login) { createdAt repositories(ownerAffiliations: OWNER, first: 100) { nodes { stargazerCount languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } } } } contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { contributionCount date } } } } commits: contributionsCollection(from: $startTime) { totalCommitContributions restrictedContributionsCount } reviews: contributionsCollection { totalPullRequestReviewContributions } pullRequests(first: 1) { totalCount } openIssues: issues(states: OPEN) { totalCount } closedIssues: issues(states: CLOSED) { totalCount } followers { totalCount } repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, PULL_REQUEST, REPOSITORY, PULL_REQUEST_REVIEW]) { totalCount } } }`, { login: username, startTime }, token);
  return data.user;
}

async function fetchSpotifyData() {
  const fallback = { trackName: null, artist: null, trackColor: theme.accent, albumArt: null };
  const data = await httpGet(`https://spotify-github-profile.kittinanx.com/api/view?uid=${spotifyUserId}`);
  if (!data || /class="not-play"/.test(data)) return fallback;

  const grab = (cls) => data.match(new RegExp(`class="${cls}"[^>]*>([^<]+)<`))?.[1] ? decodeEntities(data.match(new RegExp(`class="${cls}"[^>]*>([^<]+)<`))[1]).trim() : null;
  const song = grab("song"), artist = grab("artist");
  if (!song) return fallback;

  let albumArt = null;
  const coverEl = data.match(/<img\b[^>]+class="cover"[^>]*>/i) || data.match(/<img\b[^>]+src="(data:image\/[^"]+)"[^>]*class="cover"/i);
  if (coverEl) albumArt = coverEl[0].match(/src="(data:image\/[^"]+)"/i)?.[1] || null;
  if (!albumArt) {
    const all = [...data.matchAll(/data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]{200,})/g)];
    if (all.length) albumArt = `data:${all[all.length - 1][1]};base64,${all[all.length - 1][2]}`;
  }
  return { trackName: song, artist: artist || "", trackColor: theme.accent, albumArt };
}

async function fetchProfileViews() {
  try { return await kv.incr(KV_KEY); } catch { return 0; }
}

function calculateStreak(weeks) {
  const allDays = weeks.flatMap((w) => w.contributionDays).sort((a, b) => (a.date < b.date ? 1 : -1));
  const today = new Date().toISOString().slice(0, 10);
  let current = 0, longest = 0, tmp = 0, start = "", end = "";

  for (const day of allDays) {
    if (day.date > today) continue;
    if (current === 0 && day.contributionCount === 0 && day.date !== today) break;
    if (day.contributionCount > 0) {
      current++;
      if (!end) end = day.date;
      start = day.date;
    } else if (day.date !== today) break;
  }
  for (const day of [...allDays].reverse()) {
    tmp = day.contributionCount > 0 ? tmp + 1 : 0;
    if (tmp > longest) longest = tmp;
  }
  return { current, longest, startDate: start, endDate: end };
}

function getTopLanguages(repos) {
  const map = {};
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      if (IGNORED_LANGUAGES.has(node.name)) continue;
      map[node.name] = map[node.name] || { size: 0, color: node.color || theme.muted };
      map[node.name].size += size;
    }
  }
  const top = Object.entries(map).sort((a, b) => b[1].size - a[1].size).slice(0, 5);
  const total = top.reduce((s, [, d]) => s + d.size, 0);
  return total === 0 ? [] : top.map(([name, { size, color }]) => ({ name: name.length > 13 ? name.slice(0, 12) + "." : name, color, percentage: ((size / total) * 100).toFixed(1) }));
}

function calculateRank({ commits, pullRequests, issues, reviews, stars, streak }) {
  const commitPts = Math.min(50, (commits / 2000) * 50);
  const streakPts = Math.min(25, (streak / 30) * 25);
  const collabPts = Math.min(15, ((pullRequests * 2 + issues + reviews * 2) / 30) * 15);
  const starPts = Math.min(10, (stars / 10) * 10);

  const score = Math.min(98, Math.round(commitPts + streakPts + collabPts + starPts));
  let level = "B";
  if (score >= 95) level = "S";
  else if (score >= 85) level = "A+";
  else if (score >= 75) level = "A";
  else if (score >= 65) level = "A-";
  else if (score >= 55) level = "B+";
  else if (score >= 45) level = "B";
  else level = "B-";

  return { level, score };
}

function createDonutChart(languages, cx, cy, r) {
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const segs = languages.map(({ color, percentage }) => {
    const dash = (percentage / 100) * circ, seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="10" stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += dash;
    return seg;
  }).join("\n");
  return segs + `\n<circle cx="${cx}" cy="${cy}" r="${r - 14}" fill="${theme.cardBackground}"/>`;
}

function createLanguageLegend(languages, posX, startY, gap) {
  return languages.map(({ name, color, percentage }, i) => `<circle cx="${posX}" cy="${startY + i * gap - 4}" r="4" fill="${color}"/><text x="${posX + 11}" y="${startY + i * gap}" ${theme.font} font-size="12" fill="${theme.text}">${escapeXml(name)} <tspan fill="${theme.muted}">${percentage}%</tspan></text>`).join("\n");
}

function createFlame(cx, cy, size, color, stroke) {
  const scale = size / 24, sw = (stroke / scale).toFixed(2);
  return `<g transform="translate(${cx - 12 * scale} ${cy - 12 * scale}) scale(${scale})"><path d="M 19.48 12.35 c -1.57 -4.08 -7.16 -4.3 -5.81 -10.23 c .1 -.44 -.37 -.78 -.75 -.55 C 9.29 3.71 6.68 8 8.87 13.62 c .18 .46 -.36 .89 -.75 .59 c -1.81 -1.37 -2 -3.34 -1.84 -4.75 c .06 -.52 -.62 -.77 -.91 -.34 C 4.69 10.16 4 11.84 4 14.37 c .38 5.6 5.11 7.32 6.81 7.54 c 2.43 .31 5.06 -.14 6.95 -1.87 c 2.08 -1.93 2.84 -5.01 1.72 -7.69 z" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"/></g>`;
}

function createViewsBadge(viewCount, rightX, centerY) {
  const h = 34, pad = 15, fs = 14, label = "Profile Views", count = formatNumber(viewCount);
  const lw = Math.round(label.length * fs * 0.54) + pad * 2, cw = Math.round(count.length * fs * 0.62) + pad * 2;
  const x = rightX - lw - cw, y = centerY - h / 2, ty = centerY + fs * 0.35, r = 6;
  return `<path d="M${x + r},${y} H${x + lw} V${y + h} H${x + r} Q${x},${y + h} ${x},${y + h - r} V${y + r} Q${x},${y} ${x + r},${y} Z" fill="${theme.accent}"/><path d="M${x + lw},${y} H${x + lw + cw - r} Q${x + lw + cw},${y} ${x + lw + cw},${y + r} V${y + h - r} Q${x + lw + cw},${y + h} ${x + lw + cw - r},${y + h} H${x + lw} Z" fill="${theme.background}" stroke="${theme.border}" stroke-width="0.5"/><text x="${x + lw / 2}" y="${ty}" ${theme.font} font-size="${fs}" font-weight="600" fill="${theme.background}" text-anchor="middle">${label}</text><text x="${x + lw + cw / 2}" y="${ty}" ${theme.font} font-size="${fs}" font-weight="700" fill="${theme.text}" text-anchor="middle">${count}</text>`;
}

function createBottomRow(spotify, viewCount) {
  const { trackName, artist, albumArt } = spotify, LINE_Y = 378, views = createViewsBadge(viewCount, 728, 409);
  if (!trackName) return `<line x1="16" y1="${LINE_Y}" x2="744" y2="${LINE_Y}" stroke="${theme.border}" stroke-width="0.5"/><text x="32" y="415" ${theme.font} font-size="12" fill="${theme.muted}">♫ Not playing</text>${views}`;

  const AX = 32, AY = LINE_Y + 3, AS = 46, AR = 7;
  const artBlock = albumArt ? `<defs><clipPath id="ac"><rect x="${AX}" y="${AY}" width="${AS}" height="${AS}" rx="${AR}"/></clipPath></defs><rect x="${AX - 1}" y="${AY - 1}" width="${AS + 2}" height="${AS + 2}" rx="${AR + 1}" fill="none" stroke="${theme.accent}" stroke-width="1.5" opacity="0.5"/><image href="${albumArt}" x="${AX}" y="${AY}" width="${AS}" height="${AS}" clip-path="url(#ac)" preserveAspectRatio="xMidYMid slice"/>` : "";
  const TX = albumArt ? AX + AS + 12 : 32, CLIP_W = 200, trackPx = trackName.length * 7.5, artistPx = artist.length * 6.5;

  const makeText = (text, x, y, fs, fw, fill, totalPx, id) => {
    const overflow = Math.round(totalPx - CLIP_W + 8);
    if (overflow <= 0) return `<text x="${x}" y="${y}" ${theme.font} font-size="${fs}" font-weight="${fw}" fill="${fill}">${escapeXml(text)}</text>`;
    const moveDur = Math.max(3, Math.round(overflow / 18)), pauseDur = 1.5, total = (moveDur * 2 + pauseDur * 3).toFixed(1);
    const t1 = (pauseDur / total).toFixed(3), t2 = ((pauseDur + moveDur) / total).toFixed(3), t3 = ((pauseDur + moveDur + pauseDur) / total).toFixed(3), t4 = ((pauseDur * 2 + moveDur * 2) / total).toFixed(3);
    return `<defs><clipPath id="cl${id}"><rect x="${x}" y="${y - fs}" width="${CLIP_W}" height="${fs + 4}"/></clipPath></defs><g clip-path="url(#cl${id})"><text x="${x}" y="${y}" ${theme.font} font-size="${fs}" font-weight="${fw}" fill="${fill}"><animateTransform attributeName="transform" type="translate" values="0,0; 0,0; -${overflow},0; -${overflow},0; 0,0; 0,0" keyTimes="0; ${t1}; ${t2}; ${t3}; ${t4}; 1" keySplines="0 0 1 1; 0.42 0 0.58 1; 0 0 1 1; 0.42 0 0.58 1; 0 0 1 1" calcMode="spline" dur="${total}s" repeatCount="indefinite" begin="1s"/>${escapeXml(text)}</text></g>`;
  };

  const textBlock = makeText(trackName, TX, AY + 17, 13, "700", theme.text, trackPx, "t") + makeText(artist, TX, AY + 33, 11, "400", theme.muted, artistPx, "a");

  const EQX = 398, baseY = AY + 42, BW = 3.5, BG = 3.5;
  const barsData = [
    { dur: "0.85s", h: "4;18;8;16;4", y: `${baseY - 4};${baseY - 18};${baseY - 8};${baseY - 16};${baseY - 4}` },
    { dur: "0.65s", h: "8;14;18;6;8", y: `${baseY - 8};${baseY - 14};${baseY - 18};${baseY - 6};${baseY - 8}` },
    { dur: "0.95s", h: "16;6;12;18;16", y: `${baseY - 16};${baseY - 6};${baseY - 12};${baseY - 18};${baseY - 16}` },
    { dur: "0.75s", h: "6;18;10;15;6", y: `${baseY - 6};${baseY - 18};${baseY - 10};${baseY - 15};${baseY - 6}` },
    { dur: "0.90s", h: "12;4;17;8;12", y: `${baseY - 12};${baseY - 4};${baseY - 17};${baseY - 8};${baseY - 12}` }
  ];

  const eqBars = barsData.map((b, i) => `<rect x="${EQX + i * (BW + BG)}" y="${baseY - 4}" width="${BW}" height="4" rx="1.5" fill="${theme.accent}"><animate attributeName="height" values="${b.h}" dur="${b.dur}" repeatCount="indefinite"/><animate attributeName="y" values="${b.y}" dur="${b.dur}" repeatCount="indefinite"/></rect>`).join("");

  return `<line x1="16" y1="${LINE_Y}" x2="744" y2="${LINE_Y}" stroke="${theme.border}" stroke-width="0.5"/>${artBlock}${textBlock}${eqBars}${views}`;
}

function generateSVG(userData, streak, languages, stars, commits, prs, issues, rank, spotify, viewCount, startDateText) {
  const total = userData.contributionsCollection.contributionCalendar.totalContributions;
  const rankCirc = 2 * Math.PI * 38, rankFill = (rank.score / 100) * rankCirc;
  const sCX = 380, sCY = 280, sR = 34, sStroke = 2.5;

  return `<svg width="760" height="456" viewBox="0 0 760 456" xmlns="http://www.w3.org/2000/svg" role="img">
  <title>S0x2-dev GitHub Stats</title>
  <defs><mask id="streak-ring-cut"><rect width="760" height="456" fill="white"/><rect x="${sCX - 6}" y="${sCY - sR - 2}" width="12" height="5" fill="black"/></mask></defs>
  <rect width="760" height="456" rx="10" fill="${theme.background}" stroke="${theme.border}" stroke-width="1"/>
  
  <rect x="16" y="16" width="454" height="188" rx="8" fill="${theme.cardBackground}" stroke="${theme.border}" stroke-width="0.5"/>
  <text x="32" y="44" ${theme.font} font-size="15" font-weight="600" fill="${theme.accent}">S0x2-dev's GitHub Stats</text>
  <text x="32" y="76" ${theme.font} font-size="13" fill="${theme.muted}">Total Stars Earned:</text><text x="260" y="76" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${stars}</text>
  <text x="32" y="100" ${theme.font} font-size="13" fill="${theme.muted}">Total Commits (last year):</text><text x="260" y="100" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${formatNumber(commits)}</text>
  <text x="32" y="124" ${theme.font} font-size="13" fill="${theme.muted}">Total PRs:</text><text x="260" y="124" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${prs}</text>
  <text x="32" y="148" ${theme.font} font-size="13" fill="${theme.muted}">Total Issues:</text><text x="260" y="148" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${issues}</text>
  <text x="32" y="172" ${theme.font} font-size="13" fill="${theme.muted}">Contributed to (last year):</text><text x="260" y="172" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${userData.repositoriesContributedTo.totalCount}</text>
  
  <circle cx="408" cy="112" r="38" fill="none" stroke="${theme.border}" stroke-width="3"/>
  <circle cx="408" cy="112" r="38" fill="none" stroke="${theme.accent}" stroke-width="3" stroke-dasharray="${rankFill.toFixed(1)} ${(rankCirc - rankFill).toFixed(1)}" stroke-dashoffset="0" transform="rotate(-90 408 112)"/>
  <text x="408" y="118" ${theme.font} font-size="18" font-weight="700" fill="${theme.text}" text-anchor="middle">${rank.level}</text>

  <rect x="482" y="16" width="262" height="188" rx="8" fill="${theme.cardBackground}" stroke="${theme.border}" stroke-width="0.5"/>
  <text x="506" y="44" ${theme.font} font-size="15" font-weight="600" fill="${theme.accent}">Most Used Languages</text>
  ${createLanguageLegend(languages, 506, 62, 22)}
  ${createDonutChart(languages, 685, 106, 34)}

  <rect x="16" y="220" width="728" height="220" rx="8" fill="${theme.cardBackground}" stroke="${theme.border}" stroke-width="0.5"/>
  <text x="137" y="293" ${theme.font} font-size="25" font-weight="700" fill="${theme.text}" text-anchor="middle">${total.toLocaleString()}</text>
  <text x="137" y="311" ${theme.font} font-size="12" fill="${theme.muted}" text-anchor="middle">Total Contributions</text>
  <text x="137" y="324" ${theme.font} font-size="11" fill="${theme.muted}" text-anchor="middle">${startDateText}</text>
  
  <line x1="259" y1="232" x2="259" y2="372" stroke="${theme.border}" stroke-width="0.5"/><line x1="501" y1="232" x2="501" y2="372" stroke="${theme.border}" stroke-width="0.5"/>
  <circle cx="${sCX}" cy="${sCY}" r="${sR}" fill="none" stroke="${theme.accent}" stroke-width="${sStroke}" mask="url(#streak-ring-cut)"/>
  ${createFlame(sCX, sCY - sR - 1, 20, theme.accent, sStroke)}

  <text x="${sCX}" y="${sCY + 9}" ${theme.font} font-size="25" font-weight="700" fill="${theme.text}" text-anchor="middle">${streak.current}</text>
  <text x="${sCX}" y="${sCY + sR + 30}" ${theme.font} font-size="17" font-weight="700" fill="${theme.accent}" text-anchor="middle">Current Streak</text>
  <text x="${sCX}" y="${sCY + sR + 48}" ${theme.font} font-size="11" fill="${theme.muted}" text-anchor="middle">${formatDate(streak.startDate)} - ${formatDate(streak.endDate)}</text>
  <text x="621" y="293" ${theme.font} font-size="25" font-weight="700" fill="${theme.text}" text-anchor="middle">${streak.longest}</text>
  <text x="621" y="311" ${theme.font} font-size="12" fill="${theme.muted}" text-anchor="middle">Longest Streak</text>

  ${createBottomRow(spotify, viewCount)}
</svg>`;
}

module.exports = async (req, res) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).send("GITHUB_TOKEN not set");

  try {
    const [gitHubUser, spotify, viewCount] = await Promise.all([fetchGitHubData(token), fetchSpotifyData(), fetchProfileViews()]);
    const languages = getTopLanguages(gitHubUser.repositories.nodes);
    const streak = calculateStreak(gitHubUser.contributionsCollection.contributionCalendar.weeks);
    const stars = gitHubUser.repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0);
    const commits = (gitHubUser.commits?.totalCommitContributions ?? 0) + (gitHubUser.commits?.restrictedContributionsCount ?? 0);
    const prs = gitHubUser.pullRequests?.totalCount ?? 0;
    const issues = (gitHubUser.openIssues?.totalCount ?? 0) + (gitHubUser.closedIssues?.totalCount ?? 0);
    const reviews = gitHubUser.reviews?.totalPullRequestReviewContributions ?? 0;

    const rank = calculateRank({ commits, pullRequests: prs, issues, reviews, stars, streak: streak.current });
    const accDate = new Date(gitHubUser.createdAt);
    const startDateText = `${formatDate(accDate)}, ${accDate.getFullYear()} - Present`;

    const svg = generateSVG(gitHubUser, streak, languages, stars, commits, prs, issues, rank, spotify, viewCount, startDateText);

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("ETag", `"${Date.now()}"`);
    return res.status(200).send(svg);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Error generating card");
  }
};
