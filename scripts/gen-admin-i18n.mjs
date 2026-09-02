/**
 * Generates the `admin` block in both dictionaries from one source of truth.
 *
 * The admin surface has a few hundred strings and they must stay in lockstep
 * across languages. Keeping the pairs side by side here means a new string
 * cannot be added to English and forgotten in Hebrew — the generator writes
 * both or neither.
 *
 * Run: node scripts/gen-admin-i18n.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";

const T = {
  title: ["ClipRewards Admin", "ניהול ClipRewards"],
  metaTitle: ["Admin — ClipRewards", "ניהול — ClipRewards"],
  signedInAs: ["Signed in as {email}", "מחוברים בתור {email}"],
  administrator: ["Administrator", "מנהל"],
  signOut: ["Sign out", "התנתקות"],
  navLabel: ["Admin sections", "מדורי הניהול"],
  openNav: ["Open navigation", "פתיחת הניווט"],
  closeNav: ["Close navigation", "סגירת הניווט"],
  refresh: ["Refresh", "רענון"],
  lastUpdated: ["Updated {time}", "עודכן {time}"],
  timezoneNote: ["All times in {tz}", "כל הזמנים ב-{tz}"],

  groupBusiness: ["Business", "עסקי"],
  groupAnalytics: ["Analytics", "אנליטיקס"],
  groupPlatform: ["Platform", "פלטפורמה"],
  groupAdmin: ["Admin", "ניהול"],

  deniedTitle: ["Access denied", "הגישה נדחתה"],
  deniedBody: [
    "This account does not have administrator access. If you believe that is wrong, ask an existing administrator to grant it.",
    "לחשבון הזה אין הרשאת ניהול. אם לדעתכם זו טעות, בקשו ממנהל קיים להעניק אותה.",
  ],
  deniedHome: ["Back to the site", "חזרה לאתר"],
  unconfiguredTitle: ["Admin access is not configured", "הרשאת הניהול אינה מוגדרת"],
  unconfiguredBody: [
    "The server has no Firebase service account, so no identity can be verified. Access stays closed until it is configured.",
    "לשרת אין חשבון שירות של Firebase, ולכן אי אפשר לאמת אף זהות. הגישה נשארת חסומה עד שההגדרה תושלם.",
  ],

  loading: ["Loading…", "טוען…"],
  errorTitle: ["Could not load this panel", "לא ניתן לטעון את הפאנל"],
  errorBody: [
    "The query failed. Other panels on this page are unaffected.",
    "השאילתה נכשלה. שאר הפאנלים בעמוד לא הושפעו.",
  ],
  retry: ["Try again", "נסו שוב"],
  noData: ["No data yet", "אין עדיין נתונים"],
  noDataBody: ["Nothing has been recorded for this range.", "לא נרשם דבר בטווח הזה."],
  unavailable: ["Not available", "לא זמין"],
  sourceNotConnected: ["Source not connected", "המקור אינו מחובר"],
  notImplemented: ["Not implemented", "לא מומש"],
  dbNotConfigured: ["Analytics database is not configured", "מסד נתוני האנליטיקס אינו מוגדר"],
  dbNotConfiguredBody: [
    "No DATABASE_URL is set, so nothing is being stored and no figure below would be real. Set it and run the migrations to begin collecting.",
    "לא מוגדר DATABASE_URL, ולכן שום דבר לא נשמר ואף נתון כאן לא יהיה אמיתי. הגדירו אותו והריצו את המיגרציות כדי להתחיל לאסוף.",
  ],

  dateRange: ["Date range", "טווח תאריכים"],
  rangeToday: ["Today", "היום"],
  rangeYesterday: ["Yesterday", "אתמול"],
  range7: ["7 days", "7 ימים"],
  range30: ["30 days", "30 ימים"],
  range90: ["90 days", "90 ימים"],
  rangeYear: ["This year", "השנה"],
  compare: ["Compare to", "השוואה מול"],
  compareNone: ["No comparison", "ללא השוואה"],
  comparePrevious: ["Previous period", "התקופה הקודמת"],
  compareYear: ["Previous year", "השנה שעברה"],
  compareUnavailable: ["Not enough history to compare", "אין מספיק היסטוריה להשוואה"],

  pageviews: ["Pageviews", "צפיות בעמודים"],
  uniqueVisitors: ["Unique visitors", "מבקרים ייחודיים"],
  sessions: ["Sessions", "סשנים"],
  recentlyActive: ["Recently active", "פעילים לאחרונה"],
  recentlyActiveHint: [
    "Sessions with activity in the last 5 minutes. This is not live presence.",
    "סשנים עם פעילות ב-5 הדקות האחרונות. זו אינה נוכחות בזמן אמת.",
  ],
  dau: ["DAU", "DAU"],
  wau: ["WAU", "WAU"],
  mau: ["MAU", "MAU"],
  activeUsersHint: [
    "Distinct signed-in accounts. Anonymous traffic is counted separately as visitors.",
    "חשבונות מחוברים ייחודיים. תנועה אנונימית נספרת בנפרד כמבקרים.",
  ],
  visitorsHint: [
    "Distinct browsers, identified by a first-party random id. Browsers, not people.",
    "דפדפנים ייחודיים, לפי מזהה אקראי משלנו. דפדפנים, לא אנשים.",
  ],
  newVisitors: ["New visitors", "מבקרים חדשים"],
  returningVisitors: ["Returning visitors", "מבקרים חוזרים"],
  avgSession: ["Avg. session", "משך סשן ממוצע"],

  trafficOverTime: ["Traffic over time", "תנועה לאורך זמן"],
  newVsReturning: ["New vs returning", "חדשים מול חוזרים"],
  activeUsers: ["Active users", "משתמשים פעילים"],
  topCountries: ["Top countries", "מדינות מובילות"],
  topPages: ["Top pages", "עמודים מובילים"],
  trafficSources: ["Traffic sources", "מקורות תנועה"],
  businessKpis: ["Business", "מדדים עסקיים"],

  financialSource: ["Financial data source", "מקור הנתונים הפיננסיים"],
  financialStatus: ["Not connected", "לא מחובר"],
  financialBody: [
    "Financial reporting activates when a trusted payment provider writes authoritative ledger records. Until then these figures are absent rather than zero — a zero would read as a business result.",
    "הדיווח הפיננסי יופעל כשספק תשלומים מהימן יכתוב רשומות ledger מוסמכות. עד אז הנתונים חסרים ולא אפס — אפס היה נקרא כתוצאה עסקית.",
  ],
  grossVolume: ["Gross campaign volume", "נפח קמפיינים ברוטו"],
  creatorPayouts: ["Creator payouts", "תשלומים ליוצרי תוכן"],
  platformRevenue: ["Platform revenue", "הכנסות הפלטפורמה"],
  refunds: ["Refunds", "החזרים"],
  processingFees: ["Processing fees", "עמלות סליקה"],
  netRevenue: ["Net platform revenue", "הכנסות נטו"],
  pendingPayouts: ["Pending payouts", "תשלומים ממתינים"],
  completedPayouts: ["Completed payouts", "תשלומים שהושלמו"],
  failedPayments: ["Failed payments", "תשלומים שנכשלו"],
  outstandingBalances: ["Outstanding balances", "יתרות פתוחות"],
  revenueOverTime: ["Revenue over time", "הכנסות לאורך זמן"],
  revenueByCurrency: ["Revenue by currency", "הכנסות לפי מטבע"],
  topBrandsBySpend: ["Top brands by spend", "מותגים מובילים לפי הוצאה"],
  topCampaignsByRevenue: ["Top campaigns by revenue", "קמפיינים מובילים לפי הכנסה"],
  multiCurrencyNote: [
    "Amounts in different currencies are never combined. Each currency is reported separately.",
    "סכומים במטבעות שונים לעולם לא מחוברים. כל מטבע מדווח בנפרד.",
  ],

  authenticatedUsers: ["Authenticated users", "משתמשים מחוברים"],
  creatorsLabel: ["Creators", "יוצרי תוכן"],
  brandsLabel: ["Brands", "מותגים"],
  adminsLabel: ["Admins", "מנהלים"],
  localeDistribution: ["Language", "שפה"],
  countryDistribution: ["Country", "מדינה"],
  onboardingStarted: ["Onboarding started", "התחילו הרשמה"],
  onboardingCompleted: ["Onboarding completed", "השלימו הרשמה"],
  brandFormSubmitted: ["Brand form submitted", "טופס מותג נשלח"],
  userId: ["User ID", "מזהה משתמש"],
  userType: ["Type", "סוג"],
  firstSeen: ["First seen", "נראה לראשונה"],
  lastSeen: ["Last seen", "נראה לאחרונה"],
  onboardingStatus: ["Onboarding", "הרשמה"],
  noIdentityNote: [
    "Email and display name are deliberately not stored in analytics. Firebase remains the identity system.",
    "אימייל ושם תצוגה לא נשמרים באנליטיקס במכוון. Firebase נשאר מערכת הזהות.",
  ],

  activityTitle: ["Activity", "פעילות"],
  realtimeBanner: [
    "True realtime presence is not enabled. This page shows sessions with activity in the last 5 minutes, which lags by up to that long.",
    "נוכחות בזמן אמת אינה מופעלת. העמוד מציג סשנים עם פעילות ב-5 הדקות האחרונות, בפיגור של עד אותו זמן.",
  ],
  currentPage: ["Last page", "עמוד אחרון"],
  device: ["Device", "מכשיר"],
  browser: ["Browser", "דפדפן"],
  duration: ["Duration", "משך"],

  geographyTitle: ["Geography", "גאוגרפיה"],
  visitorsByCountry: ["Visitors by country", "מבקרים לפי מדינה"],
  usersByCountry: ["Authenticated users by country", "משתמשים מחוברים לפי מדינה"],
  conversionByCountry: ["Conversion by country", "המרה לפי מדינה"],
  unknownCountry: ["Unknown", "לא ידוע"],
  countryHint: [
    "Country comes from a header our hosting provider attaches. No IP address is stored.",
    "המדינה מגיעה מ-header שספק האחסון מצרף. לא נשמרת כתובת IP.",
  ],

  source: ["Source", "מקור"],
  medium: ["Medium", "מדיום"],
  campaignParam: ["Campaign", "קמפיין"],
  direct: ["Direct", "ישיר"],
  utmReporting: ["UTM attribution", "ייחוס UTM"],

  page: ["Page", "עמוד"],
  ctaClicks: ["CTA clicks", "לחיצות CTA"],
  entrySessions: ["Entries", "כניסות"],
  exitSessions: ["Exits", "יציאות"],
  conversionRate: ["Conversion", "המרה"],

  funnelsTitle: ["Funnels", "משפכים"],
  creatorFunnel: ["Creator funnel", "משפך יוצרי תוכן"],
  brandFunnel: ["Brand funnel", "משפך מותגים"],
  stage: ["Stage", "שלב"],
  fromPrevious: ["From previous", "מהשלב הקודם"],
  fromStart: ["From start", "מההתחלה"],
  dropOff: ["Drop-off", "נשירה"],
  stVisitor: ["Unique visitor", "מבקר ייחודי"],
  stStartEarning: ["Start Earning clicked", "לחיצה על הכפתור הראשי"],
  stLoginStarted: ["Sign-in started", "התחלת התחברות"],
  stLoginCompleted: ["Sign-in completed", "השלמת התחברות"],
  stOnboardingStarted: ["Onboarding started", "תחילת הרשמה"],
  stOnboardingStep: ["Onboarding step reached", "הגעה לשלב בהרשמה"],
  stOnboardingDone: ["Onboarding completed", "השלמת הרשמה"],
  stBrandVisitor: ["Brand page visitor", "מבקר בעמוד המותגים"],
  stLaunchCta: ["Launch Campaign clicked", "לחיצה על השקת קמפיין"],
  stFormStarted: ["Form started", "התחלת מילוי טופס"],
  stFormSubmitted: ["Form submitted", "שליחת טופס"],
  stCampaignCreated: ["Campaign created", "קמפיין נוצר"],
  stCampaignFunded: ["Campaign funded", "קמפיין מומן"],
  stCampaignLaunched: ["Campaign launched", "קמפיין הושק"],

  campaignsTitle: ["Campaigns", "קמפיינים"],
  campaignSourceBody: [
    "No campaign database exists yet. The fictional campaigns on the public site are design placeholders, not business records, and are deliberately not reported here.",
    "עדיין אין מסד נתוני קמפיינים. הקמפיינים הבדיוניים באתר הציבורי הם מציינֵי מקום עיצוביים ולא רשומות עסקיות, והם במכוון לא מדווחים כאן.",
  ],
  creatorsSourceBody: [
    "Only what analytics can observe is shown. Earnings, submissions and approval rates need the creator product database, which does not exist yet.",
    "מוצג רק מה שהאנליטיקס יכול לראות. הכנסות, הגשות ושיעורי אישור דורשים את מסד נתוני היוצרים, שעדיין לא קיים.",
  ],
  brandsSourceBody: [
    "Only what analytics can observe is shown. Spend, campaigns per brand and retention need the brand product database, which does not exist yet.",
    "מוצג רק מה שהאנליטיקס יכול לראות. הוצאה, קמפיינים לכל מותג ושימור דורשים את מסד נתוני המותגים, שעדיין לא קיים.",
  ],
  observableNow: ["Observable today", "ניתן למדידה היום"],
  needsSource: ["Needs a data source", "דורש מקור נתונים"],

  eventsTitle: ["Events", "אירועים"],
  eventName: ["Event", "אירוע"],
  time: ["Time", "זמן"],
  metadata: ["Metadata", "מטא-דאטה"],
  filterAll: ["All", "הכול"],
  eventDetail: ["Event detail", "פרטי אירוע"],
  close: ["Close", "סגירה"],
  privacyNote: [
    "Only allow-listed fields are stored. No IP address, no full user-agent, no full referrer URL and no form content.",
    "נשמרים רק שדות מרשימת ההיתר. ללא כתובת IP, ללא user-agent מלא, ללא URL מפנה מלא וללא תוכן טפסים.",
  ],

  auditTitle: ["Audit log", "יומן ביקורת"],
  auditEmpty: ["No admin actions recorded yet.", "לא נרשמו עדיין פעולות ניהול."],
  action: ["Action", "פעולה"],
  targetType: ["Target type", "סוג יעד"],
  targetId: ["Target ID", "מזהה יעד"],
  adminLabel: ["Admin", "מנהל"],

  systemTitle: ["System", "מערכת"],
  statusConnected: ["Connected", "מחובר"],
  statusNotConfigured: ["Not configured", "לא מוגדר"],
  statusDurable: ["Durable", "נשמר"],
  statusDisabled: ["Disabled", "מושבת"],
  statusEnabled: ["Enabled", "מופעל"],
  statusNotEnabled: ["Not enabled", "לא מופעל"],
  svcAdminAuth: ["Admin authentication", "אימות ניהול"],
  svcDatabase: ["Database", "מסד נתונים"],
  svcAnalytics: ["Analytics collection", "איסוף אנליטיקס"],
  svcFinancial: ["Financial source", "מקור פיננסי"],
  svcRealtime: ["Realtime presence", "נוכחות בזמן אמת"],
  svcFirebase: ["Firebase", "Firebase"],
  svcWhop: ["Whop", "Whop"],
  svcMigrations: ["Migrations", "מיגרציות"],
  eventsStored: ["Events stored", "אירועים שנשמרו"],
  lastEvent: ["Last event", "אירוע אחרון"],
  never: ["Never", "אף פעם"],
  blockedBy: ["Blocked by", "חסום בגלל"],

  sortAsc: ["Sort ascending", "מיון עולה"],
  sortDesc: ["Sort descending", "מיון יורד"],
  previousPage: ["Previous page", "עמוד קודם"],
  nextPage: ["Next page", "עמוד הבא"],
  pageOf: ["Page {current} of {total}", "עמוד {current} מתוך {total}"],
  rows: ["{count} rows", "{count} שורות"],
  search: ["Search", "חיפוש"],
  chartSummary: ["Chart data as a table", "נתוני התרשים כטבלה"],
};

const NAV = {
  overview: ["Overview", "סקירה"],
  revenue: ["Revenue", "הכנסות"],
  users: ["Users", "משתמשים"],
  activity: ["Activity", "פעילות"],
  geography: ["Geography", "גאוגרפיה"],
  traffic: ["Traffic", "תנועה"],
  pages: ["Pages", "עמודים"],
  funnels: ["Funnels", "משפכים"],
  events: ["Events", "אירועים"],
  campaigns: ["Campaigns", "קמפיינים"],
  creators: ["Creators", "יוצרי תוכן"],
  brands: ["Brands", "מותגים"],
  audit: ["Audit Log", "יומן ביקורת"],
  system: ["System", "מערכת"],
};

function block(i) {
  const q = (s) => JSON.stringify(s);
  const lines = Object.entries(T).map(([k, v]) => `    ${k}: ${q(v[i])},`);
  const nav = Object.entries(NAV).map(([k, v]) => `      ${k}: ${q(v[i])},`);
  return `  admin: {\n${lines.join("\n")}\n    nav: {\n${nav.join("\n")}\n    },\n  },\n\n`;
}

for (const [file, i] of [
  ["src/i18n/dictionaries/en.ts", 0],
  ["src/i18n/dictionaries/he.ts", 1],
]) {
  let s = readFileSync(file, "utf8");
  const start = s.indexOf("  admin: {");
  const end = s.indexOf("  meta: {", start);
  s = s.slice(0, start) + block(i) + s.slice(end);
  writeFileSync(file, s);
}

console.log(`admin dictionary rewritten: ${Object.keys(T).length + Object.keys(NAV).length} keys per language`);
