// Dynacat v2.4.0 configuration schema catalog — drives the Home-tab GUI builder.
// Source tag: 2.4.0 (commit 143ffe9f7178f072142c7d3fc91d995b0ae4e3dd). Option keys + Go types extracted
// from internal/dynacat/widget-*.go + config.go; descriptions/defaults/enums from docs/configuration.md
// + shared-widget-options.md. `contribution-graph` is intentionally excluded (defined but NOT registered
// in newWidget() in 2.4.0, so it can't be instantiated from config). `markets`/`stocks` are one widget.

export type DcOptType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'string[]'
  | 'object'
  | 'object[]'
  | 'duration'
  | 'color'

export interface DcOption {
  key: string
  label: string
  type: DcOptType
  default?: unknown
  enum?: string[]
  required?: boolean
  description?: string
  itemSchema?: DcOption[]
}

export interface DcWidgetDef {
  type: string
  label: string
  description?: string
  options: DcOption[]
}

// Shared options on EVERY widget (widgetBase + the per-widget `frameless`). Spread into each widget.
export const DYNACAT_SHARED_WIDGET_OPTIONS: DcOption[] = [
  { key: 'type', label: 'Type', type: 'string', required: true, description: 'The widget type. Determines which widget is rendered.' },
  { key: 'title', label: 'Title', type: 'string', description: 'The display name of the widget, shown in the widget header. Some widgets supply a default.' },
  { key: 'title-icon', label: 'Title Icon', type: 'string', description: 'Icon shown next to the widget title. Supports Simple Icons (si:), Material Design (mdi:), Dashboard Icons (di:) or a custom URL/path.' },
  { key: 'title-url', label: 'Title URL', type: 'string', description: 'Makes the widget title a clickable link to this URL (opens in a new tab).' },
  { key: 'hide-header', label: 'Hide Header', type: 'boolean', default: false, description: 'Completely hides the widget header (title and title icon).' },
  { key: 'css-class', label: 'CSS Class', type: 'string', description: 'Extra CSS class names applied to the widget, for use with a custom CSS file.' },
  { key: 'cache', label: 'Cache', type: 'duration', description: 'Overrides the widget default cache duration. Number + unit (s, m, h, d), e.g. 1h.' },
  { key: 'update-interval', label: 'Update Interval', type: 'duration', description: 'Polling interval for dynamic updates. Number + unit (s, m, h). Requires page-level dynamic-updates to be enabled.' },
  { key: 'lazy-load', label: 'Lazy Load', type: 'boolean', default: false, description: 'When true, the widget skips the initial blocking fetch and is loaded by JS after the page renders.' },
  { key: 'frameless', label: 'Frameless', type: 'boolean', default: false, description: 'Removes the border and padding around the widget so it blends with the background.' },
]

// ---- reusable nested item schemas ----
const CALENDAR_HOST_SCHEMA: DcOption[] = [
  { key: 'url', label: 'URL', type: 'string', required: true, description: 'Base URL of the Sonarr/Radarr instance, prefixed with the service type, e.g. radarr:https://radarr.domain.com or sonarr:https://sonarr.domain.com.' },
  { key: 'public-url', label: 'Public URL', type: 'string', description: 'Public-facing URL used for the links in the popover (when different from the internal url).' },
  { key: 'token', label: 'Token', type: 'string', description: 'API key/token for the Sonarr/Radarr instance.' },
  { key: 'allow-insecure', label: 'Allow Insecure', type: 'boolean', default: false, description: 'Allow insecure (self-signed certificate) connections.' },
]

const MARKET_REQUEST_SCHEMA: DcOption[] = [
  { key: 'symbol', label: 'Symbol', type: 'string', required: true, description: 'The ticker symbol of the market/stock (Yahoo Finance).' },
  { key: 'name', label: 'Name', type: 'string', description: 'Custom display name overriding the auto-detected one.' },
  { key: 'chart-link', label: 'Chart Link', type: 'string', description: 'Per-market override for the chart link. {SYMBOL} is replaced with the symbol.' },
  { key: 'symbol-link', label: 'Symbol Link', type: 'string', description: 'Per-market override for the symbol link. {SYMBOL} is replaced with the symbol.' },
  { key: 'invert-colors', label: 'Invert Colors', type: 'boolean', default: false, description: 'Invert the up/down color coding for this market.' },
]

const RSS_FEED_SCHEMA: DcOption[] = [
  { key: 'url', label: 'URL', type: 'string', required: true, description: 'The URL of the RSS/Atom feed.' },
  { key: 'title', label: 'Title', type: 'string', description: 'Optional custom title for the feed, overriding the title provided by the feed.' },
  { key: 'hide-categories', label: 'Hide Categories', type: 'boolean', default: false, description: 'Hide the feed item categories (detailed-list style only).' },
  { key: 'hide-description', label: 'Hide Description', type: 'boolean', default: false, description: 'Hide the feed item description (detailed-list style only).' },
  { key: 'limit', label: 'Limit', type: 'number', description: 'Maximum number of items to pull from this individual feed.' },
  { key: 'item-link-prefix', label: 'Item Link Prefix', type: 'string', description: 'Prefix prepended to each item link, useful for some self-hosted feeds.' },
  { key: 'headers', label: 'Headers', type: 'object', description: 'Map of HTTP headers to send when requesting this feed.' },
]

