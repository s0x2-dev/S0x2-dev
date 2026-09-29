const fs = require("fs");

const username = "S0x2-dev", token = process.env.GITHUB_TOKEN, spotifyUserId = "31leep2d5rpspzgszzi6glolhul4", spotifyGreen = "#1db954";
const IGNORED_LANGUAGES = new Set(["HTML", "CSS", "Makefile", "Shell"]);
const theme = { background: "#171517", cardBackground: "#1d1b1d", border: "#212022", accent: "#91a1f1", text: "#c8c8c8", muted: "#8c8c8c", font: `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"` };

const escapeXml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const decodeEntities = (t) => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)));
const formatDate = (iso) => iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
const formatNumber = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);

async function executeGraphQL(query, variables) {
  const res = await fetch("https://api.github.com/graphql", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "profile-card-generator" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`GitHub GraphQL API error: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchSpotifyData() {
  const fallback = { trackName: null, trackColor: spotifyGreen, isPlaying: false };
  try {
    const res = await fetch(`https://spotify-github-profile.kittinanx.com/api/view?uid=${spotifyUserId}`, { headers: { "User-Agent": "profile-card-generator" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return fallback;
    const data = await res.text();
    if (/class="not-play"/.test(data)) return fallback;
    const grab = (cls) => data.match(new RegExp(`class="${cls}"[^>]*>([^<]+)<`))?.[1] ? decodeEntities(data.match(new RegExp(`class="${cls}"[^>]*>([^<]+)<`))[1]).trim() : null;
    const song = grab("song"), artist = grab("artist");
    return song ? { trackName: artist ? `${song} — ${artist}` : song, trackColor: spotifyGreen, isPlaying: true } : fallback;
  } catch { return fallback; }
}

async function fetchGitHubData() {
  const cur = new Date().getFullYear(), prev = cur - 1;
  const yearFragments = [{ year: cur, key: "current" }, { year: prev, key: "previous" }].map(({ year, key }) => `${key}: contributionsCollection(from: "${year}-01-01T00:00:00Z", to: "${year}-12-31T23:59:59Z") { totalCommitContributions totalPullRequestContributions totalIssueContributions restrictedContributionsCount }`).join(" ");
  const { data } = await executeGraphQL(`query($login: String!) { user(login: $login) { createdAt repositories(ownerAffiliations: OWNER, first: 100) { nodes { stargazerCount languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } } } } contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { contributionCount date } } } } ${yearFragments} followers { totalCount } repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, PULL_REQUEST, REPOSITORY, PULL_REQUEST_REVIEW]) { totalCount } } }`, { login: username });
  return data.user;
}

function calculateStreak(weeks) {
  const allDays = weeks.flatMap((w) => w.contributionDays).sort((a, b) => (a.date < b.date ? 1 : -1));
  const today = new Date().toISOString().slice(0, 10);
  let current = 0, longest = 0, temp = 0, startDate = "", endDate = "";

  for (const day of allDays) {
    if (day.date > today) continue;
    if (current === 0 && day.contributionCount === 0 && day.date !== today) break;
    if (day.contributionCount > 0) {
      current++;
      if (!endDate) endDate = day.date;
      startDate = day.date;
    } else if (day.date !== today) break;
  }

  for (const day of [...allDays].reverse()) {
    temp = day.contributionCount > 0 ? temp + 1 : 0;
    if (temp > longest) longest = temp;
  }
  return { current, longest, startDate, endDate };
}

function getTopLanguages(repositories) {
  const map = {};
  for (const repo of repositories) {
    for (const { size, node } of repo.languages.edges) {
      if (IGNORED_LANGUAGES.has(node.name)) continue;
      map[node.name] = map[node.name] || { size: 0, color: node.color || theme.muted };
      map[node.name].size += size;
    }
  }
  const top = Object.entries(map).sort((a, b) => b[1].size - a[1].size).slice(0, 5);
  const totalSize = top.reduce((sum, [, d]) => sum + d.size, 0);
  return totalSize === 0 ? [] : top.map(([name, { size, color }]) => ({ name: name.length > 13 ? name.slice(0, 12) + "." : name, color, percentage: ((size / totalSize) * 100).toFixed(1) }));
}

