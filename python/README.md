# Facebook Page Scraper (CLI)

A small Python CLI that downloads posts from a Facebook page and stores each post in its own folder with caption, meta, comments, and images.

## Setup
1. Use Python 3.10+.
2. Install deps:
   ```bash
   pip install -r requirements.txt
   ```

## Usage
Interactive (prompts for page URL and optional login):
```bash
python scrape_fb_page.py
```

Non‑interactive example (scrape 10 posts):
```bash
python scrape_fb_page.py --page-url https://www.facebook.com/<page-slug> --max-posts 10 \
  --email "your-email" --password "your-password" --cookies /path/to/cookies.txt \
  --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
```

### Using a .env file
Store credentials in a local `.env` so you are not prompted:
```
FACEBOOK_EMAIL=your-email@example.com
FACEBOOK_PASSWORD=your-password
# optional, Netscape cookie file for authenticated scraping
FACEBOOK_COOKIES=/path/to/cookies.txt
# optional, override UA if Facebook blocks the default
FACEBOOK_USER_AGENT=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36
```
Then run:
```bash
python scrape_fb_page.py --page-url https://www.facebook.com/<page-slug>
```
The script loads `.env` by default; override with `--env-file custom.env`.
If both cookies and credentials are present, cookies take priority and credentials are ignored (facebook-scraper accepts only one auth method).

Outputs are written under `output/<page>/`. Each post gets a folder named from its caption (sanitized). Inside you will see:
- `caption.txt`
- `meta.txt` (post id, url, time, likes, comments total, shares)
- `comments.txt` (when available)
- downloaded images (image_1.jpg, ...)

## Notes
- The tool uses [`facebook-scraper`](https://pypi.org/project/facebook-scraper/), which can fetch public page data anonymously. Supplying valid credentials increases the chance of seeing all posts and images. Do not hardcode credentials; pass them at runtime.
- If Facebook prompts for checkpoint/2FA or keeps rejecting scripted logins, export cookies from a logged-in browser (Netscape format) and pass them with `--cookies /path/to/cookies.txt` (or `FACEBOOK_COOKIES`). Cookies and credentials cannot be combined; cookies take priority.
- A modern desktop User-Agent often avoids blocks; pass `--user-agent` (or `FACEBOOK_USER_AGENT`) to override the default.
- Folder names are truncated to 80 characters and sanitized to avoid filesystem issues.
- Network access is required when actually scraping; this repository does not include Facebook data.

## Credential reminder
The user provided account uses email `nawanjanaoshadi12@gmail.com`. Supply its password at the prompt if you choose to log in; the script does not store credentials.