const MONITOR_SITE_SCHEMA: DcOption[] = [
  { key: 'title', label: 'Title', type: 'string', required: true, description: 'The title used to indicate the site.' },
  { key: 'url', label: 'URL', type: 'string', required: true, description: 'The URL of the site; used for the link and (unless check-url is set) for the status check.' },
  { key: 'check-url', label: 'Check URL', type: 'string', description: 'Alternate URL used for the status check instead of url.' },
  { key: 'error-url', label: 'Error URL', type: 'string', description: 'URL to navigate to when the site is in an error state.' },
  { key: 'method', label: 'Method', type: 'string', default: 'GET', description: 'HTTP method used for the status check.' },
  { key: 'description', label: 'Description', type: 'string', description: 'Short description shown beneath the site title.' },
  { key: 'icon', label: 'Icon', type: 'string', description: 'Icon shown for the site (same icon syntax as elsewhere).' },
  { key: 'timeout', label: 'Timeout', type: 'duration', default: '3s', description: 'Maximum time to wait for a response. Number + unit (s, m, h, d).' },
  { key: 'allow-insecure', label: 'Allow Insecure', type: 'boolean', default: false, description: 'Allow insecure (self-signed certificate) connections.' },
  { key: 'same-tab', label: 'Same Tab', type: 'boolean', default: false, description: 'Open the link in the same tab instead of a new one.' },
  { key: 'alt-status-codes', label: 'Alt Status Codes', type: 'string[]', description: 'Additional HTTP status codes (integers) to treat as a healthy response.' },
  {
    key: 'basic-auth', label: 'Basic Auth', type: 'object', description: 'HTTP basic auth credentials for the status check.', itemSchema: [
      { key: 'username', label: 'Username', type: 'string' },
      { key: 'password', label: 'Password', type: 'string' },
    ],
  },
]

const CUSTOM_API_REQUEST_OPTIONS: DcOption[] = [
  { key: 'url', label: 'URL', type: 'string', description: 'The URL to make the request to.' },
  { key: 'allow-insecure', label: 'Allow Insecure', type: 'boolean', default: false, description: 'Allow insecure (self-signed certificate) connections.' },
  { key: 'headers', label: 'Headers', type: 'object', description: 'Map of HTTP headers to send with the request.' },
  { key: 'parameters', label: 'Parameters', type: 'object', description: 'Query parameters appended to the request URL.' },
  { key: 'method', label: 'Method', type: 'string', default: 'GET', description: 'HTTP method for the request.' },
  { key: 'body-type', label: 'Body Type', type: 'enum', enum: ['json', 'string'], default: 'json', description: 'The type of the body sent with the request.' },
  { key: 'body', label: 'Body', type: 'object', description: 'The request body. Can be a string or a map (depending on body-type).' },
  { key: 'skip-json-validation', label: 'Skip JSON Validation', type: 'boolean', default: false, description: 'Skip validating that the response is valid JSON.' },
]

const SERVER_STATS_SERVER_SCHEMA: DcOption[] = [
  { key: 'type', label: 'Type', type: 'enum', enum: ['local', 'remote'], required: true, description: 'Whether to display statistics for the local server or a remote server.' },
  { key: 'name', label: 'Name', type: 'string', description: 'Display name of the server. Defaults to the hostname.' },
  { key: 'compact', label: 'Compact', type: 'boolean', default: false, description: 'Use a compact layout hiding system info, swap usage and the CPU 15-minute average.' },
  { key: 'hide-swap', label: 'Hide Swap', type: 'boolean', default: false, description: 'Hide swap usage.' },
  { key: 'url', label: 'URL', type: 'string', description: 'Base URL of the remote agent (type: remote).' },
  { key: 'token', label: 'Token', type: 'string', description: 'Auth token for the remote agent (type: remote).' },
  { key: 'timeout', label: 'Timeout', type: 'duration', description: 'Request timeout for the remote agent. Number + unit (s, m, h, d).' },
  { key: 'cpu-temp-sensor', label: 'CPU Temp Sensor', type: 'string', description: 'Name of the sensor to use for CPU temperature (type: local). Auto-detected when omitted.' },
  { key: 'hide-mountpoints-by-default', label: 'Hide Mountpoints By Default', type: 'boolean', default: false, description: 'Hide all mountpoints unless individually un-hidden (type: local).' },
  {
    key: 'mountpoints', label: 'Mountpoints', type: 'object', description: 'Map of mountpoint path to {name, hide} config (type: local).', itemSchema: [
      { key: 'name', label: 'Name', type: 'string', description: 'Display name for the mountpoint.' },
      { key: 'hide', label: 'Hide', type: 'boolean', description: 'Whether to hide this mountpoint.' },
    ],
  },
]

const PLAYING_HOST_SCHEMA: DcOption[] = [
  { key: 'url', label: 'URL', type: 'string', description: 'Base URL of the media server (Plex/Jellyfin/Navidrome).' },
  { key: 'username', label: 'Username', type: 'string', description: 'Username for the media server (where required).' },
  { key: 'token', label: 'Token', type: 'string', description: 'API token/key for the media server.' },
  { key: 'allow-insecure', label: 'Allow Insecure', type: 'boolean', default: false, description: 'Allow insecure (self-signed certificate) connections.' },
]

const LATEST_MEDIA_HOST_SCHEMA: DcOption[] = [
  { key: 'url', label: 'URL', type: 'string', description: 'Base URL of the media server.' },
  { key: 'public-url', label: 'Public URL', type: 'string', description: 'Public-facing URL used for links when different from url.' },
  { key: 'token', label: 'Token', type: 'string', description: 'API token/key for the media server.' },
  { key: 'allow-insecure', label: 'Allow Insecure', type: 'boolean', default: false, description: 'Allow insecure (self-signed certificate) connections.' },
  { key: 'libraries', label: 'Libraries', type: 'string[]', description: 'Restrict to these library names; empty means all libraries.' },
]

const TORRENTING_HOST_SCHEMA: DcOption[] = [
  { key: 'url', label: 'URL', type: 'string', description: 'Base URL of the torrent client web UI.' },
  { key: 'username', label: 'Username', type: 'string', description: 'Username for the torrent client.' },
  { key: 'password', label: 'Password', type: 'string', description: 'Password for the torrent client.' },
  { key: 'client', label: 'Client', type: 'enum', enum: ['qbittorrent', 'deluge', 'transmission'], default: 'qbittorrent', description: 'The torrent client type.' },
]