function calculateRank({ commits, pullRequests, issues, stars, followers }) {
  const expCdf = (x) => 1 - Math.pow(2, -x);
  const normCdf = (m, s, v) => {
    const z = (v - m) / Math.sqrt(2 * s * s), t = 1 / (1 + 0.3275911 * Math.abs(z));
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-z * z);
    return 0.5 * (1 + (z >= 0 ? erf : -erf));
  };
  const score = (2 * expCdf(commits / 250) + 3 * expCdf(pullRequests / 50) + 1 * expCdf(issues / 25) + 4 * expCdf(stars / 50) + 1 * expCdf(followers / 10)) / 11;
  const percentile = 100 - 100 * normCdf(score, 1, 0.75);
  const grade = percentile <= 5 ? "S" : percentile <= 25 ? "A+" : percentile <= 50 ? "A" : percentile <= 70 ? "B+" : percentile <= 85 ? "B" : "B-";
  return { percentile, grade };
}

function createDonutChart(languages, cx, cy, r) {
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const segments = languages.map(({ color, percentage }) => {
    const dash = (percentage / 100) * circ, seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="10" stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += dash;
    return seg;
  }).join("\n");
  return segments + `\n<circle cx="${cx}" cy="${cy}" r="${r - 14}" fill="${theme.cardBackground}"/>`;
}

function createLanguageLegend(languages, x, y, gap) {
  return languages.map(({ name, color, percentage }, i) => `<circle cx="${x}" cy="${y + i * gap - 4}" r="4" fill="${color}"/><text x="${x + 11}" y="${y + i * gap}" ${theme.font} font-size="12" fill="${theme.text}">${escapeXml(name)} <tspan fill="${theme.muted}">${percentage}%</tspan></text>`).join("");
}

function createFlame(cx, cy, size, color, stroke) {
  const scale = size / 24, tx = cx - 12 * scale, ty = cy - 12 * scale, sw = (stroke / scale).toFixed(2);
  return `<g transform="translate(${tx} ${ty}) scale(${scale})"><path d="M 19.48 12.35 c -1.57 -4.08 -7.16 -4.3 -5.81 -10.23 c .1 -.44 -.37 -.78 -.75 -.55 C 9.29 3.71 6.68 8 8.87 13.62 c .18 .46 -.36 .89 -.75 .59 c -1.81 -1.37 -2 -3.34 -1.84 -4.75 c .06 -.52 -.62 -.77 -.91 -.34 C 4.69 10.16 4 11.84 4 14.37 c .38 5.6 5.11 7.32 6.81 7.54 c 2.43 .31 5.06 -.14 6.95 -1.87 c 2.08 -1.93 2.84 -5.01 1.72 -7.69 z" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"/></g>`;
}

function createSpotifyCard(trackName, color, isPlaying) {
  const leftX = 32, rowY = 415;
  if (!trackName || !isPlaying) return `<line x1="16" y1="390" x2="744" y2="390" stroke="${theme.border}" stroke-width="0.5"/><text x="${leftX}" y="${rowY}" ${theme.font} font-size="12" fill="${theme.muted}">♫ Not playing</text>`;
  const label = trackName.length > 42 ? trackName.slice(0, 41).trimEnd() + "…" : trackName, boxWidth = Math.min(360, 36 + label.length * 6.6).toFixed(0);
  return `<line x1="16" y1="390" x2="744" y2="390" stroke="${theme.border}" stroke-width="0.5"/><rect x="${leftX}" y="${rowY - 14}" width="${boxWidth}" height="26" rx="4" fill="${color}22"/><g transform="translate(${leftX + 8}, ${rowY + 2})"><rect class="eq-bar eq-1" x="0" y="-11" width="2.5" height="11" rx="1.2" fill="${color}"/><rect class="eq-bar eq-2" x="4.5" y="-11" width="2.5" height="11" rx="1.2" fill="${color}"/><rect class="eq-bar eq-3" x="9" y="-11" width="2.5" height="11" rx="1.2" fill="${color}"/></g><text x="${leftX + 27}" y="${rowY + 5}" ${theme.font} font-size="12" font-weight="600" fill="${theme.text}">${escapeXml(label)}</text>`;
}

