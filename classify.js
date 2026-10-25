// Focus Cap domain classifier. puts a hostname into "distraction",
// "productive", or "neutral" using a list of well-known domains.
// Loaded before stats.js on stats page. unknown domains fall to "neutral".

const DISTRACTION_DOMAINS = [
  "youtube.com", "facebook.com", "instagram.com", "twitter.com", "x.com",
  "reddit.com", "tiktok.com", "twitch.tv", "netflix.com", "hulu.com",
  "primevideo.com", "disneyplus.com", "hbomax.com", "max.com", "pinterest.com",
  "snapchat.com", "tumblr.com", "9gag.com", "buzzfeed.com", "imgur.com",
  "quora.com", "threads.net", "dailymotion.com", "espn.com", "ign.com",
  "kotaku.com", "polygon.com", "tmz.com", "vice.com", "ladbible.com", "open.spotify.com"
];

const PRODUCTIVE_DOMAINS = [
  "github.com", "gitlab.com", "bitbucket.org", "stackoverflow.com",
  "stackexchange.com", "developer.mozilla.org", "docs.google.com",
  "drive.google.com", "mail.google.com", "calendar.google.com", "sheets.google.com",
  "notion.so", "figma.com", "linear.app", "atlassian.net", "trello.com",
  "asana.com", "slack.com", "overleaf.com", "wikipedia.org", "khanacademy.org",
  "coursera.org", "udemy.com", "edx.org", "leetcode.com", "hackerrank.com",
  "canva.com", "zoom.us", "office.com", "dropbox.com", "duolingo.com", 
  "classroom.google.com", "google.com","congressionalappchallenge.us"
];

// Classify a hostname/domain. `blocked` overrides to "distraction" visually,
// since the user already flagged it.
function classifyDomain(domain) {
  const d = (domain || "").replace(/^www\./, "").toLowerCase();
  const inList = (list) => list.some((x) => d === x || d.endsWith("." + x));
  if (inList(DISTRACTION_DOMAINS)) return "distraction";
  if (inList(PRODUCTIVE_DOMAINS)) return "productive";
  return "neutral";
}