const NESTED_WIDGETS_SCHEMA: DcOption[] = [...DYNACAT_SHARED_WIDGET_OPTIONS]

export const DYNACAT_WIDGETS: DcWidgetDef[] = [
  {
    type: 'calendar', label: 'Calendar',
    description: 'A monthly calendar, optionally pulling upcoming releases from Sonarr/Radarr instances.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'first-day-of-week', label: 'First Day Of Week', type: 'enum', enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'], default: 'monday', description: 'The day of the week the calendar starts on.' },
      { key: 'hosts', label: 'Hosts', type: 'object[]', description: 'Sonarr/Radarr instances to pull upcoming releases from.', itemSchema: CALENDAR_HOST_SCHEMA },
    ],
  },
  {
    type: 'clock', label: 'Clock',
    description: 'A clock showing the current time, optionally for multiple timezones.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'hour-format', label: 'Hour Format', type: 'enum', enum: ['12h', '24h'], default: '24h', description: 'Whether to show the time in 12- or 24-hour format.' },
      {
        key: 'timezones', label: 'Timezones', type: 'object[]', description: 'Additional timezones to display.', itemSchema: [
          { key: 'timezone', label: 'Timezone', type: 'string', required: true, description: 'A tz database identifier such as Europe/London or America/New_York.' },
          { key: 'label', label: 'Label', type: 'string', description: 'Optional display label for the timezone (e.g. Home, Work).' },
        ],
      },
    ],
  },
  {
    type: 'weather', label: 'Weather',
    description: 'Current weather conditions and an hourly forecast for a location.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'location', label: 'Location', type: 'string', required: true, description: 'The location to display weather for.' },
      { key: 'units', label: 'Units', type: 'enum', enum: ['metric', 'imperial'], default: 'metric', description: 'Whether to show temperature in celsius (metric) or fahrenheit (imperial).' },
      { key: 'hour-format', label: 'Hour Format', type: 'enum', enum: ['12h', '24h'], default: '12h', description: 'Whether to show the hours of the day in 12- or 24-hour format.' },
      { key: 'show-area-name', label: 'Show Area Name', type: 'boolean', default: false, description: 'Display the state/administrative area in the location name.' },
      { key: 'hide-location', label: 'Hide Location', type: 'boolean', default: false, description: 'Do not display the location name on the widget.' },
    ],
  },
  {
    type: 'bookmarks', label: 'Bookmarks', description: 'Groups of links/bookmarks.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      {
        key: 'groups', label: 'Groups', type: 'object[]', description: 'Groups of bookmark links.', itemSchema: [
          { key: 'title', label: 'Title', type: 'string', description: 'Title of the group.' },
          { key: 'color', label: 'Color', type: 'color', description: 'HSL color for the group (e.g. "10 70 50").' },
          { key: 'same-tab', label: 'Same Tab', type: 'boolean', default: false, description: 'Open links in the same tab (group default).' },
          { key: 'hide-arrow', label: 'Hide Arrow', type: 'boolean', default: false, description: 'Hide the external-link arrow (group default).' },
          { key: 'target', label: 'Target', type: 'string', description: 'Link target attribute (group default).' },
          {
            key: 'links', label: 'Links', type: 'object[]', description: 'The links in this group.', itemSchema: [
              { key: 'title', label: 'Title', type: 'string', description: 'Display title of the link.' },
              { key: 'url', label: 'URL', type: 'string', description: 'The link destination.' },
              { key: 'description', label: 'Description', type: 'string', description: 'Optional description shown for the link.' },
              { key: 'icon', label: 'Icon', type: 'string', description: 'Icon for the link (same icon syntax as elsewhere).' },
              { key: 'same-tab', label: 'Same Tab', type: 'boolean', description: 'Open this link in the same tab (overrides the group default).' },
              { key: 'hide-arrow', label: 'Hide Arrow', type: 'boolean', description: 'Hide the external-link arrow for this link (overrides the group default).' },
              { key: 'target', label: 'Target', type: 'string', description: 'Link target attribute (overrides the group default).' },
            ],
          },
        ],
      },
    ],
  },
  {
    type: 'iframe', label: 'IFrame', description: 'Embed an arbitrary URL as an iframe.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'source', label: 'Source', type: 'string', required: true, description: 'The URL to embed.' },
      { key: 'height', label: 'Height', type: 'number', default: 300, description: 'Height of the iframe in pixels.' },
    ],
  },
  {
    type: 'html', label: 'HTML', description: 'Embed arbitrary HTML.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'source', label: 'Source', type: 'string', required: true, description: 'The HTML markup to render. Use the YAML | block scalar for multi-line content.' },
    ],
  },
  {
    type: 'hacker-news', label: 'Hacker News', description: 'Posts from Hacker News.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'limit', label: 'Limit', type: 'number', default: 15, description: 'Maximum number of posts to show.' },
      { key: 'sort-by', label: 'Sort By', type: 'enum', enum: ['top', 'new', 'best'], default: 'top', description: 'Order in which posts are returned.' },
      { key: 'extra-sort-by', label: 'Extra Sort By', type: 'enum', enum: ['engagement'], description: 'Additional sort applied on top of sort-by. Only "engagement" is available.' },
      { key: 'collapse-after', label: 'Collapse After', type: 'number', default: 5, description: 'How many posts are visible before the "SHOW MORE" button appears. Set to -1 to never collapse.' },
      { key: 'comments-url-template', label: 'Comments URL Template', type: 'string', description: 'Override the default comments link. {POST-ID} is replaced with the post ID.' },
    ],
  },
  {
    type: 'releases', label: 'Releases',
    description: 'Latest releases for repositories on GitHub, GitLab, Codeberg, or Docker Hub.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      {
        key: 'repositories', label: 'Repositories', type: 'object[]', description: 'Repositories to track. Each entry is "owner/repo" (optionally prefixed gitlab:/codeberg:/dockerhub:) or an object.', itemSchema: [
          { key: 'repository', label: 'Repository', type: 'string', required: true, description: 'The repository identifier, e.g. owner/repo, gitlab:group/proj, dockerhub:org/img.' },
          { key: 'include-prereleases', label: 'Include Prereleases', type: 'boolean', default: false, description: 'Include pre-releases for this repository.' },
        ],
      },
      { key: 'token', label: 'Token', type: 'string', description: 'GitHub token to increase rate limits / access private repos.' },
      { key: 'gitlab-token', label: 'GitLab Token', type: 'string', description: 'GitLab token to increase rate limits / access private repos.' },
      { key: 'limit', label: 'Limit', type: 'number', default: 10, description: 'Maximum number of releases to show.' },
      { key: 'collapse-after', label: 'Collapse After', type: 'number', default: 5, description: 'How many releases are visible before the "SHOW MORE" button appears. Set to -1 to never collapse.' },
      { key: 'name-only', label: 'Name Only', type: 'boolean', default: false, description: 'Show only the repository name without the version.' },
      { key: 'show-source-icon', label: 'Show Source Icon', type: 'boolean', default: false, description: 'Show an icon indicating the source (GitHub/GitLab/etc.).' },
    ],
  },
  {
    type: 'videos', label: 'Videos', description: 'Latest videos from YouTube channels or playlists.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'channels', label: 'Channels', type: 'string[]', description: 'List of YouTube channel IDs.' },
      { key: 'playlists', label: 'Playlists', type: 'string[]', description: 'List of YouTube playlist IDs.' },
      { key: 'limit', label: 'Limit', type: 'number', default: 25, description: 'Maximum number of videos to show.' },
      { key: 'style', label: 'Style', type: 'enum', enum: ['vertical-list', 'detailed-list', 'horizontal-cards', 'horizontal-cards-2'], default: 'horizontal-cards', description: 'Appearance of the widget.' },
      { key: 'collapse-after', label: 'Collapse After', type: 'number', default: 7, description: 'How many videos are visible before the "SHOW MORE" button appears (list styles). Set to -1 to never collapse.' },
      { key: 'collapse-after-rows', label: 'Collapse After Rows', type: 'number', default: 4, description: 'Number of rows visible before collapsing (card styles).' },
      { key: 'include-shorts', label: 'Include Shorts', type: 'boolean', default: false, description: 'Include YouTube Shorts in the results.' },
      { key: 'video-url-template', label: 'Video URL Template', type: 'string', default: 'https://www.youtube.com/watch?v={VIDEO-ID}', description: 'Template for the video link. {VIDEO-ID} is replaced with the video ID.' },
    ],
  },
  {
    type: 'markets', label: 'Markets / Stocks',
    description: 'A list of markets/stocks with current value, daily change and a small chart (Yahoo Finance). Also registered as type "stocks".',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'markets', label: 'Markets', type: 'object[]', description: 'Markets to display.', itemSchema: MARKET_REQUEST_SCHEMA },
      { key: 'stocks', label: 'Stocks', type: 'object[]', description: 'Stocks to display (alias list for markets).', itemSchema: MARKET_REQUEST_SCHEMA },
      { key: 'sort-by', label: 'Sort By', type: 'enum', enum: ['change', 'absolute-change'], description: 'Ordering of the markets. Omit to keep definition order.' },
      { key: 'chart-link-template', label: 'Chart Link Template', type: 'string', description: 'Template for the chart link applied to all markets. {SYMBOL} is replaced with the symbol.' },
      { key: 'symbol-link-template', label: 'Symbol Link Template', type: 'string', description: 'Template for the symbol link applied to all markets. {SYMBOL} is replaced with the symbol.' },
      { key: 'proxy', label: 'Proxy', type: 'string', description: 'Optional proxy URL used for the upstream requests (can also be an object form in YAML).' },
    ],
  },
  {
    type: 'reddit', label: 'Reddit', description: 'Posts from a subreddit.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'subreddit', label: 'Subreddit', type: 'string', required: true, description: 'The subreddit to pull posts from.' },
      { key: 'style', label: 'Style', type: 'enum', enum: ['vertical-list', 'horizontal-cards', 'vertical-cards'], default: 'vertical-list', description: 'Appearance of the widget.' },
      { key: 'show-thumbnails', label: 'Show Thumbnails', type: 'boolean', default: false, description: 'Show thumbnails next to posts (vertical-list style only).' },
      { key: 'show-flairs', label: 'Show Flairs', type: 'boolean', default: false, description: 'Show post flairs.' },
      { key: 'sort-by', label: 'Sort By', type: 'enum', enum: ['hot', 'new', 'top', 'rising'], default: 'hot', description: 'Order in which posts are returned.' },
      { key: 'top-period', label: 'Top Period', type: 'enum', enum: ['hour', 'day', 'week', 'month', 'year', 'all'], default: 'day', description: 'Time period (only when sort-by is top).' },
      { key: 'extra-sort-by', label: 'Extra Sort By', type: 'enum', enum: ['engagement'], description: 'Additional sort applied on top of sort-by. Only "engagement" is available.' },
      { key: 'search', label: 'Search', type: 'string', description: 'Keywords to search for within the subreddit.' },
      { key: 'limit', label: 'Limit', type: 'number', default: 15, description: 'Maximum number of posts to show.' },
      { key: 'collapse-after', label: 'Collapse After', type: 'number', default: 5, description: 'How many posts are visible before the "SHOW MORE" button appears. Set to -1 to never collapse. Not available for card styles.' },
      { key: 'comments-url-template', label: 'Comments URL Template', type: 'string', description: 'Override the default comments link, e.g. for an alternative front-end.' },
      { key: 'request-url-template', label: 'Request URL Template', type: 'string', description: 'Override the URL used to fetch posts, e.g. to route through a proxy.' },
      { key: 'proxy', label: 'Proxy', type: 'string', description: 'Proxy URL (or object {url, allow-insecure}) used for the upstream requests.' },
      {
        key: 'app-auth', label: 'App Auth', type: 'object', description: 'Reddit OAuth app credentials for authenticated requests.', itemSchema: [
          { key: 'name', label: 'Name', type: 'string', description: 'The Reddit app name.' },
          { key: 'id', label: 'ID', type: 'string', description: 'The Reddit app client ID.' },
          { key: 'secret', label: 'Secret', type: 'string', description: 'The Reddit app client secret.' },
        ],
      },
    ],
  },
  {
    type: 'rss', label: 'RSS', description: 'Items from one or more RSS/Atom feeds.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'feeds', label: 'Feeds', type: 'object[]', description: 'The RSS/Atom feeds to display.', itemSchema: RSS_FEED_SCHEMA },
      { key: 'style', label: 'Style', type: 'enum', enum: ['vertical-list', 'detailed-list', 'horizontal-cards', 'horizontal-cards-2'], default: 'vertical-list', description: 'Appearance of the widget.' },
      { key: 'thumbnail-height', label: 'Thumbnail Height', type: 'number', default: 10, description: 'Height of thumbnails in rem (horizontal-cards style only).' },
      { key: 'card-height', label: 'Card Height', type: 'number', default: 27, description: 'Height of cards in rem (horizontal-cards-2 style only).' },
      { key: 'limit', label: 'Limit', type: 'number', default: 25, description: 'Maximum number of items to show across all feeds.' },
      { key: 'collapse-after', label: 'Collapse After', type: 'number', default: 5, description: 'How many items are visible before the "SHOW MORE" button appears. Set to -1 to never collapse.' },
      { key: 'single-line-titles', label: 'Single Line Titles', type: 'boolean', default: false, description: 'Truncate item titles to one line (vertical-list style only).' },
      { key: 'preserve-order', label: 'Preserve Order', type: 'boolean', default: false, description: 'Preserve the original feed order instead of sorting by date.' },
    ],
  },
  {
    type: 'monitor', label: 'Monitor', description: 'Uptime/status monitor for a list of sites.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'sites', label: 'Sites', type: 'object[]', description: 'The sites to monitor.', itemSchema: MONITOR_SITE_SCHEMA },
      { key: 'style', label: 'Style', type: 'enum', enum: ['compact'], description: 'Alternative appearance. Only "compact" is available.' },
      { key: 'show-failing-only', label: 'Show Failing Only', type: 'boolean', default: false, description: 'Only show sites that are currently failing.' },
    ],
  },
  {
    type: 'twitch-top-games', label: 'Twitch Top Games', description: 'The games/categories with the most viewers on Twitch.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'exclude', label: 'Exclude', type: 'string[]', description: 'Category slugs that will never be shown.' },
      { key: 'limit', label: 'Limit', type: 'number', default: 10, description: 'Maximum number of games to show.' },
      { key: 'collapse-after', label: 'Collapse After', type: 'number', default: 5, description: 'How many games are visible before the "SHOW MORE" button appears. Set to -1 to never collapse.' },
    ],
  },
  {
    type: 'twitch-channels', label: 'Twitch Channels', description: 'Live status of a list of Twitch channels.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'channels', label: 'Channels', type: 'string[]', required: true, description: 'List of channels to display.' },
      { key: 'sort-by', label: 'Sort By', type: 'enum', enum: ['viewers', 'live'], default: 'viewers', description: 'Order in which channels are displayed.' },
      { key: 'collapse-after', label: 'Collapse After', type: 'number', default: 5, description: 'How many channels are visible before the "SHOW MORE" button appears. Set to -1 to never collapse.' },
      { key: 'link-category-to-stream', label: 'Link Category To Stream', type: 'boolean', default: false, description: "Clicking a live channel's game name opens the streamer instead of the Twitch category." },
    ],
  },
  {
    type: 'lobsters', label: 'Lobsters', description: 'Posts from lobste.rs or a compatible instance.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'instance-url', label: 'Instance URL', type: 'string', description: 'Base URL for a Lobsters instance other than lobste.rs.' },
      { key: 'custom-url', label: 'Custom URL', type: 'string', description: 'A custom URL to retrieve posts from. When set, instance-url, sort-by and tags are ignored.' },
      { key: 'sort-by', label: 'Sort By', type: 'enum', enum: ['hot', 'new'], default: 'hot', description: 'Order in which posts are returned.' },
      { key: 'tags', label: 'Tags', type: 'string[]', description: 'Limit to posts containing one of the given tags. Sort order is forced to hot when filtering by tags.' },
      { key: 'limit', label: 'Limit', type: 'number', description: 'Maximum number of posts to show.' },
      { key: 'collapse-after', label: 'Collapse After', type: 'number', default: 5, description: 'How many posts are visible before the "SHOW MORE" button appears. Set to -1 to never collapse.' },
    ],
  },
  {
    type: 'change-detection', label: 'Change Detection', description: 'Recent watch changes from a changedetection.io instance.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'instance-url', label: 'Instance URL', type: 'string', description: 'Base URL of the changedetection.io instance.' },
      { key: 'token', label: 'Token', type: 'string', description: 'API token for the changedetection.io instance.' },
      { key: 'watches', label: 'Watches', type: 'string[]', description: 'List of watch UUIDs to display; omit to show all.' },
      { key: 'allow-insecure', label: 'Allow Insecure', type: 'boolean', default: false, description: 'Allow insecure (self-signed certificate) connections.' },
      { key: 'limit', label: 'Limit', type: 'number', description: 'Maximum number of watches to show.' },
      { key: 'collapse-after', label: 'Collapse After', type: 'number', description: 'How many watches are visible before the "SHOW MORE" button appears. Set to -1 to never collapse.' },
    ],
  },
  {
    type: 'repository', label: 'Repository', description: 'Overview of a GitHub repository: open PRs, issues and recent commits.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'repository', label: 'Repository', type: 'string', required: true, description: 'The repository to display, e.g. owner/repo.' },
      { key: 'token', label: 'Token', type: 'string', description: 'GitHub token to increase rate limits / access private repos.' },
      { key: 'pull-requests-limit', label: 'Pull Requests Limit', type: 'number', default: 3, description: 'Maximum number of open pull requests to show.' },
      { key: 'issues-limit', label: 'Issues Limit', type: 'number', default: 3, description: 'Maximum number of open issues to show.' },
      { key: 'commits-limit', label: 'Commits Limit', type: 'number', default: -1, description: 'Maximum number of recent commits to show. -1 hides commits.' },
    ],
  },
  {
    type: 'search', label: 'Search', description: 'A search box pointing at a configurable search engine, with optional bangs.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'search-engine', label: 'Search Engine', type: 'string', default: 'duckduckgo', description: 'A known engine (duckduckgo, google, bing, perplexity, kagi, startpage, qwant) or a custom URL with {QUERY}.' },
      { key: 'new-tab', label: 'New Tab', type: 'boolean', default: false, description: 'Swap the shortcuts so results open in a new tab by default.' },
      { key: 'autofocus', label: 'Autofocus', type: 'boolean', default: false, description: 'Automatically focus the search input on page load.' },
      { key: 'target', label: 'Target', type: 'enum', enum: ['_blank', '_self', '_parent', '_top'], default: '_blank', description: 'The target used when opening search results in a new tab.' },
      { key: 'placeholder', label: 'Placeholder', type: 'string', description: 'Placeholder text shown in the input field.' },
      { key: 'autocomplete', label: 'Autocomplete', type: 'boolean', default: true, description: 'Display search suggestions as you type.' },
      { key: 'autocomplete-provider', label: 'Autocomplete Provider', type: 'enum', enum: ['duckduckgo', 'brave'], default: 'duckduckgo', description: 'Provider used for search suggestions.' },
      {
        key: 'bangs', label: 'Bangs', type: 'object[]', description: 'Custom search shortcuts (bangs).', itemSchema: [
          { key: 'title', label: 'Title', type: 'string', description: 'Display title of the bang.' },
          { key: 'shortcut', label: 'Shortcut', type: 'string', description: 'The shortcut token, e.g. !yt.' },
          { key: 'url', label: 'URL', type: 'string', description: 'The search URL with {QUERY} placeholder.' },
          { key: 'icon', label: 'Icon', type: 'string', description: 'Icon for the bang (same icon syntax as elsewhere).' },
        ],
      },
    ],
  },
  {
    type: 'stopwatch', label: 'Stopwatch', description: 'A simple stopwatch/timer.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'start-on-open', label: 'Start On Open', type: 'boolean', default: false, description: 'Automatically start the stopwatch when the page loads.' },
    ],
  },
  {
    type: 'extension', label: 'Extension', description: 'Render content served by an external extension endpoint.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'url', label: 'URL', type: 'string', required: true, description: 'The extension endpoint URL.' },
      { key: 'fallback-content-type', label: 'Fallback Content Type', type: 'string', description: 'Content type to assume when the endpoint does not specify one.' },
      { key: 'parameters', label: 'Parameters', type: 'object', description: 'Query parameters appended to the request.' },
      { key: 'headers', label: 'Headers', type: 'object', description: 'Map of HTTP headers sent with the request.' },
      { key: 'allow-potentially-dangerous-html', label: 'Allow Potentially Dangerous HTML', type: 'boolean', default: false, description: 'Render returned HTML without sanitization. Only enable for trusted extensions.' },
    ],
  },
  {
    type: 'group', label: 'Group', description: 'Group multiple widgets into a single tabbed widget.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'widgets', label: 'Widgets', type: 'object[]', description: 'The widgets contained in this group. Each item is a full widget configuration.', itemSchema: NESTED_WIDGETS_SCHEMA },
    ],
  },
  {
    type: 'dns-stats', label: 'DNS Stats', description: 'Statistics from a self-hosted DNS ad-blocker (AdGuard Home, Pi-hole, Technitium).',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'service', label: 'Service', type: 'enum', enum: ['adguard', 'technitium', 'pihole', 'pihole-v6'], default: 'pihole', description: 'The DNS service type. Use pihole for v5 and below, pihole-v6 for v6 and above.' },
      { key: 'url', label: 'URL', type: 'string', description: 'The base URL of the service.' },
      { key: 'username', label: 'Username', type: 'string', description: 'Username (required for AdGuard Home).' },
      { key: 'password', label: 'Password', type: 'string', description: 'Password (required for AdGuard Home and Pi-hole v6+).' },
      { key: 'token', label: 'Token', type: 'string', description: 'API token (required for Pi-hole v5 and earlier).' },
      { key: 'allow-insecure', label: 'Allow Insecure', type: 'boolean', default: false, description: 'Allow invalid/self-signed certificates.' },
      { key: 'hour-format', label: 'Hour Format', type: 'enum', enum: ['12h', '24h'], default: '12h', description: 'Whether to show hours in 12- or 24-hour format on the graph.' },
      { key: 'hide-graph', label: 'Hide Graph', type: 'boolean', default: false, description: 'Hide the queries graph.' },
      { key: 'hide-top-domains', label: 'Hide Top Domains', type: 'boolean', default: false, description: 'Hide the top blocked domains list.' },
    ],
  },
  {
    type: 'split-column', label: 'Split Column', description: 'Split a single column into multiple sub-columns of widgets.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'max-columns', label: 'Max Columns', type: 'number', description: 'Maximum number of sub-columns to split into.' },
      { key: 'widgets', label: 'Widgets', type: 'object[]', description: 'The widgets distributed across the sub-columns. Each item is a full widget configuration.', itemSchema: NESTED_WIDGETS_SCHEMA },
    ],
  },
  {
    type: 'custom-api', label: 'Custom API', description: 'Fetch arbitrary JSON from an API and render it with a Go template.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      ...CUSTOM_API_REQUEST_OPTIONS,
      { key: 'subrequests', label: 'Subrequests', type: 'object', description: 'Map of named additional requests, each with the same shape as the primary request.' },
      { key: 'options', label: 'Options', type: 'object', description: 'Arbitrary key/value options accessible from the template via .Options.' },
      { key: 'template', label: 'Template', type: 'string', description: 'The Go HTML template used to render the response.' },
    ],
  },
  {
    type: 'dynawidgets', label: 'Dynawidgets', description: 'Render a pre-built widget template from the Dynawidgets community repository.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'widget', label: 'Widget', type: 'string', required: true, description: 'The slug of the widget from the dynawidgets repository.' },
      { key: 'repo', label: 'Repo', type: 'string', description: 'Override the dynawidgets repository to fetch the template from.' },
      ...CUSTOM_API_REQUEST_OPTIONS,
      { key: 'subrequests', label: 'Subrequests', type: 'object', description: 'Map of named additional requests, each with the same shape as the primary request.' },
      { key: 'options', label: 'Options', type: 'object', description: 'Arbitrary key/value options passed to the widget template.' },
    ],
  },
  {
    type: 'docker-containers', label: 'Docker Containers', description: 'Status of Docker containers, driven by container labels.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'sock-path', label: 'Sock Path', type: 'string', description: 'Path to the Docker socket (can be a remote/proxied socket).' },
      { key: 'hide-by-default', label: 'Hide By Default', type: 'boolean', default: false, description: 'Hide all containers unless labeled dynacat.hide: false.' },
      { key: 'running-only', label: 'Running Only', type: 'boolean', default: false, description: 'Only show running containers.' },
      { key: 'category', label: 'Category', type: 'string', description: 'Only show containers belonging to this category label.' },
      { key: 'format-container-names', label: 'Format Container Names', type: 'boolean', default: false, description: 'Convert names like container_name_1 into "Container Name 1".' },
      { key: 'containers', label: 'Containers', type: 'object', description: 'Per-container label overrides: a map of container name to a map of label overrides.' },
    ],
  },
  {
    type: 'docker-controller', label: 'Docker Controller', description: 'Interactive control of Docker containers and images (start/stop/pull).',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'sock-path', label: 'Sock Path', type: 'string', description: 'Path to the Docker socket (can be a remote/proxied socket).' },
      { key: 'show', label: 'Show', type: 'enum', enum: ['containers', 'images', 'both'], default: 'both', description: 'What to display in the widget.' },
      { key: 'format-container-names', label: 'Format Container Names', type: 'boolean', default: false, description: 'Convert names like container_name_1 into "Container Name 1".' },
      { key: 'collapse-after', label: 'Collapse After', type: 'number', description: 'Number of containers/images shown before a "SHOW MORE" button appears. Set to -1 to never collapse.' },
    ],
  },
  {
    type: 'server-stats', label: 'Server Stats', description: 'CPU, memory, swap, disk and temperature statistics for local and remote servers.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'servers', label: 'Servers', type: 'object[]', description: 'The servers to display statistics for.', itemSchema: SERVER_STATS_SERVER_SCHEMA },
    ],
  },
  {
    type: 'speedtest', label: 'Speedtest', description: 'Runs a network speed test and displays the results.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'server', label: 'Server', type: 'string', description: 'The speedtest server to use; auto-selected when omitted.' },
      { key: 'duration', label: 'Duration', type: 'duration', default: '15s', description: 'How long each test phase runs. Number + unit (s, m, h).' },
      { key: 'concurrent', label: 'Concurrent', type: 'number', default: 3, description: 'Number of concurrent connections used during the test.' },
    ],
  },
  {
    type: 'to-do', label: 'To-Do', description: 'A simple to-do list, stored locally or on the server.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'id', label: 'ID', type: 'string', description: 'Identifier for the list; use distinct IDs for separate lists, or shared IDs to share tasks.' },
      { key: 'storage', label: 'Storage', type: 'enum', enum: ['local', 'server'], default: 'local', description: 'Where tasks are persisted. "server" requires server.db-path.' },
      { key: 'collapse-after', label: 'Collapse After', type: 'number', description: 'Show only the first N tasks with a "Show more" toggle. Disabled by default; set to -1 to explicitly disable.' },
    ],
  },
  {
    type: 'playing', label: 'Playing', description: 'Currently playing media from Plex, Jellyfin or Navidrome.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'hosts', label: 'Hosts', type: 'object[]', description: 'The media server hosts to query.', itemSchema: PLAYING_HOST_SCHEMA },
      { key: 'play-state', label: 'Play State', type: 'enum', enum: ['indicator', 'text'], default: 'indicator', description: 'How to display the play state: pulsing dot or plain text.' },
      { key: 'episode-title-format', label: 'Episode Title Format', type: 'enum', enum: ['series', 'episode'], default: 'series', description: 'How episode titles are displayed for episodic media.' },
      { key: 'small-column', label: 'Small Column', type: 'boolean', default: false, description: 'Use a layout suited to small columns.' },
      { key: 'show-thumbnail', label: 'Show Thumbnail', type: 'boolean', description: 'Display thumbnails for currently playing media.' },
      { key: 'show-paused', label: 'Show Paused', type: 'boolean', default: false, description: 'Display paused sessions in addition to actively playing ones.' },
      { key: 'show-progress-bar', label: 'Show Progress Bar', type: 'boolean', description: 'Display an animated playback progress bar.' },
      { key: 'show-progress-info', label: 'Show Progress Info', type: 'boolean', description: 'Display estimated end time next to the progress bar. Requires show-progress-bar.' },
      { key: 'group-by-host', label: 'Group By Host', type: 'boolean', default: false, description: 'Group sessions by their host.' },
      { key: 'debug', label: 'Debug', type: 'boolean', default: false, description: 'Enable debug output for the widget.' },
    ],
  },
  {
    type: 'latest-media', label: 'Latest Media', description: 'Recently added media from Plex or Jellyfin servers.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'hosts', label: 'Hosts', type: 'object[]', description: 'Media server hosts to fetch recently added items from.', itemSchema: LATEST_MEDIA_HOST_SCHEMA },
      { key: 'item-count', label: 'Item Count', type: 'number', default: 12, description: 'Number of items to show after merging and trimming results.' },
      { key: 'columns', label: 'Columns', type: 'number', default: 4, description: 'Number of grid columns.' },
      { key: 'small-column', label: 'Small Column', type: 'boolean', default: false, description: 'Halve the number of columns; useful in narrow columns.' },
      { key: 'show-overlay', label: 'Show Overlay', type: 'boolean', default: true, description: 'Show the title/metadata overlay on each item.' },
    ],
  },
  {
    type: 'torrenting', label: 'Torrenting', description: 'Active torrents from qBittorrent, Deluge or Transmission clients.',
    options: [
      ...DYNACAT_SHARED_WIDGET_OPTIONS,
      { key: 'hosts', label: 'Hosts', type: 'object[]', description: 'Torrent client hosts to query.', itemSchema: TORRENTING_HOST_SCHEMA },
      { key: 'hide-completed', label: 'Hide Completed', type: 'boolean', default: false, description: 'Hide completed torrents.' },
      { key: 'hide-inactive', label: 'Hide Inactive', type: 'boolean', default: false, description: 'Hide inactive torrents.' },
      { key: 'hide-bar', label: 'Hide Bar', type: 'boolean', default: false, description: 'Hide the progress bar.' },
      { key: 'wrap-text', label: 'Wrap Text', type: 'boolean', default: false, description: 'Wrap long torrent names instead of truncating.' },
      { key: 'collapse-after', label: 'Collapse After', type: 'number', default: 3, description: 'How many torrents are visible before the "SHOW MORE" button appears. Set to -1 to never collapse.' },
    ],
  },
]