function generateSVG(userData, streakInfo, languages, stars, commits, prs, issues, rank, spotify, startDate) {
  const total = userData.contributionsCollection.contributionCalendar.totalContributions;
  const rankCirc = 2 * Math.PI * 38, rankFill = (1 - rank.percentile / 100) * rankCirc, rankGap = rankCirc - rankFill;
  const flameSVG = createFlame(380, 245, 20, theme.accent, 2.5);

  return `<svg width="760" height="456" viewBox="0 0 760 456" xmlns="http://www.w3.org/2000/svg" role="img">
    <title>S0x2-dev GitHub Stats</title>
    <defs>
      <mask id="streak-cut"><rect width="760" height="456" fill="white"/><rect x="374" y="244" width="12" height="5" fill="black"/></mask>
      <style>
        .eq-bar { transform-origin: bottom; animation: eq 1.2s ease-in-out infinite alternate; }
        .eq-1 { animation-delay: 0.1s; } .eq-2 { animation-delay: 0.4s; } .eq-3 { animation-delay: 0.7s; }
        @keyframes eq { 0% { transform: scaleY(0.25); } 100% { transform: scaleY(1); } }
      </style>
    </defs>
    <rect width="760" height="456" rx="10" fill="${theme.background}" stroke="${theme.border}" stroke-width="1"/>
    
    <rect x="16" y="16" width="454" height="188" rx="8" fill="${theme.cardBackground}" stroke="${theme.border}" stroke-width="0.5"/>
    <text x="32" y="44" ${theme.font} font-size="15" font-weight="600" fill="${theme.accent}">S0x2-dev's GitHub Stats</text>
    <text x="32" y="76" ${theme.font} font-size="13" fill="${theme.muted}">Total Stars Earned:</text><text x="260" y="76" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${stars}</text>
    <text x="32" y="100" ${theme.font} font-size="13" fill="${theme.muted}">Total Commits:</text><text x="260" y="100" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${formatNumber(commits)}</text>
    <text x="32" y="124" ${theme.font} font-size="13" fill="${theme.muted}">Total PRs:</text><text x="260" y="124" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${prs}</text>
    <text x="32" y="148" ${theme.font} font-size="13" fill="${theme.muted}">Total Issues:</text><text x="260" y="148" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${issues}</text>
    <text x="32" y="172" ${theme.font} font-size="13" fill="${theme.muted}">Contributed to (last year):</text><text x="260" y="172" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${userData.repositoriesContributedTo.totalCount}</text>

    <circle cx="408" cy="112" r="38" fill="none" stroke="${theme.border}" stroke-width="3"/>
    <circle cx="408" cy="112" r="38" fill="none" stroke="${theme.accent}" stroke-width="3" stroke-dasharray="${rankFill.toFixed(1)} ${rankGap.toFixed(1)}" stroke-dashoffset="0" transform="rotate(-90 408 112)"/>
    <text x="408" y="118" ${theme.font} font-size="18" font-weight="700" fill="${theme.text}" text-anchor="middle">${rank.grade}</text>

    <rect x="482" y="16" width="262" height="188" rx="8" fill="${theme.cardBackground}" stroke="${theme.border}" stroke-width="0.5"/>
    <text x="506" y="44" ${theme.font} font-size="15" font-weight="600" fill="${theme.accent}">Most Used Languages</text>
    ${createLanguageLegend(languages, 506, 64, 22)}
    ${createDonutChart(languages, 685, 119, 34)}

    <rect x="16" y="220" width="728" height="220" rx="8" fill="${theme.cardBackground}" stroke="${theme.border}" stroke-width="0.5"/>
    <text x="137" y="293" ${theme.font} font-size="25" font-weight="700" fill="${theme.text}" text-anchor="middle">${total.toLocaleString()}</text>
    <text x="137" y="311" ${theme.font} font-size="12" fill="${theme.muted}" text-anchor="middle">Total Contributions</text>
    <text x="137" y="324" ${theme.font} font-size="11" fill="${theme.muted}" text-anchor="middle">${startDate}</text>

    <line x1="259" y1="232" x2="259" y2="372" stroke="${theme.border}" stroke-width="0.5"/><line x1="501" y1="232" x2="501" y2="372" stroke="${theme.border}" stroke-width="0.5"/>

    <circle cx="380" cy="280" r="34" fill="none" stroke="${theme.accent}" stroke-width="2.5" mask="url(#streak-cut)"/>
    ${flameSVG}
    <text x="380" y="289" ${theme.font} font-size="25" font-weight="700" fill="${theme.text}" text-anchor="middle">${streakInfo.current}</text>
    <text x="380" y="344" ${theme.font} font-size="17" font-weight="700" fill="${theme.accent}" text-anchor="middle">Current Streak</text>
    <text x="380" y="362" ${theme.font} font-size="11" fill="${theme.muted}" text-anchor="middle">${formatDate(streakInfo.startDate)} - ${formatDate(streakInfo.endDate)}</text>

    <text x="621" y="293" ${theme.font} font-size="25" font-weight="700" fill="${theme.text}" text-anchor="middle">${streakInfo.longest}</text>
    <text x="621" y="311" ${theme.font} font-size="12" fill="${theme.muted}" text-anchor="middle">Longest Streak</text>

    ${createSpotifyCard(spotify.trackName, spotify.trackColor, spotify.isPlaying)}
  </svg>`;
}