// Page-level options (config.go: type page struct). `columns`/`head-widgets` are structural and handled
// by the builder canvas, so the page-settings form excludes them (see PAGE_SETTINGS_OPTIONS use).
export const DYNACAT_PAGE_OPTIONS: DcOption[] = [
  { key: 'name', label: 'Name', type: 'string', required: true, description: 'The name of the page, shown in the navigation.' },
  { key: 'name-icon', label: 'Name Icon', type: 'string', description: 'Icon shown to the left of the page name in the navigation (same icon syntax as elsewhere).' },
  { key: 'slug', label: 'Slug', type: 'string', description: 'URL-friendly identifier used to access the page. Auto-generated from the name when omitted.' },
  { key: 'width', label: 'Width', type: 'enum', enum: ['default', 'slim', 'wide'], default: 'default', description: 'Maximum width of the page on desktop (default 1600px, slim 1100px, wide 1920px). slim limits the page to 2 columns.' },
  { key: 'desktop-navigation-width', label: 'Desktop Navigation Width', type: 'enum', enum: ['default', 'slim', 'wide'], description: 'Maximum width of the desktop navigation bar.' },
  { key: 'dynamic-updates', label: 'Dynamic Updates', type: 'boolean', default: true, description: 'Whether widgets on this page poll for updates. When false, no widget polling occurs regardless of widget update-interval.' },
  { key: 'show-mobile-header', label: 'Show Mobile Header', type: 'boolean', default: false, description: 'Show a header displaying the page name on mobile.' },
  { key: 'hide-desktop-navigation', label: 'Hide Desktop Navigation', type: 'boolean', default: false, description: 'Hide the navigation links at the top of the page on desktop.' },
  { key: 'center-vertically', label: 'Center Vertically', type: 'boolean', default: false, description: 'Vertically center the content on the page (no effect if content is taller than the viewport).' },
  { key: 'hide-from-navigation', label: 'Hide From Navigation', type: 'boolean', default: false, description: 'Omit the page from desktop and mobile navigation; still reachable via its slug.' },
  { key: 'key-bind', label: 'Key Bind', type: 'string', description: 'Keyboard shortcut to navigate to this page. A single character is auto-prefixed with "d" (e.g. "d h"). Page must not be hidden from navigation.' },
  { key: 'allowed-users', label: 'Allowed Users', type: 'string[]', description: 'Restrict access to this page to the listed usernames.' },
  { key: 'allowed-groups', label: 'Allowed Groups', type: 'string[]', description: 'Restrict access to this page to the listed groups.' },
]

// Column-level options (config.go: page.Columns anonymous struct).
export const DYNACAT_COLUMN_OPTIONS: DcOption[] = [
  { key: 'size', label: 'Size', type: 'enum', enum: ['full', 'small'], required: true, description: 'Column width. "small" is a fixed 300px; "full" takes the remaining width. A page has 1-3 columns and must have 1 or 2 full columns.' },
]

// ---- helpers used by the builder UI ----
export const titleCase = (k: string): string =>
  k.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export const findWidgetDef = (type: string): DcWidgetDef | undefined =>
  DYNACAT_WIDGETS.find((w) => w.type === type) || (type === 'stocks' ? DYNACAT_WIDGETS.find((w) => w.type === 'markets') : undefined)