(async () => {
  const [gitHubUser, spotifyData] = await Promise.all([fetchGitHubData(), fetchSpotifyData()]);
  const topLanguages = getTopLanguages(gitHubUser.repositories.nodes);
  const streakData = calculateStreak(gitHubUser.contributionsCollection.contributionCalendar.weeks);
  const totalStars = gitHubUser.repositories.nodes.reduce((sum, repo) => sum + repo.stargazerCount, 0);

  const totalCommits = (gitHubUser.current?.totalCommitContributions ?? 0) + (gitHubUser.previous?.totalCommitContributions ?? 0) + (gitHubUser.current?.restrictedContributionsCount ?? 0) + (gitHubUser.previous?.restrictedContributionsCount ?? 0);
  const totalPullRequests = (gitHubUser.current?.totalPullRequestContributions ?? 0) + (gitHubUser.previous?.totalPullRequestContributions ?? 0);
  const totalIssues = (gitHubUser.current?.totalIssueContributions ?? 0) + (gitHubUser.previous?.totalIssueContributions ?? 0);

  const rank = calculateRank({ commits: gitHubUser.current?.totalCommitContributions ?? 0, pullRequests: totalPullRequests, issues: totalIssues, stars: totalStars, followers: gitHubUser.followers.totalCount });
  const createdDate = new Date(gitHubUser.createdAt);
  const accountStartDate = `${createdDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${createdDate.getFullYear()} - Present`;

  const svgOutput = generateSVG(gitHubUser, streakData, topLanguages, totalStars, totalCommits, totalPullRequests, totalIssues, rank, spotifyData, accountStartDate);
  fs.writeFileSync("profile-card.svg", svgOutput);
  console.log("profile-card.svg saved");
})().catch((err) => { console.error(err); process.exit(1); });
